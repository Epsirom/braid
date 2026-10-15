import { StringEnum, Type } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { BraidInput, ExecutionActivity, GraphUpdate, NodeResult } from "@chrok/braid";
import { Text } from "@earendil-works/pi-tui";
import { BraidJobs, type JobSnapshot } from "./jobs.js";
import { registerBraidCommand, registerBraidWidget } from "./command.js";
import { registerReviewCommand } from "./review.js";
import { renderGraphCall, renderGraphResult, renderNodeResult } from "./display.js";
import { formatJobList, formatJobStatus, formatNodeStatus, formatReceipt, formatResume, formatUpdate } from "./status-text.js";

const text = (description?: string) => Type.String({ minLength: 1, pattern: "\\S", ...(description ? { description } : {}) });
const prompt = () => Type.Union([
  text("Instructions for this node; it does not receive the parent conversation."),
  Type.Object({
    template: text("Exact key in promptTemplates."),
    variables: Type.Record(Type.String(), Type.String(), {
      description: "Exactly the template's placeholder names with string values; use {} if there are no placeholders. No missing or extra keys.",
    }),
  }, { additionalProperties: false }),
], { description: "Required for execute/decision; optional for merge/integrate. A non-blank instruction string or a reference to a declared prompt template." });
const timeout = (scope: "node" | "graph") =>
  Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: 2_147_483_647,
      description: scope === "graph"
        ? "Total wall-clock timeout in milliseconds, including queueing and pauses. Updates/resume do not reset it; reserve time for final integration. Omit for no time limit."
        : "Timeout in milliseconds per node execution; omit for no time limit.",
    }),
  );
const toolBudget = (unit: string) =>
  Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description: `Maximum tool ${unit} per node, including decide and rejected requests; omit for no limit`,
    }),
  );

const commonNodeParameters = {
  id: text("Unique node definition ID; edges refer to this exact ID. This is not an executionId."),
  model: Type.Optional(text("Model override as provider/model-id; omit to use the parent model.")),
  notifyOnCompletion: Type.Optional(Type.Boolean({ description: "In background mode, send an execution completion reminder; default false. Does not pause scheduling." })),
  pauseAfter: Type.Optional(Type.Boolean({ description: "Background mode only: hold this execution's outgoing dependencies until braid_resume or an atomic braid_update with resume. Sends a pause reminder." })),
  requireSuccess: Type.Optional(Type.Boolean({ description: "If true, failure aborts the entire job and cancels running siblings. Default false: unconditional successors can recover." })),
};
const workspace = Type.Optional(StringEnum(["read-only", "worktree"], {
  description: "Only for execute/decision; omit for merge/integrate. Defaults to worktree in Git. Both modes use fresh predecessor snapshots; read-only disables writes and shell tools. Outside Git, all workers are read-only.",
}));
// Keep all fields visible in one object. Kimi sessions using object-variant
// unions repeatedly emitted bare merge nodes instead of intended executions.
// Core validates the conditional requirements before starting or changing a job.
const nodeParameters = Type.Object({
  id: commonNodeParameters.id,
  type: StringEnum(["execute", "decision", "merge", "integrate"], {
    description: "execute: analyze/implement; decision: choose a route; merge: combine predecessor checkpoints in an isolated worktree; integrate: apply predecessor changes to the invoking checkout.",
  }),
  prompt: Type.Optional(prompt()),
  choices: Type.Optional(Type.Array(text(), { minItems: 1, uniqueItems: true, description: "Required only for decision; omit for every other type. Distinct routing labels used by decide and outgoing choice edges." })),
  workspace,
  model: commonNodeParameters.model,
  notifyOnCompletion: commonNodeParameters.notifyOnCompletion,
  pauseAfter: commonNodeParameters.pauseAfter,
  requireSuccess: commonNodeParameters.requireSuccess,
}, { additionalProperties: false, description: "execute/decision REQUIRE prompt; decision also REQUIRES choices. merge/integrate may omit prompt but MUST omit choices and workspace. Omit unused optional fields. All types accept model, notifyOnCompletion, pauseAfter, and requireSuccess." });
const edgeFields = {
  from: text("Source node ID."),
  to: text("Target node ID."),
  choice: Type.Optional(text("Only for a decision source: one exact declared choice. Omit for an unconditional dependency, including error recovery.")),
  feedback: Type.Optional(text("Loop ID, only on the single back edge from its decision to its entry. Requires choice and a matching loops definition; not a boolean. Cannot be combined with executionId.")),
};
const edgeParameters = Type.Object(edgeFields, { additionalProperties: false });
const updateEdgeParameters = Type.Object({
  ...edgeFields,
  executionId: Type.Optional(text("Pin a completed historical source execution from braid_status; from must match that execution's node ID. Available only in braid_update, never in the initial graph.")),
}, { additionalProperties: false });
const loopParameters = Type.Object({
  id: text("Unique loop ID referenced by exactly one edge.feedback."),
  entry: text("Node ID where every iteration starts; the feedback edge must target this node."),
  maxIterations: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Total rounds including the first, not the number of retries. Choosing feedback on the last round fails with LOOP_LIMIT." }),
}, { additionalProperties: false, description: "A bounded loop with one entry and a decision that selects retry or exit. The body is acyclic after removing the feedback edge; external edges enter only at entry and leave only from that decision. Loops cannot overlap or nest." });
const templateDescription = "Named prompt strings. Placeholders use {{name}} with names matching [A-Za-z_][A-Za-z0-9_]*. Node variables must match exactly; string values are inserted literally.";
const templates = Type.Record(Type.String(), text(), { description: templateDescription });
const braidParameters = Type.Object({
  goal: text("Shared goal included in every worker's context."),
  nodes: Type.Array(nodeParameters, { minItems: 1 }),
  edges: Type.Array(edgeParameters, { description: "Dependencies between node IDs; use [] for independent roots. Cycles require a declared loop and explicit feedback edge. Historical executionId is not allowed at submission." }),
  promptTemplates: Type.Optional(templates), loops: Type.Optional(Type.Array(loopParameters)),
  options: Type.Optional(Type.Object({
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum simultaneous node executions; default 4." })),
    maxExecutions: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Total execution limit across all iterations and updates; default 1000." })),
    nodeTimeoutMs: timeout("node"), graphTimeoutMs: timeout("graph"), maxToolRounds: toolBudget("rounds"), maxToolCalls: toolBudget("calls"),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const BRAID_FILESYSTEM_GUIDANCE =
  "Every execute/decision activation gets a fresh worktree in Git, based on its predecessor execution checkpoint (roots use the initial job snapshot). Set workspace=read-only to disable writes. Multiple independent code snapshots require an explicit merge node. " +
  "merge combines selected predecessor checkpoints into a new isolated worktree; integrate writes selected changes to the invoking checkout while preserving user edits. Workers apply changes with Git/file tools, then call finish_merge using executionId for each source; finish_merge only records dispositions and does not apply changes. There is no automatic final integration. " +
  "Do not set workspace on merge/integrate nodes. Checkpoints remain recoverable after cleanup. Optional failed predecessors pass errors and partial work along unconditional edges; requireSuccess=true makes failure abort the job. " +
  "Nodes have local read/ls and Git inspection; writable nodes have write/edit and Pi shell tools for dependencies, builds, and tests, while merge/integrate also have local Git integration tools. Search tools require local rg/fd. Outside Git all filesystem access is read-only; read-only nodes have no shell. Worktrees are not an OS sandbox: prompts constrain shell writes and shared resources. Checkpoints omit ignored new files. Parent extension/MCP tools and recursive Braid calls are not provided. Nodes should verify their changes; the parent reviews results and performs any remaining validation after integration.";

/** Lifecycle guidance shared by the system prompt and tool descriptions. */
export const BRAID_ASYNC_GUIDANCE =
  "By default, Braid is asynchronous: braid returns a jobId immediately and the job keeps running independently of the foreground response; ending your turn does not cancel it. " +
  "Completion, failure, or cancellation sends a reminder: an idle agent is resumed automatically, and a running agent receives it at the next model step. " +
  "After submitting, continue useful independent work. If nothing else can proceed until the result arrives, end your turn and let the reminder resume the task. " +
  "Do not call sleep, run a shell sleep, use a timer, or enter a sleep/poll loop solely to wait for a Braid job; delays required by the user's actual task remain allowed. " +
  "On the reminder, retrieve terminal outputs with braid_status before relying on them and continue the original task. Between reminders, use braid_status only for deliberate progress checks or diagnosis. " +
  "Set notifyOnCompletion=true on selected nodes to receive intermediate success/failure reminders. Use braid_status({jobId, executionId}) to retrieve the exact execution; nodeId selects the latest instance. Use pauseAfter=true to hold outgoing scheduling. Definitions can always be changed with braid_update using expectedRevision; existing executions retain their captured inputs. Use resume in the same update to apply changes and release held executions atomically, or braid_resume for no graph changes.";

/** Short reminder repeated in every submission receipt. */
export const BRAID_WAIT_REMINDER =
  "Braid runs asynchronously and notifies you when the job finishes. Continue independent work, or end your turn if you need the result before proceeding; the completion reminder will resume you. " +
  "Do not sleep or poll in a loop to wait for this job. Retrieve its results with braid_status after the reminder.";

const BRAID_BLOCKING_GUIDANCE =
  "In blocking mode (enabled by --braid-blocking or /braid:blocking on), braid waits for the entire graph and workspace cleanup, then returns final status, outputs, and usage directly. " +
  "Foreground cancellation cancels the submitted job and waits for cleanup. Completion reminders are suppressed unless the job is cancelled; cancellation reminders preserve its handle and access to partial results. " +
  "Do not set pauseAfter=true in blocking mode: it requires a later resume call and is rejected. Use braid_status for focused reads, diagnosis, or retrieving an existing job after cancellation or a wait/result error.";

const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be handled independently. Nodes can analyze the project and implement changes in isolated Git worktrees. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  BRAID_FILESYSTEM_GUIDANCE,
  "For repeated instructions, define promptTemplates once and use prompt={template: name, variables: {name: value}} on nodes. Values are strings inserted literally into {{name}} placeholders; plain-string prompts remain supported.",
  "When Braid fits, submit a graph: use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, merge nodes to combine code snapshots, and integrate nodes to apply changes to the working branch. Read terminal outputs before relying on them.",
  "Make the delegation choice once per user request. Reminders and definition errors are not new tasks. If the same definition problem recurs, stop resubmitting and report the concrete mismatch; do not launch repeated probe/replacement jobs. In braid_update, add new nodes together with their dependencies and loops: a node added without incoming edges can start immediately, even while another execution is paused.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, a single shell command, or when decomposition adds no value. Writable nodes can implement and test their work. The parent reviews results and performs any remaining validation after Braid completes.",
].join("\n");

function isJobSnapshot(value: unknown): value is JobSnapshot {
  // Pi uses details={} for validation/execution errors, including before execute runs.
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<JobSnapshot>;
  return typeof job.jobId === "string" && job.jobId.length > 0 &&
    ["running", "completed", "failed", "cancelled"].includes(job.status ?? "") &&
    !!job.live && typeof job.live.nodes === "object" && job.live.nodes !== null;
}

type BraidStatusDetails = JobSnapshot & { selectedNode?: NodeResult; selectedActivity?: ExecutionActivity; nodeOutputPath?: string; fullOutputPath?: string };

/** Focused reads return the latest activity entries; activityBefore pages earlier ones. */
export const STATUS_ACTIVITY_ENTRIES = 40;

/** Bound a text result; the complete document stays readable in a private file. */
async function boundedText(text: string, name: string): Promise<{ text: string; path?: string }> {
  const preview = truncateHead(text);
  if (!preview.truncated) return { text };
  const directory = await mkdtemp(join(tmpdir(), "braid-status-"));
  const path = join(directory, name);
  await writeFile(path, text, { mode: 0o600 });
  return { text: `${preview.content}\n[Truncated. Full text: ${path}]`, path };
}

export function createBraidTools(jobs: BraidJobs, blocking: () => boolean = () => false) {
  const braidTool = defineTool<typeof braidParameters, BraidStatusDetails | undefined>(
    {
      name: "braid",
      label: "Braid",
      description:
        "Use this tool FIRST for nontrivial engineering work: code reviews, bug investigations, design comparisons, test planning, and changes spanning multiple files. " +
        "Run a mutable graph of isolated LLM invocations with parallel branches and joins; the user does not need to mention Braid. " +
        "Use execute, decision, merge, or integrate nodes. Execute/decision nodes require prompt. Only decision nodes declare choices and call decide; matching choice edges activate together. Merge/integrate nodes accept multiple predecessors and an optional prompt, with no workspace or choices field. " +
        "Structured loops declare id, entry, maxIterations, and one back edge from a decision to entry with both choice and feedback=loopId. The decision also needs an exit choice. External edges enter only at entry and leave only through that decision; the body must be acyclic and loops cannot overlap or nest. Each round uses new executions and worktrees. " +
        'Example retry loop: nodes work (execute with prompt) and check (decision with prompt and choices ["retry","done"]); edges [{"from":"work","to":"check"},{"from":"check","to":"work","choice":"retry","feedback":"retryLoop"}]; loops [{"id":"retryLoop","entry":"work","maxIterations":3}]. An optional done edge leaves check to a downstream node. ' +
        "For repeated prompts, define promptTemplates and set node prompt to {template: name, variables: {name: value}}; core renders {{name}} placeholders using explicit string variables before execution. " +
        "Unlabelled edges are unconditional. Joins wait for all possible predecessor paths to resolve. " +
        "Nodes see only the goal, their prompt, labelled direct-predecessor outputs, and their filesystem capabilities: " +
        "no parent history, inherited extension/MCP tools, or recursive Braid tools. " +
        BRAID_FILESYSTEM_GUIDANCE + " " +
        "Do not use it for a simple one-step answer or trivial direct edit. " +
        "Use braid_cancel(jobId) to stop it. Humans can open /braid for the live flow panel. " +
        "Follow the current session's Braid execution policy in the system prompt for waiting, result retrieval, and pause/notification controls. " +
        "Read result.status: failed graphs can still return successful terminal outputs.",
      promptSnippet:
        "Use FIRST for nontrivial code review/debug/design/implementation work; set workspace=read-only for analysis/synthesis, use worktrees for edits, merge to combine snapshots, and integrate to apply changes",
      promptGuidelines: [
        "Call braid before direct repository inspection when a code task has two or more separable review, debugging, design, test-planning, or implementation concerns; the Braid nodes can inspect the project and edit isolated Git worktrees.",
        "Use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, merge nodes to combine code snapshots, and integrate nodes to apply changes to the working branch. The user does not need to mention Braid or design the graph.",
        "Do not use braid for simple one-step answers or trivial direct edits. Let writable nodes run shell commands and tests for their work; use merge nodes to combine and validate snapshots before explicit integration.",
        BRAID_FILESYSTEM_GUIDANCE,
        "Decision nodes additionally receive decide. Nodes cannot call recursive Braid.",
        "Tool and time budgets are unlimited by default. Set maxToolRounds, maxToolCalls, nodeTimeoutMs, or graphTimeoutMs in options to impose hard limits; nodes receive system reminders of their remaining budgets before each model call.",
      ],
      parameters: braidParameters,
      renderCall(args, theme) {
        return renderGraphCall(args, theme);
      },
      renderResult(result, options, theme, ctx) {
        const job = result.details;
        const fallback = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        if (ctx.isError || !isJobSnapshot(job)) {
          const pending = options.isPartial && !ctx.isError;
          return new Text(theme.fg(pending ? "warning" : "error",
            pending ? fallback || "Braid submission pending…" : `✗ ${fallback || "Braid submission failed without error details"}`,
          ), 0, 0);
        }
        if (job.status !== "running")
          return statusTool.renderResult!(result, options, theme, { ...ctx, args: { jobId: job.jobId } });
        return new Text(
          theme.fg(
            "accent",
            `Braid ${options.isPartial ? "job" : "background job"} ${job.handle ?? job.jobId} · ${job.status} · /braid to view${job.error ? `\n${job.error}` : ""}`,
          ),
          0,
          0,
        );
      },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        const waitForCompletion = blocking();
        let job: JobSnapshot;
        try {
          job = jobs.start(
            {
              goal: params.goal,
              nodes: params.nodes,
              edges: params.edges,
              ...(params.loops !== undefined ? { loops: params.loops } : {}),
              ...(params.promptTemplates !== undefined ? { promptTemplates: params.promptTemplates } : {}),
            } as BraidInput,
            params.options ?? {},
            ctx,
            waitForCompletion,
          );
        } catch (error) {
          throw new Error(
            `Braid submission failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!waitForCompletion) return {
          content: [{ type: "text", text: formatReceipt(job,
            `${BRAID_WAIT_REMINDER} Humans can follow it live in /braid.`) }],
          details: job,
        };
        const cancel = () => { jobs.cancel(job.jobId); };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          try {
            onUpdate?.({
              content: [{ type: "text", text: formatReceipt(job,
                "Waiting for the graph and workspace cleanup. Humans can follow it live in /braid.") }],
              details: job,
            });
          } catch { /* Progress observers must not stop the foreground wait. */ }
          await jobs.wait(job.jobId);
          return await statusTool.execute(_toolCallId, { jobId: job.jobId }, signal, undefined, ctx);
        } catch (error) {
          const current = jobs.get(job.jobId)!;
          const usage = current.status === "running" || signal?.aborted ? undefined : jobs.claimUsage(job.jobId);
          return {
            content: [{ type: "text", text:
              `Braid job ${job.handle} was started and is ${current.status}. Could not wait for or retrieve its results: ${error instanceof Error ? error.message : String(error)}. Do not resubmit this graph: it may already have changed the checkout. Retrieve the existing job with braid_status(${JSON.stringify({ jobId: job.handle })}).` }],
            details: current,
            isError: true,
            ...(usage ? { usage } : {}),
          };
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    },
  );

  const statusParameters = Type.Object(
    {
      jobId: Type.Optional(text("Exact session handle (e.g. job-1) or UUID; omit all IDs to list jobs.")),
      executionId: Type.Optional(text("Exact execution ID from braid_status or a reminder; requires jobId. Takes precedence over nodeId; if both are provided they must match.")),
      nodeId: Type.Optional(text("Exact node ID; requires jobId. Retrieve this node's latest full output/error even while the job is running.")),
      activityBefore: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: `Focused reads include activity: the current phase, model/tool waits, and the latest ${STATUS_ACTIVITY_ENTRIES} history entries. Pass an entry sequence to page earlier entries.` })),
    },
    { additionalProperties: false },
  );
  const statusTool = defineTool<
    typeof statusParameters,
    BraidStatusDetails | undefined
  >({
    name: "braid_status",
    label: "Braid status",
    description:
      "Retrieve a Braid job's status, node progress, and final results by exact session handle (e.g. job-1) or UUID in jobId. Add executionId for an exact execution, or nodeId for the latest instance, including intermediate results while the job runs. Focused reads include live activity: phase, time in phase and since the last observed signal, model request/stream state, running tools, and recent history. Lack of observed activity is a diagnostic signal, not proof of a stall. Every job read starts with the current graph revision and paused execution IDs for live control. Results are text; long ones are truncated and the full text is saved to a file whose path is shown. Usage is Pi's provider accounting, including rounds from failed nodes. Prefer the short handle from submission/reminders. Omit all IDs to list jobs in this session. Follow the current session's Braid execution policy for result retrieval; do not sleep, use a timer, or poll in a loop to wait for a job.",
    parameters: statusParameters,
    renderResult(result, options, theme, ctx) {
      const job = result.details;
      const fallback = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (ctx.isError) return new Text(theme.fg("error", `✗ ${fallback || "Braid status failed without error details"}`), 0, 0);
      if (!isJobSnapshot(job)) return new Text(fallback || "Braid returned no job details", 0, 0);
      // Older saved sessions stored only the job snapshot for focused reads.
      const state = job.result ?? job.execution;
      const executionId = ctx.args?.executionId;
      const nodeId = ctx.args?.nodeId;
      const selectedNode = job.selectedNode ?? (executionId
        ? state && Object.hasOwn(state.executions, executionId) ? state.executions[executionId] : undefined
        : nodeId && state && Object.hasOwn(state.nodes, nodeId) ? state.nodes[nodeId] : undefined);
      // Render at the read's observation time so a saved result never keeps counting.
      if (selectedNode) return renderNodeResult(selectedNode, options.expanded, theme, job.nodeOutputPath,
        job.live.progress?.[selectedNode.id], job.live.observedAt, job.selectedActivity);
      if (executionId || nodeId) return new Text(fallback || "Braid returned no node details", 0, 0);
      if (job.error)
        return new Text(
          theme.fg("error", `Braid ${job.status}: ${job.error}`),
          0,
          0,
        );
      return renderGraphResult(
        {
          ...(job.result ?? job.live),
          progress: job.live.progress,
          ...(job.workspaces ? { workspaces: job.workspaces } : {}),
          ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {}),
        },
        options.expanded,
        options.isPartial,
        theme,
        fallback,
      );
    },
    async execute(_id, params, signal) {
      if ((params.nodeId !== undefined || params.executionId !== undefined) && !params.jobId)
        throw new Error("nodeId/executionId requires jobId");
      if (params.activityBefore !== undefined && params.nodeId === undefined && params.executionId === undefined)
        throw new Error("activityBefore requires nodeId or executionId");
      if (!params.jobId)
        return {
          content: [{ type: "text", text: formatJobList(jobs.list()) }],
          details: undefined,
        };
      const job = jobs.get(params.jobId);
      if (!job) throw jobs.unknownJob(params.jobId);
      if (params.nodeId !== undefined || params.executionId !== undefined) {
        const node = jobs.getNode(params.jobId, params.nodeId, params.executionId);
        const activity = node.executionId ? jobs.getActivity(params.jobId, node.executionId, {
          limit: STATUS_ACTIVITY_ENTRIES, ...(params.activityBefore === undefined ? {} : { before: params.activityBefore }),
        }) : undefined;
        const result = await boundedText(formatNodeStatus({ job, node, ...(activity ? { activity } : {}), now: Date.now() }), "node.txt");
        // Focused reads do not claim the whole job's usage; final job retrieval does.
        return { content: [{ type: "text", text: result.text }], details: {
          ...job, selectedNode: node, ...(activity ? { selectedActivity: activity } : {}), ...(result.path ? { nodeOutputPath: result.path } : {}),
        } };
      }
      const result = await boundedText(formatJobStatus(job, Date.now()), "status.txt");
      const details: BraidStatusDetails = result.path ? { ...job, fullOutputPath: result.path } : job;
      // Saving a running snapshot can race job completion; claim usage only
      // when this response actually contains a terminal snapshot.
      const usage = job.status === "running" || signal?.aborted ? undefined : jobs.claimUsage(job.jobId);
      return {
        content: [{ type: "text", text: result.text }],
        details,
        ...(usage ? { usage } : {}),
      };
    },
  });

  const cancelParameters = Type.Object(
    { jobId: text("Exact session handle (e.g. job-1) or UUID returned by braid or braid_status.") },
    { additionalProperties: false },
  );
  const cancelTool = defineTool<typeof cancelParameters, undefined>({
    name: "braid_cancel",
    label: "Cancel Braid",
    description:
      "Cancel a background Braid job by jobId. Stopping the foreground response does not cancel background jobs.",
    parameters: cancelParameters,
    async execute(_id, params) {
      const cancelled = jobs.cancel(params.jobId);
      return {
        content: [
          {
            type: "text",
            text: cancelled
              ? "Cancellation requested."
              : "Job has already finished.",
          },
        ],
        details: undefined,
      };
    },
  });
  const updateParameters = Type.Object({
    jobId: text("Exact session handle (e.g. job-1) or UUID."),
    expectedRevision: Type.Integer({ minimum: 0, description: "Current graph revision from braid_status. A stale revision rejects the entire update." }),
    upsertNodes: Type.Optional(Type.Array(nodeParameters, { description: "Complete node definitions to add or replace, not partial patches. Add dependencies and loops in this SAME update: new roots may start immediately even if another execution is paused. Already admitted executions keep their captured definitions." })),
    removeNodeIds: Type.Optional(Type.Array(text(), { description: "Node IDs to remove, together with all incident edges." })),
    addEdges: Type.Optional(Type.Array(updateEdgeParameters, { description: "Edges to add. Pin a historical source using executionId when needed." })),
    removeEdges: Type.Optional(Type.Array(updateEdgeParameters, { description: "Exact edge identities to remove: copy from, to, and every present choice/feedback/executionId from the current graph edges in braid_status. Omitted optional fields do not act as wildcards." })),
    promptTemplates: Type.Optional(Type.Record(Type.String(), text(), { description: `${templateDescription} Replaces the entire template map; omit to preserve it. Include every template still referenced by nodes.` })),
    loops: Type.Optional(Type.Array(loopParameters, { description: "Replaces all loop definitions; omit to preserve them, or use [] to remove all (also remove their feedback edges)." })),
    resume: Type.Optional(Type.Array(text(), { uniqueItems: true, description: "Paused execution IDs from braid_status, not node IDs. Releases them atomically with the graph edit." })),
  }, { additionalProperties: false });
  const updateTool = defineTool<typeof updateParameters, JobSnapshot>({
    name: "braid_update", label: "Update Braid",
    description: "Atomically edit a running or waiting job using its current expectedRevision from braid_status. Upserts replace complete node definitions; removeNodeIds also removes incident edges. Submit new nodes, dependencies, loops, and optional resume together; do not stage disconnected nodes in separate calls, as they can start immediately. Existing executions and their failure policy remain unchanged. Completion routes through the latest graph. Pin historical inputs with edge.executionId. Optional resume releases paused execution IDs in the same transaction. Rejected updates change nothing; retry the entire corrected patch. Finalized jobs cannot be reopened.",
    parameters: updateParameters,
    async execute(_id, params) {
      const { jobId, ...patch } = params;
      let job: JobSnapshot;
      try {
        job = jobs.update(jobId, patch as GraphUpdate);
      } catch (error) {
        throw new Error(`Braid update rejected; no changes or resumes were applied. ${error instanceof Error ? error.message : String(error)}. Retry the complete corrected patch, including its edges/loops/resume; adding disconnected nodes separately can start them immediately.`);
      }
      return { content: [{ type: "text", text: formatUpdate(job) }], details: job };
    },
  });
  const resumeParameters = Type.Object({
    jobId: text("Exact session handle (e.g. job-1) or UUID."),
    expectedRevision: Type.Integer({ minimum: 0, description: "Current graph revision from braid_status." }),
    executionIds: Type.Array(text(), { minItems: 1, uniqueItems: true, description: "Paused execution IDs from braid_status, not node IDs. Only these completed, paused executions are released." }),
  }, { additionalProperties: false });
  const resumeTool = defineTool<typeof resumeParameters, JobSnapshot>({
    name: "braid_resume", label: "Resume Braid",
    description: "Release specific paused execution IDs using expectedRevision from braid_status. Independent branches keep running during a pause; this does not reset deadlines or execution limits.",
    parameters: resumeParameters,
    async execute(_id, params) {
      const job = jobs.resume(params.jobId, params.executionIds, params.expectedRevision);
      return { content: [{ type: "text", text: formatResume(job) }], details: job };
    },
  });
  return { braidTool, statusTool, cancelTool, updateTool, resumeTool };
}

export default function braidExtension(pi: ExtensionAPI) {
  pi.registerFlag("braid-blocking", {
    description: "Experimental: wait for braid tool calls to finish in the foreground (for CI/print mode)",
    type: "boolean",
    default: false,
  });
  let sessionBlocking: boolean | undefined;
  const blocking = () => sessionBlocking ?? (pi.getFlag("braid-blocking") === true);
  pi.registerCommand("braid:blocking", {
    description: "Experimental: set blocking mode for new braid tool calls: /braid:blocking [on|off]; omit to show the current mode",
    handler: async (args, ctx) => {
      const setting = args.trim().toLowerCase();
      if (setting === "on" || setting === "off") sessionBlocking = setting === "on";
      else if (setting) throw new Error("Usage: /braid:blocking [on|off]");
      ctx.ui.notify(`Braid blocking mode: ${blocking() ? "on" : "off"}. Applies to new braid tool calls.`, "info");
    },
  });
  const pending = new Map<string, Parameters<ExtensionAPI["sendMessage"]>[0]>();
  const remind = (message: Parameters<ExtensionAPI["sendMessage"]>[0]): void => {
    try {
      // Pi consumes steering after the assistant response and its entire tool
      // batch. followUp waits until the whole foreground task would stop.
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    } catch {
      // Keep failed deliveries pending for the next settled retry.
    }
  };
  const jobs = new BraidJobs((job) => {
    const { jobId, handle, status } = job;
    const reminderId = JSON.stringify([jobId, "job"]);
    const message = {
      customType: "braid-completed",
      display: true,
      content: `[system-reminder] Braid job ${handle} finished with status ${status}. Retrieve its results with braid_status({"jobId":"${handle}"}) and continue the original task. Failed or cancelled jobs may contain successful partial outputs. [/system-reminder]`,
      details: { jobId, handle, status, reminderId },
    };
    pending.set(reminderId, message);
    remind(message);
  }, (completion) => {
    const { jobId, handle, nodeId, executionId, status, eventSequence, errorCode, paused, iteration } = completion;
    const reminderId = JSON.stringify([jobId, "execution", executionId, eventSequence]);
    const lookup = JSON.stringify({ jobId: handle, executionId });
    const message = {
      customType: "braid-node-completed",
      display: true,
      content: `[system-reminder] Braid job ${handle} node ${JSON.stringify(nodeId)} execution ${executionId}${iteration ? ` (iteration ${iteration})` : ""} finished with status ${status}${errorCode ? ` (${errorCode})` : ""}. Retrieve its output or error with braid_status(${lookup}) and continue the original task. ${paused ? "Outgoing scheduling was paused at completion. Inspect the current status, revision, and pausedExecutionIds; if this execution is still paused, use braid_update with resume or braid_resume to continue. Independent branches may still be running. A finalized job cannot be resumed." : "This execution reminder does not pause downstream scheduling; the job may still be running."} [/system-reminder]`,
      details: { ...completion, reminderId },
    };
    pending.set(reminderId, message);
    remind(message);
  });
  // Foreground cancellation can discard queued steering. Retry only reminders
  // that never entered context, once Pi has settled and emptied its queues.
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role === "custom" &&
        (message.customType === "braid-completed" || message.customType === "braid-node-completed")) {
      const details = message.details as { reminderId?: string } | undefined;
      if (details?.reminderId) pending.delete(details.reminderId);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      for (const message of pending.values()) remind(message);
    }
  });
  const { braidTool, statusTool, cancelTool, updateTool, resumeTool } = createBraidTools(jobs, blocking);
  registerBraidCommand(pi, jobs);
  registerReviewCommand(pi, jobs);
  const disposeWidget = registerBraidWidget(pi, jobs);
  pi.registerTool(braidTool);
  pi.registerTool(statusTool);
  pi.registerTool(cancelTool);
  pi.registerTool(updateTool);
  pi.registerTool(resumeTool);
  pi.on("session_shutdown", () => {
    pending.clear();
    jobs.dispose();
    disposeWidget();
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## Braid execution policy\n${BRAID_USAGE_GUIDANCE}\n${blocking() ? "Blocking mode is enabled for this session. " + BRAID_BLOCKING_GUIDANCE : BRAID_ASYNC_GUIDANCE}\n\nFor the current user request, make this delegation choice before using read, grep, find, edit, write, or bash. Completion reminders refer to existing jobs: retrieve their results instead of submitting the same graph again.`,
  }));
}
