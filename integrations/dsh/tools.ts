import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { GraphUpdate } from "@chrok/braid";
import { BRAID_ASYNC_GUIDANCE, braidParameters, nodeParameters, updateEdgeParameters, loopParameters } from "./schema.js";
import type { BraidJobs, JobSnapshot } from "./jobs.js";
import { boundedText, formatJobList, formatJobStatus, formatNodeStatus, formatPause, formatResume, formatUpdate } from "./status-text.js";

const id = Type.String({ minLength: 1, pattern: "\\S" });
const revision = Type.Integer({ minimum: 0 });
/** Focused reads return the latest activity entries; activityBefore pages earlier ones. */
export const STATUS_ACTIVITY_ENTRIES = 40;

/**
 * The model reads `text` in native and PTC mode alike. The remaining fields are
 * the stable identifiers the Web client needs to label cards and open the panel.
 */
export type ToolValue = { text: string } & Record<string, unknown>;

/** Identifiers for the client card; never outputs or prompts. */
function control(job: JobSnapshot) {
  const executions = Object.values(job.execution.executions);
  return { jobId: job.handle, canonicalJobId: job.jobId, status: job.status, execution: {
    status: job.execution.status, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds,
    suspendedExecutionIds: job.execution.suspendedExecutionIds, ...(job.execution.pause ? { pause: job.execution.pause } : {}),
    total: executions.length, completed: executions.filter(execution => execution.status === "completed").length,
  } };
}

async function bounded(text: string, name: string) {
  const result = await boundedText(text, name);
  return { text: result.text, ...(result.path ? { fullOutputPath: result.path, truncated: true } : {}) };
}

export function createBraidTools(
  getJobs: (context: ToolRunContext) => BraidJobs,
  submit: (args: { goal: string; nodes: unknown[]; edges: unknown[]; options?: object }, context: ToolRunContext) => ToolValue,
): ToolDefinition[] {
  function tool<S extends TSchema>(name: string, description: string, parameters: S,
    execute: (args: import("@sinclair/typebox").Static<S>, context: ToolRunContext) => ToolValue | Promise<ToolValue>): ToolDefinition {
    // TypeBox's symbol metadata is local validation state, not lossless wire JSON.
    return { name, description, parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>,
      output: {
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: (value as unknown as ToolValue).text }],
        presentationMeta: (_args, value) => {
          const { text: _text, ...meta } = value as unknown as ToolValue;
          return JSON.parse(JSON.stringify(meta));
        },
      },
      async execute(args, context) {
        context.signal.throwIfAborted();
        if (!Value.Check(parameters, args)) throw new Error(`Invalid ${name} arguments: ${[...Value.Errors(parameters, args)].map(error => `${error.path} ${error.message}`).join("; ")}`);
        // Drop undefined fields: values must be lossless JSON.
        return JSON.parse(JSON.stringify(await execute(args, context)));
      },
    };
  }
  return [
    tool("braid", "Start a background Braid graph before nontrivial engineering work with independent concerns. Returns jobId immediately. Supports execute/decision/merge/integrate, promptTemplates, bounded loops, worktree isolation, pauseAfter and notifyOnCompletion. Omit workspace on merge/integrate. No automatic integration. " + BRAID_ASYNC_GUIDANCE, braidParameters, submit),
    tool("braid_status", "Retrieve progress and results by exact jobId handle or UUID. Omit all IDs to list this agent's jobs. executionId selects an exact invocation; nodeId selects its latest invocation. Focused reads include live activity: phase, time in phase and since the last observed signal, model request/stream state, running tools, and the latest " + STATUS_ACTIVITY_ENTRIES + " history entries; activityBefore pages earlier entries. Lack of observed activity is a diagnostic signal, not proof of a stall. Every job read starts with the CURRENT graph revision and paused execution IDs. Results are text; long ones are truncated and the full text is saved to a file whose path is shown. usage includes completed provider rounds from failed workers and cache tokens; reads do not add charges. Read results after the completion reminder, or deliberately for a progress check or diagnosis; do not sleep, use a timer, or poll in a loop to wait for a job.", Type.Object({
      jobId: Type.Optional(id), nodeId: Type.Optional(id), executionId: Type.Optional(id),
      activityBefore: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    }, { additionalProperties: false }), async (args, context) => {
      const jobs = getJobs(context);
      if (!args.jobId) {
        if (args.nodeId || args.executionId) throw new Error("nodeId/executionId requires jobId");
        const list = jobs.list();
        return { text: formatJobList(list), jobs: list.map(({ jobId, handle, status }) => ({ jobId, handle, status })) };
      }
      const job = jobs.get(args.jobId);
      if (args.activityBefore !== undefined && !args.nodeId && !args.executionId) throw new Error("activityBefore requires nodeId or executionId");
      if (!args.nodeId && !args.executionId) return { ...control(job), ...await bounded(formatJobStatus(job, Date.now()), "status.txt") };
      const node = jobs.getNode(args.jobId, args.nodeId, args.executionId);
      const activity = node.executionId ? jobs.getActivity(args.jobId, node.executionId, {
        limit: STATUS_ACTIVITY_ENTRIES, ...(args.activityBefore === undefined ? {} : { before: args.activityBefore }),
      }) : undefined;
      return { ...control(job), node: { id: node.id, executionId: node.executionId, status: node.status },
        ...await bounded(formatNodeStatus({ job, node, ...(activity ? { activity } : {}), now: Date.now() }), "node.txt") };
    }),
    tool("braid_cancel", "Cancel a background job. Foreground cancellation does not stop Braid jobs.", Type.Object({ jobId: id }, { additionalProperties: false }), (args, context) => {
      const jobs = getJobs(context), job = jobs.get(args.jobId);
      const cancelled = jobs.cancel(args.jobId);
      return { text: cancelled ? "Cancellation requested." : "Job has already finished.", jobId: job.handle, canonicalJobId: job.jobId, cancelled };
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
      return { text: formatUpdate(job), jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds };
    }),
    tool("braid_resume", "Release paused (pauseAfter) executions, or resume suspended ones in the same conversation, by execution ID at expectedRevision. Omit executionIds to resume a job paused with braid_pause; executions paused separately stay suspended. This does not reset budgets or the graph deadline. Do not resume work the user paused unless the user asks.", Type.Object({
      jobId: id, expectedRevision: Type.Optional(revision), executionIds: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
    }, { additionalProperties: false }), (args, context) => {
      const jobs = getJobs(context);
      if (args.executionIds && args.expectedRevision === undefined) throw new Error("expectedRevision is required with executionIds; read it from braid_status");
      const job = args.executionIds ? jobs.resume(args.jobId, args.executionIds, args.expectedRevision!) : jobs.resumeJob(args.jobId);
      return { text: formatResume(job), jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision,
        pausedExecutionIds: job.execution.pausedExecutionIds, suspendedExecutionIds: job.execution.suspendedExecutionIds };
    }),
    tool("braid_pause", "Temporarily stop running executions without losing their work: each finishes its running tool, then stops before its next model request, keeping its conversation, workspace, and tool budgets, and releasing its concurrency slot. Omit executionIds to pause the whole job: no new executions start and running ones pause. Resume with braid_resume. The node timeout stops while suspended; the graph timeout keeps running, so resume or cancel paused work.", Type.Object({
      jobId: id, executionIds: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
    }, { additionalProperties: false }), (args, context) => {
      const job = getJobs(context).pause(args.jobId, args.executionIds, "agent");
      return { text: formatPause(job, args.executionIds), ...control(job) };
    }),
  ];
}
