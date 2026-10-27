import type { BraidInput, BraidNode, Edge, GraphCycle } from "./types.js";

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

/** Internal, validated snapshot; arrays/maps are never handed to the runner. */
export interface Graph {
  goal: string;
  nodes: BraidNode[];
  topologicalOrder: BraidNode[];
  edges: Edge[];
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
  /** The edges that close cycles; scheduling treats the rest of the graph as acyclic. */
  closing: Set<Edge>;
  /** Strongly connected component of each node: nodes on a common cycle share one. */
  component: Map<string, number>;
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GraphValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fields(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    requireValid(allowed.includes(key), `${label}: unsupported field '${key}'`);
  }
}

interface PromptTemplate {
  parts: (string | { variable: string })[];
  variables: Set<string>;
}

function compileTemplates(value: unknown): Map<string, PromptTemplate> {
  const templates = new Map<string, PromptTemplate>();
  if (value === undefined) return templates;
  requireValid(isRecord(value), "Graph promptTemplates must be an object");
  for (const [name, source] of Object.entries(value)) {
    requireValid(text(name), "Prompt template name must be a non-empty string");
    const label = `Prompt template '${name}'`;
    requireValid(text(source), `${label} must be a non-empty string`);
    const parts: PromptTemplate["parts"] = [];
    const variables = new Set<string>();
    let offset = 0;
    while (offset < source.length) {
      const open = source.indexOf("{{", offset);
      const close = source.indexOf("}}", offset);
      requireValid(close === -1 || (open !== -1 && close > open), `${label} has an unmatched '}}'`);
      if (open === -1) {
        parts.push(source.slice(offset));
        break;
      }
      requireValid(close !== -1, `${label} has an unclosed '{{'`);
      const variable = source.slice(open + 2, close).trim();
      requireValid(/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable), `${label} has invalid variable '${variable}'`);
      parts.push(source.slice(offset, open), { variable });
      variables.add(variable);
      offset = close + 2;
    }
    templates.set(name, { parts, variables });
  }
  return templates;
}

function renderPrompt(value: unknown, nodeId: string, templates: Map<string, PromptTemplate>): string {
  const nodeLabel = `Node '${nodeId}'`;
  if (typeof value === "string") {
    requireValid(text(value), `${nodeLabel} needs a non-empty prompt`);
    return value;
  }
  requireValid(isRecord(value), `${nodeLabel} needs a non-empty prompt or template reference`);
  fields(value, ["template", "variables"], `${nodeLabel} prompt`);
  requireValid(text(value.template), `${nodeLabel} prompt needs a non-empty template reference`);
  const label = `${nodeLabel} prompt template '${value.template}'`;
  const template = templates.get(value.template);
  requireValid(template, `${label} is unknown`);
  requireValid(isRecord(value.variables), `${label} variables must be an object`);
  const variables = new Map<string, string>();
  for (const [name, variable] of Object.entries(value.variables)) {
    requireValid(typeof variable === "string", `${label} variable '${name}' must be a string`);
    requireValid(template.variables.has(name), `${label} has unused variable '${name}'`);
    variables.set(name, variable);
  }
  for (const name of template.variables) {
    requireValid(variables.has(name), `${label} is missing variable '${name}'`);
  }
  // One pass over the parsed template: inserted values are never parsed or evaluated.
  const rendered = template.parts.map(part => typeof part === "string" ? part : variables.get(part.variable)!).join("");
  requireValid(text(rendered), `${label} renders an empty prompt`);
  return rendered;
}

/** Throws before execution for malformed graphs, references, or choices. Cycles are allowed. */
export function validateGraph(input: BraidInput): void {
  compileGraph(input);
}

export function compileGraph(input: BraidInput): Graph {
  requireValid(isRecord(input), "Graph must be an object");
  fields(input, ["goal", "nodes", "edges", "promptTemplates"], "Graph");
  requireValid(text(input.goal), "Graph goal must be a non-empty string");
  requireValid(
    Array.isArray(input.nodes) && input.nodes.length > 0,
    "Graph needs at least one node",
  );
  requireValid(Array.isArray(input.edges), "Graph edges must be an array");
  const templates = compileTemplates(input.promptTemplates);

  const byId = new Map<string, BraidNode>();
  for (const node of input.nodes) {
    requireValid(isRecord(node), "Node must be an object");
    requireValid(text(node.id), "Node id must be a non-empty string");
    requireValid(!node.id.includes("@"), `Node id '${node.id}' must not contain '@', which separates a node ID from an instance's generation`);
    requireValid(
      node.type === "execute" || node.type === "decision" || (node.type === "merge" || node.type === "integrate"),
      `Node '${node.id}': unknown node type; expected execute, decision, merge, or integrate`,
    );
    fields(
      node,
      node.type === "decision"
        ? ["type", "id", "prompt", "model", "choices", "workspace", "notifyOnCompletion", "requireSuccess", "pauseAfter", "maxRuns"]
        : node.type === "execute"
          ? ["type", "id", "prompt", "model", "workspace", "notifyOnCompletion", "requireSuccess", "pauseAfter", "maxRuns"]
          : ["type", "id", "prompt", "model", "notifyOnCompletion", "requireSuccess", "pauseAfter", "maxRuns"],
      `Node '${node.id}' (${node.type})`,
    );
    requireValid(!byId.has(node.id), `Duplicate node id '${node.id}'`);
    const prompt = (node.type === "merge" || node.type === "integrate") && node.prompt === undefined
      ? (node.type === "merge" ? "Merge selected predecessor results into this new isolated worktree. Resolve conflicts and account for every source with finish_merge." : "Integrate selected predecessor results into the invoking checkout. Preserve user changes and account for every source with finish_merge.")
      : renderPrompt(node.prompt, node.id, templates);
    requireValid(
      node.model === undefined || text(node.model),
      `Invalid model on '${node.id}'`,
    );
    const workspace = (node.type === "merge" || node.type === "integrate") ? undefined : node.workspace;
    requireValid(
      node.notifyOnCompletion === undefined || typeof node.notifyOnCompletion === "boolean",
      `Invalid notifyOnCompletion on '${node.id}': expected a boolean`,
    );
    requireValid(
      workspace === undefined || workspace === "read-only" || workspace === "worktree",
      `Invalid workspace on '${node.id}'`,
    );
    for (const field of ["requireSuccess", "pauseAfter"] as const) {
      requireValid(node[field] === undefined || typeof node[field] === "boolean", `Invalid ${field} on '${node.id}': expected a boolean`);
    }
    requireValid(node.maxRuns === undefined || node.maxRuns === Infinity ||
      (typeof node.maxRuns === "number" && Number.isSafeInteger(node.maxRuns) && node.maxRuns > 0),
    `Invalid maxRuns on '${node.id}': expected a positive integer, Infinity, or omitted`);
    const common = {
      id: node.id,
      prompt,
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.notifyOnCompletion !== undefined ? { notifyOnCompletion: node.notifyOnCompletion } : {}),
      ...(node.requireSuccess !== undefined ? { requireSuccess: node.requireSuccess as boolean } : {}),
      ...(node.pauseAfter !== undefined ? { pauseAfter: node.pauseAfter as boolean } : {}),
      ...(node.maxRuns !== undefined ? { maxRuns: node.maxRuns } : {}),
      ...(workspace !== undefined ? { workspace } as const : {}),
    };
    if (node.type === "decision") {
      requireValid(
        Array.isArray(node.choices) && node.choices.length > 0,
        `Decision '${node.id}' needs at least one choice`,
      );
      const choices: unknown[] = [...node.choices];
      requireValid(choices.every(text), `Invalid choice on '${node.id}'`);
      requireValid(
        new Set(choices).size === choices.length,
        `Duplicate choices on '${node.id}'`,
      );
      byId.set(node.id, { type: "decision", ...common, choices });
    } else {
      byId.set(node.id, { type: node.type, ...common });
    }
  }

  const edges: Edge[] = [];
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  const seen = new Set<string>();
  for (const id of byId.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of input.edges) {
    requireValid(isRecord(edge), "Edge must be an object");
    fields(edge, ["from", "to", "choice", "closesCycle"], `Edge '${edge.from}' -> '${edge.to}'`);
    requireValid(text(edge.from) && byId.has(edge.from), `Missing source node '${edge.from}'`);
    requireValid(text(edge.to) && byId.has(edge.to), `Missing target node '${edge.to}'`);
    requireValid(edge.choice === undefined || text(edge.choice), "Invalid edge choice");
    requireValid(edge.closesCycle === undefined || typeof edge.closesCycle === "boolean",
      `Edge '${edge.from}' -> '${edge.to}': closesCycle must be a boolean`);
    if (edge.choice !== undefined) {
      const source = byId.get(edge.from)!;
      requireValid(source.type === "decision", `Choice edge from non-decision '${edge.from}'`);
      requireValid(source.choices.includes(edge.choice), `Undeclared edge choice '${edge.choice}' on '${edge.from}'`);
    }
    const key = edgeIdentity(edge as unknown as Edge);
    requireValid(!seen.has(key), `Duplicate edge '${edge.from}' -> '${edge.to}'`);
    seen.add(key);
    const snapshot: Edge = {
      from: edge.from,
      to: edge.to,
      ...(edge.choice !== undefined ? { choice: edge.choice } : {}),
      ...(edge.closesCycle ? { closesCycle: true } : {}),
    };
    edges.push(snapshot);
    incoming.get(edge.to)!.push(snapshot);
    outgoing.get(edge.from)!.push(snapshot);
  }

  const nodes = [...byId.values()];
  const { closing, component } = selectClosing(nodes, edges, outgoing);
  for (const edge of edges) {
    requireValid(!edge.closesCycle || component.get(edge.from) === component.get(edge.to),
      `Edge '${edge.from}' -> '${edge.to}' sets closesCycle but is not on a cycle`);
  }
  // Kahn's algorithm is iterative, including for very deep graphs.
  const remaining = new Map(nodes.map(node => [node.id, incoming.get(node.id)!.filter(edge => !closing.has(edge)).length]));
  const topologicalOrder = nodes.filter(node => remaining.get(node.id) === 0);
  for (let i = 0; i < topologicalOrder.length; i++) {
    for (const edge of outgoing.get(topologicalOrder[i]!.id)!) {
      if (closing.has(edge)) continue;
      const count = remaining.get(edge.to)! - 1;
      remaining.set(edge.to, count);
      if (count === 0) topologicalOrder.push(byId.get(edge.to)!);
    }
  }
  return {
    goal: input.goal,
    nodes,
    topologicalOrder,
    edges,
    incoming,
    outgoing,
    closing,
    component,
  };
}

/**
 * Choose the edges that close cycles, which decides where each round starts:
 * removing them leaves the graph acyclic. Edges marked closesCycle always close.
 * Within each strongly connected component, the other edges are kept as ordinary
 * dependencies, least likely to close first; an edge that would complete a cycle
 * with the edges kept before it closes the cycle instead. Most likely to close:
 * edges into an entry (a node that an edge from outside the component enters),
 * then choice edges, then edges to nodes listed earlier.
 */
function selectClosing(nodes: readonly Pick<BraidNode, "id">[], edges: readonly Edge[], outgoing: Map<string, Edge[]>):
  { closing: Set<Edge>; component: Map<string, number> } {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const position = new Map(edges.map((edge, index) => [edge, index]));
  const component = new Map<string, number>();
  stronglyConnected(nodes, outgoing).forEach((members, index) => { for (const id of members) component.set(id, index); });
  const closing = new Set<Edge>();
  const groups = new Map<number, Edge[]>();
  for (const edge of edges) {
    const id = component.get(edge.from)!;
    if (id === component.get(edge.to)) (groups.get(id) ?? groups.set(id, []).get(id)!).push(edge);
  }
  for (const internal of groups.values()) {
    const entries = new Set(edges.filter(edge => component.get(edge.to) === component.get(internal[0]!.from) &&
      component.get(edge.from) !== component.get(edge.to)).map(edge => edge.to));
    const rank = (edge: Edge) => [entries.has(edge.to) ? 1 : 0, edge.choice !== undefined ? 1 : 0, -order.get(edge.to)!, position.get(edge)!];
    for (const edge of internal) if (edge.closesCycle) closing.add(edge);
    const sorted = internal.filter(edge => !edge.closesCycle).sort((a, b) => {
      const left = rank(a), right = rank(b);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
      return 0;
    });
    const kept = new Map<string, string[]>();
    for (const edge of sorted) {
      if (reaches(kept, edge.to, edge.from)) closing.add(edge);
      else (kept.get(edge.from) ?? kept.set(edge.from, []).get(edge.from)!).push(edge.to);
    }
  }
  return { closing, component };
}

function reaches(next: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    for (const target of next.get(id) ?? []) if (!seen.has(target)) { seen.add(target); stack.push(target); }
  }
  return false;
}

/** A graph as displays and tools see it; edges with unknown endpoints are ignored. */
type GraphShape = { nodes: readonly Pick<BraidNode, "id" | "maxRuns">[]; edges: readonly Edge[] };

function shape(graph: GraphShape) {
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as Edge[]]));
  const edges = graph.edges.filter(edge => outgoing.has(edge.from) && outgoing.has(edge.to));
  for (const edge of edges) outgoing.get(edge.from)!.push(edge);
  return { nodes: graph.nodes, edges, outgoing, ...selectClosing(graph.nodes, edges, outgoing) };
}

/**
 * The edges that close the graph's cycles, for displays and tools. When one
 * fires, it clones its target for another round. Removing them leaves the
 * graph acyclic. Best effort: it does not validate the graph.
 */
export function closingEdges(graph: GraphShape): Edge[] {
  const { edges, closing } = shape(graph);
  return edges.filter(edge => closing.has(edge));
}

/** At most this many cycles are reported for one submission or update. */
const CYCLE_REPORT_LIMIT = 20;

/**
 * The cycles in `graph` that `previous` did not have: each one uses an edge that
 * `previous` lacks. Without `previous`, every cycle. At most 20 are listed;
 * `truncated` says there may be more. Best effort: it does not validate the graph.
 */
export function newCycles(graph: GraphShape, previous?: Pick<GraphShape, "edges">): { cycles: GraphCycle[]; truncated: boolean } {
  return reportCycles(shape(graph), previous?.edges);
}

/** Elementary cycles through edges that `previous` lacks, each starting where its closing edge starts a round. */
export function reportCycles(graph: Pick<Graph, "edges" | "outgoing" | "closing" | "component"> & GraphShape, previous?: readonly Edge[]):
  { cycles: GraphCycle[]; truncated: boolean } {
  const old = new Set(previous?.map(edgeIdentity));
  const maxRuns = new Map(graph.nodes.map(node => [node.id, node.maxRuns]));
  const position = new Map(graph.edges.map((edge, index) => [edge, index]));
  const found = new Map<string, Edge[]>();
  let budget = 100_000;
  let truncated = false;
  const record = (cycle: Edge[]) => {
    const rotated = rotate(cycle, graph.closing, position);
    const key = JSON.stringify(rotated.map(edgeIdentity));
    if (found.has(key)) return;
    if (found.size === CYCLE_REPORT_LIMIT) truncated = true;
    else found.set(key, rotated);
  };
  for (const first of graph.edges) {
    if (truncated) break;
    const scope = graph.component.get(first.from);
    if (old.has(edgeIdentity(first)) || scope !== graph.component.get(first.to)) continue;
    if (first.from === first.to) { record([first]); continue; }
    // Each simple path from the new edge's target back to its source closes a cycle through it.
    const path: Edge[] = [first];
    const onPath = new Set([first.to]);
    const stack: [string, number][] = [[first.to, 0]];
    while (stack.length && !truncated) {
      const top = stack[stack.length - 1]!;
      const out = graph.outgoing.get(top[0])!;
      if (top[1] === out.length) {
        stack.pop();
        onPath.delete(top[0]);
        path.pop();
        continue;
      }
      if (--budget < 0) { truncated = true; break; }
      const edge = out[top[1]++]!;
      if (graph.component.get(edge.to) !== scope || onPath.has(edge.to)) continue;
      if (edge.to === first.from) { record([...path, edge]); continue; }
      path.push(edge);
      onPath.add(edge.to);
      stack.push([edge.to, 0]);
    }
  }
  // A node runs only through a choice edge when every edge it waits for is one.
  const choiceOnly = new Map<string, boolean>();
  for (const edge of graph.edges) {
    if (!graph.closing.has(edge)) choiceOnly.set(edge.to, (choiceOnly.get(edge.to) ?? true) && edge.choice !== undefined);
  }
  const cycles = [...found.values()].map(edges => ({
    nodeIds: edges.map(edge => edge.from),
    edges: edges.map(copyEdge),
    stops: edges.filter(edge => edge.choice !== undefined).map(copyEdge),
    limitedNodeIds: edges.map(edge => edge.from).filter(id => Number.isFinite(maxRuns.get(id) ?? Infinity)),
    choiceGated: edges.filter(edge => edge.choice !== undefined && !graph.closing.has(edge) && choiceOnly.get(edge.to)).map(copyEdge),
  }));
  return { cycles, truncated };
}

/** End the cycle with its closing edge listed first in the graph, so it starts where that edge starts a round. */
function rotate(cycle: readonly Edge[], closing: Set<Edge>, position: Map<Edge, number>): Edge[] {
  let last = -1;
  cycle.forEach((edge, index) => {
    if (closing.has(edge) && (last === -1 || position.get(edge)! < position.get(cycle[last]!)!)) last = index;
  });
  if (last === -1) last = cycle.length - 1;
  return [...cycle.slice(last + 1), ...cycle.slice(0, last + 1)];
}

function copyEdge(edge: Edge): Edge {
  return { from: edge.from, to: edge.to, ...(edge.choice !== undefined ? { choice: edge.choice } : {}), ...(edge.closesCycle ? { closesCycle: true } : {}) };
}

/** Edges are identified by source, target, and choice. */
export function edgeIdentity(edge: Pick<Edge, "from" | "to" | "choice">): string {
  return JSON.stringify([edge.from, edge.to, edge.choice ?? null]);
}

/** Iterative Kosaraju, so very deep graphs do not overflow the stack. */
function stronglyConnected(nodes: readonly Pick<BraidNode, "id">[], outgoing: Map<string, Edge[]>): string[][] {
  const incoming = new Map(nodes.map(node => [node.id, [] as Edge[]]));
  for (const edges of outgoing.values()) for (const edge of edges) incoming.get(edge.to)!.push(edge);
  const finished: string[] = [];
  const visited = new Set<string>();
  for (const { id: start } of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: [string, number][] = [[start, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const edges = outgoing.get(top[0])!;
      if (top[1] < edges.length) {
        const next = edges[top[1]++]!.to;
        if (!visited.has(next)) { visited.add(next); stack.push([next, 0]); }
      } else {
        finished.push(top[0]);
        stack.pop();
      }
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let i = finished.length - 1; i >= 0; i--) {
    const start = finished[i]!;
    if (assigned.has(start)) continue;
    assigned.add(start);
    const component: string[] = [];
    const queue = [start];
    while (queue.length) {
      const id = queue.pop()!;
      component.push(id);
      for (const edge of incoming.get(id)!) {
        if (!assigned.has(edge.from)) { assigned.add(edge.from); queue.push(edge.from); }
      }
    }
    components.push(component);
  }
  return components;
}
