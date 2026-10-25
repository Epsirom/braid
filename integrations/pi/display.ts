import type { Theme } from "@earendil-works/pi-coding-agent";
import { render as renderMermaid } from "grok-mermaid";
import {
  Text,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  closingEdges,
  formatActivityStatus,
  formatPauseSource,
  type BraidResult,
  type Edge,
  type ExecutionActivity,
  type ExecutionError,
  type ExecutionEvent,
  type NodeExecution,
  type NodeResult,
  type NodeWorkspace as PiNodeWorkspace,
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
  edges: Edge[];
  progress: Record<string, PiNodeProgress>;
  events: ExecutionEvent[];
  latencyMs: number;
  observedAt: number;
  revision?: number;
  pausedExecutionIds?: string[];
  suspendedExecutionIds?: string[];
  /** Present while the whole job is paused. */
  pause?: { source: string; pausedAt: number };
  /** The generation of each node's head, from its execution ID. */
  generations?: Record<string, number>;
  /** Every instance, when a run snapshot is attached for display; the stored state never holds it. */
  executions?: Record<string, NodeExecution>;
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
  /**
   * A too-wide chart is cropped to the terminal width around the first
   * `focusMarks` entry drawn in it (the selected node, then a running node),
   * or from its left edge. `fallback` (a node list while selecting) appears when
   * there is no chart, or when the selected node cannot be found in it.
   */
  constructor(
    private readonly lines: string[],
    private readonly chartStart = lines.length,
    private readonly chartLength = 0,
    private readonly fallback: readonly string[] = [],
    private readonly focusMarks: readonly { mark: string; label: string }[] = [],
  ) {}

  render(width: number): string[] {
    const chart = this.lines.slice(
      this.chartStart,
      this.chartStart + this.chartLength,
    );
    const fallback = this.fallback.map((line) => truncateToWidth(line, width, ""));
    if (chart.length === 0 && fallback.length === 0)
      return this.lines.map((line) => truncateToWidth(line, width, ""));
    const chartWidth = chart.length ? Math.max(...chart.map((line) => visibleWidth(line))) : 0;
    let chartOutput = chart;
    if (!chart.length) chartOutput = fallback;
    else if (chartWidth > width) {
      const focus = this.focus(chart);
      const start = focus === undefined ? 0 : Math.max(0, Math.min(chartWidth - width, focus.column - Math.floor(width / 2)));
      chartOutput = [
        truncateToWidth(`[chart ${start + 1}–${start + width} of ${chartWidth} cols${focus ? ` · ${focus.label}` : ""}]`, width, ""),
        ...chart.map((line) => sliceByColumn(line, start, width, true)),
        // The first mark is the selection; list nodes if it is not drawn.
        ...(this.focusMarks.length && focus?.mark !== this.focusMarks[0]!.mark ? fallback : []),
      ];
    }
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

  /** The first focus mark drawn in the chart and its centre column. */
  private focus(chart: readonly string[]): { mark: string; label: string; column: number } | undefined {
    for (const { mark, label } of this.focusMarks) {
      for (const line of chart) {
        const plain = stripTerminalSequences(line);
        const index = plain.indexOf(mark);
        if (index < 0) continue;
        // Centre on the label: from the mark to the node's right border, when drawn.
        const border = plain.indexOf("│", index);
        const end = border < 0 ? index : border;
        return { mark, label, column: Math.floor((visibleWidth(plain.slice(0, index)) + visibleWidth(plain.slice(0, end))) / 2) };
      }
    }
    return undefined;
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
  edges: Edge[];
  progress: Record<string, PiNodeProgress>;
} {
  if ("nodeTypes" in result) return result;
  const nodes: Record<string, NodeResult> = Object.assign(
    Object.create(null),
    result.nodes,
  );
  const nodeTypes: Record<string, "execute" | "decision" | "merge" | "integrate"> = Object.create(null);
  const edges: Edge[] = [];
  for (const event of result.events) {
    if (event.type === "graph_updated") {
      edges.splice(0, edges.length, ...event.graph.edges);
      for (const node of event.graph.nodes) {
        nodes[node.id] ??= { id: node.id, status: "pending" };
        Object.defineProperty(nodeTypes, node.id, { value: node.type, enumerable: true, configurable: true });
      }
      for (const id of Object.keys(nodes)) if (!event.graph.nodes.some(node => node.id === id)) { delete nodes[id]; delete nodeTypes[id]; }
    } else if (event.type === "execution_created") {
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
        ...(event.limit !== undefined ? { limit: event.limit } : {}),
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

/** Replaces the selected node's one-column status icon, so selection never moves the layout. */
export const SELECTED_NODE_MARK = "◆";

/** The two views of the execution-only graph in the panel. */
export type GraphView = "heads" | "history";
/** Generations of each lineage the history view keeps expanded by default. */
export const HISTORY_ROUNDS = 2;

/** One box per instance; older settled instances of a lineage fold into one box per lineage. */
export interface HistoryLayout {
  shown: NodeExecution[];
  folded: Map<string, NodeExecution[]>;
}

const settled = (record: NodeResult) =>
  (record.status === "completed" || record.status === "failed" || record.status === "skipped") && !record.held;

/**
 * Pending, running, and held instances always stay expanded, as do the last
 * HISTORY_ROUNDS generations of each lineage (every generation with `all`).
 * Past MAX_VISIBLE_NODES boxes, the oldest settled instances fold first.
 */
export function historyLayout(executions: Record<string, NodeExecution>, all = false): HistoryLayout {
  const records = Object.values(executions);
  const latest = new Map<string, number>();
  for (const record of records) latest.set(record.id, Math.max(latest.get(record.id) ?? 0, record.generation));
  const keep = new Set(records.filter(record => all || !settled(record) || record.generation > latest.get(record.id)! - HISTORY_ROUNDS));
  for (const record of records) {
    if (keep.size <= MAX_VISIBLE_NODES) break;
    if (settled(record) && record.generation < latest.get(record.id)!) keep.delete(record);
  }
  const folded = new Map<string, NodeExecution[]>();
  for (const record of records) {
    if (!keep.has(record)) (folded.get(record.id) ?? folded.set(record.id, []).get(record.id)!).push(record);
  }
  return { shown: records.filter(record => keep.has(record)), folded };
}

function statusIcon(node: NodeResult, selected: boolean): string {
  const suspended = node.suspension && node.suspension.state !== "pausing";
  const icon =
    suspended
      ? "‖ PAUSED"
      : node.status === "running"
      ? "▶ ACTIVE"
      : {
          completed: "✓",
          failed: "✗",
          skipped: "⊘",
          pending: "○",
        }[node.status];
  return selected ? SELECTED_NODE_MARK + icon.slice(1) : icon;
}

/** Status with the pending wait reason, the running sub-state, or the hold. */
function statusText(node: NodeResult, now: number, progress?: PiNodeProgress): string {
  if (node.suspension)
    return `${node.suspension.state}${node.suspension.source === "node_timeout" ? " · timed out" : ""} · ${nodeElapsed(node, now)}`;
  const decision = node.decision === undefined ? "" : ` → ${compact(node.decision, 16)}`;
  switch (node.status) {
    case "pending":
      return node.waitReason ? `pending · waits ${node.waitReason.replace("_", " ")}` : "pending";
    case "running":
      return `running${progress && (!progress.executionId || progress.executionId === node.executionId) ? ` · ${progress.phase}` : ""}${node.holdAfter ? " · hold" : ""} · ${nodeElapsed(node, now)}`;
    case "skipped":
      return `skipped${node.skipReason ? ` · ${node.skipReason.replace("_", " ")}` : ""}`;
    default:
      return `${node.status === "completed" ? "done" : "failed"}${decision}${node.held ? " · held" : ""} · ${nodeElapsed(node, now)}`;
  }
}

function progressText(progress: PiNodeProgress): string {
  const window = progress.contextWindow === undefined ? "—" : compactCount(progress.contextWindow);
  const prefix = progress.contextSource === "estimate" ? "~" : "";
  return `${prefix}${compactCount(progress.contextTokens)}/${window} · T${progress.toolCalls}`;
}

/** Started instances and reported tokens of each lineage. */
function lineageTotals(executions: Record<string, NodeExecution> | undefined): Map<string, { runs: number; tokens: number }> {
  const totals = new Map<string, { runs: number; tokens: number }>();
  for (const record of Object.values(executions ?? {})) {
    const total = totals.get(record.id) ?? totals.set(record.id, { runs: 0, tokens: 0 }).get(record.id)!;
    if (record.status !== "pending" && record.status !== "skipped") total.runs++;
    if (record.usage) total.tokens += record.usage.inputTokens + record.usage.outputTokens;
  }
  return totals;
}

/** A lineage head: status, runs, and the lineage's usage. */
function mermaidLabelLines(
  id: string,
  result: BraidResult | BraidLiveState,
  selected = false,
  totals = lineageTotals(result.executions),
): string[] {
  const progress = "progress" in result ? result.progress?.[id] : undefined;
  const live = result.nodes[id];
  if (!live) return [compact(id, 24), "pending"];
  const head = live.executionId ? result.executions?.[live.executionId] : undefined;
  // Snapshot records carry the derived wait reason and hold marker.
  const node = { ...live, ...(head?.waitReason ? { waitReason: head.waitReason } : {}), ...(head?.held ? { held: true } : {}) };
  const now = "observedAt" in result ? result.observedAt : Date.now();
  const generation = head?.generation ?? ("generations" in result ? result.generations?.[id] : undefined);
  const { runs, tokens: used } = totals.get(id) ?? { runs: 0, tokens: 0 };
  const lines = [
    `${statusIcon(node, selected)} ${compact(id, 24)}${generation && generation > 1 ? `@${generation}` : ""}`,
    statusText(node, now, progress),
  ];
  if (runs || used) lines.push(`${runs} run${runs === 1 ? "" : "s"}${used ? ` · ${compactCount(used)} tok` : ""}`);
  if (progress && node.status === "running") lines.push(progressText(progress));
  return lines;
}

/** One instance: its exact ID, status, and whether it was superseded or removed. */
function historyLabelLines(record: NodeExecution, result: BraidResult | BraidLiveState, selected: boolean): string[] {
  const progress = "progress" in result ? result.progress?.[record.id] : undefined;
  const now = "observedAt" in result ? result.observedAt : Date.now();
  const lines = [`${statusIcon(record, selected)} ${compact(record.executionId, 24)}`, statusText(record, now, progress)];
  if (record.supersededBy) lines.push(`superseded → ${compact(record.supersededBy, 16)}`);
  else if (!Object.hasOwn(result.nodes, record.id)) lines.push("removed");
  if (progress && record.status === "running" && progress.executionId === record.executionId) lines.push(progressText(progress));
  return lines;
}

function foldedLabelLines(records: readonly NodeExecution[]): string[] {
  const first = records[0]!;
  const last = records.at(-1)!;
  const counts = (["completed", "failed", "skipped"] as const)
    .map(status => [status, records.filter(record => record.status === status).length] as const)
    .filter(([, count]) => count)
    .map(([status, count]) => `${count} ${status === "completed" ? "done" : status}`);
  return [
    `≡ ${compact(first.id, 18)}@${first.generation}${records.length > 1 ? `–${last.generation}` : ""}`,
    `${records.length} earlier · ${counts.join(" ")}`,
  ];
}

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

function closingOf(parts: ReturnType<typeof graphParts>): Set<Edge> {
  return new Set(closingEdges({ nodes: Object.entries(parts.nodeTypes).map(([id, type]) => ({ id, type })), edges: parts.edges }));
}

function mermaidSource(result: BraidResult | BraidLiveState, selected?: string): string {
  const parts = graphParts(result);
  const closing = closingOf(parts);
  const closingSources = new Map([...closing].map(edge => [edge.to, edge.from]));
  const ids = Object.keys(parts.nodes);
  const names = new Map(ids.map((id, index) => [id, `n${index}`]));
  const totals = lineageTotals(result.executions);
  const lines = ["flowchart TD"];
  for (const id of ids) {
    const shape = parts.nodeTypes[id] === "decision" ? "{" : "[";
    const close = parts.nodeTypes[id] === "decision" ? "}" : "]";
    lines.push(
      `  ${names.get(id)}${shape}"${mermaidLabelLines(id, result, id === selected, totals).map(escapeMermaidText).join("<br/>")}"${close}`,
    );
  }
  for (const edge of parts.edges) {
    // Distinguish the direct data handoff from its reverse retry edge.
    const arrow = !closing.has(edge) && closingSources.get(edge.from) === edge.to ? "-.->" : "-->";
    lines.push(
      `  ${names.get(edge.from)} ${arrow}${edge.choice ? `|${escapeMermaidText(edge.choice)}|` : ""} ${names.get(edge.to)}`,
    );
  }
  return lines.join("\n");
}

/**
 * The history view: a flat, acyclic graph of instances, so each round of a cycle
 * is drawn below the one before it. Solid edges are the inputs an instance ran
 * with; dotted edges are the inputs a pending instance will use or a skipped one
 * saw, and "replaces" links a replaced instance to its replacement.
 */
function historySource(result: BraidResult | BraidLiveState, all: boolean, selected?: string): string {
  const executions = result.executions ?? {};
  const { shown, folded } = historyLayout(executions, all);
  const parts = graphParts(result);
  const closing = closingOf(parts);
  const names = new Map<string, string>();
  const lines = ["flowchart TD"];
  for (const [id, records] of folded) {
    const name = `f${names.size}`;
    for (const record of records) names.set(record.executionId, name);
    lines.push(`  ${name}("${foldedLabelLines(records).map(escapeMermaidText).join("<br/>")}")`);
  }
  shown.forEach((record, index) => {
    names.set(record.executionId, `e${index}`);
    const [open, close] = record.node.type === "decision" ? ["{", "}"] : ["[", "]"];
    lines.push(`  e${index}${open}"${historyLabelLines(record, result, record.executionId === selected).map(escapeMermaidText).join("<br/>")}"${close}`);
  });
  const drawn = new Set<string>();
  const link = (from: NodeExecution | undefined, to: NodeExecution, arrow: string, label?: string) => {
    const source = from && names.get(from.executionId);
    const target = names.get(to.executionId);
    const line = `  ${source} ${arrow}${label ? `|${escapeMermaidText(label)}|` : ""} ${target}`;
    if (!source || !target || source === target || drawn.has(line)) return;
    drawn.add(line);
    lines.push(line);
  };
  const decision = (record: NodeExecution) => record.node.type === "decision" ? record.decision : undefined;
  const records = Object.values(executions);
  const lineages = new Map<string, NodeExecution[]>();
  for (const record of records) (lineages.get(record.id) ?? lineages.set(record.id, []).get(record.id)!).push(record);
  for (const record of records) {
    for (const id of record.predecessorExecutionIds) {
      const source = executions[id];
      if (source) link(source, record, "-->", decision(source));
    }
    if (record.supersedes) link(executions[record.supersedes], record, "-.->", "replaces");
    if (record.status !== "pending" && record.status !== "skipped") continue;
    // Not started, or skipped without inputs: draw the upstream instance it will use or saw.
    for (const edge of parts.edges) {
      if (edge.to !== record.id) continue;
      const lineage = lineages.get(edge.from) ?? [];
      const source = record.status === "pending"
        ? lineage.at(-1)
        : lineage.filter(source => source.finishedAt !== undefined && source.finishedAt <= record.finishedAt!).at(-1);
      if (!source || record.predecessorExecutionIds.includes(source.executionId)) continue;
      // A cycle-closing edge reaches an instance only after its source fired.
      if (closing.has(edge) && (record.status === "skipped" || !settled(source))) continue;
      link(source, record, "-.->", edge.choice);
    }
  }
  return lines.join("\n");
}

function mermaidLines(
  result: BraidResult | BraidLiveState,
  theme: Palette,
  selected?: string,
  options: GraphViewOptions = {},
): string[] {
  let art: ReturnType<typeof renderMermaid>;
  try {
    art = renderMermaid(options.view === "history" ? historySource(result, options.allHistory ?? false, selected) : mermaidSource(result, selected));
  } catch {
    // The chart is a view of state already listed elsewhere; never fail the panel for it.
    return [];
  }
  if (!art) return [];
  return art.styled.map((row) =>
    row
      .map((span) => {
        switch (span.cls) {
          case "border":
            return theme.fg("borderMuted", span.text);
          case "text":
            if (selected !== undefined && span.text.includes(SELECTED_NODE_MARK))
              return theme.bg("selectedBg", theme.bold(theme.fg("warning", span.text)));
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
    case "execution_suspending": return `pausing · ${compact(event.nodeId, 40)} · by ${compact(formatPauseSource(event.source), 20)}`;
    case "execution_suspended": return `suspended · ${compact(event.nodeId, 40)} · by ${compact(formatPauseSource(event.source), 20)}`;
    case "execution_hold_added": return `hold added · ${compact(event.nodeId, 40)} · by ${compact(event.source, 20)}`;
    case "execution_hold_removed": return `hold removed · ${compact(event.nodeId, 40)} · by ${compact(event.source, 20)}`;
    case "replan_requested": return `replan requested · ${compact(event.nodeId, 40)}: ${compact(event.reason, 64)}`;
    case "graph_paused": return `job paused · by ${compact(event.source, 20)}`;
    case "graph_resumed": return "job resumed";
    case "limit_reached": return `limit reached · ${event.edge ? `edge ${compact(event.edge.from, 30)} → ${compact(event.edge.to, 30)}` : event.limit} ${event.value}${event.nodeId ? ` · holds ${compact(event.nodeId, 40)}` : ""}`;
    case "limits_updated": return `limits updated · ${Object.entries(event.limits).map(([key, value]) => `${key} ${value}`).join(", ") || "none"}`;
    case "graph_waiting": return `nothing active · ${event.pausedExecutionIds.length} held · ${event.suspendedExecutionIds.length} suspended${event.pause ? " · job paused" : ""}`;
    case "graph_created":
      return `graph created · ${event.nodeCount} nodes · ${event.edgeCount} edges`;
    case "execution_created":
      return `${event.cause === "submitted" || event.cause === "added" ? "node created" : event.cause === "cloned" ? "rerun" : "replaced"} · ${compact(event.executionId ?? event.nodeId, 40)} (${event.nodeType})${event.model ? ` · ${compact(event.model, 50)}` : ""}`;
    case "execution_removed":
      return `removed · ${compact(event.executionId ?? event.nodeId, 40)}`;
    case "execution_superseded":
      return `superseded · ${compact(event.executionId ?? event.nodeId, 40)} by ${compact(event.supersededBy, 40)}`;
    case "edge_created":
      return `edge created · ${compact(event.from, 40)}${event.choice ? ` -${compact(event.choice, 30)}->` : " →"} ${compact(event.to, 40)}`;
    case "workspace_updated":
      return `workspace · ${compact(event.workspace.nodeId, 40)} · ${event.workspace.state}`;
    case "handoff":
      return `handoff · ${compact(event.from, 40)} → ${compact(event.to, 40)}: ${compact(event.output, 64)}`;
    case "node_started":
      return `started · ${compact(event.nodeId, 40)}${event.model ? ` · ${compact(event.model, 50)}` : ""}`;
    case "human_input":
      return `human input · ${compact(event.nodeId, 40)}: ${compact(event.text, 64)}`;
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
          : event.type === "human_input"
            ? "warning"
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
    observedAt: Date.now(), revision: 0, pausedExecutionIds: [], suspendedExecutionIds: [], generations: Object.create(null),
  };
}

export function applyEvent(state: BraidLiveState, event: ExecutionEvent): void {
  // Keep per-update payloads bounded, without discarding any events from the core result.
  const preview = { ...event };
  if ("output" in preview && preview.output !== undefined)
    preview.output = compact(preview.output, 180);
  if (preview.type === "human_input") preview.text = compact(preview.text, 180);
  if ("error" in preview)
    preview.error = {
      ...preview.error,
      message: compact(preview.error.message, 180),
    };
  state.events.push(preview);
  if (event.type === "execution_created")
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
      ...(event.limit !== undefined ? { limit: event.limit } : {}),
    });
  if (state.events.length > MAX_VISIBLE_EVENTS) state.events.shift();
  if (event.type === "graph_completed" || event.type === "graph_failed") {
    state.status = event.type === "graph_completed" ? "completed" : "failed";
    state.pausedExecutionIds = [];
    state.suspendedExecutionIds = [];
    delete state.pause;
    if (event.type === "graph_failed") state.error = { ...event.error };
    return;
  }
  if (event.type === "execution_created") {
    // The new instance becomes the node's head.
    Object.defineProperty(state.nodes, event.nodeId, {
      value: {
        id: event.nodeId,
        status: "pending",
        ...(event.executionId ? { executionId: event.executionId } : {}),
        ...(event.model ? { model: event.model } : {}),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    delete state.progress[event.nodeId];
    state.generations ??= Object.create(null) as Record<string, number>;
    state.generations[event.nodeId] = event.generation;
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
  if (event.type === "graph_paused") state.pause = { source: event.source, pausedAt: event.timestamp };
  if (event.type === "graph_resumed") delete state.pause;
  if (event.type === "execution_suspended") state.suspendedExecutionIds = [...(state.suspendedExecutionIds ?? []), event.executionId!];
  if (event.type === "execution_resumed") state.pausedExecutionIds = state.pausedExecutionIds?.filter(id => id !== event.executionId) ?? [];
  if (event.type === "execution_resumed" || event.type === "node_completed" || event.type === "node_failed")
    state.suspendedExecutionIds = state.suspendedExecutionIds?.filter(id => id !== event.executionId) ?? [];
  const node =
    "nodeId" in event && Object.hasOwn(state.nodes, event.nodeId)
      ? state.nodes[event.nodeId]
      : undefined;
  if (!node) return;
  // Events of an earlier instance, such as a replaced one that is still stopping, do not change the head.
  if (event.executionId && node.executionId && event.executionId !== node.executionId) return;
  switch (event.type) {
    case "node_started":
      node.status = "running";
      node.startedAt = event.timestamp;
      break;
    case "execution_suspending":
      node.suspension = { state: "pausing", source: event.source, requestedAt: event.timestamp };
      break;
    case "execution_suspended":
      node.suspension = { state: "suspended", source: event.source, requestedAt: node.suspension?.requestedAt ?? event.timestamp, suspendedAt: event.timestamp };
      break;
    case "execution_resumed":
      delete node.suspension;
      break;
    case "execution_hold_added":
      node.holdAfter = { source: event.source, requestedAt: event.timestamp };
      break;
    case "execution_hold_removed":
      delete node.holdAfter;
      break;
    case "node_completed":
    case "node_failed":
      delete node.suspension;
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
    case "human_input":
      node.humanInputs = [...(node.humanInputs ?? []), { text: compact(event.text, 180), timestamp: event.timestamp }];
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

export const COLLAPSED_ACTIVITY_ENTRIES = 6;

/** Live phase, waits, and chronological history; absence of activity is shown, not judged. */
export function renderActivity(
  activity: ExecutionActivity,
  expanded: boolean,
  theme: Palette,
  now: number,
  part: "all" | "summary" | "history" = "all",
): string[] {
  const ago = (at: number) => elapsed(Math.max(0, now - at));
  if (part === "history") return renderActivity(activity, expanded, theme, now).slice(renderActivity(activity, expanded, theme, now, "summary").length);
  const lines = [theme.fg(activity.finishedAt === undefined ? "accent" : "muted", `activity: ${compact(formatActivityStatus(activity, now), 200)}`)];
  const model = activity.model;
  if (model && model.completedAt === undefined) {
    lines.push(theme.fg("muted", model.firstStreamAt === undefined
      ? `  model request #${model.round} sent ${ago(model.startedAt)} ago · no stream events received yet`
      : `  model request #${model.round} sent ${ago(model.startedAt)} ago · ${model.streamEvents} stream events, ${compactCount(model.receivedChars)} chars · last ${ago(model.lastStreamAt!)} ago`));
    if (model.tail) lines.push(theme.fg("dim", `  receiving ${model.receiving === "tool_call" ? `${compact(model.toolName ?? "tool call", 40)} arguments` : model.receiving ?? "output"}: …${compact(model.tail, 160)}`));
  }
  for (const tool of activity.tools) {
    lines.push(theme.fg("warning", `  tool ${compact(tool.name, 40)} running ${ago(tool.startedAt)} · ${tool.lastOutputAt === undefined ? "no output yet" : `last output ${ago(tool.lastOutputAt)} ago`}`));
    lines.push(theme.fg("dim", `    args: ${compact(tool.arguments, 200)}`));
    if (tool.outputTail) lines.push(theme.fg("dim", `    output: …${compact(tool.outputTail, 200)}`));
  }
  for (const limitation of activity.limitations) lines.push(theme.fg("muted", `  unavailable: ${compact(limitation, 200)}`));
  if (part === "summary") return lines;
  const visible = expanded ? activity.entries : activity.entries.slice(-COLLAPSED_ACTIVITY_ENTRIES);
  const hidden = activity.droppedEntries + activity.entries.length - visible.length;
  lines.push(theme.fg("dim", `history · ${activity.sequence} events${hidden ? ` · ${hidden} earlier ${expanded ? "trimmed" : "hidden (expand for more)"}` : ""}:`));
  for (const entry of visible) {
    const color = entry.isError ? "error" : entry.kind === "tool_call" ? "accent" : entry.kind === "assistant" ? "text" : entry.kind === "human_input" ? "warning" : "muted";
    lines.push(theme.fg(color, `  ${`+${elapsed(Math.max(0, entry.timestamp - activity.startedAt))}`.padStart(7)} ${compact(entry.summary, 200)}`));
    // Show a detail preview only when the summary line does not already contain it.
    if (expanded && entry.detail && entry.kind !== "workspace" && !compact(entry.summary, 400).includes(compact(entry.detail, 400))) {
      lines.push(theme.fg("dim", `          ${compact(entry.detail, 300)}${entry.detailLength ? ` (${compactCount(entry.detailLength)} chars)` : ""}`));
    }
  }
  return lines;
}

/** Focused status reads must show the requested execution, including historical ones. */
export function renderNodeResult(
  node: NodeResult,
  expanded: boolean,
  theme: Palette,
  fullOutputPath?: string,
  progress?: PiNodeProgress,
  now = Date.now(),
  activity?: ExecutionActivity,
): Component {
  const failed = node.status === "failed";
  const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  const timing = [
    ...(node.model ? [`model ${compact(node.model, 60)}`] : []),
    ...(node.supersededBy ? [`superseded by ${compact(node.supersededBy, 80)}`] : []),
    ...(node.waitReason ? [`waiting: ${node.waitReason.replace("_", " ")}`] : []),
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
    // Activity describes one execution; never mix histories from repeated visits.
    ...(activity && activity.executionId === node.executionId ? renderActivity(activity, expanded, theme, now) : []),
    ...(node.output ? [expanded ? clean(node.output) : compact(node.output, 400)] : []),
    ...(!expanded && node.output && (node.output.length > 400 || node.output.includes("\n")) ? [theme.fg("dim", "Expand for full node output")] : []),
    ...(fullOutputPath ? [theme.fg("dim", `full text: ${compact(fullOutputPath, 240)}`)] : []),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

/** Status, timing, and live waits above a node's session transcript. */
export function renderSessionHeader(
  node: NodeResult,
  theme: Palette,
  now: number,
  progress?: PiNodeProgress,
  activity?: ExecutionActivity,
): string[] {
  const failed = node.status === "failed";
  const live = progress && (!progress.executionId || progress.executionId === node.executionId) ? progress : undefined;
  const facts = [
    ...(node.executionId ? [compact(node.executionId, 80)] : []),
    ...(node.supersededBy ? [`superseded by ${compact(node.supersededBy, 80)}`] : []),
    ...(node.model ? [compact(node.model, 60)] : []),
    ...(node.startedAt !== undefined || node.latencyMs !== undefined ? [`elapsed ${nodeElapsed(node, now)}`] : []),
    ...(node.usage ? [`${compactCount(node.usage.inputTokens)} in / ${compactCount(node.usage.outputTokens)} out tokens`] : []),
  ];
  return [
    theme.fg(failed ? "error" : "accent", `${failed ? "✗" : node.status === "completed" ? "✓" : node.status === "running" ? "▶" : "○"} Braid node ${compact(node.id, 80)} · ${node.status}`),
    ...(facts.length ? [theme.fg("muted", facts.join(" · "))] : []),
    ...(live ? [theme.fg("muted", `context ${live.contextSource === "estimate" ? "~" : ""}${compactCount(live.contextTokens)}/${live.contextWindow === undefined ? "—" : compactCount(live.contextWindow)} · ${live.toolCalls} tool calls in ${live.toolRounds} rounds · ${live.phase} phase`)] : []),
    ...(node.humanInputs?.length ? [theme.fg("warning", humanInputNotice(node.humanInputs.length))] : []),
    ...(activity && activity.executionId === node.executionId ? renderActivity(activity, false, theme, now, "summary") : []),
    ...(node.error ? [theme.fg("error", `${node.error.code}: ${compact(node.error.message, 300)}`)] : []),
  ];
}

const humanInputNotice = (count: number): string =>
  `✎ received ${count} human message${count === 1 ? "" : "s"} while running; its result is not from the graph alone`;

/** What a node view shows below its pinned header when no live session is retained. */
export function renderNodeDetails(
  node: NodeResult,
  theme: Palette,
  now: number,
  activity?: ExecutionActivity,
): string[] {
  const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  const workspace = node.workspace;
  const workspaceActive = workspace && ["preparing", "ready", "failed"].includes(workspace.state);
  const workspaceRef = workspaceActive ? workspace.worktreeRoot : workspace?.checkpointRef ?? workspace?.reason;
  return [
    ...(workspace ? [theme.fg("dim", `workspace: ${workspace.mode} · ${workspace.state}${workspaceRef ? ` · ${compact(workspaceRef, 160)}` : ""}`)] : []),
    ...(node.decision ? [theme.fg("accent", `decision: ${compact(node.decision, 80)}`)] : []),
    ...(node.skipReason ? [theme.fg("muted", `skipped: ${node.skipReason}`)] : []),
    ...(node.humanInputs?.length ? [
      theme.fg("warning", humanInputNotice(node.humanInputs.length)),
      ...node.humanInputs.map(input => theme.fg("warning", `  ✎ ${compact(clean(input.text), 300)}`)),
    ] : []),
    ...(activity && activity.executionId === node.executionId ? renderActivity(activity, true, theme, now, "history") : []),
    ...(node.output ? ["", ...clean(node.output).split("\n")] : []),
  ];
}

export interface GraphViewOptions {
  /** Default "heads": one box per lineage head. */
  view?: GraphView;
  /** In the history view, expand every generation instead of the last HISTORY_ROUNDS. */
  allHistory?: boolean;
}

/** In the history view, `selectedNodeId` is an execution ID. */
export function renderGraphResult(
  result: BraidToolDetails,
  expanded: boolean,
  isPartial: boolean,
  theme: Palette,
  fallback = "",
  isError = false,
  selectedNodeId?: string,
  options: GraphViewOptions = {},
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
  const pending = nodes.filter((node) => node.status === "pending").length;
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
  if ("pause" in result && result.pause) lines.push(theme.fg("warning", `job paused by ${compact(result.pause.source, 20)} · no new executions start`));
  if ("pausedExecutionIds" in result && result.pausedExecutionIds?.length) lines.push(theme.fg("warning", `${result.pausedExecutionIds.length} paused executions · revision ${result.revision ?? 0}`));
  if ("suspendedExecutionIds" in result && result.suspendedExecutionIds?.length) lines.push(theme.fg("warning", `${result.suspendedExecutionIds.length} suspended executions · revision ${result.revision ?? 0}`));
  const history = options.view === "history";
  if (result.executions) lines.push(theme.fg("dim", `${Object.keys(result.executions).length} executions · revision ${result.revision ?? 0}`));
  const layout = history ? historyLayout(result.executions ?? {}, options.allHistory) : undefined;
  const folded = layout ? [...layout.folded.values()].reduce((sum, records) => sum + records.length, 0) : 0;
  if (layout && folded) lines.push(theme.fg("dim", `${folded} older settled executions folded into ${layout.folded.size} ≡ boxes`));
  const chartStart = lines.length;
  const chart = mermaidLines(result, theme, selectedNodeId, options);
  lines.push(...chart);
  // Selection must stay usable when the chart cannot be drawn or does not fit.
  const entries = layout
    ? layout.shown.map(record => [record.executionId, record.status] as const)
    : Object.keys(graphParts(result).nodes).map(id => [id, result.nodes[id]?.status ?? "pending"] as const);
  const nodeList = selectedNodeId === undefined ? [] : [
    theme.fg("dim", chart.length ? `${history ? "executions" : "nodes"} (selected ${history ? "execution" : "node"} not found in the flowchart):` : `${history ? "executions" : "nodes"} (flowchart unavailable):`),
    ...entries.map(([id, status]) => {
      const text = `${id === selectedNodeId ? `${SELECTED_NODE_MARK} ` : "  "}${compact(id, 60)} · ${status}`;
      return id === selectedNodeId ? theme.bg("selectedBg", theme.bold(theme.fg("warning", text))) : theme.fg("muted", text);
    }),
  ];
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
        `full text: ${compact(result.fullOutputPath, 240)}`,
      ),
    );
  return new FixedLines(lines, chartStart, chart.length, nodeList, [
    ...(selectedNodeId === undefined ? [] : [{ mark: SELECTED_NODE_MARK, label: history ? "selected execution" : "selected node" }]),
    { mark: "▶ ACTIVE", label: history ? "running execution" : "running node" },
  ]);
}
