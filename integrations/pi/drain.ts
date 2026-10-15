import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BraidJobs, OutstandingJob } from "./jobs.js";

/** Pi exits once print and JSON runs settle, so Braid drains jobs before that. */
export const isSingleShot = (ctx: Pick<ExtensionContext, "mode">) => ctx.mode === "print" || ctx.mode === "json";

export const BRAID_DRAIN_GUIDANCE =
  "This is a single-shot run. It stays open until every Braid job finishes and its reminder is delivered, so submit, end your turn, and continue from the reminder as usual. " +
  "Paused executions are not resumed automatically: resume or cancel them before ending your turn. If only paused executions remain when you end a turn, you get one warning; ending the next turn without resuming them cancels their jobs and the run exits with a failure status.";

/** The run's wall-clock budget is checked by a timer, so the drain also wakes periodically. */
const RECHECK_MS = 1_000;

export function parseDuration(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(value);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  const ms = match ? Number(match[1]) * scale[(match[2] ?? "ms") as keyof typeof scale] : NaN;
  if (!(ms > 0) || ms > 2_147_483_647)
    throw new Error(`Invalid --braid-ci-timeout ${JSON.stringify(value)}: use a positive duration such as 90000, 90s, 30m, or 2h`);
  return ms;
}

const stalledReminder = (jobs: OutstandingJob[]) =>
  `[system-reminder] This single-shot run cannot end while Braid jobs are outstanding, and nothing can progress: ` +
  jobs.map(job => `${job.handle} is waiting on paused executions ${JSON.stringify(job.pausedExecutionIds)} at revision ${job.revision}`).join("; ") +
  `. Resume them with braid_resume or braid_update with resume, or cancel the job with braid_cancel, then continue the original task. ` +
  `If you end your turn again without doing so, Braid cancels these jobs and the run exits with a failure status. [/system-reminder]`;

/**
 * Keeps print and JSON runs alive until every Braid job reaches a terminal
 * status. Reminders are steered into the run as in interactive mode, so the
 * parent keeps the async model: it ends its turn and the reminder resumes it.
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
  const nextChange = () => new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(tick);
      unsubscribe();
      resolve();
    };
    const tick = setTimeout(done, RECHECK_MS);
    const unsubscribe = jobs.subscribe(done);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const budget = pi.getFlag("braid-ci-timeout");
    if (timer || timedOut || !isSingleShot(ctx) || typeof budget !== "string") return;
    // The budget covers the whole run, starting at its first prompt.
    timer = setTimeout(expire, parseDuration(budget));
    timer.unref();
  });

  pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx): Promise<BoundaryResult | undefined> => {
    if (!isSingleShot(ctx)) return;
    while (!closed) {
      // A queued reminder continues this run; Pi settles only when its queues are empty.
      if (hasPendingReminders()) return;
      if (timedOut) cancelOutstanding("--braid-ci-timeout expired; cancelled outstanding Braid jobs");
      const outstanding = jobs.outstanding();
      if (!outstanding.length) return;
      if (outstanding.every(job => job.stalled)) {
        const key = JSON.stringify(outstanding.map(job => [job.jobId, job.revision, job.pausedExecutionIds]));
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
        cancelOutstanding(`paused executions were never resumed; cancelled ${outstanding.map(job => job.handle).join(", ")}`);
      }
      await nextChange();
    }
  });

  pi.on("session_shutdown", () => {
    closed = true;
    clearTimeout(timer);
  });
}
