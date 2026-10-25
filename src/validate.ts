import type { BraidInput, BraidNode, DecisionNode, Edge } from "./types.js";

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
  /** The edge that closes each cycle; scheduling treats the rest of the graph as acyclic. */
  closing: Set<Edge>;
  cycles: CompiledCycle[];
}

export interface CompiledCycle {
  /** Where each round starts: the closing edge's target. */
  entry: string;
  /** A decision's choice edge back to the entry. */
  edge: Edge;
  members: Set<string>;
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

/** Throws before execution for malformed graphs, references, choices, or cycles. */
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
    fields(edge, ["from", "to", "choice"], `Edge '${edge.from}' -> '${edge.to}'`);
    requireValid(text(edge.from) && byId.has(edge.from), `Missing source node '${edge.from}'`);
    requireValid(text(edge.to) && byId.has(edge.to), `Missing target node '${edge.to}'`);
    requireValid(edge.choice === undefined || text(edge.choice), "Invalid edge choice");
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
    };
    edges.push(snapshot);
    incoming.get(edge.to)!.push(snapshot);
    outgoing.get(edge.from)!.push(snapshot);
  }

  const nodes = [...byId.values()];
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const cycles: CompiledCycle[] = [];
  const closing = new Set<Edge>();
  for (const cycle of findCycles(nodes, edges, outgoing, incoming)) {
    const { members, breaks, entries, candidates } = cycle;
    const label = `Cycle through ${[...members].sort((a, b) => order.get(a)! - order.get(b)!).map(id => `'${id}'`).join(", ")}`;
    requireValid(breaks.length > 0, `${label}: nested or overlapping cycles are unsupported`);
    requireValid(entries.size <= 1, `${label} has multiple entries (${[...entries].map(id => `'${id}'`).join(", ")}). Route external dependencies to one entry node`);
    const entry = [...entries][0];
    requireValid(candidates.length > 0, entry
      ? `${label} must return to its entry '${entry}' through a decision's choice edge. Route the edge back to '${entry}' from a decision and set its choice`
      : `${label} must be closed by a decision's choice edge back to the node where each round starts`);
    const back = candidates[0]!;
    const decision = byId.get(back.from)! as DecisionNode;
    requireValid(decision.choices.some(choice => choice !== back.choice), `${label}: decision '${back.from}' needs an exit choice besides '${back.choice}'`);
    for (const edge of edges) {
      requireValid(!(members.has(edge.from) && !members.has(edge.to) && edge.from !== back.from),
        `${label} must exit through its decision '${back.from}': edge '${edge.from}' -> '${edge.to}' leaves from another node`);
    }
    closing.add(back);
    cycles.push({ entry: back.to, edge: back, members });
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
  requireValid(topologicalOrder.length === nodes.length, "Graph contains an unsupported cycle");
  return {
    goal: input.goal,
    nodes,
    topologicalOrder,
    edges,
    incoming,
    outgoing,
    closing,
    cycles,
  };
}

interface CycleCandidates {
  members: Set<string>;
  /** Internal edges whose removal leaves the cycle acyclic. */
  breaks: Edge[];
  /** Cycle nodes that edges from outside enter. */
  entries: Set<string>;
  /** Decision choice edges that could close the cycle, best first. */
  candidates: Edge[];
}

function findCycles(nodes: readonly Pick<BraidNode, "id" | "type">[], edges: readonly Edge[],
  outgoing: Map<string, Edge[]>, incoming: Map<string, Edge[]>): CycleCandidates[] {
  const types = new Map(nodes.map(node => [node.id, node.type]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const cycles: CycleCandidates[] = [];
  for (const component of stronglyConnected(nodes, outgoing, incoming)) {
    const members = new Set(component);
    const inside = (edge: Edge) => members.has(edge.from) && members.has(edge.to);
    if (members.size === 1 && !outgoing.get(component[0]!)!.some(inside)) continue;
    const internal = edges.filter(inside);
    // Removing the closing edge must leave the cycle acyclic; otherwise cycles nest or overlap.
    const breaks = internal.filter(edge => acyclic(members, internal.filter(other => other !== edge)));
    const entries = new Set(edges.filter(edge => !members.has(edge.from) && members.has(edge.to)).map(edge => edge.to));
    // The closing edge enters the cycle's entry; without an external input, the entry listed first wins.
    const candidates = breaks.filter(edge => types.get(edge.from) === "decision" && edge.choice !== undefined &&
      (!entries.size || entries.has(edge.to))).sort((a, b) => order.get(a.to)! - order.get(b.to)!);
    cycles.push({ members, breaks, entries, candidates });
  }
  return cycles;
}

/**
 * The edge that closes each cycle in a graph, for displays and tools. Each round
 * of a cycle starts at the closing edge's target. Best effort: it does not
 * validate the graph, and skips cycles that validation would reject.
 */
export function closingEdges(graph: { nodes: readonly Pick<BraidNode, "id" | "type">[]; edges: readonly Edge[] }): Edge[] {
  const outgoing = new Map(graph.nodes.map(node => [node.id, [] as Edge[]]));
  const incoming = new Map(graph.nodes.map(node => [node.id, [] as Edge[]]));
  const edges = graph.edges.filter(edge => outgoing.has(edge.from) && incoming.has(edge.to));
  for (const edge of edges) {
    outgoing.get(edge.from)!.push(edge);
    incoming.get(edge.to)!.push(edge);
  }
  return findCycles(graph.nodes, edges, outgoing, incoming)
    .filter(cycle => cycle.breaks.length && cycle.entries.size <= 1 && cycle.candidates.length)
    .map(cycle => cycle.candidates[0]!);
}

/** Edges are identified by source, target, and choice. */
export function edgeIdentity(edge: Pick<Edge, "from" | "to" | "choice">): string {
  return JSON.stringify([edge.from, edge.to, edge.choice ?? null]);
}

/** Iterative Kosaraju, so very deep graphs do not overflow the stack. */
function stronglyConnected(nodes: readonly Pick<BraidNode, "id">[], outgoing: Map<string, Edge[]>, incoming: Map<string, Edge[]>): string[][] {
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

function acyclic(members: Set<string>, edges: Edge[]): boolean {
  const remaining = new Map([...members].map(id => [id, 0]));
  for (const edge of edges) remaining.set(edge.to, remaining.get(edge.to)! + 1);
  const queue = [...members].filter(id => remaining.get(id) === 0);
  let visited = 0;
  while (queue.length) {
    const id = queue.pop()!;
    visited++;
    for (const edge of edges) {
      if (edge.from !== id) continue;
      const count = remaining.get(edge.to)! - 1;
      remaining.set(edge.to, count);
      if (count === 0) queue.push(edge.to);
    }
  }
  return visited === members.size;
}
