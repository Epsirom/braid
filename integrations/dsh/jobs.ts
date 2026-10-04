import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { startBraid, validateGraph, type BraidInput, type BraidRun, type BraidResult, type BraidSnapshot, type GraphUpdate, type ExecutionEvent, type NodeResult } from "@chrok/braid";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import { createDshRunner, sumUsage, validateBudgets, type NodeProgress, type DshLlm } from "./runner.js";

export interface JobOptions {
  maxConcurrency?: number;
  maxExecutions?: number;
  nodeTimeoutMs?: number;
  graphTimeoutMs?: number;
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
}

export interface Completion {
  jobId: string;
  handle: string;
  status: string;
  executionId?: string;
  nodeId?: string;
  iteration?: number;
  paused?: boolean;
  sequence?: number;
}

/** One manager per live DSH agent; foreground cancellation never owns these runs. */
export class BraidJobs {
  private jobs = new Map<string, Job>();
  private handles = new Map<string, string>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private nextHandle = 1;

  constructor(private llm: DshLlm, private notify: (completion: Completion) => void = () => {}) {}

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
    const invoke = createDshRunner(this.llm, { cwd: context.cwd,
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
      runner: async request => { await nextTurn(); return invoke(request); },
      onEvent: event => {
        events.push(structuredClone(event));
        if (events.length > 80) events.shift();
        this.changed();
        this.onEvent(jobId, handle, event);
      },
    });
    const job: Job = { jobId, handle, goal: input.goal, status: "running", createdAt: Date.now(), run, reports, progress, events, done: Promise.resolve() };
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
    if (!["execution_paused", "node_completed", "node_failed"].includes(event.type) || !event.executionId) return;
    const state = this.jobs.get(jobId)?.run.snapshot();
    const node = state?.executions[event.executionId];
    if (!node) return;
    const paused = event.type === "execution_paused";
    if (!paused && (!node.node.notifyOnCompletion || (node.node.pauseAfter && !state?.error))) return;
    this.remind({ jobId, handle, status: node.status, executionId: node.executionId, nodeId: node.id,
      ...(node.iteration === undefined ? {} : { iteration: node.iteration }), paused, sequence: event.sequence });
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
    const { run, done: _done, reports, ...job } = this.lookup(id);
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

  list() {
    return [...this.jobs.values()].reverse().map(({ jobId, handle, goal, status, createdAt }) => ({ jobId, handle, goal, status, createdAt }));
  }

  update(id: string, patch: GraphUpdate): JobSnapshot {
    this.lookup(id).run.update(patch); this.changed(); return this.get(id);
  }

  resume(id: string, executionIds: readonly string[], expectedRevision: number): JobSnapshot {
    this.lookup(id).run.resume(executionIds, expectedRevision); this.changed(); return this.get(id);
  }

  cancel(id: string): boolean {
    const job = this.lookup(id);
    if (job.status !== "running") return false;
    job.run.cancel(); return true;
  }

  async wait(id: string): Promise<void> { await this.lookup(id).done; }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    for (const job of this.jobs.values()) job.run.cancel();
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
