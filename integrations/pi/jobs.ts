import { setImmediate as nextTurn } from "node:timers/promises";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ExecutionActivityTracker,
  formatActivityStatus,
  startBraid,
  type BraidRun,
  type ExecutionActivity,
  type ExecutionActivityPage,
  type BraidSnapshot,
  type GraphUpdate,
  validateGraph,
  type BraidInput,
  type BraidResult,
  type ExecutionError,
  type NodeResult,
  type NodeWorkspace as PiNodeWorkspace,
  type ResumeOptions,
} from "@chrok/braid";
import {
  applyEvent,
  applyProgress,
  createLiveState,
  type BraidLiveState,
} from "./display.js";
import { createPiRunner, sumPiUsage } from "./runner.js";
import { PiTranscripts, type PiTranscript } from "./transcript.js";
import { PiHumanInputs, type PiPendingInput } from "./human-input.js";
import { BraidAssistant } from "./assistant.js";

export interface JobOptions {
  maxConcurrency?: number;
  maxExecutions?: number;
  nodeTimeoutMs?: number;
  graphTimeoutMs?: number;
  /** Default "pause": a node timeout suspends the execution and wakes the parent. */
  onNodeTimeout?: "pause" | "fail";
  maxToolRounds?: number;
  maxToolCalls?: number;
  maxModelRetries?: number;
}

export interface JobSnapshot {
  /** Short exact alias scoped to this session. UUID jobId remains supported. */
  handle: string;
  jobId: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  live: BraidLiveState;
  result?: BraidResult;
  execution?: BraidSnapshot;
  error?: string;
  usage?: Usage;
  /** Core workspace lifecycle, including recovery refs for failed and cancelled nodes. */
  workspaces?: Record<string, PiNodeWorkspace>;
}

interface Job extends JobSnapshot {
  blocking: boolean;
  run?: BraidRun;
  controller: AbortController;
  done: Promise<void>;
  usageClaimed: boolean;
  nodeResults: Map<string, NodeResult>;
  runningExecutions: Map<string, string>;
  suspendedExecutions: Map<string, string>;
  /** What each execution was doing when its node timeout fired, for the reminder. */
  timeoutActivity: Map<string, string>;
  /** Kept outside snapshots: histories are read one execution at a time. */
  activity: ExecutionActivityTracker;
  transcripts: PiTranscripts;
  humanInputs: PiHumanInputs;
}

export interface NodeCompletion {
  jobId: string;
  handle: string;
  nodeId: string;
  executionId: string;
  paused?: boolean;
  iteration?: number;
  status: "completed" | "failed";
  /** Identifies this execution event within the job. */
  eventSequence: number;
  errorCode?: ExecutionError["code"];
}

/** An execution the node timeout paused; the parent decides what happens next. */
export interface TimeoutPause {
  jobId: string;
  handle: string;
  nodeId: string;
  executionId: string;
  iteration?: number;
  /** The node time budget that ran out. */
  nodeTimeoutMs: number;
  /** Time the execution ran, excluding earlier suspensions. */
  activeMs: number;
  /** Observed activity when the timeout fired. */
  activity?: string;
  /** Identifies this pause within the job; a later timeout of the same execution is a new one. */
  eventSequence: number;
}

/** A pause, resume, hold change, or cancellation someone other than the parent agent made, such as the user in /braid. */
export interface ControlNotice {
  jobId: string;
  handle: string;
  /** held/unheld: a hold on running executions' results was added or removed. */
  action: "paused" | "resumed" | "held" | "unheld" | "cancelled";
  /** Omitted for the whole job. */
  executions?: { executionId: string; nodeId: string }[];
  source: string;
}

export interface OutstandingJob {
  jobId: string;
  handle: string;
  stalled: boolean;
  revision?: number;
  pausedExecutionIds: string[];
  suspendedExecutionIds: string[];
  /** Suspended executions their node timeout paused; they wait for the parent. */
  timedOutExecutionIds?: string[];
  /** The whole job is paused and admits no new executions. */
  paused?: boolean;
}

function timedOut(state: BraidSnapshot | undefined): Pick<OutstandingJob, "timedOutExecutionIds"> {
  const ids = (state?.suspendedExecutionIds ?? []).filter(id => state!.executions[id]?.suspension?.source === "node_timeout");
  return ids.length ? { timedOutExecutionIds: ids } : {};
}

/** Jobs belong to one extension/session lifetime, independently of foreground turns. */
export class BraidJobs {
  private jobs = new Map<string, Job>();
  private assistants = new Map<string, BraidAssistant>();
  private cwd = process.cwd();
  private handles = new Map<string, string>();
  private nextHandle = 1;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly onFinished: (job: JobSnapshot) => void = () => {},
    private readonly onNodeFinished: (completion: NodeCompletion) => void = () => {},
    private readonly onControl: (notice: ControlNotice) => void = () => {},
    private readonly onTimeoutPause: (pause: TimeoutPause) => void = () => {},
  ) {}

  /** The parent made the change itself; anyone else's change becomes a notice for it. */
  private notify(job: Job, action: ControlNotice["action"], source: string, executionIds?: readonly string[]): void {
    if (source === "agent" || this.disposed) return;
    const state = job.run?.snapshot();
    try {
      this.onControl({
        jobId: job.jobId, handle: job.handle, action, source,
        ...(executionIds ? { executions: executionIds.map(executionId => ({ executionId, nodeId: state?.executions[executionId]?.id ?? "?" })) } : {}),
      });
    } catch { /* Notices are advisory. */ }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* UI observers cannot fail a job. */
      }
    }
  }

  start(
    input: BraidInput,
    options: JobOptions,
    ctx: ExtensionContext,
    blocking = false,
  ): JobSnapshot {
    if (this.disposed) throw new Error("Braid session has closed");
    validateGraph(input);
    if (blocking && input.nodes.some(node => node.pauseAfter))
      throw new Error("Blocking Braid jobs cannot use pauseAfter; remove it or start Pi without --braid-blocking.");
    // Nothing can resume a blocking job's timeout pause while the foreground call waits for it.
    if (blocking && options.onNodeTimeout === "pause")
      throw new Error('Blocking Braid jobs cannot use onNodeTimeout "pause"; remove it or start Pi without --braid-blocking.');
    const snapshot = structuredClone(input);
    const settings = { ...options, ...(blocking ? { onNodeTimeout: "fail" as const } : {}) };
    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const registry = ctx.modelRegistry;
    const cwd = ctx.cwd;
    this.cwd = cwd;
    const job: Job = {
      blocking,
      handle: `job-${this.nextHandle++}`,
      jobId: crypto.randomUUID(),
      goal: snapshot.goal,
      status: "running",
      createdAt: Date.now(),
      live: createLiveState(),
      controller: new AbortController(),
      done: Promise.resolve(),
      usageClaimed: false,
      runningExecutions: new Map(),
      suspendedExecutions: new Map(),
      timeoutActivity: new Map(),
      activity: new ExecutionActivityTracker({ onChange: () => this.changed() }),
      transcripts: new PiTranscripts(() => this.changed()),
      humanInputs: new PiHumanInputs(() => this.changed()),
      nodeResults: new Map(snapshot.nodes.map((node) => [node.id, { id: node.id, status: "pending" }])),
    };
    this.jobs.set(job.jobId, job);
    this.handles.set(job.handle, job.jobId);
    job.done = this.run(job, snapshot, settings, registry, cwd, model);
    this.changed();
    return this.get(job.jobId)!;
  }

  private async run(
    job: Job,
    input: BraidInput,
    options: JobOptions,
    registry: ExtensionContext["modelRegistry"],
    cwd: string,
    model?: string,
  ): Promise<void> {
    const reports: Usage[] = [];
    try {
      // Defer provider work until the job handle has been published.
      job.run = startBraid(input, {
        ...options,
        cwd,
        nodeTimeoutMs: options.nodeTimeoutMs ?? Infinity,
        graphTimeoutMs: options.graphTimeoutMs ?? Infinity,
        signal: job.controller.signal,
        ...(model ? { defaultModel: model } : {}),
        runner: (() => {
          const invoke = createPiRunner(registry, {
            cwd,
            activity: job.activity,
            transcripts: job.transcripts,
            humanInputs: job.humanInputs,
            maxToolRounds: options.maxToolRounds ?? Infinity,
            maxToolCalls: options.maxToolCalls ?? Infinity,
            ...(options.maxModelRetries === undefined ? {} : { maxModelRetries: options.maxModelRetries }),
            onUsage: (usage) => {
              if (job.status === "running" && !job.controller.signal.aborted)
                reports.push(usage);
            },
            onProgress: (progress) => {
              if (job.status !== "running" || job.controller.signal.aborted)
                return;
              applyProgress(job.live, progress);
              this.changed();
            },
          });
          return Object.assign(async (request: Parameters<typeof invoke>[0]) => {
            try {
              await nextTurn();
              return await invoke(request);
            } finally {
              job.activity.workerFinished(request.execution.executionId);
              const executionId = request.execution.executionId;
              if (executionId !== undefined) {
                job.transcripts.human(executionId, job.humanInputs.close(executionId).map(input => input.text), false);
              }
              job.transcripts.finish(request.execution.executionId,
                request.signal.aborted ? "Execution was stopped before this step finished" : undefined);
            }
          }, { pausable: invoke.pausable === true, interruptible: invoke.interruptible === true });
        })(),
        onEvent: (event) => {
          // Capture what the worker was doing before the interruption changes it.
          if (event.type === "execution_suspending" && event.source === "node_timeout" && event.executionId) {
            const activity = job.activity.get(event.executionId);
            if (activity) job.timeoutActivity.set(event.executionId, formatActivityStatus(activity, event.timestamp));
          }
          job.activity.observe(event);
          if (event.type === "workspace_updated") {
            job.workspaces ??= {};
            Object.defineProperty(job.workspaces, event.workspace.executionId ?? event.workspace.nodeId, {
              value: { ...event.workspace }, enumerable: true, configurable: true, writable: true,
            });
          }
          // Definition edits can remove nodes whose executions are still running.
          // A suspended execution is not running: drain can then see a stalled job.
          if (event.type === "node_started" && event.executionId) {
            job.runningExecutions.set(event.executionId, event.nodeId);
          } else if (event.type === "execution_suspended" && event.executionId) {
            job.runningExecutions.delete(event.executionId);
            job.suspendedExecutions.set(event.executionId, event.nodeId);
          } else if (event.type === "execution_resumed" && event.executionId && job.suspendedExecutions.has(event.executionId)) {
            job.runningExecutions.set(event.executionId, event.nodeId);
            job.suspendedExecutions.delete(event.executionId);
          } else if ((event.type === "node_completed" || event.type === "node_failed") && event.executionId) {
            job.runningExecutions.delete(event.executionId);
            job.suspendedExecutions.delete(event.executionId);
          } else if (event.type === "graph_completed" || event.type === "graph_failed") {
            job.runningExecutions.clear();
            job.suspendedExecutions.clear();
          }
          applyEvent(job.live, event);
          if ("nodeId" in event && Object.hasOwn(job.live.nodes, event.nodeId)) {
            // The panel keeps short previews; node retrieval needs the complete
            // output/error before the rest of the graph finishes.
            job.nodeResults.set(event.nodeId, {
              ...job.live.nodes[event.nodeId]!,
              ...("output" in event ? { output: event.output } : {}),
              ...(event.type === "node_failed" ? { error: { ...event.error } } : {}),
            });
          }
          this.changed();
          if (event.type === "execution_suspended" && event.source === "node_timeout" && event.executionId) {
            const instance = job.run?.snapshot().executions[event.executionId];
            const timeout = instance?.suspension?.timeout;
            const activity = job.timeoutActivity.get(event.executionId);
            job.timeoutActivity.delete(event.executionId);
            // A timeout pause always wakes the parent, which must resume or cancel it.
            if (!this.disposed && instance && timeout) {
              try {
                void Promise.resolve(this.onTimeoutPause({
                  jobId: job.jobId, handle: job.handle, nodeId: event.nodeId, executionId: event.executionId,
                  ...(instance.iteration ? { iteration: instance.iteration } : {}),
                  nodeTimeoutMs: timeout.nodeTimeoutMs, activeMs: timeout.activeMs,
                  ...(activity ? { activity } : {}), eventSequence: event.sequence,
                })).catch(() => {});
              } catch { /* Notification failures must not affect scheduling. */ }
            }
          }
          const terminal = event.type === "execution_paused" || event.type === "node_completed" || event.type === "node_failed";
          const state = terminal ? job.run?.snapshot() : undefined;
          const instance = event.executionId ? state?.executions[event.executionId] : undefined;
          const shouldNotify = event.type === "execution_paused" ||
            ((event.type === "node_completed" || event.type === "node_failed") && instance?.node.notifyOnCompletion &&
              (!instance.holdAfter || state?.error));
          if (!this.disposed && !job.blocking && shouldNotify && "nodeId" in event && instance) {
            try {
              void Promise.resolve(this.onNodeFinished({
                jobId: job.jobId,
                handle: job.handle,
                nodeId: event.nodeId,
                executionId: instance.executionId,
                ...(event.type === "execution_paused" ? { paused: true } : {}),
                ...(instance.iteration ? { iteration: instance.iteration } : {}),
                status: instance.status === "completed" ? "completed" : "failed",
                eventSequence: event.sequence,
                ...(instance.error ? { errorCode: instance.error.code } : {}),
              })).catch(() => {});
            } catch {
              /* Notification failures must not affect scheduling or results. */
            }
          }
        },
      });
      job.result = await job.run.result;
      if (reports.length) job.usage = sumPiUsage(reports);
      job.live.observedAt = job.result.metadata.finishedAt;
      job.live.latencyMs = job.result.metadata.latencyMs;
      const status =
        job.result.error?.code === "CANCELLED"
          ? "cancelled"
          : job.result.status;
      job.status = status;
    } catch (error) {
      job.status = "failed";
      job.live.status = "failed";
      job.live.pausedExecutionIds = [];
      job.runningExecutions.clear();
      job.suspendedExecutions.clear();
      job.error = error instanceof Error ? error.message : String(error);
      if (reports.length) job.usage = sumPiUsage(reports);
    }
    this.changed();
    if (!this.disposed && (!job.blocking || job.status === "cancelled")) {
      try {
        this.onFinished(this.get(job.jobId)!);
      } catch {
        /* Result remains retrievable. */
      }
    }
  }

  private lookup(jobId: string): Job | undefined {
    return this.jobs.get(this.handles.get(jobId) ?? jobId);
  }

  unknownJob(jobId: string): Error {
    const available = this.list().slice(0, 8).map(job => ({ jobId: job.handle, status: job.status }));
    return new Error(`Unknown Braid job: ${jobId}. Exact session handles or UUIDs are required; IDs are never guessed. Available jobs: ${JSON.stringify(available)}. Omit jobId in braid_status to list all session jobs.`);
  }

  get(jobId: string): JobSnapshot | undefined {
    const job = this.lookup(jobId);
    if (!job) return undefined;
    const {
      blocking: _blocking,
      run: _run,
      controller: _controller,
      done: _done,
      usageClaimed: _claimed,
      nodeResults: _nodeResults,
      runningExecutions: _runningExecutions,
      suspendedExecutions: _suspendedExecutions,
      activity: _activity,
      transcripts: _transcripts,
      humanInputs: _humanInputs,
      ...snapshot
    } = job;
    const copy = structuredClone(snapshot);
    if (job.run) copy.execution = job.run.snapshot();
    if (job.status === "running") {
      copy.live.observedAt = Date.now();
      copy.live.latencyMs = copy.live.observedAt - job.createdAt;
    }
    return copy;
  }

  getNode(jobId: string, nodeId?: string, executionId?: string): NodeResult {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    const state = job.result ?? job.run?.snapshot();
    const node = executionId
      ? state && Object.hasOwn(state.executions, executionId) ? state.executions[executionId] : undefined
      : nodeId ? (state && Object.hasOwn(state.nodes, nodeId) ? state.nodes[nodeId] : undefined) ?? job.nodeResults.get(nodeId) : undefined;
    if (!node || (nodeId && node.id !== nodeId)) throw new Error(`Unknown Braid node or execution in ${job.handle}. Use braid_status with only jobId to list executions.`);
    return structuredClone(node);
  }

  /** Live activity for one exact execution; undefined until it is first observed. */
  getActivity(jobId: string, executionId: string, page?: ExecutionActivityPage): ExecutionActivity | undefined {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    return job.activity.get(executionId, page);
  }

  /** The live conversation for one execution; read-only, and absent once evicted. */
  getTranscript(jobId: string, executionId: string): PiTranscript | undefined {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    return job.transcripts.get(executionId);
  }

  /**
   * Queue a human message for one running execution. The worker receives it
   * before its next model request; running tools are not interrupted.
   */
  sendInput(jobId: string, executionId: string, text: string): PiPendingInput {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.transcripts.isLive(executionId)) {
      throw new Error("Messages can be sent only to a running execution whose live session has started");
    }
    return job.humanInputs.send(executionId, text);
  }

  /** Messages waiting for the execution's next model request. */
  pendingInputs(jobId: string, executionId: string): readonly PiPendingInput[] {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    return structuredClone(job.humanInputs.pending(executionId));
  }

  /** The panel's side conversation about a job or one of its nodes, kept for the session. */
  assistant(jobId: string, nodeId?: string): BraidAssistant {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    const key = JSON.stringify([job.jobId, nodeId ?? null]);
    let assistant = this.assistants.get(key);
    if (!assistant) {
      assistant = new BraidAssistant(this, job.jobId, this.cwd, () => this.changed(), nodeId);
      this.assistants.set(key, assistant);
    }
    return assistant;
  }

  update(jobId: string, patch: GraphUpdate): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run) throw new Error("Job is not accepting updates");
    job.run.update(patch);
    this.changed();
    return this.get(jobId)!;
  }

  /** Release held executions or resume paused ones. */
  resume(jobId: string, executionIds: readonly string[], expectedRevision: number, source = "agent", options?: ResumeOptions): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run) throw new Error("Job is not accepting updates");
    job.run.resume(executionIds, expectedRevision, options);
    this.notify(job, "resumed", source, executionIds);
    this.changed();
    return this.get(jobId)!;
  }

  /**
   * Pause running executions at their next model request, or the whole job
   * when executionIds is omitted. source records who asked, e.g. "agent" or "user".
   */
  pause(jobId: string, executionIds: readonly string[] | undefined, source: string): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run || job.status !== "running") throw new Error("Job is not accepting updates");
    if (executionIds) job.run.pause(executionIds, { source });
    else job.run.pauseRun({ source });
    this.notify(job, "paused", source, executionIds);
    this.changed();
    return this.get(jobId)!;
  }

  /**
   * Hold running executions' results once they finish (hold = true), or remove
   * that hold, without suspending them. source records who asked.
   */
  holdAfter(jobId: string, executionIds: readonly string[], hold: boolean, source: string): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run || job.status !== "running") throw new Error("Job is not accepting updates");
    if (job.blocking) throw new Error("Blocking Braid jobs cannot hold results; start Pi without --braid-blocking.");
    job.run.holdAfter(executionIds, hold, { source });
    this.notify(job, hold ? "held" : "unheld", source, executionIds);
    this.changed();
    return this.get(jobId)!;
  }

  /** Admit work again and resume the executions the job pause paused. */
  resumeJob(jobId: string, source = "agent"): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run || job.status !== "running") throw new Error("Job is not accepting updates");
    job.run.resumeRun();
    this.notify(job, "resumed", source);
    this.changed();
    return this.get(jobId)!;
  }

  list(): Pick<JobSnapshot, "jobId" | "handle" | "goal" | "status" | "createdAt">[] {
    return [...this.jobs.values()]
      .map(({ jobId, handle, goal, status, createdAt }) => ({
        jobId,
        handle,
        goal,
        status,
        createdAt,
      }))
      .reverse();
  }

  /**
   * Jobs that have not reached a terminal status. A job is stalled when only
   * held, suspended, or job-paused work remains, so it cannot progress without
   * resume or cancel.
   */
  outstanding(): OutstandingJob[] {
    return [...this.jobs.values()].filter(job => job.status === "running").map(job => {
      // Skip the snapshot copy while executions are visibly running.
      const state = job.runningExecutions.size ? undefined : job.run?.snapshot();
      return {
        jobId: job.jobId,
        handle: job.handle,
        stalled: state?.status === "waiting",
        ...(state ? { revision: state.revision } : {}),
        pausedExecutionIds: state?.pausedExecutionIds ?? [],
        suspendedExecutionIds: state?.suspendedExecutionIds ?? [],
        ...timedOut(state),
        ...(state?.pause ? { paused: true } : {}),
      };
    });
  }

  /** Editor progress without copying outputs, transcripts, or execution snapshots. */
  progress(jobId: string): {
    total: number;
    done: number;
    failed: number;
    running: string[];
    paused: number;
  } | undefined {
    const job = this.lookup(jobId);
    if (!job) return undefined;
    const nodes = Object.values(job.live.nodes);
    return {
      total: nodes.length,
      done: nodes.filter(node =>
        node.status === "completed" || node.status === "failed" || node.status === "skipped",
      ).length,
      failed: nodes.filter(node => node.status === "failed").length,
      running: [...new Set(job.runningExecutions.values())],
      paused: (job.live.pausedExecutionIds?.length ?? 0) + job.suspendedExecutions.size,
    };
  }

  cancel(jobId: string): boolean {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (job.status !== "running") return false;
    job.controller.abort();
    return true;
  }

  /** Fail running or paused executions only; their successors follow the usual failure semantics. */
  cancelExecutions(jobId: string, executionIds: readonly string[], source: string): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run || job.status !== "running") throw new Error("Job is not accepting updates");
    job.run.cancelExecutions(executionIds, { source });
    this.notify(job, "cancelled", source, executionIds);
    this.changed();
    return this.get(jobId)!;
  }

  /** Pi accounts usage only once, on the first retrieval of a terminal result. */
  claimUsage(jobId: string): Usage | undefined {
    const job = this.lookup(jobId);
    if (!job || job.status === "running" || job.usageClaimed || !job.usage)
      return undefined;
    job.usageClaimed = true;
    return structuredClone(job.usage);
  }

  async wait(jobId: string): Promise<void> {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    await job.done;
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    for (const assistant of this.assistants.values()) assistant.dispose();
    this.listeners.clear();
  }
}
