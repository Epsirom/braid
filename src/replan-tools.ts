import type { ModelRequest, ReplanInput } from "./types.js";

const edge = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    choice: { type: "string", description: "Required on edges from a decision node that route one choice." },
  },
  required: ["from", "to"], additionalProperties: false,
};

const node = {
  type: "object",
  description: "A complete node definition, as in the graph: execute and decision nodes need a prompt; decision nodes also need choices.",
  properties: {
    type: { type: "string", enum: ["execute", "decision", "merge"] },
    id: { type: "string" },
    prompt: { type: "string" },
    choices: { type: "array", items: { type: "string" } },
    workspace: { type: "string", enum: ["read-only", "worktree"] },
  },
  required: ["type", "id"], additionalProperties: false,
};

/** Provider-neutral schema for ModelRequest.requestReplan; core validates the request. */
export function replanToolDefinition() {
  return {
    name: "request_replan",
    description: "Ask the parent agent to change the plan around this node. Use it when what you found makes planned work wrong, unnecessary, or insufficient, or calls for work nobody planned. It does not change the graph or stop you: the parent is notified now, and your successors wait for its decision after you finish. Keep working and give your final answer, which the parent reads as evidence. Optionally include suggestion, a graph edit the parent may apply; refer only to node IDs you know, such as your own. An invalid suggestion is rejected with the reason; fix it or omit it. Calling again replaces your earlier request.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1, description: "What you found and why the plan should change." },
        suggestion: {
          type: "object",
          properties: {
            upsertNodes: { type: "array", items: node },
            removeNodeIds: { type: "array", items: { type: "string" } },
            addEdges: { type: "array", items: edge },
            removeEdges: { type: "array", items: edge },
          },
          additionalProperties: false,
        },
      },
      required: ["reason"], additionalProperties: false,
    },
  };
}

/** System prompt guidance for nodes that receive request_replan. */
export function replanInstructions(request: ModelRequest): string {
  return request.requestReplan
    ? "If what you find shows that the planned work after this node is wrong, unnecessary, or insufficient, call request_replan with the reason instead of working around the plan; then finish your answer. "
    : "";
}

export function parseReplanArguments(value: unknown): ReplanInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "reason" && key !== "suggestion") ||
      typeof (value as Record<string, unknown>).reason !== "string")
    throw new Error("request_replan requires reason (a string) and an optional suggestion object");
  return value as ReplanInput;
}

export const REPLAN_RECORDED =
  "Replan requested. The parent agent has been notified; your successors wait for its decision after you finish. Continue your work and give your final answer, including the evidence behind this request.";
