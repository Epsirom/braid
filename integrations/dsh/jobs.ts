import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ExecutionActivityTracker, formatActivityStatus, startBraid, validateGraph, type BraidInput, type BraidLimits, type ExecutionActivity, type ExecutionActivityPage, type BraidRun, type BraidResult, type BraidSnapshot, type Edge, type GraphUpdate, type ExecutionEvent, type NodeResult, type ResumeOptions } from "@chrok/braid";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { createDshRunner, sumUsage, validateBudgets, type NodeProgress, type DshLlm } from "./runner.js";

export interface JobOptions extends BraidLimits {
  maxConcurrency?: number;
  nodeTimeoutMs?: number;
  /** Default "pause": a node timeout suspends the execution and wakes the parent. */
  onNodeTimeout?: "pause" | "fail";
  /** Default "pause": a limit holds the loop's decision or pauses the job, and wakes the parent. */
  onLimit?: "pause" | "fail";
  maxToolRounds?: number;
  maxToolCalls?: number;
}

export interface JobSnapshot {
  jobId: string;
  handle: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  execution: BraidSnapshot;
  result?: BraidResult;
  error?: string;
  usage: TokenUsage;
  progress: Record<string, NodeProgress>;
  events: ExecutionEvent[];
}

interface Job {
  jobId: string;
  handle: string;
  goal: string;
  status: JobSnapshot["status"];
  createdAt: number;
  run: BraidRun;
  done: Promise<void>;
  result?: BraidResult;
  error?: string;
  reports: TokenUsage[];
  progress: Record<string, NodeProgress>;
  events: ExecutionEvent[];
  /** Kept outside snapshots: histories are read one execution at a time. */
  activity: ExecutionActivityTracker;
}

/** An execution the node timeout paused; the parent decides what happens next. */
export interface TimeoutPause {
  jobId: string;
  handle: string;
  nodeId: string;
  executionId: string;
  /** The node time budget that ran out. */
  nodeTimeoutMs: number;
  /** Time the execution ran, excluding earlier suspensions. */
  activeMs: number;
  /** Observed activity when the timeout fired. */
  activity?: string;
  /** Identifies this pause within the job; a later timeout of the same execution is a new one. */
  sequence: number;
}

/** Work a job with nothing active waits on, and who put it there: "agent", "user", "definition", "replan", or "node_timeout". */
export interface WaitingItem {
  kind: "held" | "suspended" | "job";
  /** Omitted for the job pause. */
  executionId?: string;
  nodeId?: string;
  source: string;
}

/** A job has nothing active any more and waits on paused work the parent owns. */
export interface WaitingNotice {
  jobId: string;
  handle: string;
  revision: number;
  waitingOn: WaitingItem[];
  /** Identifies this transition within the job; a later one is a new one. */
  sequence: number;
}

/**
 * What a waiting job waits on, or undefined when the parent should not be woken: the user
 * paused the job or everything that remains, or what just left nothing active was the parent's
 * own suspension, or a held result or timeout pause, whose own reminder already wakes the parent.
 */
function waitingOn(state: BraidSnapshot, event: Extract<ExecutionEvent, { type: "graph_waiting" }>): WaitingItem[] | undefined {
  const settled = state.executions[event.settledExecutionId]?.suspension?.source;
  if (event.pause?.source === "user" || settled === "agent" || settled === "node_timeout" ||
      event.pausedExecutionIds.includes(event.settledExecutionId)) return undefined;
  const execution = (kind: WaitingItem["kind"], executionId: string, source: string | undefined): WaitingItem =>
    ({ kind, executionId, nodeId: state.executions[executionId]?.id ?? "?", source: source ?? "caller" });
  const items = [
    ...event.pausedExecutionIds.map(id => execution("held", id, state.executions[id]?.holdAfter?.source)),
    ...event.suspendedExecutionIds.map(id => execution("suspended", id, state.executions[id]?.suspension?.source)),
    ...event.pause ? [{ kind: "job" as const, source: event.pause.source }] : [],
  ];
  return items.some(item => item.source !== "user") ? items : undefined;
}

/** A pause, resume, hold change, or cancellation someone other than the parent agent made, such as the user in the panel. */
export interface ControlNotice {
  jobId: string;
  handle: string;
  /** held/unheld: a hold on running executions' results was added or removed. */
  action: "paused" | "resumed" | "held" | "unheld" | "cancelled";
  /** Omitted for the whole job. */
  executions?: { executionId: string; nodeId: string }[];
  source: string;
}

export interface Completion {
  jobId: string;
  handle: string;
  status: string;
  executionId?: string;
  nodeId?: string;
  paused?: boolean;
  sequence?: number;
  /** A decision held because the edge it chose is at its limit. */
  edgeLimit?: Edge;
  /** The execution asked for a replan; its result is held for the parent. */
  replanRequested?: boolean;
}

/** A running execution asked the parent to replan; its result will be held when it finishes. */
export interface ReplanNotice {
  jobId: string;
  handle: string;
  nodeId: string;
  executionId: string;
  reason: string;
  /** The node suggested a graph edit, readable with braid_status. */
  suggested: boolean;
  /** Identifies this request within the job; a repeated request is a new one. */
  sequence: number;
}

/** One manager per live DSH agent; foreground cancellation never owns these runs. */
/** The edge at its limit that holds a decision, for its pause reminder. */
function edgeLimit(state: BraidSnapshot, node: BraidSnapshot["executions"][string]): Pick<Completion, "edgeLimit"> {
  if (node.holdAfter?.source !== "edge_limit") return {};
  const edge = state.graph.edges.find(edge => edge.from === node.id && edge.choice === node.decision && edge.limit !== undefined);
  return edge ? { edgeLimit: { ...edge } } : {};
}

export class BraidJobs {
  private jobs = new Map<string, Job>();
  private handles = new Map<string, string>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private nextHandle = 1;

  constructor(
    private llm: DshLlm,
    private notify: (completion: Completion) => void = () => {},
    private onControl: (notice: ControlNotice) => void = () => {},
    private onTimeoutPause: (pause: TimeoutPause) => void = () => {},
    private onReplanRequested: (notice: ReplanNotice) => void = () => {},
    private onWaiting: (notice: WaitingNotice) => void = () => {},
  ) {}

  /** The parent made the change itself; anyone else's change becomes a notice for it. */
  private control(job: Job, action: ControlNotice["action"], source: string, executionIds?: readonly string[]): void {
    if (source === "agent" || this.disposed) return;
    const state = job.run.snapshot();
    try {
      this.onControl({ jobId: job.jobId, handle: job.handle, action, source,
        ...(executionIds ? { executions: executionIds.map(executionId => ({ executionId, nodeId: state.executions[executionId]?.id ?? "?" })) } : {}) });
    } catch { /* Notices are advisory. */ }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    for (const listener of this.listeners) { try { listener(); } catch { /* UI isolation. */ } }
  }

  start(input: BraidInput, options: JobOptions, context: { cwd: string; model?: string }): JobSnapshot {
    if (this.disposed) throw new Error("Braid session has closed");
    validateGraph(input);
    validateBudgets({ maxToolRounds: options.maxToolRounds, maxToolCalls: options.maxToolCalls });
    const jobId = randomUUID(), handle = `job-${this.nextHandle}`;
    const reports: TokenUsage[] = [];
    const events: ExecutionEvent[] = [];
    const progress: Record<string, NodeProgress> = Object.create(null);
    const activity = new ExecutionActivityTracker({ onChange: () => this.changed() });
    // What each execution was doing when its node timeout fired, for the reminder.
    const timeoutActivity = new Map<string, string>();
    const invoke = createDshRunner(this.llm, { cwd: context.cwd, activity,
      ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
      ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
      onUsage: usage => { reports.push(usage); },
      onProgress: value => { progress[value.executionId] = value; this.changed(); },
    });
    // Core options and graph validation happen synchronously before publishing a handle.
    const run = startBraid(structuredClone(input), {
      cwd: context.cwd, ...options,
      nodeTimeoutMs: options.nodeTimeoutMs ?? Infinity, graphTimeoutMs: options.graphTimeoutMs ?? Infinity,
      ...(context.model ? { defaultModel: context.model } : {}),
      runner: Object.assign(async (request: Parameters<typeof invoke>[0]) => {
        try { await nextTurn(); return await invoke(request); }
        finally { activity.workerFinished(request.execution.executionId); }
      }, { pausable: invoke.pausable === true, interruptible: invoke.interruptible === true }),
      onEvent: event => {
        // Capture what the worker was doing before the interruption changes it.
        if (event.type === "execution_suspending" && event.source === "node_timeout" && event.executionId) {
          const current = activity.get(event.executionId);
          if (current) timeoutActivity.set(event.executionId, formatActivityStatus(current, event.timestamp));
        }
        activity.observe(event);
        events.push(structuredClone(event));
        if (events.length > 80) events.shift();
        this.changed();
        if (event.type === "execution_suspended" && event.source === "node_timeout" && event.executionId) {
          const doing = timeoutActivity.get(event.executionId);
          timeoutActivity.delete(event.executionId);
          this.timedOut(jobId, handle, event, doing);
        }
        this.onEvent(jobId, handle, event);
      },
    });
    const job: Job = { jobId, handle, goal: input.goal, status: "running", createdAt: Date.now(), run, reports, progress, events, activity, done: Promise.resolve() };
    this.nextHandle++;
    this.jobs.set(jobId, job); this.handles.set(handle, jobId);
    job.done = (async () => {
      try {
        job.result = await run.result;
        job.status = job.result.error?.code === "CANCELLED" ? "cancelled" : job.result.status;
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = "failed";
      }
      this.changed();
      this.remind({ jobId, handle, status: job.status });
    })();
    this.changed();
    return this.get(handle);
  }

  private onEvent(jobId: string, handle: string, event: ExecutionEvent): void {
    // A replan request wakes the parent now, while the node keeps working.
    if (event.type === "replan_requested" && event.executionId && !this.disposed) {
      try {
        this.onReplanRequested({ jobId, handle, nodeId: event.nodeId, executionId: event.executionId,
          reason: event.reason, suggested: event.suggestion !== undefined, sequence: event.sequence });
      } catch { /* Notification failures cannot fail jobs. */ }
      return;
    }
    // With nothing active, no later event would wake the parent to resume, update, or cancel.
    if (event.type === "graph_waiting" && !this.disposed) {
      const job = this.jobs.get(jobId);
      const items = job && waitingOn(job.run.snapshot(), event);
      if (items) {
        try { this.onWaiting({ jobId, handle, revision: event.revision ?? 0, waitingOn: items, sequence: event.sequence }); }
        catch { /* Notification failures cannot fail jobs. */ }
      }
      return;
    }
    if (!["execution_paused", "node_completed", "node_failed"].includes(event.type) || !event.executionId) return;
    const state = this.jobs.get(jobId)?.run.snapshot();
    const node = state?.executions[event.executionId];
    if (!node) return;
    const paused = event.type === "execution_paused";
    if (!paused && (!node.node.notifyOnCompletion || (node.holdAfter && !state?.error))) return;
    this.remind({ jobId, handle, status: node.status, executionId: node.executionId, nodeId: node.id, paused, sequence: event.sequence,
      ...(node.replan ? { replanRequested: true } : {}), ...edgeLimit(state!, node) });
  }

  /** A timeout pause always wakes the parent, which must resume or cancel it. */
  private timedOut(jobId: string, handle: string, event: ExecutionEvent & { type: "execution_suspended" }, activity: string | undefined): void {
    const node = this.jobs.get(jobId)?.run.snapshot().executions[event.executionId!];
    const timeout = node?.suspension?.timeout;
    if (this.disposed || !node || !timeout) return;
    try {
      this.onTimeoutPause({ jobId, handle, nodeId: node.id, executionId: node.executionId,
        nodeTimeoutMs: timeout.nodeTimeoutMs, activeMs: timeout.activeMs, ...(activity ? { activity } : {}), sequence: event.sequence });
    } catch { /* Notification failures cannot fail jobs. */ }
  }

  private remind(completion: Completion): void {
    if (this.disposed) return;
    try { this.notify(completion); } catch { /* Notification failures cannot fail jobs. */ }
  }

  private lookup(id: string): Job {
    const job = this.jobs.get(this.handles.get(id) ?? id);
    if (!job) throw new Error(`Unknown Braid job: ${id}. Use an exact session handle or UUID. Available jobs: ${JSON.stringify(this.list())}`);
    return job;
  }

  get(id: string): JobSnapshot {
    const { run, done: _done, reports, activity: _activity, ...job } = this.lookup(id);
    return structuredClone({ ...job, execution: run.snapshot(), usage: sumUsage(reports) });
  }

  getNode(id: string, nodeId?: string, executionId?: string): NodeResult {
    const state = this.lookup(id).run.snapshot();
    const selected = executionId ? state.executions : state.nodes;
    const key = executionId ?? nodeId;
    const node = key && Object.hasOwn(selected, key) ? selected[key] : undefined;
    if (!node || (nodeId && node.id !== nodeId)) throw new Error("Unknown Braid node or execution; inspect braid_status with only jobId");
    return structuredClone(node);
  }

  /** Live activity for one exact execution; undefined until it is first observed. */
  getActivity(id: string, executionId: string, page?: ExecutionActivityPage): ExecutionActivity | undefined {
    return this.lookup(id).activity.get(executionId, page);
  }

  list() {
    return [...this.jobs.values()].reverse().map(({ jobId, handle, goal, status, createdAt }) => ({ jobId, handle, goal, status, createdAt }));
  }

  update(id: string, patch: GraphUpdate): JobSnapshot {
    this.lookup(id).run.update(patch); this.changed(); return this.get(id);
  }

  /** Release held executions or resume paused ones. */
  resume(id: string, executionIds: readonly string[], expectedRevision: number, source = "agent", options?: ResumeOptions): JobSnapshot {
    const job = this.lookup(id);
    job.run.resume(executionIds, expectedRevision, options);
    this.control(job, "resumed", source, executionIds);
    this.changed(); return this.get(id);
  }

  /** Pause running executions at their next model request, or the whole job when executionIds is omitted. */
  pause(id: string, executionIds: readonly string[] | undefined, source: string): JobSnapshot {
    const job = this.lookup(id);
    if (job.status !== "running") throw new Error("This run is no longer accepting updates");
    if (executionIds) job.run.pause(executionIds, { source });
    else job.run.pauseRun({ source });
    this.control(job, "paused", source, executionIds);
    this.changed(); return this.get(id);
  }

  /** Hold running executions' results once they finish (hold = true), or remove that hold, without suspending them. */
  holdAfter(id: string, executionIds: readonly string[], hold: boolean, source: string): JobSnapshot {
    const job = this.lookup(id);
    if (job.status !== "running") throw new Error("This run is no longer accepting updates");
    job.run.holdAfter(executionIds, hold, { source });
    this.control(job, hold ? "held" : "unheld", source, executionIds);
    this.changed(); return this.get(id);
  }

  /** Admit work again and resume the executions the job pause paused. */
  resumeJob(id: string, source = "agent", limits?: BraidLimits): JobSnapshot {
    const job = this.lookup(id);
    if (limits) job.run.setLimits(limits);
    job.run.resumeRun();
    this.control(job, "resumed", source);
    this.changed(); return this.get(id);
  }

  cancel(id: string): boolean {
    const job = this.lookup(id);
    if (job.status !== "running") return false;
    job.run.cancel(); return true;
  }

  /** Fail running or paused executions only; their successors follow the usual failure semantics. */
  cancelExecutions(id: string, executionIds: readonly string[], source: string): JobSnapshot {
    const job = this.lookup(id);
    if (job.status !== "running") throw new Error("This run is no longer accepting updates");
    job.run.cancelExecutions(executionIds, { source });
    this.control(job, "cancelled", source, executionIds);
    this.changed(); return this.get(id);
  }

  async wait(id: string): Promise<void> { await this.lookup(id).done; }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    for (const job of this.jobs.values()) job.run.cancel();
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
