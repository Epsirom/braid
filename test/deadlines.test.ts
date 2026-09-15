import assert from "node:assert/strict";
import test from "node:test";
import { braid, type ModelRequest } from "../src/index.js";
import { execute, graph } from "./helpers.js";

// Deliberately starve timer callbacks to test clock checks at invocation boundaries.
function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* bounded synchronous provider stand-in */
  }
}

test("no runner invocation begins after a graph deadline, even when timers are starved", {
  timeout: 2_000,
}, async () => {
  const calls: string[] = [];
  const result = await braid(graph([execute("a"), execute("b")]), {
    maxConcurrency: 2,
    graphTimeoutMs: 10,
    nodeTimeoutMs: 1_000,
    runner: async (request) => {
      calls.push(request.node.id);
      if (request.node.id === "a") blockEventLoop(30);
      return { output: request.node.id };
    },
  });
  assert.deepEqual(calls, ["a"]);
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.a!.error!.code, "GRAPH_TIMEOUT");
  assert.equal(result.nodes.b!.error!.code, "GRAPH_TIMEOUT");
});

test("no runner invocation begins after its admitted node deadline", {
  timeout: 2_000,
}, async () => {
  const calls: string[] = [];
  let first!: ModelRequest;
  const result = await braid(graph([execute("a"), execute("b")]), {
    maxConcurrency: 2,
    graphTimeoutMs: 1_000,
    nodeTimeoutMs: 10,
    runner: async (request) => {
      calls.push(request.node.id);
      if (request.node.id === "a") {
        first = request;
        blockEventLoop(30);
      }
      return { output: request.node.id };
    },
  });
  assert.deepEqual(calls, ["a"]);
  assert.equal(first.signal.aborted, true);
  assert.equal(result.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(result.nodes.b!.error!.code, "NODE_TIMEOUT");
});

test("queued nodes receive a fresh node deadline when admitted", {
  timeout: 2_000,
}, async () => {
  const calls: string[] = [];
  const result = await braid(graph([execute("a"), execute("b")]), {
    maxConcurrency: 1,
    graphTimeoutMs: 1_000,
    nodeTimeoutMs: 10,
    runner: async (request) => {
      calls.push(request.node.id);
      if (request.node.id === "a") blockEventLoop(30);
      return { output: request.node.id };
    },
  });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(result.nodes.b!.status, "completed");
  assert.deepEqual(result.terminalOutputs, { b: { output: "b" } });
});
