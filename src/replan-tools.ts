import type { ModelRequest, ReplanInput } from "./types.js";

const edge = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    choice: { type: "string", description: "Required on edges from a decision node that route one choice." },
    closesCycle: { type: "boolean", description: "True to make this edge close the cycle it is on, so each round starts at its target." },
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
    description: "Report a finding that may change the plan to the parent agent. You see only the goal, your prompt, and your direct inputs, not the rest of the graph, so report what you found, not a new plan; the parent decides which planned work it affects. " +
      "Use it when what you found contradicts what your prompt assumes, makes your task unnecessary, or affects more than your task in a way the goal depends on, such as a root cause that also explains other problems. " +
      "Use it rarely: each call holds your successors and wakes the parent. Do not call it for ordinary obstacles you can work through, to report your result, to ask for confirmation, or for uncertainty you can state in your final answer. " +
      "Call it as soon as you know, so the parent can stop work that is no longer needed. It does not change the graph or stop you: keep working as far as it still makes sense and give your final answer, which the parent reads as evidence. On a decision node it does not replace decide. " +
      "suggestion is optional; use it only to add nodes after your own node ID, and describe anything else in reason. An invalid suggestion is rejected with the reason; fix it or omit it. Calling again replaces your earlier request.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1, description: "One to three sentences: what you found, how it differs from what your prompt assumed, and what it affects. Put the evidence in your final answer." },
        suggestion: {
          type: "object",
          description: "Optional graph edit the parent may apply, for example new nodes with edges from your node ID.",
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
  if (!request.requestReplan) return "";
  return "You see only the goal, your prompt, and your direct inputs, not the rest of the graph. If what you find contradicts what your prompt assumes, makes your task unnecessary, or affects more than your task in a way the goal depends on, call request_replan as soon as you know to report the finding, not a new plan, then finish your assigned work as far as it still makes sense. Do not call it for ordinary obstacles. " +
    (request.decide ? "It does not replace decide; still call decide exactly once. " : "");
}

export function parseReplanArguments(value: unknown): ReplanInput {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "reason" && key !== "suggestion") ||
      typeof (value as Record<string, unknown>).reason !== "string")
    throw new Error("request_replan requires reason (a string) and an optional suggestion object");
  return value as ReplanInput;
}

export const REPLAN_RECORDED =
  "Replan requested. The parent agent has been notified; your successors wait for its decision after you finish. Continue your work and give your final answer, including the evidence behind this request. Do not call request_replan again unless your reason changes.";
