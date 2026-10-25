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

/** A dependency between lineages; `from`, `to`, and `choice` identify it. */
export interface Edge {
  from: string;
  to: string;
  /** Omit for an unconditional edge, including from a decision node. */
  choice?: string;
  /**
   * Only on the edge that closes a cycle: how many times it may fire, each time
   * cloning its target for another round. Omit or use Infinity for no limit.
   */
  limit?: number;
}

export interface BraidInput {
  goal: string;
  nodes: readonly BraidInputNode[];
  edges: readonly Edge[];
  /** Named {{variable}} templates, expanded and validated before execution. */
  promptTemplates?: Readonly<Record<string, string>>;
}

export type NodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

/**
 * Why a pending instance has not started. predecessors: an input has not run yet;
 * stale: an input has a newer instance, or will get one, that has not settled;
 * hold: an input is held; run_paused: the run is paused; slot: no concurrency
 * slot is free, or the instance it replaces is still stopping.
 */
export type WaitReason = "predecessors" | "stale" | "hold" | "run_paused" | "slot";

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
  /** One-based position of this instance in its lineage. */
  generation?: number;
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
   * Present on execute and decision nodes. An adapter exposes this as the
   * request_replan tool. Records the request, holds this execution's result like
   * pauseAfter, and lets the execution continue; the graph owner decides how to
   * replan. A suggestion is validated against the current graph. A repeated call
   * replaces the request. Throws on invalid input or once the invocation has ended.
   */
  requestReplan?: (request: ReplanInput) => void;
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
  /**
   * "definition" for the node's pauseAfter, "replan" for a replan request,
   * "edge_limit" for a decision that chose an edge at its limit, otherwise the
   * caller-supplied label.
   */
  source: string;
  requestedAt: number;
}

/** A graph edit a node suggests to its graph owner; applied only through a GraphUpdate. */
export type ReplanSuggestion = Pick<GraphUpdate, "upsertNodes" | "removeNodeIds" | "addEdges" | "removeEdges">;

/** What a running execution asks of its graph owner. */
export interface ReplanInput {
  /** Why the current plan should change. */
  reason: string;
  suggestion?: ReplanSuggestion;
}

/** A replan request recorded on an execution. */
export interface ReplanRequest extends ReplanInput {
  /** The graph revision the request, and its suggestion, was validated against. */
  revision: number;
  requestedAt: number;
}

/** Frozen snapshots in emission order, including graph revisions and execution identities. */
export type ExecutionEvent = Readonly<
  {
    sequence: number;
    timestamp: number;
    executionId?: string;
    revision?: number;
  } & (
    | { type: "graph_created"; nodeCount: number; edgeCount: number }
    | {
        /** A new pending instance: for a submitted or added node, a clone, or a replacement. */
        type: "execution_created";
        nodeId: string;
        nodeType: BraidNode["type"];
        generation: number;
        cause: "submitted" | "added" | "cloned" | "replaced";
        model?: string;
        /** The instance this one replaces. */
        supersedes?: string;
        /** For a clone: the upstream instance whose edge reached the settled head. */
        trigger?: string;
      }
    | { type: "execution_removed"; nodeId: string }
    | { type: "execution_superseded"; nodeId: string; supersededBy: string }
    | ({ type: "edge_created" } & Edge)
    | { type: "graph_updated"; graph: BraidInput }
    | { type: "execution_paused"; nodeId: string }
    | { type: "execution_resumed"; nodeId: string }
    | { type: "execution_suspending"; nodeId: string; source: string }
    | { type: "execution_suspended"; nodeId: string; source: string }
    | { type: "execution_hold_added"; nodeId: string; source: string }
    | { type: "execution_hold_removed"; nodeId: string; source: string }
    | { type: "replan_requested"; nodeId: string; reason: string; suggestion?: ReplanSuggestion }
    | { type: "graph_paused"; source: string }
    | { type: "graph_resumed" }
    | {
        /**
         * A limit was reached under onLimit: "pause". An edge limit holds the decision
         * that chose the edge; the other limits pause the run.
         */
        type: "limit_reached";
        limit: keyof BraidLimits | "edge";
        /** The limit's value when it was reached. */
        value: number;
        /** The held decision, for an edge limit. */
        nodeId?: string;
        /** The edge at its limit. */
        edge?: Edge;
      }
    | { type: "limits_updated"; limits: Readonly<BraidLimits> }
    | {
        /**
         * The last active execution settled, was held, or suspended, and only held,
         * suspended, or paused work remains. Emitted once per transition into that state.
         */
        type: "graph_waiting";
        /** The execution whose settling or suspension left nothing active. */
        settledExecutionId: string;
        pausedExecutionIds: readonly string[];
        suspendedExecutionIds: readonly string[];
        pause?: Readonly<{ source: string; pausedAt: number }>;
      }
    | { type: "workspace_updated"; workspace: Readonly<NodeWorkspace> }
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

/** Run-wide limits. Each is unlimited when omitted or Infinity. */
export interface BraidLimits {
  /** Total started and skipped executions across rounds and graph updates; pending instances do not count. */
  maxExecutions?: number;
  /** Wall time from the start of the run, including queueing and pauses. */
  graphTimeoutMs?: number;
  /**
   * Total reported input and output tokens across all executions. Checked when an
   * execution settles, so running executions can exceed it.
   */
  maxTokens?: number;
}

export interface BraidOptions extends BraidLimits {
  runner: ModelRunner;
  defaultModel?: string;
  /** Source checkout for the initial snapshot and explicit integrate nodes. */
  cwd?: string;
  /** Positive integer. Defaults to 4. */
  maxConcurrency?: number;
  /** Applied separately to each invocation, starting when it runs and stopped while it is suspended. Default: unlimited. */
  nodeTimeoutMs?: number;
  /**
   * What a node timeout does. "pause" interrupts the current step and suspends the
   * execution until it is resumed or cancelled; it needs an interruptible runner,
   * and other runners fail as with "fail". Default: "pause" for startBraid, and
   * "fail" for braid(), which cannot resume executions.
   */
  onNodeTimeout?: "pause" | "fail";
  /**
   * What reaching an edge limit or a run limit does. "pause" holds the decision
   * that chose the edge, or pauses the run, until the owner raises the limit or
   * decides otherwise; "fail" fails the run with EDGE_LIMIT, EXECUTION_LIMIT,
   * GRAPH_TIMEOUT, or TOKEN_LIMIT. Default: "pause" for startBraid, and "fail" for
   * braid(), which cannot resume.
   */
  onLimit?: "pause" | "fail";
  /** Caller cancellation, independent of node and graph deadlines. */
  signal?: AbortSignal;
  /** Live observer. Throws/rejections are ignored; returned work is not awaited. */
  onEvent?: (event: ExecutionEvent) => void;
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
    | "EDGE_LIMIT"
    | "TOKEN_LIMIT"
    | "REQUIRED_NODE_FAILED"
    | "SCHEDULING_ERROR";
  message: string;
}

/** Output is absent if no valid response was received; status determines success. */
export interface NodeResult extends Partial<NodeOutput> {
  /** The lineage (node) ID. */
  id: string;
  /** `<id>@<generation>`. */
  executionId?: string;
  status: NodeStatus;
  /** Present on a pending instance in snapshots. */
  waitReason?: WaitReason;
  /** True while this settled instance's result is held: its outgoing edges wait for a resume. */
  held?: boolean;
  /** The started instance this one replaced. */
  supersedes?: string;
  /** The instance that replaced this one. Set only on started instances. */
  supersededBy?: string;
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
   * Present when this execution will be held after it settles, from its node's
   * pauseAfter or from BraidRun.holdAfter. Authoritative over node.pauseAfter.
   */
  holdAfter?: ExecutionHold;
  /** Present when this execution asked its graph owner to replan. */
  replan?: ReplanRequest;
}

export interface BraidResult {
  status: "completed" | "failed";
  /** Outputs of completed lineage heads that no other execution consumed; exact IDs are in terminalExecutionIds. */
  terminalOutputs: Record<string, NodeOutput>;
  /** Immutable execution log, including graph revisions and runtime handoffs. */
  events: readonly ExecutionEvent[];
  /** The head of each lineage that was not removed. */
  nodes: Record<string, NodeResult>;
  /** Every instance, including removed lineages and superseded instances. */
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


/**
 * One instance of a lineage. A pending instance is edited in place; once started,
 * its definition and inputs never change.
 */
export interface NodeExecution extends NodeResult {
  executionId: string;
  generation: number;
  node: BraidNode;
  /** The graph revision that created, or last edited, this instance. */
  revision: number;
  /** The inputs it ran with; empty until it starts. */
  predecessorExecutionIds: string[];
}

export interface GraphUpdate {
  expectedRevision: number;
  /**
   * Complete node definitions. A new ID adds a lineage. A not-started head is
   * edited in place. A started head is replaced: a new instance supersedes it,
   * a running head is cancelled, and downstream lineages rerun once it settles.
   */
  upsertNodes?: readonly BraidInputNode[];
  /** Remove lineages with their edges. A pending head is deleted, a running one cancelled; started instances stay in history. */
  removeNodeIds?: readonly string[];
  addEdges?: readonly Edge[];
  /** Edge identities (from, to, choice) to remove; `limit` is ignored. */
  removeEdges?: readonly Edge[];
  promptTemplates?: Readonly<Record<string, string>>;
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
  /** Settled executions whose outgoing edges are held by pauseAfter, holdAfter, a replan request, or an edge limit. */
  pausedExecutionIds: string[];
  /** Running executions stopped at a checkpoint, including resumed ones waiting for a slot. */
  suspendedExecutionIds: string[];
  /**
   * Present while the whole run is paused: no new executions are admitted. A limit
   * under onLimit: "pause" uses source "execution_limit", "graph_timeout", or "token_limit".
   */
  pause?: { source: string; pausedAt: number };
  /** The run's finite limits; unlimited ones are omitted. */
  limits: BraidLimits;
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
  /**
   * Admit executions again and resume the executions that pauseRun paused. Throws
   * while the run is paused by a limit that is still reached; raise it with setLimits first.
   */
  resumeRun(): BraidSnapshot;
  /**
   * Change run limits. Each given limit replaces the current one; Infinity removes it.
   * graphTimeoutMs still counts from the start of the run. Does not resume the run.
   */
  setLimits(limits: BraidLimits): BraidSnapshot;
  /** Cancel the whole run. */
  cancel(): void;
  /**
   * Fail running executions, including paused ones, without cancelling the run.
   * Successors follow the usual failure semantics. A node timeout pause fails with
   * NODE_TIMEOUT, anything else with CANCELLED.
   */
  cancelExecutions(executionIds: readonly string[], options?: CancelExecutionsOptions): BraidSnapshot;
}
