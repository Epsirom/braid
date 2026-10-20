import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-jobs";
import type { BraidInput } from "@chrok/braid";
import { BraidJobs, type ControlNotice, type JobOptions, type JobSnapshot } from "./jobs.js";
import { createBraidTools } from "./tools.js";
import { formatControlNotice, formatJobList, formatReceipt, formatTimeoutPause } from "./status-text.js";
import { BRAID_USAGE_GUIDANCE, BRAID_WAIT_REMINDER } from "./schema.js";
import { renderPanel } from "./display.js";
import { BraidPanel } from "./panel.js";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    braid: { kind: "braid"; reminderId: string; form: "notice"; summary: string };
  }
}
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap { braid: "braid" }
}

export const name = "braid";
export const inject = ["tools", "llm", "commands", "systemPrompt", "jobs"];

export function apply(ctx: Context): void {
  const observers = new Set<() => void>();
  const changed = () => { for (const listener of observers) listener(); };
  const sessions = new Map<Agent, { jobs: BraidJobs; pending: Map<string, UserMessage>; queued: Set<string>; notices: Map<string, ControlNotice>; release: () => Promise<void> }>();
  ctx.inject(["typert"], ctx => {
    new BraidPanel(ctx, id => [...sessions].find(([agent]) => agent.session.id === id)?.[1].jobs,
      listener => { observers.add(listener); return () => { observers.delete(listener); }; });
  });
  const send = (agent: Agent, message: UserMessage) => {
    if (message.source.kind !== "braid") return;
    const state = sessions.get(agent);
    if (!state || state.queued.has(message.source.reminderId)) return;
    state.queued.add(message.source.reminderId);
    try { agent.steer(message); }
    catch { state.queued.delete(message.source.reminderId); }
  };
  // Pauses and resumes made by someone else never wake the parent: a woken parent could
  // resume work the user deliberately paused. Held while idle, the latest change per
  // execution or job wins; they are injected as context once the parent runs again.
  const flushNotices = (agent: Agent) => {
    const state = sessions.get(agent);
    if (!state?.notices.size || agent.status !== "running") return;
    const lines = [...state.notices.values()].map(formatControlNotice);
    state.notices.clear();
    try {
      agent.inject(createUserMessage({
        source: { kind: "braid", reminderId: JSON.stringify(["control", Date.now()]), form: "notice", summary: "Braid: paused, resumed, or cancelled outside this conversation" },
        content: [{ type: "text", text: `[system-reminder] ${lines.join(" ")} [/system-reminder]` }],
      }));
    } catch { /* Notices are advisory; braid_status still shows who paused. */ }
  };
  const noteControl = (agent: Agent, notice: ControlNotice) => {
    const state = sessions.get(agent);
    if (!state) return;
    // The latest change per execution or job wins; holds and pauses are tracked separately.
    const kind = notice.action === "held" || notice.action === "unheld" ? "hold" : "pause";
    for (const execution of notice.executions ?? [undefined])
      state.notices.set(JSON.stringify([notice.jobId, execution?.executionId ?? "job", kind]), { ...notice, ...(execution ? { executions: [execution] } : {}) });
    flushNotices(agent);
  };
  const session = (agent: Agent) => {
    const existing = sessions.get(agent);
    if (existing) return existing;
    const pending = new Map<string, UserMessage>();
    const jobs = new BraidJobs(ctx.llm, completion => {
      const { jobId, handle, status, executionId, nodeId, paused, sequence } = completion;
      const reminderId = JSON.stringify([jobId, executionId ?? "job", sequence ?? 0]);
      const lookup = JSON.stringify({ jobId: handle, ...(executionId ? { executionId } : {}) });
      const summary = `Braid ${handle}${nodeId ? ` / ${nodeId}` : ""}: ${paused ? "paused" : status}`.slice(0, 120);
      const message = createUserMessage({
        source: { kind: "braid", reminderId, form: "notice", summary },
        content: [{ type: "text", text: `[system-reminder] ${summary}. Retrieve results with braid_status(${lookup}) and continue the original task. Failed or cancelled jobs may contain successful partial results. ${paused ? "Outgoing scheduling was paused. Inspect CURRENT execution.revision and pausedExecutionIds before braid_update with resume or braid_resume. Deadlines continue; finalized jobs cannot resume." : "This reminder does not pause scheduling."} [/system-reminder]` }],
      });
      pending.set(reminderId, message); send(agent, message);
    }, notice => { noteControl(agent, notice); }, pause => {
      // Unlike other pauses, a timeout pause wakes the parent: only it can decide what happens next.
      const reminderId = JSON.stringify([pause.jobId, "timeout", pause.executionId, pause.sequence]);
      const message = createUserMessage({
        source: { kind: "braid", reminderId, form: "notice", summary: `Braid ${pause.handle} / ${pause.nodeId}: paused by node timeout`.slice(0, 120) },
        content: [{ type: "text", text: `[system-reminder] ${formatTimeoutPause(pause)} [/system-reminder]` }],
      });
      pending.set(reminderId, message); send(agent, message);
    });
    const value = { jobs, pending, queued: new Set<string>(), notices: new Map<string, ControlNotice>(), release: () => jobs.dispose() };
    sessions.set(agent, value);
    const off = jobs.subscribe(changed);
    changed();
    // Agent-scoped effects unwind on clear, reload, disposal, or session replacement.
    value.release = agent.ctx.effect(() => () => {
      off(); pending.clear(); value.notices.clear(); sessions.delete(agent); changed(); return jobs.dispose();
    });
    return value;
  };
  const requireAgent = (agent: Agent | undefined): Agent => {
    if (!agent) throw new Error("Braid requires an owning DSH agent");
    return agent;
  };
  ctx.jobs.attachController("braid");
  for (const tool of createBraidTools(exec => session(requireAgent(exec.agent)).jobs, (args, exec) => {
    const jobs = session(requireAgent(exec.agent)).jobs;
    const agent = requireAgent(exec.agent);
    const { options, ...input } = args;
    let snapshot: JobSnapshot | undefined;
    const nativeJobId = ctx.jobs.start({
      kind: "braid", label: args.goal.slice(0, 200), owner: agent.session.id,
      run(native) {
        const { provider, model } = agent.options;
        snapshot = jobs.start(input as BraidInput, (options ?? {}) as JobOptions, {
          cwd: agent.session.header.cwd ?? process.cwd(),
          ...(provider && model ? { model: `${provider}/${model}` } : {}),
        });
        const handle = snapshot.handle;
        native.append(renderPanel(snapshot) + "\n", { channel: "log" });
        let previous = "", timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = () => {
          timer = undefined;
          const job = jobs.get(handle);
          // The log records lifecycle changes; ticking activity belongs in the replaceable progress line.
          const panel = renderPanel(job);
          if (panel !== previous) { previous = panel; native.append("\n" + panel + "\n", { channel: "log" }); }
          const running = Object.values(job.execution.executions).find(execution => execution.status === "running");
          const live = running && jobs.getActivity(handle, running.executionId, { limit: 0 });
          native.updateProgress(`${handle} · ${job.execution.status} · ${Object.keys(job.execution.executions).length} executions` +
            (live ? ` · ${running.id}: ${live.phase}${live.tools[0] ? ` (${live.tools[0].name})` : ""}` : ""));
        };
        const unsubscribe = jobs.subscribe(() => { timer ??= setTimeout(refresh, 250); });
        return {
          cancel: () => { jobs.cancel(handle); },
          done: jobs.wait(handle).then(() => {
            clearTimeout(timer); unsubscribe(); refresh();
            const job = jobs.get(handle);
            return { status: job.status === "cancelled" ? "killed" as const : job.status === "completed" ? "completed" as const : "failed" as const,
              detail: `Braid ${handle}; retrieve with braid_status`, result: `Braid job ${handle} finished with status ${job.status}.` };
          }),
        };
      },
    });
    return { text: formatReceipt(snapshot!, `${BRAID_WAIT_REMINDER} Open Braid in the session header for the live graph and execution details, or use the Jobs panel / /braid.`),
      jobId: snapshot!.handle, canonicalJobId: snapshot!.jobId, nativeJobId, status: snapshot!.status, nodeCount: snapshot!.execution.graph.nodes.length };
  })) ctx.tools.register(tool);

  ctx.systemPrompt.section({ name: "braid", order: 80, text: BRAID_USAGE_GUIDANCE, interpolate: false });
  ctx.commands.register({ name: "braid", description: "Show Braid flow/progress or cancel a job; live progress also appears in the Jobs panel.", input: { hint: "[jobId] | cancel <jobId> | list" },
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted();
      try {
        const jobs = session(agent).jobs;
        const parts = rawInput.trim().split(/\s+/).filter(Boolean);
        if (parts[0] === "cancel" && parts.length === 2)
          return { kind: "success", text: jobs.cancel(parts[1]!) ? "Cancellation requested." : "Job already finished." };
        if (parts.length > 1 || parts[0] === "cancel") return { kind: "error", text: "Usage: /braid [jobId] | cancel <jobId> | list" };
        if (parts[0] === "list") return { kind: "success", text: formatJobList(jobs.list()) };
        const id = parts[0] ?? jobs.list()[0]?.handle;
        return { kind: "success", text: id ? renderPanel(jobs.get(id), executionId => jobs.getActivity(id, executionId, { limit: 0 })) : "No Braid jobs in this session." };
      } catch (error) { return { kind: "error", text: error instanceof Error ? error.message : String(error) }; }
    },
  });
  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    if (message.source.kind === "braid") {
      sessions.get(agent)?.pending.delete(message.source.reminderId);
      sessions.get(agent)?.queued.delete(message.source.reminderId);
    }
  });
  ctx.on("agent/inbox/discarded", ({ agent, message }) => {
    if (message.source.kind === "braid") sessions.get(agent)?.queued.delete(message.source.reminderId);
  });
  ctx.on("agent/status", ({ agent, status }) => {
    if (status === "idle") for (const message of sessions.get(agent)?.pending.values() ?? []) send(agent, message);
    else flushNotices(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    const value = sessions.get(agent);
    value?.pending.clear(); sessions.delete(agent); changed(); void value?.release();
  });
  ctx.effect(() => async () => {
    const active = [...sessions.values()]; sessions.clear();
    for (const value of active) value.pending.clear();
    await Promise.all(active.map(value => value.release()));
  });
}
