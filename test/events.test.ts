import assert from "node:assert/strict";
import test from "node:test";
import { type ExecutionEvent, type ModelRunner } from "../src/index.js";
import { braid, decision, execute, graph } from "./helpers.js";

function types(events: readonly ExecutionEvent[]): string[] {
  return events.map((event) => event.type);
}

test("execution log records graph creation, handoffs, routing, skips, and completion", async () => {
  const observed: ExecutionEvent[] = [];
  const result = await braid(
    graph(
      [
        decision("route", ["go", "stop"]),
        execute("left"),
        execute("right"),
        execute("join"),
      ],
      [
        { from: "route", to: "left", choice: "go" },
        { from: "route", to: "right", choice: "stop" },
        { from: "left", to: "join" },
      ],
    ),
    {
      onEvent: (event) => observed.push(event),
      runner: async (request) => {
        if (request.decide) request.decide("go");
        return { output: request.node.id, model: "test/model" };
      },
    },
  );
  assert.deepEqual(types(result.events), [
    "graph_created",
    "node_created",
    "node_created",
    "node_created",
    "node_created",
    "edge_created",
    "edge_created",
    "edge_created",
    "node_runnable",
    "node_started",
    "node_completed",
    "node_runnable",
    "node_skipped",
    "node_started",
    "handoff",
    "node_completed",
    "node_runnable",
    "node_started",
    "handoff",
    "node_completed",
    "graph_completed",
  ]);
  assert.deepEqual(types(observed), types(result.events));
  assert.deepEqual(
    result.events.map((event) => event.sequence),
    result.events.map((_event, i) => i + 1),
  );
  assert.ok(result.events.every((event) => event.timestamp > 0));
  assert.deepEqual(result.events[0], {
    type: "graph_created",
    sequence: 1,
    timestamp: result.events[0]!.timestamp,
    nodeCount: 4,
    edgeCount: 3,
  });
  assert.deepEqual(result.events[1], {
    type: "node_created",
    sequence: 2,
    timestamp: result.events[1]!.timestamp,
    nodeId: "route",
    nodeType: "decision",
  });
  assert.deepEqual(result.events[5], {
    type: "edge_created",
    sequence: 6,
    timestamp: result.events[5]!.timestamp,
    from: "route",
    to: "left",
    choice: "go",
  });
  const handoffs = result.events.filter((event) => event.type === "handoff");
  assert.deepEqual(
    handoffs.map(({ timestamp: _timestamp, ...event }) => event),
    [
      {
        type: "handoff",
        sequence: 15,
        from: "route",
        to: "left",
        output: "route",
        decision: "go",
      },
      {
        type: "handoff",
        sequence: 19,
        from: "left",
        to: "join",
        output: "left",
      },
    ],
  );
  const completed = result.events.find(
    (event) => event.type === "node_completed" && event.nodeId === "route",
  );
  assert.equal(completed?.type, "node_completed");
  if (completed?.type === "node_completed") {
    assert.equal(completed.sequence, 11);
    assert.equal(completed.nodeId, "route");
    assert.equal(completed.output, "route");
    assert.equal(completed.decision, "go");
    assert.equal(completed.model, "test/model");
    assert.ok(completed.latencyMs >= 0);
  }
  assert.deepEqual(result.events.at(-1), {
    type: "graph_completed",
    sequence: result.events.length,
    timestamp: result.events.at(-1)!.timestamp,
    terminalNodeIds: ["join"],
  });
});

test("execution log records failures and continued handoffs", async () => {
  const runner: ModelRunner = async (request) => {
    if (request.node.id === "bad") throw new Error("boom");
    return { output: request.node.id };
  };
  const result = await braid(
    graph(
      [execute("bad"), execute("dependent"), execute("independent")],
      [{ from: "bad", to: "dependent" }],
    ),
    { runner },
  );
  const failure = result.events.find((event) => event.type === "node_failed");
  assert.equal(failure?.type, "node_failed");
  if (failure?.type === "node_failed") {
    assert.equal(failure.nodeId, "bad");
    assert.deepEqual(failure.error, { code: "MODEL_ERROR", message: "boom" });
  }
  assert.ok(result.events.some(event => event.type === "handoff" && event.from === "bad" && event.to === "dependent"));
  assert.equal(result.nodes.dependent!.status, "completed");
  const final = result.events.at(-1);
  assert.equal(final?.type, "graph_failed");
  assert.deepEqual(result.terminalOutputs, {
    independent: { output: "independent" },
    dependent: { output: "dependent" },
  });
});

test("event observers are isolated from the retained execution log and cannot fail the run", async () => {
  const result = await braid(graph([execute("a")]), {
    onEvent: (event) => {
      assert.throws(() => {
        (event as unknown as { type: string }).type = "graph_failed";
      });
      throw new Error("observer failed");
    },
    runner: async () => ({ output: "done" }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.events[0]?.type, "graph_created");
  assert.equal(result.events.at(-1)?.type, "graph_completed");
});
