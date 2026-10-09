import type { Theme } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid } from "grok-mermaid";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  BraidResult,
  ExecutionError,
  ExecutionEvent,
  NodeResult,
  NodeWorkspace as PiNodeWorkspace,
} from "@chrok/braid";
import type { PiNodeProgress } from "./runner.js";

export const MAX_VISIBLE_EVENTS = 80;
export const MAX_VISIBLE_NODES = 80;

/** Only previews are retained here; final results contain the full core log. */
export interface BraidLiveState {
  status: "running" | "completed" | "failed";
  error?: ExecutionError;
  nodes: Record<string, NodeResult>;
  nodeTypes: Record<string, "execute" | "decision" | "merge" | "integrate">;
  edges: Array<{ from: string; to: string; choice?: string }>;
  progress: Record<string, PiNodeProgress>;
  events: ExecutionEvent[];
  latencyMs: number;
  observedAt: number;
  revision?: number;
  pausedExecutionIds?: string[];
  iterations?: Record<string, number>;
}
export type BraidToolDetails =
  | ((BraidResult | BraidLiveState) & {
      fullOutputPath?: string;
      progress?: Record<string, PiNodeProgress>;
      workspaces?: Record<string, PiNodeWorkspace>;
    })
  | undefined;
type Palette = Pick<Theme, "fg" | "bg" | "bold">;

class FixedLines implements Component {
  constructor(
    private readonly lines: string[],
    private readonly chartStart = lines.length,
    private readonly chartLength = 0,
  ) {}

  render(width: number): string[] {
    const chart = this.lines.slice(
      this.chartStart,
      this.chartStart + this.chartLength,
    );
    if (chart.length === 0)
      return this.lines.map((line) => truncateToWidth(line, width, ""));
    const chartWidth = Math.max(...chart.map((line) => visibleWidth(line)));
    const chartOutput =
      chartWidth <= width
        ? chart
        : [
            truncateToWidth(
              `[Flowchart needs ${chartWidth} columns; terminal width is ${width}. Expand your terminal to see it.]`,
              width,
              "",
            ),
          ];
    const output: string[] = [];
    let chartInserted = false;
    for (let index = 0; index < this.lines.length; index++) {
      if (index === this.chartStart) {
        output.push(...chartOutput);
        chartInserted = true;
      }
      if (
        index < this.chartStart ||
        index >= this.chartStart + this.chartLength
      ) {
        output.push(truncateToWidth(this.lines[index]!, width, ""));
      }
    }
    if (!chartInserted) output.push(...chartOutput);
    return output;
  }

  invalidate(): void {}
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compact(value: unknown, max = 90): string {
  if (typeof value !== "string") return "…";
  // Node IDs and model output are untrusted terminal content, not ANSI markup.
  const line = stripTerminalSequences(value)
    .replace(/\p{Cc}|\s+/gu, " ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function graphParts(result: BraidResult | BraidLiveState): {
  nodes: Record<string, NodeResult>;
  nodeTypes: Record<string, "execute" | "decision" | "merge" | "integrate">;
  edges: Array<{ from: string; to: string; choice?: string }>;
  progress: Record<string, PiNodeProgress>;
} {
  if ("nodeTypes" in result) return result;
  const nodes: Record<string, NodeResult> = Object.assign(
    Object.create(null),
    result.nodes,
  );
  const nodeTypes: Record<string, "execute" | "decision" | "merge" | "integrate"> = Object.create(null);
  const edges: Array<{ from: string; to: string; choice?: string }> = [];
  for (const event of result.events) {
    if (event.type === "graph_updated") {
      edges.splice(0, edges.length, ...event.graph.edges);
      for (const node of event.graph.nodes) {
        nodes[node.id] ??= { id: node.id, status: "pending" };
        Object.defineProperty(nodeTypes, node.id, { value: node.type, enumerable: true, configurable: true });
      }
      for (const id of Object.keys(nodes)) if (!event.graph.nodes.some(node => node.id === id)) { delete nodes[id]; delete nodeTypes[id]; }
    } else if (event.type === "node_created") {
      nodes[event.nodeId] ??= { id: event.nodeId, status: "pending" };
      if (
        event.model !== undefined &&
        nodes[event.nodeId]!.model === undefined
      ) {
        nodes[event.nodeId]!.model = event.model;
      }
      Object.defineProperty(nodeTypes, event.nodeId, {
        value: event.nodeType,
        enumerable: true,
        configurable: true,
      });
    } else if (event.type === "edge_created") {
      edges.push({
        from: event.from,
        to: event.to,
        ...(event.choice ? { choice: event.choice } : {}),
      });
    }
  }
  const progress: Record<string, PiNodeProgress> =
    "progress" in result &&
    result.progress !== undefined &&
    typeof result.progress === "object"
      ? (result.progress as Record<string, PiNodeProgress>)
      : Object.create(null);
  return { nodes, nodeTypes, edges, progress };
}

function compactCount(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function elapsed(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function nodeElapsed(node: NodeResult, now: number): string {
  if (node.latencyMs !== undefined) return elapsed(node.latencyMs);
  if (node.status === "running" && node.startedAt !== undefined) {
    return elapsed(Math.max(0, now - node.startedAt));
  }
  return "—";
}

function mermaidLabelLines(
  id: string,
  result: BraidResult | BraidLiveState,
): string[] {
  const progress = "progress" in result ? result.progress?.[id] : undefined;
  const node = result.nodes[id];
  if (!node) return [compact(id, 24), "pending"];
  const icon =
    node.status === "running"
      ? "▶ ACTIVE"
      : {
          completed: "✓",
          failed: "✗",
          skipped: "·",
          runnable: "◇",
          pending: "○",
        }[node.status];
  const status = node.status === "completed" ? "done" : node.status;
  const decision =
    node.decision === undefined ? "" : ` → ${compact(node.decision, 16)}`;
  const now = "observedAt" in result ? result.observedAt : Date.now();
  const iteration = "executions" in result ? result.executions[node.executionId ?? ""]?.iteration : result.iterations?.[id];
  const lines = [
    `${icon} ${compact(id, 24)}${iteration ? ` #${iteration}` : ""}`,
    `${status}${decision} · ${nodeElapsed(node, now)}`,
  ];
  if (progress) {
    const window =
      progress.contextWindow === undefined
        ? "—"
        : compactCount(progress.contextWindow);
    const prefix = progress.contextSource === "estimate" ? "~" : "";
    lines.push(
      `${prefix}${compactCount(progress.contextTokens)}/${window} · T${progress.toolCalls}`,
    );
  }
  return lines;
}

function mermaidSource(result: BraidResult | BraidLiveState): string {
  const parts = graphParts(result);
  const ids = Object.keys(parts.nodes);
  const names = new Map(ids.map((id, index) => [id, `n${index}`]));
  const escapeMermaidText = (value: string) =>
    stripTerminalSequences(value)
      .replace(/\p{Cc}/gu, "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/\|/g, "&#124;")
      .replace(
        /[[\]{}<>]/g,
        (character) =>
          ({
            "[": "&#91;",
            "]": "&#93;",
            "{": "&#123;",
            "}": "&#125;",
            "<": "&lt;",
            ">": "&gt;",
          })[character] ?? character,
      );
  const lines = ["flowchart TD"];
  for (const id of ids) {
    const shape = parts.nodeTypes[id] === "decision" ? "{" : "[";
    const close = parts.nodeTypes[id] === "decision" ? "}" : "]";
    lines.push(
      `  ${names.get(id)}${shape}"${mermaidLabelLines(id, result).map(escapeMermaidText).join("<br/>")}"${close}`,
    );
  }
  for (const edge of parts.edges) {
    lines.push(
      `  ${names.get(edge.from)} -->${edge.choice ? `|${escapeMermaidText(edge.choice)}|` : ""} ${names.get(edge.to)}`,
    );
  }
  return lines.join("\n");
}

function mermaidLines(
  result: BraidResult | BraidLiveState,
  theme: Palette,
): string[] {
  const art = renderMermaid(mermaidSource(result));
  if (!art) return [];
  return art.styled.map((row) =>
    row
      .map((span) => {
        switch (span.cls) {
          case "border":
            return theme.fg("borderMuted", span.text);
          case "text":
            return span.text.includes("▶ ACTIVE")
              ? theme.bg(
                  "selectedBg",
                  theme.bold(theme.fg("accent", span.text)),
                )
              : theme.fg("text", span.text);
          case "edge":
            return theme.fg("accent", span.text);
          case "edgeLabel":
            return theme.fg("muted", span.text);
          case "title":
            return theme.fg("accent", theme.bold(span.text));
          default:
            return span.text;
        }
      })
      .join(""),
  );
}

export function renderGraphCall(args: unknown, theme: Palette): Component {
  // Pi renders partially streamed tool arguments, including incomplete array items.
  const partial = record(args) ? args : {};
  const nodes = Array.isArray(partial.nodes)
    ? partial.nodes.filter(record)
    : [];
  const edges = Array.isArray(partial.edges)
    ? partial.edges.filter(record)
    : [];
  const options = record(partial.options) ? partial.options : {};
  const decisions = nodes.filter((node) => node.type === "decision").length;
  const route = edges
    .slice(0, 5)
    .map(
      (edge) =>
        `${compact(edge.from, 30)}${edge.choice ? ` -${compact(edge.choice, 20)}->` : " →"} ${compact(edge.to, 30)}`,
    )
    .join("  ");
  const nodeLabels = nodes
    .slice(0, 8)
    .map(
      (node) =>
        `${node.type === "decision" ? "◇" : "○"} ${compact(node.id, 30)}`,
    );
  return new FixedLines([
    theme.fg("toolTitle", "◆ Braid"),
    theme.fg(
      "muted",
      `${nodes.length} nodes (${decisions} decision) · ${edges.length} edges · max ${options.maxConcurrency ?? 4}`,
    ),
    theme.fg("dim", `goal: ${compact(partial.goal)}`),
    theme.fg(
      "accent",
      `nodes: ${nodeLabels.join("  ")}${nodes.length > 8 ? `  +${nodes.length - 8} more` : ""}`,
    ),
    theme.fg(
      "dim",
      route
        ? `graph: ${route}${edges.length > 5 ? `  +${edges.length - 5} more` : ""}`
        : "graph: no edges yet",
    ),
  ]);
}

function eventText(event: ExecutionEvent): string {
  switch (event.type) {
    case "graph_updated": return `graph updated · revision ${event.revision}`;
    case "execution_paused": return `paused · ${compact(event.nodeId, 40)} · ${event.executionId}`;
    case "execution_resumed": return `resumed · ${compact(event.nodeId, 40)} · ${event.executionId}`;
    case "loop_started": return `loop ${compact(event.loopId, 40)} · iteration ${event.iteration}`;
    case "loop_completed": return `loop ${compact(event.loopId, 40)} completed · iteration ${event.iteration}`;
    case "graph_created":
      return `graph created · ${event.nodeCount} nodes · ${event.edgeCount} edges`;
    case "node_created":
      return `node created · ${compact(event.nodeId, 40)} (${event.nodeType})${event.model ? ` · ${compact(event.model, 50)}` : ""}`;
    case "edge_created":
      return `edge created · ${compact(event.from, 40)}${event.choice ? ` -${compact(event.choice, 30)}->` : " →"} ${compact(event.to, 40)}`;
    case "workspace_updated":
      return `workspace · ${compact(event.workspace.nodeId, 40)} · ${event.workspace.state}`;
    case "node_runnable":
      return `runnable · ${compact(event.nodeId, 40)}`;
    case "handoff":
      return `handoff · ${compact(event.from, 40)} → ${compact(event.to, 40)}: ${compact(event.output, 64)}`;
    case "node_started":
      return `started · ${compact(event.nodeId, 40)}${event.model ? ` · ${compact(event.model, 50)}` : ""}`;
    case "node_completed":
      return `completed · ${compact(event.nodeId, 40)}${event.decision ? ` → ${compact(event.decision, 30)}` : ""}: ${compact(event.output, 64)}`;
    case "node_skipped":
      return `skipped · ${compact(event.nodeId, 40)} (${event.reason})`;
    case "node_failed":
      return `failed · ${compact(event.nodeId, 40)} (${event.error.code}): ${compact(event.error.message, 64)}`;
    case "graph_completed":
      return `graph completed · terminals: ${compact(event.terminalNodeIds.join(", "), 80) || "none"}`;
    case "graph_failed":
      return `graph failed · ${event.error.code}: ${compact(event.error.message, 80)}`;
  }
}

function renderEventLog(
  events: readonly ExecutionEvent[],
  expanded: boolean,
  theme: Palette,
): string[] {
  if (!events.length) return [];
  const visible = events.slice(-(expanded ? MAX_VISIBLE_EVENTS : 8));
  const total = events.at(-1)!.sequence;
  const lines = [theme.fg("dim", `execution log · ${total} events:`)];
  if (visible[0]!.sequence > 1) {
    lines.push(
      theme.fg(
        "dim",
        `  … ${visible[0]!.sequence - 1} earlier events${expanded ? " (see full result)" : " (expand for more)"}`,
      ),
    );
  }
  for (const event of visible) {
    const color = event.type.endsWith("failed")
      ? "error"
      : event.type.endsWith("completed")
        ? "success"
        : event.type === "node_started"
          ? "accent"
          : "dim";
    lines.push(
      theme.fg(
        color,
        `  ${String(event.sequence).padStart(3, "0")} ${eventText(event)}`,
      ),
    );
  }
  return lines;
}

export function createLiveState(): BraidLiveState {
  return {
    status: "running",
    nodes: Object.create(null),
    nodeTypes: Object.create(null),
    edges: [],
    progress: Object.create(null),
    events: [],
    latencyMs: 0,
    observedAt: Date.now(), revision: 0, pausedExecutionIds: [], iterations: Object.create(null),
  };
}

export function applyEvent(state: BraidLiveState, event: ExecutionEvent): void {
  // Keep per-update payloads bounded, without discarding any events from the core result.
  const preview = { ...event };
  if ("output" in preview && preview.output !== undefined)
    preview.output = compact(preview.output, 180);
  if ("error" in preview)
    preview.error = {
      ...preview.error,
      message: compact(preview.error.message, 180),
    };
  state.events.push(preview);
  if (event.type === "node_created")
    Object.defineProperty(state.nodeTypes, event.nodeId, {
      value: event.nodeType,
      enumerable: true,
      configurable: true,
    });
  if (event.type === "edge_created")
    state.edges.push({
      from: event.from,
      to: event.to,
      ...(event.choice ? { choice: event.choice } : {}),
    });
  if (state.events.length > MAX_VISIBLE_EVENTS) state.events.shift();
  if (event.type === "graph_completed" || event.type === "graph_failed") {
    state.status = event.type === "graph_completed" ? "completed" : "failed";
    state.pausedExecutionIds = [];
    if (event.type === "graph_failed") state.error = { ...event.error };
    return;
  }
  if (event.type === "node_created") {
    Object.defineProperty(state.nodes, event.nodeId, {
      value: {
        id: event.nodeId,
        status: "pending",
        ...(event.model ? { model: event.model } : {}),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  if (event.type === "graph_updated") {
    state.revision = event.revision ?? state.revision ?? 0;
    state.edges = structuredClone([...event.graph.edges]);
    for (const id of Object.keys(state.nodes)) if (!event.graph.nodes.some(node => node.id === id)) {
      delete state.nodes[id]; delete state.nodeTypes[id]; delete state.progress[id];
    }
    for (const node of event.graph.nodes) {
      Object.defineProperty(state.nodeTypes, node.id, { value: node.type, enumerable: true, configurable: true });
      if (!Object.hasOwn(state.nodes, node.id)) Object.defineProperty(state.nodes, node.id, {
        value: { id: node.id, status: "pending" }, enumerable: true, configurable: true, writable: true,
      });
    }
  }
  if (event.type === "execution_paused") state.pausedExecutionIds = [...(state.pausedExecutionIds ?? []), event.executionId!];
  if (event.type === "execution_resumed") state.pausedExecutionIds = state.pausedExecutionIds?.filter(id => id !== event.executionId) ?? [];
  const node =
    "nodeId" in event && Object.hasOwn(state.nodes, event.nodeId)
      ? state.nodes[event.nodeId]
      : undefined;
  if (!node) return;
  if (event.type === "node_runnable" || event.type === "node_skipped") {
    for (const key of Object.keys(node)) if (key !== "id") delete (node as unknown as Record<string, unknown>)[key];
    if (event.executionId) node.executionId = event.executionId;
    delete state.progress[node.id];
    if (event.iteration !== undefined) {
      state.iterations ??= Object.create(null) as Record<string, number>;
      state.iterations[node.id] = event.iteration;
    }
  } else if (event.executionId && node.executionId && event.executionId !== node.executionId) return;
  switch (event.type) {
    case "node_runnable":
      node.status = "runnable";
      break;
    case "node_started":
      node.status = "running";
      node.startedAt = event.timestamp;
      break;
    case "node_completed":
    case "node_failed":
      node.status = event.type === "node_completed" ? "completed" : "failed";
      node.finishedAt = event.timestamp;
      node.latencyMs = event.latencyMs;
      if (event.output !== undefined) node.output = compact(event.output, 180);
      if (event.decision !== undefined) node.decision = event.decision;
      if (event.model !== undefined) node.model = event.model;
      if (event.usage !== undefined) node.usage = { ...event.usage };
      if (event.type === "node_failed")
        node.error = {
          ...event.error,
          message: compact(event.error.message, 180),
        };
      break;
    case "node_skipped":
      node.status = "skipped";
      node.skipReason = event.reason;
      node.finishedAt = event.timestamp;
      break;
  }
}

export function applyProgress(
  state: BraidLiveState,
  progress: PiNodeProgress,
): void {
  if (progress.executionId && state.nodes[progress.nodeId]?.executionId !== progress.executionId) return;
  Object.defineProperty(state.progress, progress.nodeId, {
    value: progress,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Focused status reads must show the requested execution, including historical ones. */
export function renderNodeResult(
  node: NodeResult & { iteration?: number },
  expanded: boolean,
  theme: Palette,
  fullOutputPath?: string,
  progress?: PiNodeProgress,
  now = Date.now(),
): Component {
  const failed = node.status === "failed";
  const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  const timing = [
    ...(node.model ? [`model ${compact(node.model, 60)}`] : []),
    ...(node.iteration ? [`iteration #${node.iteration}`] : []),
    ...(node.startedAt !== undefined || node.latencyMs !== undefined ? [`elapsed ${nodeElapsed(node, now)}`] : []),
    ...(node.usage ? [`${compactCount(node.usage.inputTokens)} in / ${compactCount(node.usage.outputTokens)} out tokens`] : []),
  ];
  // Progress is tracked per node ID; only show it for the execution it describes.
  const live = progress && (!progress.executionId || progress.executionId === node.executionId) ? progress : undefined;
  const workspace = node.workspace;
  // Cleaned-up worktrees are gone; their checkpoint ref is what can be recovered.
  const workspaceActive = workspace && ["preparing", "ready", "failed"].includes(workspace.state);
  const workspaceRef = workspaceActive ? workspace.worktreeRoot : workspace?.checkpointRef ?? workspace?.reason;
  const lines = [
    theme.fg(failed ? "error" : "accent", `${failed ? "✗" : node.status === "completed" ? "✓" : "○"} Braid node ${compact(node.id, 80)} · ${node.status}`),
    ...(node.executionId ? [theme.fg("dim", `execution: ${compact(node.executionId, 80)}`)] : []),
    ...(timing.length ? [theme.fg("muted", timing.join(" · "))] : []),
    ...(live ? [theme.fg("muted", `context ${live.contextSource === "estimate" ? "~" : ""}${compactCount(live.contextTokens)}/${live.contextWindow === undefined ? "—" : compactCount(live.contextWindow)} · ${live.toolCalls} tool calls in ${live.toolRounds} rounds · ${live.phase} phase`)] : []),
    ...(workspace ? [theme.fg("dim", `workspace: ${workspace.mode} · ${workspace.state}${workspaceRef ? ` · ${compact(workspaceRef, 160)}` : ""}`)] : []),
    ...(node.decision ? [theme.fg("accent", `decision: ${compact(node.decision, 80)}`)] : []),
    ...(node.error ? [theme.fg("error", `${node.error.code}: ${clean(node.error.message)}`)] : []),
    ...(node.skipReason ? [theme.fg("muted", `skipped: ${node.skipReason}`)] : []),
    ...(node.output ? [expanded ? clean(node.output) : compact(node.output, 400)] : []),
    ...(!expanded && node.output && (node.output.length > 400 || node.output.includes("\n")) ? [theme.fg("dim", "Expand for full node output")] : []),
    ...(fullOutputPath ? [theme.fg("dim", `full node result: ${compact(fullOutputPath, 240)}`)] : []),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

export function renderGraphResult(
  result: BraidToolDetails,
  expanded: boolean,
  isPartial: boolean,
  theme: Palette,
  fallback = "",
  isError = false,
): Component {
  if (isError || !result?.nodes) {
    const message =
      fallback ||
      (isPartial ? "Braid is running…" : "Braid returned no execution details");
    return new Text(
      theme.fg(isError ? "error" : "warning", compact(message, 500)),
      0,
      0,
    );
  }
  const nodes = Object.values(result.nodes);
  const completed = nodes.filter((node) => node.status === "completed").length;
  const skipped = nodes.filter((node) => node.status === "skipped").length;
  const failed = nodes.filter((node) => node.status === "failed").length;
  const active = nodes.filter((node) => node.status === "running").length;
  const pending = nodes.filter(
    (node) => node.status === "pending" || node.status === "runnable",
  ).length;
  const elapsedMs =
    "metadata" in result ? result.metadata.latencyMs : result.latencyMs;
  const title =
    result.status === "running"
      ? theme.fg("warning", "⟳ Braid executing")
      : result.status === "completed"
        ? theme.fg("success", "✓ Braid completed")
        : result.error?.code === "CANCELLED"
          ? theme.fg("warning", "■ Braid cancelled")
          : theme.fg("error", "✗ Braid failed");
  const lines = [
    title,
    theme.fg(
      "muted",
      `${completed}/${nodes.length} completed · ${result.status === "running" ? `${active} active · ${pending} pending · ` : ""}${skipped} skipped · ${failed} failed · ${elapsed(elapsedMs)}`,
    ),
  ];
  if ("terminalOutputs" in result) {
    const terminals = Object.keys(result.terminalOutputs);
    if (terminals.length)
      lines.push(
        theme.fg("accent", `terminals: ${compact(terminals.join(", "), 120)}`),
      );
  }
  if (result.error) lines.push(theme.fg("error", `${result.error.code}: ${compact(result.error.message, 120)}`));
  if ("pausedExecutionIds" in result && result.pausedExecutionIds?.length) lines.push(theme.fg("warning", `${result.pausedExecutionIds.length} paused executions · revision ${result.revision ?? 0}`));
  if ("executions" in result) lines.push(theme.fg("dim", `${Object.keys(result.executions).length} executions · revision ${result.revision}`));
  const chartStart = lines.length;
  const chart = mermaidLines(result, theme);
  lines.push(...chart);
  const workspaces = Object.values(result.workspaces ?? {}).filter(workspace => workspace.worktreeRoot);
  if (workspaces.length) {
    const active = workspaces.filter(workspace => ["preparing", "ready", "failed"].includes(workspace.state)).length;
    lines.push(theme.fg("accent", `workspaces: ${active} active · ${workspaces.length - active} cleaned${expanded ? "" : " (expand for recovery refs)"}`));
    if (expanded) {
      for (const workspace of workspaces.slice(0, MAX_VISIBLE_NODES)) {
        const active = ["preparing", "ready", "failed"].includes(workspace.state);
        lines.push(theme.fg("dim", `  ${compact(workspace.nodeId, 40)} · ${workspace.state}: ${compact(active ? workspace.worktreeRoot : workspace.checkpointRef ?? workspace.reason, 240)}`));
      }
    }
  }
  if (expanded) lines.push(...renderEventLog(result.events ?? [], true, theme));
  if ("fullOutputPath" in result && result.fullOutputPath)
    lines.push(
      theme.fg(
        "dim",
        `full result/log: ${compact(result.fullOutputPath, 240)}`,
      ),
    );
  return new FixedLines(lines, chartStart, chart.length);
}
