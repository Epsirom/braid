import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Usage } from "@earendil-works/pi-ai";
import {
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ExecutionActivityTracker,
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
} from "@chrok/braid";
import {
  applyEvent,
  applyProgress,
  createLiveState,
  type BraidLiveState,
} from "./display.js";
import { createPiRunner, sumPiUsage } from "./runner.js";
import { PiTranscripts, type PiTranscript } from "./transcript.js";

export interface JobOptions {
  maxConcurrency?: number;
  maxExecutions?: number;
  nodeTimeoutMs?: number;
  graphTimeoutMs?: number;
  maxToolRounds?: number;
  maxToolCalls?: number;
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
  fullOutputPath?: string;
  usage?: Usage;
  /** Core workspace lifecycle, including recovery refs for failed and cancelled nodes. */
  workspaces?: Record<string, PiNodeWorkspace>;
}

interface Job extends JobSnapshot {
  run?: BraidRun;
  controller: AbortController;
  done: Promise<void>;
  usageClaimed: boolean;
  nodeResults: Map<string, NodeResult>;
  runningExecutions: Map<string, string>;
  /** Kept outside snapshots: histories are read one execution at a time. */
  activity: ExecutionActivityTracker;
  transcripts: PiTranscripts;
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

/** Jobs belong to one extension/session lifetime, independently of foreground turns. */
export class BraidJobs {
  private jobs = new Map<string, Job>();
  private handles = new Map<string, string>();
  private nextHandle = 1;
  private listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly onFinished: (job: JobSnapshot) => void = () => {},
    private readonly onNodeFinished: (completion: NodeCompletion) => void = () => {},
  ) {}

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
  ): JobSnapshot {
    if (this.disposed) throw new Error("Braid session has closed");
    validateGraph(input);
    const snapshot = structuredClone(input);
    const settings = { ...options };
    const model = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined;
    const registry = ctx.modelRegistry;
    const cwd = ctx.cwd;
    const job: Job = {
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
      activity: new ExecutionActivityTracker({ onChange: () => this.changed() }),
      transcripts: new PiTranscripts(() => this.changed()),
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
      // Return the submission to Pi before doing provider work or sending reminders.
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
            maxToolRounds: options.maxToolRounds ?? Infinity,
            maxToolCalls: options.maxToolCalls ?? Infinity,
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
          return async request => {
            try {
              await nextTurn();
              return await invoke(request);
            } finally {
              job.activity.workerFinished(request.execution.executionId);
              job.transcripts.finish(request.execution.executionId,
                request.signal.aborted ? "Execution was stopped before this step finished" : undefined);
            }
          };
        })(),
        onEvent: (event) => {
          job.activity.observe(event);
          if (event.type === "workspace_updated") {
            job.workspaces ??= {};
            Object.defineProperty(job.workspaces, event.workspace.executionId ?? event.workspace.nodeId, {
              value: { ...event.workspace }, enumerable: true, configurable: true, writable: true,
            });
          }
          // Definition edits can remove nodes whose executions are still running.
          if (event.type === "node_started" && event.executionId) {
            job.runningExecutions.set(event.executionId, event.nodeId);
          } else if ((event.type === "node_completed" || event.type === "node_failed") && event.executionId) {
            job.runningExecutions.delete(event.executionId);
          } else if (event.type === "graph_completed" || event.type === "graph_failed") {
            job.runningExecutions.clear();
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
          const terminal = event.type === "execution_paused" || event.type === "node_completed" || event.type === "node_failed";
          const state = terminal ? job.run?.snapshot() : undefined;
          const instance = event.executionId ? state?.executions[event.executionId] : undefined;
          const shouldNotify = event.type === "execution_paused" ||
            ((event.type === "node_completed" || event.type === "node_failed") && instance?.node.notifyOnCompletion &&
              (!instance.node.pauseAfter || state?.error));
          if (!this.disposed && shouldNotify && "nodeId" in event && instance) {
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
      // Core metadata counts usage returned by runners; Pi also records completed
      // provider rounds from workers that later fail or time out.
      const full = JSON.stringify({ ...job.result, workspaces: job.workspaces, piUsage: job.usage }, null, 2);
      const preview = JSON.stringify(
        { ...this.get(job.jobId), status },
        null,
        2,
      );
      if (truncateHead(preview).truncated) {
        const directory = await mkdtemp(join(tmpdir(), "braid-result-"));
        const path = join(directory, "result.json");
        await writeFile(path, full, { mode: 0o600 });
        job.fullOutputPath = path;
      }
      job.status = status;
    } catch (error) {
      job.status = "failed";
      job.live.status = "failed";
      job.live.pausedExecutionIds = [];
      job.runningExecutions.clear();
      job.error = error instanceof Error ? error.message : String(error);
      if (reports.length) job.usage = sumPiUsage(reports);
    }
    this.changed();
    if (!this.disposed) {
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
      run: _run,
      controller: _controller,
      done: _done,
      usageClaimed: _claimed,
      nodeResults: _nodeResults,
      runningExecutions: _runningExecutions,
      activity: _activity,
      transcripts: _transcripts,
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

  update(jobId: string, patch: GraphUpdate): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run) throw new Error("Job is not accepting updates");
    job.run.update(patch);
    this.changed();
    return this.get(jobId)!;
  }

  resume(jobId: string, executionIds: readonly string[], expectedRevision: number): JobSnapshot {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (!job.run) throw new Error("Job is not accepting updates");
    job.run.resume(executionIds, expectedRevision);
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
      paused: job.live.pausedExecutionIds?.length ?? 0,
    };
  }

  cancel(jobId: string): boolean {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    if (job.status !== "running") return false;
    job.controller.abort();
    return true;
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
    this.listeners.clear();
  }
}
