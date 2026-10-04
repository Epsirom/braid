import { Type } from "@sinclair/typebox";
const StringEnum = (values: string[], options = {}) => Type.Union(values.map(value => Type.Literal(value)), options);
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
  notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Send an execution completion reminder; default false. Does not pause scheduling." })),
  pauseAfter: Type.Optional(Type.Boolean({ description: "Hold this execution's outgoing dependencies until braid_resume or an atomic braid_update with resume. Sends a pause reminder." })),
  requireSuccess: Type.Optional(Type.Boolean({ description: "If true, failure aborts the entire job and cancels running siblings. Default false: unconditional successors can recover." })),
};
const workspace = Type.Optional(StringEnum(["read-only", "worktree"], {
  description: "Only for execute/decision; omit for merge/integrate. Defaults to worktree in Git. Both modes use fresh predecessor snapshots; read-only disables writes and shell tools. Outside Git, all workers are read-only.",
}));
// Keep all fields visible in one object. Kimi sessions using object-variant
// unions repeatedly emitted bare merge nodes instead of intended executions.
// Core validates the conditional requirements before starting or changing a job.
export const nodeParameters = Type.Object({
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
export const updateEdgeParameters = Type.Object({
  ...edgeFields,
  executionId: Type.Optional(text("Pin a completed historical source execution from braid_status; from must match that execution's node ID. Available only in braid_update, never in the initial graph.")),
}, { additionalProperties: false });
export const loopParameters = Type.Object({
  id: text("Unique loop ID referenced by exactly one edge.feedback."),
  entry: text("Node ID where every iteration starts; the feedback edge must target this node."),
  maxIterations: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Total rounds including the first, not the number of retries. Choosing feedback on the last round fails with LOOP_LIMIT." }),
}, { additionalProperties: false, description: "A bounded loop with one entry and a decision that selects retry or exit. The body is acyclic after removing the feedback edge; external edges enter only at entry and leave only from that decision. Loops cannot overlap or nest." });
const templateDescription = "Named prompt strings. Placeholders use {{name}} with names matching [A-Za-z_][A-Za-z0-9_]*. Node variables must match exactly; string values are inserted literally.";
const templates = Type.Record(Type.String(), text(), { description: templateDescription });
export const braidParameters = Type.Object({
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
  "Nodes have local read/ls/grep/find and Git inspection; writable nodes have write/edit and shell tools for dependencies, builds, and tests, while merge/integrate also have local Git integration tools. Search tools require local rg. Outside Git all filesystem access is read-only; read-only nodes have no shell. Worktrees are not an OS sandbox: prompts constrain shell writes and shared resources. Checkpoints omit ignored new files. Parent extension/MCP tools and recursive Braid calls are not provided. Nodes should verify their changes; the parent reviews results and performs any remaining validation after integration.";

export const BRAID_USAGE_GUIDANCE = [
  "Braid is a proactive execution primitive, not only a user-requested command.",
  "Selection rule: for a code review, bug investigation, design comparison, test-planning request, or change spanning multiple files, call braid FIRST when two or more concerns can be handled independently. Nodes can analyze the project and implement changes in isolated Git worktrees. Do this without waiting for the user to say Braid; do not read everything in the parent and then decide whether to delegate.",
  BRAID_FILESYSTEM_GUIDANCE,
  "For repeated instructions, define promptTemplates once and use prompt={template: name, variables: {name: value}} on nodes. Values are strings inserted literally into {{name}} placeholders; plain-string prompts remain supported.",
  "When Braid fits, submit a graph: use parallel execute nodes for independent analysis or implementation, execute nodes to synthesize findings, merge nodes to combine code snapshots, and integrate nodes to apply changes to the working branch. The tool returns a jobId immediately. Continue independent work or finish your turn while it runs; do not poll repeatedly. A completion reminder will resume you. Use braid_status with the jobId to retrieve terminal outputs before relying on them.",
  "Set notifyOnCompletion=true on selected nodes to receive intermediate success/failure reminders. Use braid_status({jobId, executionId}) to retrieve the exact execution; nodeId selects the latest instance. Use pauseAfter=true to hold outgoing scheduling. Definitions can always be changed with braid_update using expectedRevision; existing executions retain their captured inputs. Use resume in the same update to apply changes and release held executions atomically, or braid_resume for no graph changes.",
  "Make the delegation choice once per user request. Reminders and definition errors are not new tasks. Check the accepted node types and settings in the tool response. If the same definition problem recurs, stop resubmitting and report the concrete mismatch; do not launch repeated probe/replacement jobs. In braid_update, add new nodes together with their dependencies and loops: a node added without incoming edges can start immediately, even while another execution is paused.",
  "Do not use braid for a simple one-step answer, a trivial direct edit, a single shell command, or when decomposition adds no value. Writable nodes can implement and test their work. The parent reviews results and performs any remaining validation after Braid completes.",
].join("\n");
