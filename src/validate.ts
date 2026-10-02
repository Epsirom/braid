import type { BraidInput, BraidNode, Edge, LoopDefinition } from "./types.js";

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
  loops: Map<string, CompiledLoop>;
  membership: Map<string, string>;
}

export interface CompiledLoop extends LoopDefinition {
  feedback: Edge;
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
  fields(input, ["goal", "nodes", "edges", "promptTemplates", "loops"], "Graph");
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
    requireValid(
      node.type === "execute" || node.type === "decision" || (node.type === "merge" || node.type === "integrate"),
      "Unknown node type",
    );
    fields(
      node,
      node.type === "decision"
        ? ["type", "id", "prompt", "model", "choices", "workspace", "notifyOnCompletion", "requireSuccess", "pauseAfter"]
        : node.type === "execute"
          ? ["type", "id", "prompt", "model", "workspace", "notifyOnCompletion", "requireSuccess", "pauseAfter"]
          : ["type", "id", "prompt", "model", "notifyOnCompletion", "requireSuccess", "pauseAfter"],
      "Node",
    );
    requireValid(text(node.id), "Node id must be a non-empty string");
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
    const common = {
      id: node.id,
      prompt,
      ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.notifyOnCompletion !== undefined ? { notifyOnCompletion: node.notifyOnCompletion } : {}),
      ...(node.requireSuccess !== undefined ? { requireSuccess: node.requireSuccess as boolean } : {}),
      ...(node.pauseAfter !== undefined ? { pauseAfter: node.pauseAfter as boolean } : {}),
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
    fields(edge, ["from", "to", "choice", "feedback", "executionId"], "Edge");
    requireValid(edge.executionId === undefined || text(edge.executionId), "Invalid edge executionId");
    requireValid(edge.feedback === undefined || text(edge.feedback), "Invalid edge feedback");
    requireValid(!edge.feedback || !edge.executionId, "Feedback cannot pin an execution");
    requireValid(
      text(edge.from) && (byId.has(edge.from) || edge.executionId !== undefined),
      `Missing source node '${edge.from}'`,
    );
    requireValid(
      text(edge.to) && byId.has(edge.to),
      `Missing target node '${edge.to}'`,
    );
    requireValid(edge.choice === undefined || text(edge.choice), "Invalid edge choice");
    if (edge.choice !== undefined && edge.executionId === undefined) {
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
    const key = JSON.stringify([edge.from, edge.to, edge.choice ?? null, edge.feedback ?? null, edge.executionId ?? null]);
    requireValid(
      !seen.has(key),
      `Duplicate edge '${edge.from}' -> '${edge.to}'`,
    );
    seen.add(key);
    const snapshot: Edge = {
      from: edge.from,
      to: edge.to,
      ...(edge.choice !== undefined ? { choice: edge.choice } : {}),
      ...(edge.feedback !== undefined ? { feedback: edge.feedback } : {}),
      ...(edge.executionId !== undefined ? { executionId: edge.executionId } : {}),
    };
    edges.push(snapshot);
    incoming.get(edge.to)!.push(snapshot);
    outgoing.get(edge.from)?.push(snapshot);
  }

  // Kahn's algorithm is iterative, including for very deep graphs.
  const nodes = [...byId.values()];
  const remaining = new Map(
    nodes.map((node) => [node.id, incoming.get(node.id)!.filter(edge => !edge.feedback && !edge.executionId).length]),
  );
  const topologicalOrder = nodes.filter((node) => remaining.get(node.id) === 0);
  for (let i = 0; i < topologicalOrder.length; i++) {
    for (const edge of outgoing.get(topologicalOrder[i]!.id)!) {
      if (edge.feedback || edge.executionId) continue;
      const count = remaining.get(edge.to)! - 1;
      remaining.set(edge.to, count);
      if (count === 0) topologicalOrder.push(byId.get(edge.to)!);
    }
  }
  requireValid(
    topologicalOrder.length === nodes.length,
    "Graph contains a cycle without a declared feedback edge",
  );
  const loops = new Map<string, CompiledLoop>();
  const membership = new Map<string, string>();
  requireValid(input.loops === undefined || Array.isArray(input.loops), "Graph loops must be an array");
  const reachable = (start: string, reverse = false): Set<string> => {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const edge of (reverse ? incoming : outgoing).get(id) ?? []) {
        if (!edge.feedback && !edge.executionId) queue.push(reverse ? edge.from : edge.to);
      }
    }
    return visited;
  };
  for (const loop of input.loops ?? []) {
    requireValid(isRecord(loop), "Loop must be an object");
    fields(loop, ["id", "entry", "maxIterations"], "Loop");
    requireValid(text(loop.id) && !loops.has(loop.id), "Loop ids must be non-empty and unique");
    requireValid(text(loop.entry) && byId.has(loop.entry), `Unknown loop entry '${loop.entry}'`);
    requireValid(typeof loop.maxIterations === "number" && Number.isSafeInteger(loop.maxIterations) && loop.maxIterations > 0, `Loop '${loop.id}' needs a positive maxIterations`);
    const feedback = edges.filter(edge => edge.feedback === loop.id);
    requireValid(feedback.length === 1, `Loop '${loop.id}' needs exactly one feedback edge`);
    const back = feedback[0]!;
    const decision = byId.get(back.from)!;
    requireValid(back.to === loop.entry && decision.type === "decision" && back.choice !== undefined,
      `Loop '${loop.id}' feedback must route a decision choice to its entry`);
    requireValid(decision.choices.some(choice => choice !== back.choice), `Loop '${loop.id}' needs an exit choice`);
    const ancestors = reachable(back.from, true);
    const members = new Set([...reachable(loop.entry)].filter(id => ancestors.has(id)));
    requireValid(members.has(loop.entry) && members.has(back.from), `Loop '${loop.id}' entry must reach its feedback decision`);
    for (const id of members) {
      requireValid(!membership.has(id), "Nested or overlapping loops are unsupported");
      membership.set(id, loop.id);
    }
    for (const edge of edges) {
      if (edge.feedback || edge.executionId) continue;
      requireValid(!(!members.has(edge.from) && members.has(edge.to) && edge.to !== loop.entry), `Loop '${loop.id}' has multiple entries`);
      requireValid(!(members.has(edge.from) && !members.has(edge.to) && edge.from !== back.from), `Loop '${loop.id}' must exit through its feedback decision`);
    }
    loops.set(loop.id, { id: loop.id, entry: loop.entry, maxIterations: loop.maxIterations, feedback: back, members });
  }
  for (const edge of edges) requireValid(!edge.feedback || loops.has(edge.feedback), `Unknown feedback loop '${edge.feedback}'`);
  return {
    goal: input.goal,
    nodes,
    topologicalOrder,
    edges,
    incoming,
    outgoing,
    loops,
    membership,
  };
}
