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
  braid,
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

export interface JobOptions {
  maxConcurrency?: number;
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
  error?: string;
  fullOutputPath?: string;
  usage?: Usage;
  /** Core workspace lifecycle, including recovery refs for failed and cancelled nodes. */
  workspaces?: Record<string, PiNodeWorkspace>;
}

interface Job extends JobSnapshot {
  controller: AbortController;
  done: Promise<void>;
  usageClaimed: boolean;
  nodeResults: Map<string, NodeResult>;
}

export interface NodeCompletion {
  jobId: string;
  handle: string;
  nodeId: string;
  status: "completed" | "failed";
  /** Identifies the terminal event within this job; nodes currently execute once. */
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
    const notifyNodes = new Set(input.nodes.filter((node) => node.notifyOnCompletion).map((node) => node.id));
    try {
      // Return the submission to Pi before doing provider work or sending reminders.
      await nextTurn();
      job.result = await braid(input, {
        ...options,
        cwd,
        nodeTimeoutMs: options.nodeTimeoutMs ?? Infinity,
        graphTimeoutMs: options.graphTimeoutMs ?? Infinity,
        signal: job.controller.signal,
        ...(model ? { defaultModel: model } : {}),
        runner: createPiRunner(registry, {
          cwd,
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
        }),
        onEvent: (event) => {
          if (event.type === "workspace_updated") {
            job.workspaces ??= {};
            Object.defineProperty(job.workspaces, event.workspace.nodeId, {
              value: { ...event.workspace }, enumerable: true, configurable: true, writable: true,
            });
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
          if (!this.disposed && (event.type === "node_completed" || event.type === "node_failed") &&
              notifyNodes.has(event.nodeId)) {
            try {
              void Promise.resolve(this.onNodeFinished({
                jobId: job.jobId,
                handle: job.handle,
                nodeId: event.nodeId,
                status: event.type === "node_completed" ? "completed" : "failed",
                eventSequence: event.sequence,
                ...(event.type === "node_failed" ? { errorCode: event.error.code } : {}),
              })).catch(() => {});
            } catch {
              /* Notification failures must not affect scheduling or results. */
            }
          }
        },
      });
      if (reports.length) job.usage = sumPiUsage(reports);
      job.live.observedAt = job.result.metadata.finishedAt;
      job.live.latencyMs = job.result.metadata.latencyMs;
      const status =
        job.result.error?.code === "CANCELLED"
          ? "cancelled"
          : job.result.status;
      const full = JSON.stringify({ ...job.result, workspaces: job.workspaces }, null, 2);
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
      controller: _controller,
      done: _done,
      usageClaimed: _claimed,
      nodeResults: _nodeResults,
      ...snapshot
    } = job;
    const copy = structuredClone(snapshot);
    if (job.status === "running") {
      copy.live.observedAt = Date.now();
      copy.live.latencyMs = copy.live.observedAt - job.createdAt;
    }
    return copy;
  }

  getNode(jobId: string, nodeId: string): NodeResult {
    const job = this.lookup(jobId);
    if (!job) throw this.unknownJob(jobId);
    const node = job.result && Object.hasOwn(job.result.nodes, nodeId)
      ? job.result.nodes[nodeId] : job.nodeResults.get(nodeId);
    if (!node) throw new Error(`Unknown Braid node: ${JSON.stringify(nodeId)} in ${job.handle}. Use braid_status with only jobId to list nodes.`);
    return structuredClone({
      ...node,
      ...(job.workspaces && Object.hasOwn(job.workspaces, nodeId)
        ? { workspace: job.workspaces[nodeId] } : {}),
    });
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
