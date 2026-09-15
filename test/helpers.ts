import type {
  BraidInput,
  BraidNode,
  DecisionNode,
  Edge,
  ExecuteNode,
} from "../src/index.js";

export function execute(id: string, model?: string): ExecuteNode {
  return {
    type: "execute",
    id,
    prompt: `Do ${id}`,
    ...(model ? { model } : {}),
  };
}

export function decision(
  id = "route",
  choices = ["left", "right"],
  model?: string,
): DecisionNode {
  return {
    type: "decision",
    id,
    prompt: `Choose for ${id}`,
    choices,
    ...(model ? { model } : {}),
  };
}

export function graph(nodes: BraidNode[], edges: Edge[] = []): BraidInput {
  return { goal: "Test Braid", nodes, edges };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
