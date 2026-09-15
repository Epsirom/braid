import assert from "node:assert/strict";
import test from "node:test";
import { braid, type ModelRequest } from "../src/index.js";
import { deferred, execute, graph } from "./helpers.js";

test("pre-cancelled graphs skip all nodes without invoking the runner", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await braid(graph([execute("a"), execute("b")]), {
    signal: controller.signal,
    runner: async () => {
      calls++;
      return { output: "unused" };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.error!.code, "CANCELLED");
  assert.ok(
    Object.values(result.nodes).every(
      (node) => node.skipReason === "cancelled",
    ),
  );
});

test("caller cancellation aborts running nodes and skips queued work while retaining completed terminals", {
  timeout: 2_000,
}, async () => {
  const controller = new AbortController();
  const ready = deferred();
  const calls: string[] = [];
  let running!: ModelRequest;
  const run = braid(
    graph([execute("done"), execute("hang"), execute("queued")]),
    {
      signal: controller.signal,
      maxConcurrency: 1,
      runner: async (request) => {
        calls.push(request.node.id);
        if (request.node.id === "done") return { output: "saved" };
        running = request;
        ready.resolve();
        return new Promise(() => {}); // Deliberately non-cooperative.
      },
    },
  );
  await ready.promise;
  controller.abort();
  const result = await run;
  assert.deepEqual(calls, ["done", "hang"]);
  assert.equal(running.signal.aborted, true);
  assert.equal(result.nodes.hang!.error!.code, "CANCELLED");
  assert.equal(result.nodes.queued!.skipReason, "cancelled");
  assert.deepEqual(result.terminalOutputs, { done: { output: "saved" } });
});

test("completed runs detach their caller cancellation listener", async () => {
  const controller = new AbortController();
  let request!: ModelRequest;
  const result = await braid(graph([execute("a")]), {
    signal: controller.signal,
    runner: async (invocation) => {
      request = invocation;
      return { output: "done" };
    },
  });
  controller.abort();
  assert.equal(request.signal.aborted, false);
  assert.equal(result.status, "completed");
});
