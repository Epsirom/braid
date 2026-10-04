import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import type { BraidJobs, JobSnapshot } from "./jobs.js";
import { PANEL_PACKAGE, panelDescriptors } from "./panel-contract.js";
import type { ControlRequest, DetailRequest, PanelDetail, PanelFrame, PanelJob, PanelRequest } from "./panel-types.js";

const clip = (text: string, limit = 2000) => text.length > limit ? text.slice(0, limit) + "…" : text;
export function panelJob(job: JobSnapshot): PanelJob {
  const state = job.execution;
  return {
    jobId: job.jobId, handle: job.handle, goal: clip(job.goal), status: job.status, createdAt: job.createdAt,
    revision: state.revision, phase: state.status,
    ...(job.error || state.error ? { error: clip(job.error ?? state.error!.message) } : {}),
    nodes: state.graph.nodes.map(node => ({ id: node.id, type: node.type, status: state.nodes[node.id]?.status ?? "pending" })),
    edges: state.graph.edges.map(edge => ({ ...edge })), loops: [...state.graph.loops ?? []],
    executions: Object.values(state.executions).map(e => ({
      id: e.id, executionId: e.executionId, status: e.status, type: e.node.type, revision: e.revision,
      ...(e.iteration === undefined ? {} : { iteration: e.iteration }),
      ...(e.loopId === undefined ? {} : { loopId: e.loopId }),
      ...(e.latencyMs === undefined ? {} : { latencyMs: e.latencyMs }),
      ...(job.progress[e.executionId] ? { progress: job.progress[e.executionId]! } : {}),
    })),
    pausedExecutionIds: [...state.pausedExecutionIds],
    usage: { inputTokens: job.usage.inputTokens ?? 0, outputTokens: job.usage.outputTokens ?? 0,
      cacheReadTokens: job.usage.cacheReadTokens ?? 0, cacheWriteTokens: job.usage.cacheWriteTokens ?? 0 },
    events: job.events.map(e => ({ sequence: e.sequence, timestamp: e.timestamp, type: e.type,
      ...(e.executionId ? { executionId: e.executionId } : {}), ...("nodeId" in e ? { nodeId: e.nodeId } : {}),
      message: clip("error" in e ? e.error.message : e.type === "handoff" ? `${e.from} → ${e.to}` : e.type === "edge_created" ? `${e.from} → ${e.to}` : e.type.replaceAll("_", " "), 500),
    })),
  };
}

/** Session managers are borrowed; viewing a panel never creates an Agent or starts model work. */
export class BraidPanel extends TypertRemoteService {
  constructor(ctx: Context, private readonly find: (sessionId: string) => BraidJobs | undefined,
    private readonly subscribe: (listener: () => void) => () => void) {
    super(ctx, "braidPanel");
    ctx.typert.register({ package: PANEL_PACKAGE, face: "host", schemas: [], model: { services: [], events: [], objects: [] }, invocations: panelDescriptors });
  }
  snapshot(request: PanelRequest): PanelFrame {
    const jobs = this.find(request.sessionId);
    const rows = jobs?.list().map(row => ({ ...row, goal: clip(row.goal) })) ?? [];
    // Old tool cards can carry short handles. Fence them by the call's timestamp
    // so a Host/plugin restart cannot redirect an old card to a reused handle.
    const selected = request.jobId ? rows.find(row => (row.jobId === request.jobId || row.handle === request.jobId)
      && (request.createdBefore === undefined || row.createdAt <= request.createdBefore)) : rows[0];
    if (request.jobId && !selected) throw new Error("Braid job is no longer available in this session");
    const id = selected?.jobId;
    return { rows, job: id && jobs ? panelJob(jobs.get(id)) : null };
  }
  @Remote({ mode: "stream" })
  async *watch(request: PanelRequest, signal: AbortSignal): AsyncIterable<PanelFrame> {
    let dirty = true, wake: (() => void) | undefined;
    const changed = () => { dirty = true; wake?.(); };
    const off = this.subscribe(changed);
    signal.addEventListener("abort", changed, { once: true });
    try {
      while (!signal.aborted) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        if (signal.aborted) break;
        dirty = false;
        try { yield this.snapshot(request); }
        catch (error) { throw this.failure(request, error); }
        // Coalesce token bursts; cancellation also wakes this delay.
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 150);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally { off(); signal.removeEventListener("abort", changed); }
  }
  @Remote
  control(request: ControlRequest): PanelFrame {
    try {
      this.snapshot(request);
      const jobs = this.find(request.sessionId)!;
      if (request.action === "resume") jobs.resume(request.jobId, request.executionIds, request.revision);
      else jobs.cancel(request.jobId);
      return this.snapshot(request);
    } catch (error) { throw this.failure(request, error); }
  }
  @Remote
  detail(request: DetailRequest): PanelDetail {
    try {
      this.snapshot(request);
      const node = this.find(request.sessionId)!.getNode(request.jobId, undefined, request.executionId);
      const output = node.output ?? "";
      const offset = Math.min(request.offset, output.length), next = Math.min(offset + 32768, output.length);
      return { executionId: request.executionId, status: node.status, output: output.slice(offset, next), offset, next, total: output.length,
        ...(node.decision === undefined ? {} : { decision: clip(node.decision) }),
        ...(node.error ? { error: clip(node.error.message) } : {}),
        ...(node.workspace ? { workspace: clip(JSON.stringify(node.workspace, null, 2), 8000) } : {}),
      };
    } catch (error) { throw this.failure(request, error); }
  }
  private failure(request: PanelRequest, error: unknown) {
    return new RemoteError("braid/panel", error instanceof Error ? error.message : String(error), { sessionId: request.sessionId });
  }
}
