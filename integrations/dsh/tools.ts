import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { GraphUpdate } from "@chrok/braid";
import { BRAID_ASYNC_GUIDANCE, braidParameters, edgeIdentityParameters, edgeParameters, limitFields, nodeParameters } from "./schema.js";
import type { BraidJobs, JobSnapshot } from "./jobs.js";
import { boundedText, formatCancelExecutions, formatHold, formatJobList, formatJobStatus, formatNodeStatus, formatPause, formatResume, formatUpdate } from "./status-text.js";

const id = Type.String({ minLength: 1, pattern: "\\S" });
const revision = Type.Integer({ minimum: 0 });
const nodeTimeoutMs = Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483_647, description: "New node time budget in milliseconds for the suspended executions, counted from when each continues. Default: a node timeout pause gets the job's nodeTimeoutMs again; other pauses keep their remaining budget." });
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

/** Holds and their removal apply to running executions only; explain the usual mistake. */
function hold(jobs: BraidJobs, jobId: string, executionIds: readonly string[] | undefined, value: boolean): JobSnapshot {
  if (!executionIds) throw new Error("after=true requires executionIds of running executions; read them from braid_status");
  try { return jobs.holdAfter(jobId, executionIds, value, "agent"); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/running execution IDs/.test(message)) throw error;
    throw new Error(`${message}. after=true applies only while an execution is still running; a finished result that is held is released with braid_resume({jobId, expectedRevision, executionIds}) without after.`);
  }
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
    tool("braid", "Start a background Braid graph before nontrivial engineering work with independent concerns. Returns jobId immediately. Supports execute/decision/merge/integrate, promptTemplates, cycles closed by a decision's choice edge, worktree isolation, pauseAfter and notifyOnCompletion. Omit workspace on merge/integrate. No automatic integration. " + BRAID_ASYNC_GUIDANCE, braidParameters, submit),
    tool("braid_status", "Retrieve progress and results by exact jobId handle or UUID. Omit all IDs to list this agent's jobs. executionId (<nodeId>@<generation>, such as review@2) selects an exact execution; nodeId selects the node's latest. Focused reads include live activity: phase, time in phase and since the last observed signal, model request/stream state, running tools, and the latest " + STATUS_ACTIVITY_ENTRIES + " history entries; activityBefore pages earlier entries. Lack of observed activity is a diagnostic signal, not proof of a stall. Every job read starts with the CURRENT graph revision and paused execution IDs. Results are text; long ones are truncated and the full text is saved to a file whose path is shown. usage includes completed provider rounds from failed workers and cache tokens; reads do not add charges. Read results after the completion reminder, or deliberately for a progress check or diagnosis; do not sleep, use a timer, or poll in a loop to wait for a job.", Type.Object({
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
    tool("braid_cancel", "Cancel a background job. Foreground cancellation does not stop Braid jobs. With executionIds, fail only those running or paused executions and keep the job running: their successors follow the usual failure rules (unconditional edges receive the error; requireSuccess aborts the job). A node timeout pause fails with NODE_TIMEOUT, anything else with CANCELLED.", Type.Object({
      jobId: id, executionIds: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
    }, { additionalProperties: false }), (args, context) => {
      const jobs = getJobs(context);
      if (args.executionIds) {
        const job = jobs.cancelExecutions(args.jobId, args.executionIds, "agent");
        return { text: formatCancelExecutions(job, args.executionIds), ...control(job) };
      }
      const job = jobs.get(args.jobId);
      const cancelled = jobs.cancel(args.jobId);
      return { text: cancelled ? "Cancellation requested." : "Job has already finished.", jobId: job.handle, canonicalJobId: job.jobId, cancelled };
    }),
    tool("braid_update", "Atomically change the graph and optionally resume paused executions at expectedRevision. upsertNodes takes complete definitions: a node that has not started is edited in place; a node that has started, running or finished, is replaced by a new execution (a running one is cancelled) and its downstream nodes rerun once the replacement finishes, so upsert only the nodes you mean to change or rerun. Changing only maxRuns never replaces a node: later reruns use the new maxRuns. removeNodeIds removes nodes with their edges and cancels a running execution; finished executions stay in history. An edge added into a finished node reruns it once its new input finishes. Include new nodes and all dependencies in the SAME update: disconnected roots may start immediately. removeEdges identifies edges by from, to, and choice. To let a rerun waiting at its node's maxRuns start, upsert that node with a higher maxRuns: the waiting execution is edited in place. Rejected patches have no effects; retry the complete corrected patch. Finalized jobs cannot be reopened.", Type.Object({
      jobId: id, expectedRevision: revision,
      upsertNodes: Type.Optional(Type.Array(nodeParameters)), removeNodeIds: Type.Optional(Type.Array(id)),
      addEdges: Type.Optional(Type.Array(edgeParameters)), removeEdges: Type.Optional(Type.Array(edgeIdentityParameters)),
      promptTemplates: Type.Optional(Type.Record(Type.String(), id)),
      resume: Type.Optional(Type.Array(id, { uniqueItems: true })),
      resumeOptions: Type.Optional(Type.Object({ nodeTimeoutMs: Type.Optional(nodeTimeoutMs) }, { additionalProperties: false })),
    }, { additionalProperties: false }), (args, context) => {
      const { jobId, ...patch } = args;
      let job: JobSnapshot;
      try { job = getJobs(context).update(jobId, patch as GraphUpdate); }
      catch (error) { throw new Error(`Braid update rejected; no changes or resumes applied. ${error instanceof Error ? error.message : String(error)}. Retry the complete corrected patch with dependencies and resume IDs.`); }
      return { text: formatUpdate(job), jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision, pausedExecutionIds: job.execution.pausedExecutionIds };
    }),
    tool("braid_resume", "Release paused (pauseAfter) executions, or resume suspended ones in the same conversation, by execution ID at expectedRevision. Releasing a rerun that waits at its node's maxRuns ends it: it is removed and the node keeps its last result. Omit executionIds to resume a job paused with braid_pause or at a job limit; executions paused separately stay suspended. A job paused at a limit resumes only once limits raises that limit. This does not reset tool budgets or the graph deadline. An execution paused by its node timeout gets the job's nodeTimeoutMs again, or nodeTimeoutMs if given; resuming the job does not resume it. With after=true it instead removes the hold on still-running executions. Do not resume work the user paused or held unless the user asks.", Type.Object({
      jobId: id, expectedRevision: Type.Optional(revision), executionIds: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
      after: Type.Optional(Type.Boolean({ description: "true: remove the hold that braid_pause after=true or pauseAfter put on these still-running executions, so their results go downstream when they finish. Requires executionIds; expectedRevision is not needed. A result that is already held is released without after." })),
      nodeTimeoutMs: Type.Optional(nodeTimeoutMs),
      limits: Type.Optional(Type.Object({
        ...limitFields,
        graphTimeoutMs: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483_647, description: "Total wall-clock timeout in milliseconds, counted from the start of the job." })),
      }, { additionalProperties: false, minProperties: 1, description: "Only without executionIds: raise or set job limits, then resume the job. Use it when the job paused at maxExecutions, graphTimeoutMs, or maxTokens; omitted limits stay as they are." })),
    }, { additionalProperties: false }), (args, context) => {
      if (args.limits && (args.executionIds || args.after)) throw new Error("limits applies to the whole job; omit executionIds and after");
      if (args.after) {
        if (args.nodeTimeoutMs !== undefined) throw new Error("nodeTimeoutMs cannot be combined with after");
        const job = hold(getJobs(context), args.jobId, args.executionIds, false);
        return { text: formatHold(job, args.executionIds!, false), jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision,
          pausedExecutionIds: job.execution.pausedExecutionIds, suspendedExecutionIds: job.execution.suspendedExecutionIds };
      }
      const jobs = getJobs(context);
      if (args.executionIds && args.expectedRevision === undefined) throw new Error("expectedRevision is required with executionIds; read it from braid_status");
      if (!args.executionIds && args.nodeTimeoutMs !== undefined) throw new Error("nodeTimeoutMs requires executionIds");
      const job = args.executionIds
        ? jobs.resume(args.jobId, args.executionIds, args.expectedRevision!, "agent", args.nodeTimeoutMs === undefined ? undefined : { nodeTimeoutMs: args.nodeTimeoutMs })
        : jobs.resumeJob(args.jobId, "agent", args.limits);
      return { text: formatResume(job), jobId: job.handle, canonicalJobId: job.jobId, revision: job.execution.revision,
        pausedExecutionIds: job.execution.pausedExecutionIds, suspendedExecutionIds: job.execution.suspendedExecutionIds };
    }),
    tool("braid_pause", "Temporarily stop running executions without losing their work: each finishes its running tool, then stops before its next model request, keeping its conversation, workspace, and tool budgets, and releasing its concurrency slot. Omit executionIds to pause the whole job: no new executions start and running ones pause. Resume with braid_resume. The node timeout stops while suspended; the graph timeout keeps running, so resume or cancel paused work. With after=true it does not suspend: each execution finishes, then its result is held until braid_resume.", Type.Object({
      jobId: id, executionIds: Type.Optional(Type.Array(id, { minItems: 1, uniqueItems: true })),
      after: Type.Optional(Type.Boolean({ description: "true: do not suspend; let these running executions finish, then hold their results like pauseAfter, so downstream work waits for braid_resume. Use it to review a result that is still being produced. Requires executionIds; applies to these executions only, not their node definitions." })),
    }, { additionalProperties: false }), (args, context) => {
      if (args.after) {
        const job = hold(getJobs(context), args.jobId, args.executionIds, true);
        return { text: formatHold(job, args.executionIds!, true), ...control(job) };
      }
      const job = getJobs(context).pause(args.jobId, args.executionIds, "agent");
      return { text: formatPause(job, args.executionIds), ...control(job) };
    }),
  ];
}
