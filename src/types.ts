export interface ExecuteNode {
  type: "execute";
  id: string;
  prompt: string;
  model?: string;
}

export interface DecisionNode {
  type: "decision";
  id: string;
  prompt: string;
  choices: readonly string[];
  model?: string;
}

export interface MergeNode {
  type: "merge";
  id: string;
  /** Defaults to reviewing and integrating all predecessor workspaces. */
  prompt?: string;
  model?: string;
}

export type BraidNode = ExecuteNode | DecisionNode | MergeNode;

export interface NodeWorkspace {
  nodeId: string;
  mode: "read-only" | "worktree" | "merge";
  workingDirectory: string;
  worktreeRoot?: string;
  sourceRoot?: string;
  baseCommit?: string;
  snapshotCommit?: string;
  checkpointRef?: string;
  checkpointCommit?: string;
  /** Source checkout snapshot captured before a merge agent receives write access. */
  backupRef?: string;
  state: "preparing" | "ready" | "integrated" | "discarded" | "archived" | "failed";
  reason?: string;
}

export interface MergeDisposition {
  nodeId: string;
  disposition: "integrated" | "discarded" | "archived";
  reason: string;
}

export interface GitPreview {
  text: string;
  truncated: boolean;
}

export interface MergeSource extends NodeWorkspace {
  /** Inspection-only summaries relative to snapshotCommit; omitted by custom runners. */
  changes?: { files: string[]; filesTruncated: boolean; stat: GitPreview; diff: GitPreview };
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
}

export interface BraidInput {
  goal: string;
  nodes: readonly BraidNode[];
  edges: readonly Edge[];
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

export interface NodeOutput {
  output: string;
  decision?: string;
  model?: string;
}

export interface PredecessorOutput extends NodeOutput {
  nodeId: string;
  /** Failed predecessors remain available on unconditional edges. */
  error?: ExecutionError;
  workspace?: NodeWorkspace;
}

export interface ExecutionContext {
  runId: string;
  /** Equal to runId in v0.1; reserved identity for future shared-root accounting. */
  rootRunId: string;
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
  /** Finite deadlines on the performance.now() clock; absent scopes are unlimited. */
  deadlines?: { node?: number; graph?: number };
  workspace?: NodeWorkspace;
  /** Adapters must wrap mutating file tools so cancellation and cleanup wait for in-flight writes. */
  withWorkspaceWrite?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Local Git operations: inspection for workers, integration commands for merge nodes. */
  git?: (args: string[], input?: string) => Promise<GitResult>;
  /** Merge nodes must account for every source before returning their final answer. */
  merge?: {
    sources: MergeSource[];
    sourceStatus?: SourceCheckoutStatus;
    finish: (dispositions: MergeDisposition[]) => Promise<void>;
  };
  /** Present only on decision nodes. An adapter exposes this as the decide tool. */
  decide?: (choice: string) => void;
}

export interface ModelResponse {
  output: string;
  /** The actual model reported by the provider, if known. */
  model?: string;
  usage?: TokenUsage;
}

/** Each call must start a fresh model conversation and expose no other tools. */
export type ModelRunner = (request: ModelRequest) => Promise<ModelResponse>;

/** Frozen snapshots in emission order. Creation means admission of the submitted DAG, not mutation. */
export type ExecutionEvent = Readonly<
  {
    sequence: number;
    timestamp: number;
  } & (
    | { type: "graph_created"; nodeCount: number; edgeCount: number }
    | {
        type: "node_created";
        nodeId: string;
        nodeType: BraidNode["type"];
        model?: string;
      }
    | { type: "edge_created"; from: string; to: string; choice?: string }
    | { type: "workspace_updated"; workspace: Readonly<NodeWorkspace> }
    | { type: "node_runnable"; nodeId: string }
    | {
        type: "handoff";
        from: string;
        to: string;
        output: string;
        decision?: string;
      }
    | { type: "node_started"; nodeId: string; model?: string }
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
  /** Source checkout. Git workspace management is automatic; outside Git, nodes are read-only. */
  cwd?: string;
  /** Positive integer. Defaults to 4. */
  maxConcurrency?: number;
  /** Applied separately to each invocation, starting when it runs. Default: 60s. Infinity disables it. */
  nodeTimeoutMs?: number;
  /** Includes queueing and execution of the entire graph. Default: 5 minutes. Infinity disables it. */
  graphTimeoutMs?: number;
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
    | "CLEANUP_FAILED";
  message: string;
}

/** Output is absent if no valid response was received; status determines success. */
export interface NodeResult extends Partial<NodeOutput> {
  id: string;
  status: NodeStatus;
  usage?: TokenUsage;
  startedAt?: number;
  finishedAt?: number;
  latencyMs?: number;
  error?: ExecutionError;
  skipReason?: "inactive" | "upstream_failed" | "graph_timeout" | "cancelled";
  workspace?: NodeWorkspace;
}

export interface BraidResult {
  status: "completed" | "failed";
  /** Completed nodes with no active outgoing edges in this execution. */
  terminalOutputs: Record<string, NodeOutput>;
  /** Immutable execution log, including graph construction and runtime handoffs. */
  events: readonly ExecutionEvent[];
  nodes: Record<string, NodeResult>;
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
