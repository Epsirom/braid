/** Browser-safe, bounded projections. Prompts and provider messages never enter the panel stream. */
export interface PanelRequest { sessionId: string; jobId?: string; createdBefore?: number }
export interface ControlRequest extends PanelRequest { jobId: string; action: "cancel" | "resume"; revision: number; executionIds: string[] }
export interface DetailRequest extends PanelRequest { jobId: string; executionId: string; offset: number }
export interface PanelRow { jobId: string; handle: string; goal: string; status: string; createdAt: number }
export interface PanelExecution {
  id: string; executionId: string; status: string; type: string; revision: number;
  iteration?: number; loopId?: string; latencyMs?: number;
  progress?: { contextTokens: number; contextWindow?: number; contextSource: string; toolCalls: number; toolRounds: number; phase: string };
}
export interface PanelJob extends PanelRow {
  revision: number; phase: string; error?: string;
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
}
export interface PanelApi {
  watch(request: PanelRequest, signal: AbortSignal): AsyncIterable<PanelFrame>;
  control(request: ControlRequest): Promise<PanelFrame>;
  detail(request: DetailRequest): Promise<PanelDetail>;
}
