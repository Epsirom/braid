import type { ExecutionEvent, ModelRequest } from "./types.js";

/**
 * What a running execution is observed doing. `workspace` and `finalizing` are
 * core work before and after the runner; `worker` is runner work between model
 * and tool steps.
 */
export type ExecutionActivityPhase =
  | "workspace"
  | "worker"
  | "model"
  | "tool"
  | "finalizing"
  | "completed"
  | "failed";

/** One chronological observation. Details are bounded previews, never full transcripts. */
export interface ExecutionActivityEntry {
  /** Per-execution, starting at 1; stable across trimming for paging. */
  sequence: number;
  timestamp: number;
  kind:
    | "lifecycle"
    | "workspace"
    | "model_request"
    | "model_response"
    | "model_error"
    | "assistant"
    | "reasoning"
    | "tool_call"
    | "tool_result";
  /** One line for lists. */
  summary: string;
  /** Bounded preview, shown on demand. */
  detail?: string;
  /** Length of the original detail when the preview is truncated. */
  detailLength?: number;
  round?: number;
  toolCallId?: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
}

/** The current model request. Stream fields stay absent until the provider sends anything. */
export interface ExecutionModelActivity {
  round: number;
  startedAt: number;
  completedAt?: number;
  firstStreamAt?: number;
  lastStreamAt?: number;
  streamEvents: number;
  /** Characters of text, reasoning, and tool-call arguments received so far. */
  receivedChars: number;
  receiving?: "text" | "reasoning" | "tool_call";
  /** Tool whose arguments are being streamed, when the provider names it. */
  toolName?: string;
  /** Last streamed characters, bounded. */
  tail?: string;
}

export interface ExecutionToolActivity {
  callId: string;
  name: string;
  startedAt: number;
  arguments: string;
  lastOutputAt?: number;
  outputChars: number;
  outputTail?: string;
}

export interface ExecutionActivity {
  executionId: string;
  nodeId: string;
  startedAt: number;
  finishedAt?: number;
  phase: ExecutionActivityPhase;
  phaseStartedAt: number;
  /** Any observed signal, including stream chunks and tool output. */
  lastActivityAt: number;
  lastActivity: string;
  modelRequests: number;
  toolCalls: number;
  /** Latest model request; completedAt is set once it has returned. */
  model?: ExecutionModelActivity;
  /** Tools currently running. */
  tools: ExecutionToolActivity[];
  /** Signals this host or provider cannot observe. Missing activity is not a stall. */
  limitations: string[];
  entries: ExecutionActivityEntry[];
  /** Sequence of the latest entry, including entries trimmed from history. */
  sequence: number;
  /** Older entries removed to bound memory; their summaries are no longer available. */
  droppedEntries: number;
}

export interface ExecutionActivityPage {
  /** Return entries with a lower sequence, for loading earlier history. */
  before?: number;
  /** Maximum entries returned: the latest ones before `before`, in chronological order. */
  limit?: number;
}

export interface ExecutionActivityOptions {
  /** Entries retained per execution. Default: 200. */
  maxEntries?: number;
  /** Characters retained per entry detail. Default: 2000. */
  maxDetailChars?: number;
  /** Finished executions that keep their entries; older ones keep only the summary. Default: 50. */
  maxRetainedHistories?: number;
  /** Discrete changes, and stream/tool output at most once per second per execution. */
  onChange?: () => void;
  now?: () => number;
}

/** Runner instrumentation for one execution. Methods never throw. */
export interface ExecutionActivityRecorder {
  limitation(text: string): void;
  modelRequest(): void;
  modelStream(kind: "text" | "reasoning" | "tool_call", delta: string, toolName?: string): void;
  modelResponse(response: {
    text?: string;
    reasoning?: string;
    toolCalls?: readonly { id: string; name: string }[];
    stopReason?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void;
  modelError(message: string): void;
  toolStart(callId: string, name: string, args: unknown): void;
  /** Append an output chunk, or replace it with a cumulative snapshot. */
  toolOutput(callId: string, text: string, mode?: "append" | "replace"): void;
  toolEnd(callId: string, result: string, isError: boolean): void;
}

const TAIL = 240;
const THROTTLE_MS = 1000;

function oneLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

interface Tracked extends ExecutionActivity {
  notifiedAt: number;
}

/**
 * Per-job, bounded activity history keyed by execution ID. Feed core events
 * through observe() and give runners a recorder(); observation never changes
 * execution semantics.
 */
export class ExecutionActivityTracker {
  private readonly records = new Map<string, Tracked>();
  private readonly finished: string[] = [];
  private readonly maxEntries: number;
  private readonly maxDetailChars: number;
  private readonly maxRetainedHistories: number;
  private readonly now: () => number;

  constructor(private readonly options: ExecutionActivityOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxDetailChars = options.maxDetailChars ?? 2000;
    this.maxRetainedHistories = options.maxRetainedHistories ?? 50;
    this.now = options.now ?? Date.now;
    for (const [name, value] of Object.entries({
      maxEntries: this.maxEntries, maxDetailChars: this.maxDetailChars, maxRetainedHistories: this.maxRetainedHistories,
    })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }

  /** Core lifecycle: workspace preparation, worker start, checkpoints, and completion. */
  observe(event: ExecutionEvent): void {
    this.safely(() => {
      if (!event.executionId) return;
      if (event.type === "workspace_updated") {
        const record = this.ensure(event.executionId, event.workspace.nodeId, event.timestamp);
        const workspace = event.workspace;
        this.add(record, {
          kind: "workspace",
          summary: `Workspace ${workspace.state} · ${workspace.mode}${workspace.reason ? ` · ${oneLine(workspace.reason, 100)}` : ""}`,
          ...this.preview(workspace.worktreeRoot ?? workspace.checkpointRef ?? workspace.workingDirectory),
        }, event.timestamp);
      } else if (event.type === "node_started") {
        const record = this.ensure(event.executionId, event.nodeId, event.timestamp);
        if (record.phase === "workspace") this.phase(record, "worker", event.timestamp);
        this.add(record, { kind: "lifecycle", summary: `Worker started${event.model ? ` · ${event.model}` : ""}` }, event.timestamp);
      } else if (event.type === "node_completed" || event.type === "node_failed") {
        const record = this.ensure(event.executionId, event.nodeId, event.timestamp);
        const failed = event.type === "node_failed";
        record.finishedAt = event.timestamp;
        record.tools = [];
        this.phase(record, failed ? "failed" : "completed", event.timestamp);
        this.add(record, {
          kind: "lifecycle",
          summary: failed ? `Failed · ${event.error.code}: ${oneLine(event.error.message, 120)}` : `Completed in ${seconds(event.latencyMs)}`,
          durationMs: event.latencyMs,
          ...(failed ? { isError: true, ...this.preview(event.error.message) } : {}),
        }, event.timestamp);
        this.retire(record.executionId);
      }
    });
  }

  /** A no-op recorder when the request has no execution identity. */
  recorder(request: Pick<ModelRequest, "node" | "execution">): ExecutionActivityRecorder {
    const executionId = request.execution.executionId;
    const record = () => executionId === undefined ? undefined : this.ensure(executionId, request.node.id, this.now());
    const run = (action: (record: Tracked) => void) => this.safely(() => {
      const value = record();
      if (value && value.finishedAt === undefined) action(value);
    });
    return {
      limitation: text => run(value => {
        if (value.limitations.includes(text)) return;
        value.limitations.push(text);
        this.changed();
      }),
      modelRequest: () => run(value => {
        const now = this.now();
        value.modelRequests++;
        value.model = { round: value.modelRequests, startedAt: now, streamEvents: 0, receivedChars: 0 };
        this.phase(value, "model", now);
        this.add(value, { kind: "model_request", summary: `Model request #${value.modelRequests} sent`, round: value.modelRequests }, now);
      }),
      modelStream: (kind, delta, toolName) => run(value => {
        const model = value.model;
        if (!model || model.completedAt !== undefined) return;
        const now = this.now();
        model.firstStreamAt ??= now;
        model.lastStreamAt = now;
        model.streamEvents++;
        model.receivedChars += delta.length;
        if (model.receiving !== kind || (toolName && model.toolName !== toolName)) model.tail = "";
        model.receiving = kind;
        if (kind === "tool_call" && toolName) model.toolName = toolName;
        else if (kind !== "tool_call") delete model.toolName;
        model.tail = ((model.tail ?? "") + delta).slice(-TAIL);
        value.lastActivityAt = now;
        value.lastActivity = kind === "tool_call"
          ? `Receiving ${model.toolName ?? "tool call"} arguments`
          : kind === "reasoning" ? "Receiving model reasoning" : "Receiving model output";
        this.throttled(value, now);
      }),
      modelResponse: response => run(value => {
        const now = this.now();
        const model = value.model;
        if (model) model.completedAt = now;
        const calls = response.toolCalls ?? [];
        const usage = response.inputTokens !== undefined || response.outputTokens !== undefined
          ? ` · ${response.inputTokens ?? 0} in / ${response.outputTokens ?? 0} out tokens` : "";
        this.add(value, {
          kind: "model_response",
          summary: `Model response #${model?.round ?? value.modelRequests}${model ? ` · ${seconds(now - model.startedAt)}` : ""}` +
            `${response.stopReason ? ` · ${response.stopReason}` : ""}${calls.length ? ` · ${calls.length} tool call${calls.length === 1 ? "" : "s"}: ${oneLine(calls.map(call => call.name).join(", "), 80)}` : ""}${usage}`,
          ...(model ? { round: model.round, durationMs: now - model.startedAt } : {}),
        }, now);
        if (response.reasoning?.trim()) {
          this.add(value, { kind: "reasoning", summary: `Reasoning · ${response.reasoning.length} chars`, ...this.preview(response.reasoning) }, now);
        }
        if (response.text?.trim()) {
          this.add(value, { kind: "assistant", summary: oneLine(response.text), ...this.preview(response.text) }, now);
        }
        this.phase(value, "worker", now);
      }),
      modelError: message => run(value => {
        const now = this.now();
        const model = value.model;
        if (model) model.completedAt ??= now;
        this.add(value, {
          kind: "model_error", summary: `Model request failed · ${oneLine(message, 120)}`, isError: true, ...this.preview(message),
          ...(model ? { round: model.round, durationMs: now - model.startedAt } : {}),
        }, now);
      }),
      toolStart: (callId, name, args) => run(value => {
        const now = this.now();
        const serialized = serialize(args);
        value.toolCalls++;
        value.tools.push({ callId, name, startedAt: now, arguments: serialized.slice(0, TAIL), outputChars: 0 });
        this.phase(value, "tool", now);
        this.add(value, {
          kind: "tool_call", summary: `${name} ${oneLine(serialized, 120)}`, toolCallId: callId, toolName: name, ...this.preview(serialized),
        }, now);
      }),
      toolOutput: (callId, text, mode = "append") => run(value => {
        const tool = value.tools.find(tool => tool.callId === callId);
        if (!tool) return;
        const now = this.now();
        if (mode === "replace" && text.length === tool.outputChars && text.endsWith(tool.outputTail ?? "")) return;
        tool.lastOutputAt = now;
        tool.outputChars = mode === "replace" ? text.length : tool.outputChars + text.length;
        tool.outputTail = (mode === "replace" ? text : (tool.outputTail ?? "") + text).slice(-TAIL);
        value.lastActivityAt = now;
        value.lastActivity = `${tool.name} produced output`;
        this.throttled(value, now);
      }),
      toolEnd: (callId, result, isError) => run(value => {
        const now = this.now();
        const index = value.tools.findIndex(tool => tool.callId === callId);
        const tool = index < 0 ? undefined : value.tools.splice(index, 1)[0];
        const name = tool?.name ?? "tool";
        this.add(value, {
          kind: "tool_result",
          summary: `${name} ${isError ? "failed" : "finished"}${tool ? ` · ${seconds(now - tool.startedAt)}` : ""} · ${oneLine(result, 100) || "no output"}`,
          toolCallId: callId, toolName: name, isError, ...this.preview(result),
          ...(tool ? { durationMs: now - tool.startedAt } : {}),
        }, now);
        if (!value.tools.length) this.phase(value, "worker", now);
      }),
    };
  }

  /** The runner returned or threw; core now drains writes, checkpoints, and cleans up. */
  workerFinished(executionId: string | undefined): void {
    this.safely(() => {
      const record = executionId === undefined ? undefined : this.records.get(executionId);
      if (!record || record.finishedAt !== undefined) return;
      const now = this.now();
      record.tools = [];
      this.phase(record, "finalizing", now);
      this.add(record, { kind: "lifecycle", summary: "Worker returned · checkpoint and cleanup" }, now);
    });
  }

  /** A copy, with an optional page of entries (latest `limit` entries before `before`). */
  get(executionId: string, page: ExecutionActivityPage = {}): ExecutionActivity | undefined {
    const record = this.records.get(executionId);
    if (!record) return undefined;
    const { notifiedAt: _notifiedAt, entries, ...activity } = record;
    const before = page.before ?? Infinity;
    const eligible = entries.filter(entry => entry.sequence < before);
    const limit = page.limit ?? eligible.length;
    return structuredClone({ ...activity, entries: limit > 0 ? eligible.slice(-limit) : [] });
  }

  private ensure(executionId: string, nodeId: string, timestamp: number): Tracked {
    let record = this.records.get(executionId);
    if (!record) {
      record = {
        executionId, nodeId, startedAt: timestamp, phase: "workspace", phaseStartedAt: timestamp,
        lastActivityAt: timestamp, lastActivity: "Preparing workspace", modelRequests: 0, toolCalls: 0,
        tools: [], limitations: [], entries: [], sequence: 0, droppedEntries: 0, notifiedAt: 0,
      };
      this.records.set(executionId, record);
    }
    return record;
  }

  private phase(record: Tracked, phase: ExecutionActivityPhase, timestamp: number): void {
    if (record.phase === phase) return;
    record.phase = phase;
    record.phaseStartedAt = timestamp;
  }

  private add(record: Tracked, entry: Omit<ExecutionActivityEntry, "sequence" | "timestamp">, timestamp: number): void {
    record.sequence++;
    record.entries.push({ sequence: record.sequence, timestamp, ...entry });
    record.lastActivityAt = timestamp;
    record.lastActivity = entry.summary;
    const excess = record.entries.length - this.maxEntries;
    if (excess > 0) {
      record.entries.splice(0, excess);
      record.droppedEntries += excess;
    }
    this.changed();
  }

  private preview(text: string | undefined): Pick<ExecutionActivityEntry, "detail" | "detailLength"> {
    if (!text) return {};
    return text.length <= this.maxDetailChars
      ? { detail: text }
      : { detail: `${text.slice(0, this.maxDetailChars)}…`, detailLength: text.length };
  }

  private retire(executionId: string): void {
    if (this.finished.includes(executionId)) return;
    this.finished.push(executionId);
    while (this.finished.length > this.maxRetainedHistories) {
      const record = this.records.get(this.finished.shift()!);
      if (!record) continue;
      record.droppedEntries += record.entries.length;
      record.entries = [];
    }
  }

  private throttled(record: Tracked, now: number): void {
    if (now - record.notifiedAt < THROTTLE_MS) return;
    record.notifiedAt = now;
    this.changed();
  }

  private changed(): void {
    try { this.options.onChange?.(); }
    catch { /* Observers cannot fail a worker. */ }
  }

  private safely(action: () => void): void {
    try { action(); }
    catch { /* Diagnostics must never affect execution. */ }
  }
}

/** One line: current phase, time in phase, and time since the last observed signal. */
export function formatActivityStatus(activity: ExecutionActivity, now: number): string {
  const end = activity.finishedAt ?? now;
  const parts = [`${activity.phase} for ${seconds(Math.max(0, end - activity.phaseStartedAt))}`];
  const model = activity.model;
  if (activity.phase === "model" && model && model.completedAt === undefined) {
    parts.push(model.firstStreamAt === undefined
      ? `request #${model.round} awaiting first stream event`
      : `request #${model.round} streaming ${model.receiving ?? "output"}${model.toolName ? ` (${model.toolName})` : ""}, ${model.receivedChars} chars`);
  }
  for (const tool of activity.tools) parts.push(`${tool.name} running ${seconds(Math.max(0, now - tool.startedAt))}`);
  if (activity.finishedAt === undefined) parts.push(`last activity ${seconds(Math.max(0, now - activity.lastActivityAt))} ago`);
  parts.push(`total ${seconds(Math.max(0, end - activity.startedAt))}`);
  return parts.join(" · ");
}
