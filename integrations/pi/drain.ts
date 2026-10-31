import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentBeforeSettleEvent,
  type BoundaryResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BraidJobs, OutstandingJob } from "./jobs.js";

/** Pi exits once print and JSON runs settle, so Braid drains jobs before that. */
export const isSingleShot = (ctx: Pick<ExtensionContext, "mode">) => ctx.mode === "print" || ctx.mode === "json";

/**
 * RPC and SDK hosts treat agent_settled as the end of a run and may end Pi then,
 * which would take running jobs with it, so only the terminal UI settles while
 * jobs run and lets their reminders start new runs.
 */
export const holdsSettlement = (ctx: Pick<ExtensionContext, "mode">) => ctx.mode !== "tui";

export const BRAID_HOLD_GUIDANCE =
  "This run stays open while Braid jobs are running, so submit, end your turn, and continue from the reminder as usual. " +
  "Messages from the user can arrive before then: answer them and end your turn again; the jobs keep running. " +
  "Paused executions, including results held by a node's replan request, reruns waiting at a node's maxRuns, and paused jobs do not keep the run open: when only paused work remains, the run ends and that work waits for the user's next message.";

export const BRAID_DRAIN_GUIDANCE =
  "This is a single-shot run. It stays open until every Braid job finishes and its reminder is delivered, so submit, end your turn, and continue from the reminder as usual. " +
  "Paused executions, including results held by a node's replan request, reruns waiting at a node's maxRuns, and paused jobs are not resumed automatically: resume or cancel them before ending your turn. If only paused work remains when you end a turn, you get one warning; ending the next turn without resuming it cancels those jobs and the run exits with a failure status.";

export const BRAID_FINISH_GUIDANCE =
  "When the task is done and no Braid job is outstanding, call braid_finish once with status success or failure and a short summary of the outcome, then end your turn with your final response. " +
  "A failure status makes the run exit 1. braid_finish only records the outcome: the run still ends when your turn ends and every Braid job has finished. Call it again to replace the outcome if more work follows.";

export type BraidFinishOutcome = { status: "success" | "failure"; summary: string };

/** Queued host input and the run's wall-clock budget are not job changes, so the drain also wakes periodically. */
const RECHECK_MS = 100;

export function parseDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const ms = match ? Number(match[1]) * scale[(match[2] ?? "ms") as keyof typeof scale] : NaN;
  if (!(ms > 0) || ms > 2_147_483_647)
    throw new Error(`Invalid --braid-ci-timeout ${JSON.stringify(value)}: use a positive duration such as 90000, 90s, 30m, or 2h`);
  return ms;
}

const waitingOn = (job: OutstandingJob) => [
  job.pausedExecutionIds.length ? `paused executions ${JSON.stringify(job.pausedExecutionIds)}` : "",
  job.suspendedExecutionIds.length ? `suspended executions ${JSON.stringify(job.suspendedExecutionIds)}` +
    (job.timedOutExecutionIds?.length ? ` (paused by their node timeout: ${JSON.stringify(job.timedOutExecutionIds)})` : "") : "",
  job.limitedExecutionIds.length ? `reruns at their node's maxRuns ${JSON.stringify(job.limitedExecutionIds)}` : "",
  job.paused ? "its job pause" : "",
].filter(Boolean).join(" and ") || "paused work";

const stalledReminder = (jobs: OutstandingJob[]) =>
  `[system-reminder] This single-shot run cannot end while Braid jobs are outstanding, and nothing can progress: ` +
  jobs.map(job => `${job.handle} is waiting on ${waitingOn(job)} at revision ${job.revision}`).join("; ") +
  `. Resume executions with braid_resume or braid_update with resume, raise a node's maxRuns with braid_update, resume a paused job with braid_resume({jobId}), fail single executions with braid_cancel and executionIds, or cancel the job with braid_cancel, then continue the original task. ` +
  `If you end your turn again without doing so, Braid cancels these jobs and the run exits with a failure status. [/system-reminder]`;

/**
 * Keeps runs without a terminal UI open until every Braid job reaches a
 * terminal status, or in RPC and SDK sessions until only paused work remains.
 * Reminders are steered into the run as in interactive mode, so the parent
 * keeps the async model: it ends its turn and the reminder resumes it.
 */
export function registerDrain(pi: ExtensionAPI, jobs: BraidJobs, hasPendingReminders: () => boolean): void {
  pi.registerFlag("braid-ci-timeout", {
    description: "Wall-clock budget for Braid jobs in print/JSON mode (e.g. 90000, 90s, 30m, 2h); on expiry, outstanding jobs are cancelled and the run exits 1",
    type: "string",
  });
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  let warnedStall: string | undefined;
  const failures = new Set<string>();
  let outcome: BraidFinishOutcome | undefined;
  let reported: BraidFinishOutcome | undefined;

  const fail = (reason: string): void => {
    if (failures.has(reason)) return;
    failures.add(reason);
    process.exitCode = 1;
    console.error(`Braid: ${reason}`);
  };
  const cancelOutstanding = (reason: string): void => {
    const outstanding = jobs.outstanding();
    if (!outstanding.length) return;
    fail(reason);
    for (const job of outstanding) jobs.cancel(job.jobId);
  };
  const expire = (): void => {
    timedOut = true;
    cancelOutstanding("--braid-ci-timeout expired; cancelled outstanding Braid jobs");
  };
  const nextChange = (signal?: AbortSignal) => new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(tick);
      unsubscribe();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const tick = setTimeout(done, RECHECK_MS);
    const unsubscribe = jobs.subscribe(done);
    signal?.addEventListener("abort", done, { once: true });
  });

  const finishParameters = Type.Object({
    status: StringEnum(["success", "failure"] as const, { description: "Whether the run achieved its task. failure makes the process exit 1." }),
    summary: Type.String({ minLength: 1, description: "Short summary of the outcome for CI logs and JSON output." }),
  }, { additionalProperties: false });
  pi.registerTool(defineTool<typeof finishParameters, BraidFinishOutcome>({
    name: "braid_finish",
    label: "Finish Braid run",
    description:
      "Single-shot (print/JSON) runs only: record the run outcome for CI. status failure makes the process exit 1. " +
      "It does not end the run; call it once the task is done and no Braid job is outstanding, then end your turn. A later call replaces the outcome.",
    parameters: finishParameters,
    // Activated in single-shot sessions only, so interactive runs never see it.
    defaultActive: false,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!isSingleShot(ctx)) throw new Error("braid_finish is only available in print and JSON runs");
      outcome = { status: params.status, summary: params.summary };
      const outstanding = jobs.outstanding().length;
      return {
        content: [{
          type: "text",
          text: `Recorded ${params.status}.` + (outstanding
            ? ` ${outstanding} Braid job(s) are still outstanding; the run stays open until they finish, so continue from their reminders and call braid_finish again if the outcome changes.`
            : " End your turn with your final response."),
        }],
        details: outcome,
      };
    },
  }));

  /** Applies the reported outcome once the run is about to settle with nothing outstanding. */
  const settle = (event: AgentBeforeSettleEvent): BoundaryResult | undefined => {
    if (!outcome || outcome === reported) return;
    reported = outcome;
    // Never reset the exit code: success must not mask a forced cancellation or a Pi error.
    if (outcome.status === "failure") {
      process.exitCode = 1;
      console.error(`Braid: run reported failure: ${outcome.summary}`);
    }
    // A custom entry is not model context and leaves the final assistant message last,
    // so text output is unchanged; JSON mode streams it as an entry_appended event.
    return {
      entries: [...event.entries, {
        type: "custom",
        customType: "braid-finish",
        data: { ...outcome, forcedFailures: [...failures] },
      }],
    };
  };

  pi.on("session_start", (_event, ctx) => {
    if (isSingleShot(ctx) && !pi.getActiveTools().includes("braid_finish"))
      pi.setActiveTools([...pi.getActiveTools(), "braid_finish"]);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const budget = pi.getFlag("braid-ci-timeout");
    if (timer || timedOut || !isSingleShot(ctx) || typeof budget !== "string") return;
    // The budget covers the whole run, starting at its first prompt.
    timer = setTimeout(expire, parseDuration(budget));
    timer.unref();
  });

  // Running jobs are awaited in the final turn, where the run's abort signal is live,
  // so abort ends the wait at once and the run settles as aborted with jobs still running.
  // agent_before_settle has no abort signal; it waits only for jobs left by a turn that
  // did not end normally, then reports stalls and the outcome.
  pi.on("turn_end", async (event, ctx) => {
    if (!holdsSettlement(ctx) || event.toolResults.length) return;
    if (event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
    const signal = ctx.signal;
    while (!closed && !timedOut && !signal?.aborted) {
      // A queued reminder or host message continues this run in its next turn,
      // and the wait resumes when that turn ends.
      if (hasPendingReminders() || ctx.hasPendingMessages()) return;
      if (jobs.outstanding().every(job => job.stalled)) return;
      await nextChange(signal);
    }
  });

  pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx): Promise<BoundaryResult | undefined> => {
    if (!holdsSettlement(ctx)) return;
    const singleShot = isSingleShot(ctx);
    while (!closed) {
      // A queued reminder or host message continues this run, and the hold resumes
      // after that turn; Pi settles only when its queues are empty.
      if (hasPendingReminders() || ctx.hasPendingMessages()) return;
      if (timedOut) cancelOutstanding("--braid-ci-timeout expired; cancelled outstanding Braid jobs");
      const outstanding = jobs.outstanding();
      if (!outstanding.length) return settle(event);
      if (outstanding.every(job => job.stalled)) {
        // A long-lived session can resume paused work on the user's next message.
        if (!singleShot) return;
        const key = JSON.stringify(outstanding.map(job => [job.jobId, job.revision, job.pausedExecutionIds, job.suspendedExecutionIds, job.paused]));
        if (key !== warnedStall) {
          warnedStall = key;
          return {
            entries: [...event.entries, {
              type: "custom_message",
              customType: "braid-drain-stalled",
              display: true,
              content: stalledReminder(outstanding),
              details: { jobs: outstanding },
            }],
            continue: true,
          };
        }
        // Cancellation reminders give the parent a final turn to report the outcome.
        cancelOutstanding(`paused work was never resumed; cancelled ${outstanding.map(job => job.handle).join(", ")}`);
      }
      await nextChange();
    }
  });

  pi.on("session_shutdown", () => {
    closed = true;
    clearTimeout(timer);
  });
}
