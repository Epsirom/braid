import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { braid, type ModelRequest } from "../src/index.js";
import { execute, graph } from "./helpers.js";

test("runner deadlines preserve graph queue time and give each node its own time budget", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const deadlines: ModelRequest["deadlines"][] = [];
  const result = await braid(graph([execute("a"), execute("b")]), {
    maxConcurrency: 1,
    nodeTimeoutMs: 100,
    graphTimeoutMs: 200,
    runner: async request => {
      deadlines.push(request.deadlines);
      now += 50;
      return { output: request.node.id };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(deadlines, [{ node: 100, graph: 200 }, { node: 150, graph: 200 }]);
});

test("unlimited deadlines allow long executions and queued nodes without timer overflow", {
  timeout: 2_000,
}, async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const result = await braid(graph([execute("a"), execute("b")]), {
    maxConcurrency: 1,
    nodeTimeoutMs: Infinity,
    graphTimeoutMs: Infinity,
    runner: async ({ node, signal, deadlines }) => {
      assert.equal(deadlines, undefined);
      now += 600_000;
      // Passing Infinity to Node's setTimeout would abort after just 1ms.
      await delay(20);
      assert.equal(signal.aborted, false);
      return { output: node.id };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.b!.status, "completed");
});

for (const scope of ["node", "graph"] as const) {
  test(`finite ${scope} timeout still applies when the other deadline is unlimited`, {
    timeout: 2_000,
  }, async () => {
    const result = await braid(graph([execute("a")]), {
      nodeTimeoutMs: scope === "node" ? 10 : Infinity,
      graphTimeoutMs: scope === "graph" ? 10 : Infinity,
      runner: () => new Promise(() => {}),
    });
    assert.equal(result.nodes.a!.error!.code,
      scope === "node" ? "NODE_TIMEOUT" : "GRAPH_TIMEOUT");
  });
}

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
