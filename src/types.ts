export interface ExecuteNode {
  type: "execute";
  id: string;
  prompt: string;
  model?: string;
  /** Ask the parent adapter for a completion reminder on success or failure. Default: false. */
  notifyOnCompletion?: boolean;
  /** Optional failures remain in history; true aborts the entire run on failure. */
  requireSuccess?: boolean;
  /** Hold this execution's outgoing dependencies until explicitly resumed. */
  pauseAfter?: boolean;
  /** Fresh predecessor snapshot in Git; read-only disables writes. Read-only outside Git. */
  workspace?: "read-only" | "worktree";
}

export interface DecisionNode {
  type: "decision";
  id: string;
  prompt: string;
  choices: readonly string[];
  model?: string;
  /** Ask the parent adapter for a completion reminder on success or failure. Default: false. */
  notifyOnCompletion?: boolean;
  /** Optional failures remain in history; true aborts the entire run on failure. */
  requireSuccess?: boolean;
  /** Hold this execution's outgoing dependencies until explicitly resumed. */
  pauseAfter?: boolean;
  /** Fresh predecessor snapshot in Git; read-only disables writes. Read-only outside Git. */
  workspace?: "read-only" | "worktree";
}

export interface MergeNode {
  type: "merge";
  id: string;
  /** Defaults to combining selected predecessor checkpoints in a new worktree. */
  prompt?: string;
  model?: string;
  /** Ask the parent adapter for a completion reminder on success or failure. Default: false. */
  notifyOnCompletion?: boolean;
  /** Optional failures remain in history; true aborts the entire run on failure. */
  requireSuccess?: boolean;
  /** Hold this execution's outgoing dependencies until explicitly resumed. */
  pauseAfter?: boolean;
}

export interface IntegrateNode extends Omit<MergeNode, "type"> { type: "integrate"; }

export type BraidNode = ExecuteNode | DecisionNode | MergeNode | IntegrateNode;

/** A reference to a template in this graph submission; values are inserted literally. */
export interface PromptTemplateReference {
  template: string;
  variables: Readonly<Record<string, string>>;
}

export type NodePrompt = string | PromptTemplateReference;

/** Submission nodes may use templates; ModelRequest.node always has a string prompt. */
export type BraidInputNode =
  | (Omit<ExecuteNode, "prompt"> & { prompt: NodePrompt })
  | (Omit<DecisionNode, "prompt"> & { prompt: NodePrompt })
  | (Omit<MergeNode, "prompt"> & { prompt?: NodePrompt })
  | (Omit<IntegrateNode, "prompt"> & { prompt?: NodePrompt });

export interface NodeWorkspace {
  nodeId: string;
  executionId?: string;
  mode: "read-only" | "worktree" | "integrate";
  workingDirectory: string;
  worktreeRoot?: string;
  sourceRoot?: string;
  baseCommit?: string;
  snapshotCommit?: string;
  checkpointRef?: string;
  checkpointCommit?: string;
  /** Source checkout snapshot captured before a merge agent receives write access. */
  backupRef?: string;
  /** Agent decisions for this merge/integrate invocation; sources remain reusable. */
  dispositions?: MergeDisposition[];
  state: "preparing" | "ready" | "integrated" | "discarded" | "archived" | "failed";
  reason?: string;
}

export interface MergeDisposition {
  executionId: string;
  disposition: "integrated" | "discarded" | "archived";
  reason: string;
}

export interface GitPreview {
  text: string;
  truncated: boolean;
}

export interface MergeSource extends NodeWorkspace {
  /** Inspection-only summaries relative to the job’s initial snapshot; omitted by custom runners. */
  changes?: {
    /** Exact preview/diff baseline, including caller edits; supplied by built-in workspaces. */
    baseCommit?: string;
    files: string[];
    filesTruncated: boolean;
    stat: GitPreview;
    diff: GitPreview;
  };
}

export interface SourceCheckoutStatus extends GitPreview {
  /** True when Git porcelain status has any staged, unstaged, or untracked entries. */
  dirty: boolean;
}

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Edge {
  from: string;
  to: string;
  /** Omit for an unconditional edge, including from a decision node. */
  choice?: string;
  /** Explicit feedback edge into the named loop's entry. */
  feedback?: string;
  /** Pin a dependency to a historical execution rather than the current round. */
  executionId?: string;
}

export interface LoopDefinition {
  id: string;
  entry: string;
  maxIterations: number;
}

export interface BraidInput {
  goal: string;
  nodes: readonly BraidInputNode[];
  edges: readonly Edge[];
  /** Named {{variable}} templates, expanded and validated before execution. */
  promptTemplates?: Readonly<Record<string, string>>;
  loops?: readonly LoopDefinition[];
}

export type NodeStatus =
  | "pending"
  | "runnable"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** A message a human sent to a running execution, outside its graph definition and inputs. */
export interface HumanInput {
  text: string;
  /** When the adapter delivered it to the worker. */
  timestamp: number;
}

export interface NodeOutput {
  output: string;
  decision?: string;
  model?: string;
}

export interface PredecessorOutput extends NodeOutput {
  nodeId: string;
  executionId?: string;
  /** Failed predecessors remain available on unconditional edges. */
  error?: ExecutionError;
  workspace?: NodeWorkspace;
}

export interface ExecutionContext {
  runId: string;
  /** Equal to runId; reserved identity for future shared-root accounting. */
  rootRunId: string;
  executionId?: string;
  revision?: number;
  loopId?: string;
  iteration?: number;
}

export interface ModelRequest {
  goal: string;
  node: BraidNode;
  /** Node override, otherwise the run's defaultModel, otherwise adapter default. */
  model?: string;
  /** Direct active predecessors, including failures on unconditional edges; no parent history. */
  predecessors: PredecessorOutput[];
  execution: ExecutionContext;
  signal: AbortSignal;
  /**
   * Finite deadlines on the performance.now() clock; absent scopes are unlimited.
   * Core moves `node` later after a suspension, so read it each time it is needed.
   */
  deadlines?: { node?: number; graph?: number };
  /**
   * Pausable runners await this before each model request. It resolves at once
   * unless a pause was requested; then the execution suspends, and it resolves
   * after resume. Rejects when the execution is aborted.
   */
  checkpoint?: () => Promise<void>;
  /**
   * Interruptible runners call this at the start of each model request, retry
   * backoff, and tool call, and pass the result to that step instead of `signal`.
   * The signal aborts with the execution, or when core interrupts the current
   * step (a node timeout pause). An aborted step signal while `signal` is not
   * aborted means the step was interrupted: record that and await checkpoint().
   */
  stepSignal?: () => AbortSignal;
  workspace?: NodeWorkspace;
  /** Rejects read-only writes; adapters must wrap mutating file tools so cleanup waits for in-flight writes. */
  withWorkspaceWrite?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Local Git operations: inspection for workers, integration commands for merge/integrate nodes. */
  git?: (args: string[], input?: string) => Promise<GitResult>;
  /** Merge nodes must account for every source before returning their final answer. */
  merge?: {
    sources: MergeSource[];
    sourceStatus?: SourceCheckoutStatus;
    finish: (dispositions: MergeDisposition[]) => Promise<void>;
  };
  /** Present only on decision nodes. An adapter exposes this as the decide tool. */
  decide?: (choice: string) => void;
  /**
   * Adapters call this when they deliver a human message to the running worker,
   * before the model request that includes it. Core records it on the execution
   * and in the event log. Throws once the invocation has ended.
   */
  recordHumanInput?: (text: string) => void;
}

export interface ModelResponse {
  output: string;
  /** The actual model reported by the provider, if known. */
  model?: string;
  usage?: TokenUsage;
}

/** Each call starts a fresh conversation and exposes only the adapter’s declared capabilities. */
export interface ModelRunner {
  (request: ModelRequest): Promise<ModelResponse>;
  /** True when the runner awaits request.checkpoint() before each model request. Required for pause. */
  readonly pausable?: boolean;
  /**
   * True when the runner passes request.stepSignal() to each step and, when a step
   * is interrupted, records it and continues to its next checkpoint. Implies
   * pausable. Required for onNodeTimeout: "pause"; other runners fail on timeout.
   */
  readonly interruptible?: boolean;
}

/** A requested or active suspension of a running execution. */
export interface ExecutionSuspension {
  /**
   * pausing: waiting for the runner's next checkpoint, still holding its slot.
   * suspended: stopped at a checkpoint; its concurrency slot is released.
   * resuming: resumed and waiting for a free concurrency slot.
   */
  state: "pausing" | "suspended" | "resuming";
  /** Who asked: a caller-supplied label such as "agent" or "user", or "node_timeout" from core. */
  source: string;
  requestedAt: number;
  suspendedAt?: number;
  /** Present when the node timeout paused the execution. */
  timeout?: {
    /** The node time budget that ran out. */
    nodeTimeoutMs: number;
    /** Time the execution ran before the timeout, excluding earlier suspensions. */
    activeMs: number;
  };
}

/** A hold on an execution's outgoing scheduling, applied once it settles. */
export interface ExecutionHold {
  /** "definition" for the node's pauseAfter, otherwise the caller-supplied label. */
  source: string;
  requestedAt: number;
}

/** Frozen snapshots in emission order, including graph revisions and execution identities. */
export type ExecutionEvent = Readonly<
  {
    sequence: number;
    timestamp: number;
    executionId?: string;
    revision?: number;
    loopId?: string;
    iteration?: number;
  } & (
    | { type: "graph_created"; nodeCount: number; edgeCount: number }
    | {
        type: "node_created";
        nodeId: string;
        nodeType: BraidNode["type"];
        model?: string;
      }
    | ({ type: "edge_created" } & Edge)
    | { type: "graph_updated"; graph: BraidInput }
    | { type: "execution_paused"; nodeId: string }
    | { type: "execution_resumed"; nodeId: string }
    | { type: "execution_suspending"; nodeId: string; source: string }
    | { type: "execution_suspended"; nodeId: string; source: string }
    | { type: "execution_hold_added"; nodeId: string; source: string }
    | { type: "execution_hold_removed"; nodeId: string; source: string }
    | { type: "graph_paused"; source: string }
    | { type: "graph_resumed" }
    | { type: "loop_started"; entry: string }
    | { type: "loop_completed"; entry: string }
    | { type: "workspace_updated"; workspace: Readonly<NodeWorkspace> }
    | { type: "node_runnable"; nodeId: string }
    | {
        type: "handoff";
        from: string;
        to: string;
        output: string;
        decision?: string;
        fromExecutionId?: string;
      }
    | { type: "node_started"; nodeId: string; model?: string }
    | { type: "human_input"; nodeId: string; text: string }
    | ({
        type: "node_completed";
        nodeId: string;
        latencyMs: number;
        usage?: Readonly<TokenUsage>;
      } & NodeOutput)
    | {
        type: "node_skipped";
        nodeId: string;
        reason: NonNullable<NodeResult["skipReason"]>;
      }
    | ({
        type: "node_failed";
        nodeId: string;
        error: Readonly<ExecutionError>;
        latencyMs: number;
        usage?: Readonly<TokenUsage>;
      } & Partial<NodeOutput>)
    | { type: "graph_completed"; terminalNodeIds: readonly string[] }
    | {
        type: "graph_failed";
        error: Readonly<ExecutionError>;
        terminalNodeIds: readonly string[];
      }
  )
>;

export interface BraidOptions {
  runner: ModelRunner;
  defaultModel?: string;
  /** Source checkout for the initial snapshot and explicit integrate nodes. */
  cwd?: string;
  /** Positive integer. Defaults to 4. */
  maxConcurrency?: number;
  /** Applied separately to each invocation, starting when it runs and stopped while it is suspended. Default: 60s. Infinity disables it. */
  nodeTimeoutMs?: number;
  /** Includes queueing, pauses, and execution of the entire graph. Default: 5 minutes. Infinity disables it. */
  graphTimeoutMs?: number;
  /**
   * What a node timeout does. "pause" interrupts the current step and suspends the
   * execution until it is resumed or cancelled; it needs an interruptible runner,
   * and other runners fail as with "fail". Default: "pause" for startBraid, and
   * "fail" for braid(), which cannot resume executions.
   */
  onNodeTimeout?: "pause" | "fail";
  /** Caller cancellation, independent of node and graph deadlines. */
  signal?: AbortSignal;
  /** Live observer. Throws/rejections are ignored; returned work is not awaited. */
  onEvent?: (event: ExecutionEvent) => void;
  /** Total admitted executions across loops and graph updates. Default: 1000. */
  maxExecutions?: number;
}

export interface ExecutionError {
  code:
    | "MODEL_ERROR"
    | "INVALID_RESPONSE"
    | "DECISION_REQUIRED"
    | "INVALID_DECISION"
    | "NODE_TIMEOUT"
    | "GRAPH_TIMEOUT"
    | "CANCELLED"
    | "MERGE_FAILED"
    | "CLEANUP_FAILED"
    | "CHECKPOINT_FAILED"
    | "WORKSPACE_MERGE_REQUIRED"
    | "EXECUTION_LIMIT"
    | "LOOP_LIMIT"
    | "REQUIRED_NODE_FAILED"
    | "SCHEDULING_ERROR";
  message: string;
}

/** Output is absent if no valid response was received; status determines success. */
export interface NodeResult extends Partial<NodeOutput> {
  id: string;
  executionId?: string;
  status: NodeStatus;
  usage?: TokenUsage;
  startedAt?: number;
  finishedAt?: number;
  latencyMs?: number;
  error?: ExecutionError;
  skipReason?: "inactive" | "upstream_failed" | "graph_timeout" | "cancelled" | "run_failed";
  workspace?: NodeWorkspace;
  /**
   * Human messages delivered while this execution ran. When present, its result
   * did not come purely from the graph definition and predecessor inputs.
   */
  humanInputs?: HumanInput[];
  /** Present while a pause of this running execution is requested or active. */
  suspension?: ExecutionSuspension;
  /**
   * Present when this execution will be held after it settles, from its
   * definition's pauseAfter or from BraidRun.holdAfter. Authoritative over node.pauseAfter.
   */
  holdAfter?: ExecutionHold;
}

export interface BraidResult {
  status: "completed" | "failed";
  /** Latest output per node among completed, unconsumed executions; exact IDs are in terminalExecutionIds. */
  terminalOutputs: Record<string, NodeOutput>;
  /** Immutable execution log, including graph revisions and runtime handoffs. */
  events: readonly ExecutionEvent[];
  nodes: Record<string, NodeResult>;
  executions: Record<string, NodeExecution>;
  terminalExecutionIds: string[];
  revision: number;
  workspaces?: Record<string, NodeWorkspace>;
  error?: ExecutionError;
  metadata: ExecutionContext & {
    startedAt: number;
    finishedAt: number;
    latencyMs: number;
    /** Sum of reported usage only, including responses that fail decision validation. */
    usage: TokenUsage;
    usageReportedNodes: number;
  };
}


/** One immutable invocation definition, with a result updated only by that invocation. */
export interface NodeExecution extends NodeResult {
  executionId: string;
  node: BraidNode;
  revision: number;
  predecessorExecutionIds: string[];
  loopId?: string;
  iteration?: number;
}

export interface GraphUpdate {
  expectedRevision: number;
  upsertNodes?: readonly BraidInputNode[];
  removeNodeIds?: readonly string[];
  addEdges?: readonly Edge[];
  removeEdges?: readonly Edge[];
  promptTemplates?: Readonly<Record<string, string>>;
  loops?: readonly LoopDefinition[];
  /** Resume these held or paused executions atomically with this update. */
  resume?: readonly string[];
  /** Applies to the paused executions in `resume`. Requires `resume`. */
  resumeOptions?: ResumeOptions;
}

export interface PauseOptions {
  /** Recorded on the suspension or hold and its events. Default: "caller". */
  source?: string;
}

export interface ResumeOptions {
  /**
   * New node time budget for each resumed pausing or suspended execution, counted
   * in active time from when it gets a slot. Infinity removes the node timeout.
   * Without it, a node timeout pause gets the run's nodeTimeoutMs again, and other
   * pauses keep their remaining budget. Held executions have settled and ignore it.
   */
  nodeTimeoutMs?: number;
}

export interface CancelExecutionsOptions {
  /** Recorded in the error message. Default: "caller". */
  source?: string;
}

export interface BraidSnapshot {
  runId: string;
  /** waiting: nothing is actively running; only held, suspended, or paused work remains. */
  status: "running" | "waiting" | "finalizing" | "completed" | "failed";
  revision: number;
  graph: BraidInput;
  nodes: Record<string, NodeResult>;
  executions: Record<string, NodeExecution>;
  /** Settled executions whose outgoing scheduling is held by pauseAfter or holdAfter. */
  pausedExecutionIds: string[];
  /** Running executions stopped at a checkpoint, including resumed ones waiting for a slot. */
  suspendedExecutionIds: string[];
  /** Present while the whole run is paused: no new executions are admitted. */
  pause?: { source: string; pausedAt: number };
  /** Present as soon as a run-wide failure or cancellation starts draining work. */
  error?: ExecutionError;
}

export interface BraidRun {
  runId: string;
  result: Promise<BraidResult>;
  snapshot(): BraidSnapshot;
  update(update: GraphUpdate): BraidSnapshot;
  /** Release held executions, or resume paused ones. Resuming a still-pausing execution withdraws the request. */
  resume(executionIds: readonly string[], expectedRevision: number, options?: ResumeOptions): BraidSnapshot;
  /** Suspend running executions at their runner's next checkpoint. Requires a pausable runner. */
  pause(executionIds: readonly string[], options?: PauseOptions): BraidSnapshot;
  /**
   * Add (hold = true) or remove a hold on running executions, applied when each
   * settles exactly like pauseAfter. Affects only these executions, not their definitions.
   */
  holdAfter(executionIds: readonly string[], hold: boolean, options?: PauseOptions): BraidSnapshot;
  /** Stop admitting executions and pause every running one. Independent of pauseAfter holds. */
  pauseRun(options?: PauseOptions): BraidSnapshot;
  /** Admit executions again and resume the executions that pauseRun paused. */
  resumeRun(): BraidSnapshot;
  /** Cancel the whole run. */
  cancel(): void;
  /**
   * Fail running executions, including paused ones, without cancelling the run.
   * Successors follow the usual failure semantics. A node timeout pause fails with
   * NODE_TIMEOUT, anything else with CANCELLED.
   */
  cancelExecutions(executionIds: readonly string[], options?: CancelExecutionsOptions): BraidSnapshot;
}
