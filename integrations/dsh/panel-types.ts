/** Browser-safe, bounded projections. Prompts and provider messages never enter the panel stream. */
export interface PanelRequest { sessionId: string; jobId?: string; createdBefore?: number }
export interface ControlRequest extends PanelRequest { jobId: string; action: "cancel" | "resume"; revision: number; executionIds: string[] }
/** activityBefore pages earlier activity entries by sequence. */
export interface DetailRequest extends PanelRequest { jobId: string; executionId: string; offset: number; activityBefore?: number }
export interface PanelRow { jobId: string; handle: string; goal: string; status: string; createdAt: number }
/** Live state of one execution; phase timings are host epoch milliseconds. */
export interface PanelActivity {
  phase: string; phaseStartedAt: number; startedAt: number; finishedAt?: number;
  lastActivityAt: number; lastActivity: string; modelRequests: number; toolCalls: number;
  model?: { round: number; startedAt: number; completedAt?: number; firstStreamAt?: number; lastStreamAt?: number;
    streamEvents: number; receivedChars: number; receiving?: string; toolName?: string; tail?: string };
  tools: { callId: string; name: string; startedAt: number; arguments: string; lastOutputAt?: number; outputChars: number; outputTail?: string }[];
  limitations: string[];
  /** Latest entry sequence; changes whenever history grows. */
  sequence: number;
  droppedEntries: number;
}
export interface PanelActivityEntry {
  sequence: number; timestamp: number; kind: string; summary: string;
  detail?: string; detailLength?: number; toolName?: string; durationMs?: number; isError?: boolean;
}
export interface PanelExecution {
  id: string; executionId: string; status: string; type: string; revision: number;
  iteration?: number; loopId?: string; latencyMs?: number;
  progress?: { contextTokens: number; contextWindow?: number; contextSource: string; toolCalls: number; toolRounds: number; phase: string };
  /** Present while running; detail returns history for any execution. */
  activity?: PanelActivity;
}
export interface PanelJob extends PanelRow {
  revision: number; phase: string; error?: string;
  /** Host clock when this frame was built, for elapsed and idle times. */
  observedAt: number;
  nodes: { id: string; type: string; status: string }[];
  edges: { from: string; to: string; choice?: string; feedback?: string; executionId?: string }[];
  loops: { id: string; entry: string; maxIterations: number }[];
  executions: PanelExecution[];
  pausedExecutionIds: string[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  events: { sequence: number; timestamp: number; type: string; executionId?: string; nodeId?: string; message: string }[];
}
export interface PanelFrame { rows: PanelRow[]; job: PanelJob | null }
export interface PanelDetail {
  executionId: string; status: string; output: string; offset: number; next: number; total: number;
  decision?: string; error?: string; workspace?: string;
  /** Up to 50 entries before activityBefore (or the latest), chronological. */
  activity?: PanelActivity & { entries: PanelActivityEntry[] };
}
export interface PanelApi {
  watch(request: PanelRequest, signal: AbortSignal): AsyncIterable<PanelFrame>;
  control(request: ControlRequest): Promise<PanelFrame>;
  detail(request: DetailRequest): Promise<PanelDetail>;
}
