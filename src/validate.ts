import type { BraidInput, BraidNode, Edge } from "./types.js";

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

/** Throws before execution for malformed graphs, references, choices, or cycles. */
export function validateGraph(input: BraidInput): void {
  compileGraph(input);
}

export function compileGraph(input: BraidInput): Graph {
  requireValid(isRecord(input), "Graph must be an object");
  fields(input, ["goal", "nodes", "edges"], "Graph");
  requireValid(text(input.goal), "Graph goal must be a non-empty string");
  requireValid(
    Array.isArray(input.nodes) && input.nodes.length > 0,
    "Graph needs at least one node",
  );
  requireValid(Array.isArray(input.edges), "Graph edges must be an array");

  const byId = new Map<string, BraidNode>();
  for (const node of input.nodes) {
    requireValid(isRecord(node), "Node must be an object");
    requireValid(
      node.type === "execute" || node.type === "decision",
      "Unknown node type",
    );
    fields(
      node,
      node.type === "decision"
        ? ["type", "id", "prompt", "model", "choices"]
        : ["type", "id", "prompt", "model"],
      "Node",
    );
    requireValid(text(node.id), "Node id must be a non-empty string");
    requireValid(!byId.has(node.id), `Duplicate node id '${node.id}'`);
    requireValid(
      text(node.prompt),
      `Node '${node.id}' needs a non-empty prompt`,
    );
    requireValid(
      node.model === undefined || text(node.model),
      `Invalid model on '${node.id}'`,
    );
    const common = {
      id: node.id,
      prompt: node.prompt,
      ...(node.model !== undefined ? { model: node.model } : {}),
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
      byId.set(node.id, { type: "execute", ...common });
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
    fields(edge, ["from", "to", "choice"], "Edge");
    requireValid(
      text(edge.from) && byId.has(edge.from),
      `Missing source node '${edge.from}'`,
    );
    requireValid(
      text(edge.to) && byId.has(edge.to),
      `Missing target node '${edge.to}'`,
    );
    if (edge.choice !== undefined) {
      const source = byId.get(edge.from)!;
      requireValid(
        source.type === "decision",
        `Choice edge from non-decision '${edge.from}'`,
      );
      requireValid(
        text(edge.choice) && source.choices.includes(edge.choice),
        `Undeclared edge choice '${edge.choice}' on '${edge.from}'`,
      );
    }
    const key = JSON.stringify([edge.from, edge.to, edge.choice ?? null]);
    requireValid(
      !seen.has(key),
      `Duplicate edge '${edge.from}' -> '${edge.to}'`,
    );
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

  // Kahn's algorithm is iterative, including for very deep graphs.
  const nodes = [...byId.values()];
  const remaining = new Map(
    nodes.map((node) => [node.id, incoming.get(node.id)!.length]),
  );
  const topologicalOrder = nodes.filter((node) => remaining.get(node.id) === 0);
  for (let i = 0; i < topologicalOrder.length; i++) {
    for (const edge of outgoing.get(topologicalOrder[i]!.id)!) {
      const count = remaining.get(edge.to)! - 1;
      remaining.set(edge.to, count);
      if (count === 0) topologicalOrder.push(byId.get(edge.to)!);
    }
  }
  requireValid(
    topologicalOrder.length === nodes.length,
    "Graph contains a cycle",
  );
  return {
    goal: input.goal,
    nodes,
    topologicalOrder,
    edges,
    incoming,
    outgoing,
  };
}
