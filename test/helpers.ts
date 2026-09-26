import type {
  BraidInput,
  BraidNode,
  DecisionNode,
  Edge,
  ExecuteNode,
} from "../src/index.js";
import { braid as coreBraid, type BraidOptions } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const readOnlyCwd = mkdtempSync(join(tmpdir(), "braid-core-test-"));
after(() => rmSync(readOnlyCwd, { recursive: true, force: true }));
export const braid = (input: BraidInput, options: BraidOptions) =>
  coreBraid(input, options ? { cwd: readOnlyCwd, ...options } : options);

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
