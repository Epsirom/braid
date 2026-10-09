import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { BraidInput, GraphUpdate } from "@chrok/braid";
import { braidParameters, nodeParameters, updateEdgeParameters, loopParameters } from "./schema.js";
import type { BraidJobs, JobSnapshot } from "./jobs.js";

const id = Type.String({ minLength: 1, pattern: "\\S" });
const revision = Type.Integer({ minimum: 0 });
/** Focused reads return the latest activity entries; activityBefore pages earlier ones. */
export const STATUS_ACTIVITY_ENTRIES = 40;

export function graphReceipt(job: JobSnapshot) {
  return {
    nodes: job.execution.graph.nodes.map(({ prompt: _prompt, ...node }) => node),
    edges: job.execution.graph.edges, loops: job.execution.graph.loops ?? [],
  };
}

/** Keep the canonical value lossless; save large responses before returning a bounded preview. */
export async function boundedResult(value: object): Promise<object> {
  const full = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(full) <= 50_000) return JSON.parse(full) as object;
  const directory = await mkdtemp(join(tmpdir(), "braid-dsh-result-"));
  const fullOutputPath = join(directory, "result.json");
  await writeFile(fullOutputPath, full, { mode: 0o600 });
  const control = value as Partial<JobSnapshot> & { canonicalJobId?: string };
  return JSON.parse(JSON.stringify({ jobId: control.jobId, canonicalJobId: control.canonicalJobId, handle: control.handle, status: control.status,
    execution: control.execution && { status: control.execution.status, revision: control.execution.revision, pausedExecutionIds: control.execution.pausedExecutionIds },
    usage: control.usage, fullOutputPath, truncated: true, preview: full.slice(0, 10_000) })) as object;
}

export function createBraidTools(
  getJobs: (context: ToolRunContext) => BraidJobs,
  submit: (args: { goal: string; nodes: unknown[]; edges: unknown[]; options?: object }, context: ToolRunContext) => object,
): ToolDefinition[] {
  function tool<S extends TSchema>(name: string, description: string, parameters: S,
    execute: (args: import("@sinclair/typebox").Static<S>, context: ToolRunContext) => object | Promise<object>): ToolDefinition {
    // TypeBox's symbol metadata is local validation state, not lossless wire JSON.
    return { name, description, parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>,
      output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
      async execute(args, context) {
        context.signal.throwIfAborted();
        if (!Value.Check(parameters, args)) throw new Error(`Invalid ${name} arguments: ${[...Value.Errors(parameters, args)].map(error => `${error.path} ${error.message}`).join("; ")}`);
        return boundedResult(await execute(args, context));
      },
    };
  }
  return [
    tool("braid", "Start a background Braid graph before nontrivial engineering work with independent concerns. Returns jobId immediately. Supports execute/decision/merge/integrate, promptTemplates, bounded loops, worktree isolation, pauseAfter and notifyOnCompletion. Omit workspace on merge/integrate. No automatic integration. Continue independent work; retrieve results after the completion reminder instead of polling.", braidParameters, submit),
    tool("braid_status", "Retrieve progress and results by exact jobId handle or UUID. Omit all IDs to list this agent's jobs. executionId selects an exact invocation; nodeId selects its latest invocation. Focused reads include live activity: phase, time in phase and since the last observed signal, model request/stream state, running tools, and the latest " + STATUS_ACTIVITY_ENTRIES + " history entries; activityBefore pages earlier entries. Lack of observed activity is a diagnostic signal, not proof of a stall. Control fields contain the CURRENT revision and paused IDs. Large results provide a fullOutputPath. usage includes completed provider rounds from failed workers and cache tokens; reads do not add charges.", Type.Object({
      jobId: Type.Optional(id), nodeId: Type.Optional(id), executionId: Type.Optional(id),
      activityBefore: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    }, { additionalProperties: false }), (args, context) => {
      const jobs = getJobs(context);
      if (!args.jobId) {
        if (args.nodeId || args.executionId) throw new Error("nodeId/executionId requires jobId");
        return { jobs: jobs.list() };
      }
      const job = jobs.get(args.jobId);
      if (args.activityBefore !== undefined && !args.nodeId && !args.executionId) throw new Error("activityBefore requires nodeId or executionId");
      if (!args.nodeId && !args.executionId) return job;
      const node = jobs.getNode(args.jobId, args.nodeId, args.executionId);
      const activity = node.executionId ? jobs.getActivity(args.jobId, node.executionId, {
        limit: STATUS_ACTIVITY_ENTRIES, ...(args.activityBefore === undefined ? {} : { before: args.activityBefore }),
      }) : undefined;
      // While running, activity is the useful part; afterwards the output is.
      const running = activity && activity.finishedAt === undefined;
      const live = activity ? { observedAt: Date.now(), activity } : {};
      return {
        jobId: job.jobId, handle: job.handle, status: job.status,
        execution: { status: job.execution.status, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds },
        ...(running ? live : {}), node, ...(running ? {} : live),
      };
    }),
    tool("braid_cancel", "Cancel a background job. Foreground cancellation does not stop Braid jobs.", Type.Object({ jobId: id }, { additionalProperties: false }), (args, context) => {
      const jobs = getJobs(context), job = jobs.get(args.jobId);
      return { jobId: job.handle, canonicalJobId: job.jobId, cancelled: jobs.cancel(args.jobId) };
    }),
    tool("braid_update", "Atomically edit live definitions and optionally resume paused executions at expectedRevision. Upserts replace complete definitions. Include new nodes and all dependencies/loops in the SAME update: disconnected roots may start immediately. removeEdges matches exact identities, not wildcards. Rejected patches have no effects; retry the complete corrected patch. Finalized jobs cannot be reopened.", Type.Object({
      jobId: id, expectedRevision: revision,
      upsertNodes: Type.Optional(Type.Array(nodeParameters)), removeNodeIds: Type.Optional(Type.Array(id)),
      addEdges: Type.Optional(Type.Array(updateEdgeParameters)), removeEdges: Type.Optional(Type.Array(updateEdgeParameters)),
      promptTemplates: Type.Optional(Type.Record(Type.String(), id)), loops: Type.Optional(Type.Array(loopParameters)),
      resume: Type.Optional(Type.Array(id, { uniqueItems: true })),
    }, { additionalProperties: false }), (args, context) => {
      const { jobId, ...patch } = args;
      let job: JobSnapshot;
      try { job = getJobs(context).update(jobId, patch as GraphUpdate); }
      catch (error) { throw new Error(`Braid update rejected; no changes or resumes applied. ${error instanceof Error ? error.message : String(error)}. Retry the complete corrected patch with dependencies, loops, and resume IDs.`); }
      return { jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds, graph: graphReceipt(job) };
    }),
    tool("braid_resume", "Release selected paused execution IDs at expectedRevision. This does not reset budgets or deadlines.", Type.Object({
      jobId: id, expectedRevision: revision, executionIds: Type.Array(id, { minItems: 1, uniqueItems: true }),
    }, { additionalProperties: false }), (args, context) => {
      const job = getJobs(context).resume(args.jobId, args.executionIds, args.expectedRevision);
      return { jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds };
    }),
  ];
}
