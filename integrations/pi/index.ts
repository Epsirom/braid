import { StringEnum, Type } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { BraidInput, GraphUpdate } from "@chrok/braid";
import { Text } from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { registerBraidCommand } from "./command.js";
import { renderGraphCall, renderGraphResult } from "./display.js";

const text = () => Type.String({ minLength: 1 });
const prompt = () => Type.Union([
  text(),
  Type.Object({
    template: text(),
    variables: Type.Record(Type.String(), Type.String()),
  }, { additionalProperties: false }),
]);
const timeout = () =>
  Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 2_147_483_647,
      description: "Timeout in milliseconds; omit for no time limit",
    }),
  );
const toolBudget = (unit: string) =>
  Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: `Maximum tool ${unit} per node, including decide and rejected requests; omit for no limit`,
    }),
  );

const nodeParameters = Type.Object({
  type: StringEnum(["execute", "decision", "merge", "integrate"]),
  id: text(), prompt: Type.Optional(prompt()), model: Type.Optional(text()),
  notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Send an execution completion reminder; default false. Does not pause scheduling." })),
  pauseAfter: Type.Optional(Type.Boolean({ description: "Hold this execution's outgoing dependencies until braid_resume or an atomic braid_update with resume. Sends a pause reminder." })),
  requireSuccess: Type.Optional(Type.Boolean({ description: "If true, failure aborts the entire job and cancels running siblings. Default false: unconditional successors can recover." })),
  workspace: Type.Optional(StringEnum(["read-only", "worktree"], { description: "Execute/decision only. Both use fresh predecessor snapshots in Git; read-only disables writes. Outside Git, all workers are read-only." })),
  choices: Type.Optional(Type.Array(text(), { minItems: 1, description: "Required only for decision nodes." })),
}, { additionalProperties: false });
const edgeParameters = Type.Object({
  from: text(), to: text(), choice: Type.Optional(text()),
  feedback: Type.Optional(text()),
  executionId: Type.Optional(Type.String({ minLength: 1, description: "Pin an exact completed historical source execution; available in braid_update only." })),
}, { additionalProperties: false });
const loopParameters = Type.Object({ id: text(), entry: text(), maxIterations: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const templates = Type.Record(Type.String(), text());
const braidParameters = Type.Object({
  goal: text(), nodes: Type.Array(nodeParameters, { minItems: 1 }), edges: Type.Array(edgeParameters),
  promptTemplates: Type.Optional(templates), loops: Type.Optional(Type.Array(loopParameters)),
  options: Type.Optional(Type.Object({
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    maxExecutions: Type.Optional(Type.Integer({ minimum: 1, description: "Total execution limit across all iterations and updates; default 1000." })),
    nodeTimeoutMs: timeout(), graphTimeoutMs: timeout(), maxToolRounds: toolBudget("rounds"), maxToolCalls: toolBudget("calls"),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const BRAID_FILESYSTEM_GUIDANCE =
  "Every execute/decision activation gets a fresh worktree in Git, based on its predecessor execution checkpoint (roots use the initial job snapshot). Set workspace=read-only to disable writes. Multiple independent code snapshots require an explicit merge node. " +
  "merge combines selected predecessor checkpoints into a new isolated worktree; integrate writes selected changes to the invoking checkout while preserving user edits. Both must call finish_merge using executionId for each source. There is no automatic final integration. " +
  "Do not set workspace on merge/integrate nodes. Checkpoints remain recoverable after cleanup. Optional failed predecessors pass errors and partial work along unconditional edges; requireSuccess=true makes failure abort the job. " +
  "Nodes have local read/ls and Git inspection; writable nodes have write/edit and Pi shell tools for dependencies, builds, and tests, while merge/integrate also have local Git integration tools. Search tools require local rg/fd. Outside Git all filesystem access is read-only; read-only nodes have no shell. Worktrees are not an OS sandbox: prompts constrain shell writes and shared resources. Checkpoints omit ignored new files. Parent extension/MCP tools and recursive Braid calls are not provided. Nodes should verify their changes; the parent reviews results and performs any remaining validation after integration.";

const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be handled independently. Nodes can analyze the project and implement changes in isolated Git worktrees. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  BRAID_FILESYSTEM_GUIDANCE,
  "For repeated instructions, define promptTemplates once and use prompt={template: name, variables: {name: value}} on nodes. Values are strings inserted literally into {{name}} placeholders; plain-string prompts remain supported.",
  "When Braid fits, submit a graph: use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, merge nodes to combine code snapshots, and integrate nodes to apply changes to the working branch. The tool returns a jobId immediately. Continue independent work or finish your turn while it runs; do not poll repeatedly. A completion reminder will resume you. Use braid_status with the jobId to retrieve terminal outputs before relying on them.",
  "Set notifyOnCompletion=true on selected nodes to receive intermediate success/failure reminders. Use braid_status({jobId, executionId}) to retrieve the exact execution; nodeId selects the latest instance. Use pauseAfter=true to hold outgoing scheduling. Definitions can always be changed with braid_update using expectedRevision; existing executions retain their captured inputs. Use resume in the same update to apply changes and release held executions atomically, or braid_resume for no graph changes.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, a single shell command, or when decomposition adds no value. Writable nodes can implement and test their work. The parent reviews results and performs any remaining validation after Braid completes.",
].join("\n");

export function createBraidTools(jobs: BraidJobs) {
  const braidTool = defineTool<typeof braidParameters, JobSnapshot | undefined>(
    {
      name: "braid",
      label: "Braid",
      description:
        "Use this tool FIRST for nontrivial engineering work: code reviews, bug investigations, design comparisons, test planning, and changes spanning multiple files. " +
        "It starts a background job and immediately returns jobId for a mutable graph of isolated LLM invocations with parallel branches and joins; the user does not need to mention Braid. " +
        "Use execute, decision, merge, or integrate nodes. Decision nodes must declare choices and call decide; matching choice edges activate together. Merge/integrate nodes accept multiple predecessors and an optional prompt. Structured loops declare id, entry, maxIterations, and one decision feedback edge labelled feedback=loopId; the body must be acyclic and loops cannot overlap or nest. Each round uses new executions and worktrees. " +
        "For repeated prompts, define promptTemplates and set node prompt to {template: name, variables: {name: value}}; core renders {{name}} placeholders using explicit string variables before execution. " +
        "Unlabelled edges are unconditional. Joins wait for all possible predecessor paths to resolve. " +
        "Nodes see only the goal, their prompt, labelled direct-predecessor outputs, and their filesystem capabilities: " +
        "no parent history, inherited extension/MCP tools, or recursive Braid tools. " +
        BRAID_FILESYSTEM_GUIDANCE + " " +
        "Do not use it for a simple one-step answer or trivial direct edit. " +
        "Use braid_status(jobId) for progress and results, or braid_cancel(jobId) to stop it. A completion reminder resumes the agent if idle; do independent work or end your turn instead of polling. Humans can open /braid for the live flow panel. " +
        "Set notifyOnCompletion=true on selected nodes for intermediate success/failure reminders; retrieve their output/error with braid_status({jobId, nodeId}). Notifications do not pause scheduling or allow graph mutation. " +
        "Read result.status: failed graphs can still return successful terminal outputs.",
      promptSnippet:
        "Use FIRST for nontrivial code review/debug/design/implementation work; set workspace=read-only for analysis/synthesis, use worktrees for edits and merge nodes for integration",
      promptGuidelines: [
        "Call braid before direct repository inspection when a code task has two or more separable review, debugging, design, test-planning, or implementation concerns; the Braid nodes can inspect the project and edit isolated Git worktrees.",
        "Use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, merge nodes to combine code snapshots, and integrate nodes to apply changes to the working branch. The user does not need to mention Braid or design the graph.",
        "Do not use braid for simple one-step answers or trivial direct edits. Let writable nodes run shell commands and tests for their work; use merge nodes to combine and validate snapshots before explicit integration.",
        BRAID_FILESYSTEM_GUIDANCE,
        "Decision nodes additionally receive decide. Nodes cannot call recursive Braid.",
        "Tool and time budgets are unlimited by default. Set maxToolRounds, maxToolCalls, nodeTimeoutMs, or graphTimeoutMs in options to impose hard limits; nodes receive system reminders of their remaining budgets before each model call.",
      ],
      parameters: braidParameters,
      renderCall(args, theme) {
        return renderGraphCall(args, theme);
      },
      renderResult(result, _options, theme) {
        const job = result.details;
        return new Text(
          theme.fg(
            job ? "accent" : "error",
            job
              ? `Braid background job ${job.jobId} · ${job.status} · /braid to view`
              : result.content
                  .filter((item) => item.type === "text")
                  .map((item) => item.text)
                  .join("\n"),
          ),
          0,
          0,
        );
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        try {
          const job = jobs.start(
            {
              goal: params.goal,
              nodes: params.nodes,
              edges: params.edges,
              ...(params.loops !== undefined ? { loops: params.loops } : {}),
              ...(params.promptTemplates !== undefined ? { promptTemplates: params.promptTemplates } : {}),
            } as BraidInput,
            params.options ?? {},
            ctx,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  jobId: job.handle,
                  canonicalJobId: job.jobId,
                  status: job.status,
                  message:
                    "Running in background. Use braid_status to retrieve progress/results. A completion reminder will resume you; do not poll repeatedly.",
                }),
              },
            ],
            details: job,
          };
        } catch (error) {
          throw new Error(
            `Braid submission failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    },
  );

  const statusParameters = Type.Object(
    {
      jobId: Type.Optional(text()),
      executionId: Type.Optional(text()),
      nodeId: Type.Optional(Type.String({ minLength: 1, description: "Exact node ID; requires jobId. Retrieve this node's full output/error even while the job is running." })),
    },
    { additionalProperties: false },
  );
  const statusTool = defineTool<
    typeof statusParameters,
    JobSnapshot | undefined
  >({
    name: "braid_status",
    label: "Braid status",
    description:
      "Retrieve a background Braid job's status, node progress, and final results by exact session handle (e.g. job-1) or UUID in jobId. Add executionId for an exact execution, or nodeId for the latest instance, including intermediate results while the job runs. Large results include a path to the full JSON. Prefer the short handle from submission/reminders. Omit both IDs to list jobs in this session. Completion reminders arrive automatically; avoid repeated polling.",
    parameters: statusParameters,
    renderResult(result, options, theme) {
      const job = result.details;
      const fallback = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!job) return new Text(fallback, 0, 0);
      if (job.error)
        return new Text(
          theme.fg("error", `Braid ${job.status}: ${job.error}`),
          0,
          0,
        );
      return renderGraphResult(
        {
          ...(job.result ?? job.live),
          progress: job.live.progress,
          ...(job.workspaces ? { workspaces: job.workspaces } : {}),
          ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {}),
        },
        options.expanded,
        options.isPartial,
        theme,
        fallback,
      );
    },
    async execute(_id, params) {
      if ((params.nodeId !== undefined || params.executionId !== undefined) && !params.jobId)
        throw new Error("nodeId/executionId requires jobId");
      if (!params.jobId)
        return {
          content: [{ type: "text", text: JSON.stringify(jobs.list()) }],
          details: undefined,
        };
      const job = jobs.get(params.jobId);
      if (!job) throw jobs.unknownJob(params.jobId);
      if (params.nodeId !== undefined || params.executionId !== undefined) {
        const node = jobs.getNode(params.jobId, params.nodeId, params.executionId);
        const full = JSON.stringify({ jobId: job.jobId, handle: job.handle, status: job.status, node }, null, 2);
        const preview = truncateHead(full);
        let suffix = "";
        if (preview.truncated) {
          const directory = await mkdtemp(join(tmpdir(), "braid-node-result-"));
          const path = join(directory, "result.json");
          await writeFile(path, full, { mode: 0o600 });
          suffix = `\n[Preview truncated. Full node result: ${path}]`;
        }
        // Focused reads do not claim the whole job's usage; final job retrieval does.
        return { content: [{ type: "text", text: preview.content + suffix }], details: job };
      }
      const preview = truncateHead(JSON.stringify(job, null, 2));
      const suffix = preview.truncated
        ? `\n[Preview truncated. ${job.fullOutputPath ? `Full result/log: ${job.fullOutputPath}` : "Full results will be available when the job finishes."}]`
        : "";
      const usage = jobs.claimUsage(job.jobId);
      return {
        content: [{ type: "text", text: preview.content + suffix }],
        details: job,
        ...(usage ? { usage } : {}),
      };
    },
  });

  const cancelParameters = Type.Object(
    { jobId: text() },
    { additionalProperties: false },
  );
  const cancelTool = defineTool<typeof cancelParameters, undefined>({
    name: "braid_cancel",
    label: "Cancel Braid",
    description:
      "Cancel a background Braid job by jobId. Stopping the foreground response does not cancel background jobs.",
    parameters: cancelParameters,
    async execute(_id, params) {
      const cancelled = jobs.cancel(params.jobId);
      return {
        content: [
          {
            type: "text",
            text: cancelled
              ? "Cancellation requested."
              : "Job has already finished.",
          },
        ],
        details: undefined,
      };
    },
  });
  const updateParameters = Type.Object({
    jobId: text(), expectedRevision: Type.Integer({ minimum: 0 }),
    upsertNodes: Type.Optional(Type.Array(nodeParameters)), removeNodeIds: Type.Optional(Type.Array(text())),
    addEdges: Type.Optional(Type.Array(edgeParameters)), removeEdges: Type.Optional(Type.Array(edgeParameters)),
    promptTemplates: Type.Optional(templates), loops: Type.Optional(Type.Array(loopParameters)),
    resume: Type.Optional(Type.Array(text())),
  }, { additionalProperties: false });
  const updateTool = defineTool<typeof updateParameters, JobSnapshot>({
    name: "braid_update", label: "Update Braid",
    description: "Atomically edit a running or waiting job using its current expectedRevision from braid_status. Upserts replace complete node definitions; removeNodeIds also removes incident edges. Existing executions and their failure policy remain unchanged. Completion routes through the latest graph. Pin historical inputs with edge.executionId. Optional resume releases paused execution IDs in the same transaction. Rejected updates change nothing; finalized jobs cannot be reopened.",
    parameters: updateParameters,
    async execute(_id, params) {
      const { jobId, ...patch } = params;
      const job = jobs.update(jobId, patch as GraphUpdate);
      return { content: [{ type: "text", text: JSON.stringify({ jobId: job.handle, revision: job.execution!.revision, pausedExecutionIds: job.execution!.pausedExecutionIds }) }], details: job };
    },
  });
  const resumeParameters = Type.Object({ jobId: text(), expectedRevision: Type.Integer({ minimum: 0 }), executionIds: Type.Array(text(), { minItems: 1 }) }, { additionalProperties: false });
  const resumeTool = defineTool<typeof resumeParameters, JobSnapshot>({
    name: "braid_resume", label: "Resume Braid",
    description: "Release specific paused execution IDs using expectedRevision from braid_status. Independent branches keep running during a pause; this does not reset deadlines or execution limits.",
    parameters: resumeParameters,
    async execute(_id, params) {
      const job = jobs.resume(params.jobId, params.executionIds, params.expectedRevision);
      return { content: [{ type: "text", text: JSON.stringify({ jobId: job.handle, revision: job.execution!.revision, pausedExecutionIds: job.execution!.pausedExecutionIds }) }], details: job };
    },
  });
  return { braidTool, statusTool, cancelTool, updateTool, resumeTool };
}

export default function braidExtension(pi: ExtensionAPI) {
  const pending = new Map<string, Parameters<ExtensionAPI["sendMessage"]>[0]>();
  const remind = (message: Parameters<ExtensionAPI["sendMessage"]>[0]): void => {
    try {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      // Keep failed deliveries pending for the next settled retry.
    }
  };
  const jobs = new BraidJobs((job) => {
    const { jobId, handle, status } = job;
    const reminderId = JSON.stringify([jobId, "job"]);
    const message = {
      customType: "braid-completed",
      display: true,
      content: `[system-reminder] Braid job ${handle} finished with status ${status}. Retrieve its results with braid_status({"jobId":"${handle}"}) and continue the original task. Failed or cancelled jobs may contain successful partial outputs. [/system-reminder]`,
      details: { jobId, handle, status, reminderId },
    };
    pending.set(reminderId, message);
    remind(message);
  }, (completion) => {
    const { jobId, handle, nodeId, executionId, status, eventSequence, errorCode, paused, iteration } = completion;
    const reminderId = JSON.stringify([jobId, "execution", executionId, eventSequence]);
    const lookup = JSON.stringify({ jobId: handle, executionId });
    const message = {
      customType: "braid-node-completed",
      display: true,
      content: `[system-reminder] Braid job ${handle} node ${JSON.stringify(nodeId)} execution ${executionId}${iteration ? ` (iteration ${iteration})` : ""} finished with status ${status}${errorCode ? ` (${errorCode})` : ""}. Retrieve its output or error with braid_status(${lookup}) and continue the original task. ${paused ? "Outgoing scheduling is paused. Inspect the current revision, then use braid_update with resume or braid_resume to continue. Independent branches may still be running." : "This execution reminder does not pause downstream scheduling; the job may still be running."} [/system-reminder]`,
      details: { ...completion, reminderId },
    };
    pending.set(reminderId, message);
    remind(message);
  });
  // Foreground cancellation can discard queued follow-ups. Retry only reminders
  // that never entered context, once Pi has settled and emptied its queues.
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role === "custom" &&
        (message.customType === "braid-completed" || message.customType === "braid-node-completed")) {
      const details = message.details as { reminderId?: string } | undefined;
      if (details?.reminderId) pending.delete(details.reminderId);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      for (const message of pending.values()) remind(message);
    }
  });
  const { braidTool, statusTool, cancelTool, updateTool, resumeTool } = createBraidTools(jobs);
  registerBraidCommand(pi, jobs);
  pi.registerTool(braidTool);
  pi.registerTool(statusTool);
  pi.registerTool(cancelTool);
  pi.registerTool(updateTool);
  pi.registerTool(resumeTool);
  pi.on("session_shutdown", () => {
    pending.clear();
    jobs.dispose();
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Braid execution policy\n${BRAID_USAGE_GUIDANCE}\n\nFor the current user request, make this delegation choice before using read, grep, find, edit, write, or bash. Completion reminders refer to existing jobs: retrieve their results instead of submitting the same graph again.`,
  }));
}
