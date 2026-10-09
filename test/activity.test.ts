import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionActivityTracker,
  formatActivityStatus,
  type ExecutionActivity,
  type ModelRequest,
} from "../src/index.js";
import { braid, deferred, execute, graph } from "./helpers.js";

test("activity follows workspace, model, stream, tool, and finalization phases for one execution", async () => {
  const snapshots: ExecutionActivity[] = [];
  const tool = deferred<void>();
  const streaming = deferred<void>();
  let executionId = "";
  const tracker = new ExecutionActivityTracker();
  const pending = braid(graph([execute("a")]), {
    onEvent: event => tracker.observe(event),
    runner: async request => {
      executionId = request.execution.executionId!;
      const activity = tracker.recorder(request);
      try {
        activity.modelRequest();
        snapshots.push(tracker.get(executionId)!);
        activity.modelStream("tool_call", '{"command":"npm', "bash");
        streaming.resolve();
        activity.modelResponse({ toolCalls: [{ id: "c1", name: "bash" }], stopReason: "toolUse", inputTokens: 5, outputTokens: 2 });
        activity.toolStart("c1", "bash", { command: "npm test" });
        activity.toolOutput("c1", "running 3 tests\n");
        await tool.promise;
        activity.toolEnd("c1", "ok", false);
        activity.modelRequest();
        activity.modelStream("text", "All ");
        activity.modelResponse({ text: "All tests pass", stopReason: "stop" });
        return { output: "All tests pass" };
      } finally {
        tracker.workerFinished(executionId);
      }
    },
  });
  await streaming.promise;
  const running = tracker.get(executionId)!;
  assert.equal(running.phase, "tool");
  assert.equal(running.tools[0]!.name, "bash");
  assert.equal(running.tools[0]!.outputTail, "running 3 tests\n");
  assert.match(formatActivityStatus(running, running.lastActivityAt), /bash running/);
  assert.equal(snapshots[0]!.phase, "model");
  assert.equal(snapshots[0]!.model!.firstStreamAt, undefined, "no stream signal is reported before one arrives");
  assert.match(formatActivityStatus(snapshots[0]!, snapshots[0]!.phaseStartedAt), /awaiting first stream event/);
  tool.resolve();
  const result = await pending;
  assert.equal(result.status, "completed");
  const done = tracker.get(executionId)!;
  assert.equal(done.phase, "completed");
  assert.equal(done.modelRequests, 2);
  assert.equal(done.toolCalls, 1);
  assert.deepEqual(done.tools, []);
  assert.ok(done.finishedAt);
  const kinds = done.entries.map(entry => entry.kind);
  assert.equal(kinds[0], "workspace");
  for (const kind of ["lifecycle", "model_request", "model_response", "tool_call", "tool_result", "assistant"])
    assert.ok(kinds.includes(kind as never), kind);
  assert.deepEqual(done.entries.map(entry => entry.sequence), done.entries.map((_, index) => index + 1));
  assert.ok(done.entries.some(entry => entry.summary === "Worker returned · checkpoint and cleanup"));
  assert.match(done.entries.at(-1)!.summary, /^Completed in/);
  assert.equal(done.entries.find(entry => entry.kind === "tool_call")!.detail, '{"command":"npm test"}');
});

test("repeated loop visits keep separate execution histories", async () => {
  const tracker = new ExecutionActivityTracker();
  let visits = 0;
  const result = await braid({
    goal: "loop",
    nodes: [execute("work"), { type: "decision", id: "check", prompt: "check", choices: ["retry", "done"] }],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "retry", feedback: "again" }],
    loops: [{ id: "again", entry: "work", maxIterations: 2 }],
  }, {
    onEvent: event => tracker.observe(event),
    runner: async request => {
      const activity = tracker.recorder(request);
      activity.modelRequest();
      if (request.node.id === "work") activity.modelResponse({ text: `visit ${++visits}` });
      if (request.decide) request.decide(visits < 2 ? "retry" : "done");
      return { output: "ok" };
    },
  });
  const works = Object.values(result.executions).filter(execution => execution.id === "work");
  assert.equal(works.length, 2);
  const texts = works.map(execution => tracker.get(execution.executionId)!.entries
    .filter(entry => entry.kind === "assistant").map(entry => entry.summary));
  assert.deepEqual(texts, [["visit 1"], ["visit 2"]]);
});

test("history, details, and finished executions are bounded and pageable", () => {
  let now = 1000;
  const changes: number[] = [];
  const tracker = new ExecutionActivityTracker({ maxEntries: 5, maxDetailChars: 10, maxRetainedHistories: 1, now: () => now, onChange: () => changes.push(now) });
  const request = (executionId: string) => ({ node: { type: "execute", id: "a", prompt: "p" }, execution: { runId: "r", rootRunId: "r", executionId } }) as Pick<ModelRequest, "node" | "execution">;
  const first = tracker.recorder(request("e1"));
  for (let index = 0; index < 4; index++) first.toolStart(`c${index}`, "read", { path: "x".repeat(50) });
  const activity = tracker.get("e1")!;
  assert.equal(activity.entries.length, 4);
  assert.equal(activity.entries[0]!.detail, '{"path":"x…');
  assert.equal(activity.entries[0]!.detailLength, 61);
  for (let index = 0; index < 4; index++) first.toolEnd(`c${index}`, "done", false);
  const bounded = tracker.get("e1")!;
  assert.equal(bounded.entries.length, 5);
  assert.equal(bounded.droppedEntries, 3);
  assert.equal(bounded.sequence, 8);
  assert.deepEqual(tracker.get("e1", { before: 7, limit: 2 })!.entries.map(entry => entry.sequence), [5, 6]);
  assert.deepEqual(tracker.get("e1", { limit: 0 })!.entries, []);

  // Stream deltas are throttled; discrete entries always notify.
  first.modelRequest();
  const before = changes.length;
  first.modelStream("text", "a");
  first.modelStream("text", "b");
  assert.equal(changes.length, before + 1);
  now += 1000;
  first.modelStream("text", "c");
  assert.equal(changes.length, before + 2);
  assert.equal(tracker.get("e1")!.model!.tail, "abc");

  for (const id of ["e1", "e2"]) {
    tracker.recorder(request(id)).modelRequest();
    tracker.observe({ sequence: 1, timestamp: now, executionId: id, type: "node_completed", nodeId: "a", latencyMs: 5, output: "x" });
  }
  assert.deepEqual(tracker.get("e1")!.entries, [], "older finished histories keep only their summary");
  assert.equal(tracker.get("e1")!.phase, "completed");
  assert.ok(tracker.get("e2")!.entries.length > 0);
  // Recorders cannot change a finished execution.
  tracker.recorder(request("e2")).toolStart("late", "bash", {});
  assert.equal(tracker.get("e2")!.toolCalls, 0);
});

test("recorders without an execution identity and throwing observers never affect a run", async () => {
  const tracker = new ExecutionActivityTracker({ onChange: () => { throw new Error("observer"); } });
  const anonymous = tracker.recorder({ node: { type: "execute", id: "a", prompt: "p" }, execution: { runId: "r", rootRunId: "r" } });
  anonymous.modelRequest();
  anonymous.limitation("no stream");
  const result = await braid(graph([execute("a")]), {
    onEvent: event => tracker.observe(event),
    runner: async request => {
      const activity = tracker.recorder(request);
      activity.limitation("Provider stream events are unavailable");
      activity.limitation("Provider stream events are unavailable");
      activity.modelRequest();
      activity.modelError("boom");
      return { output: "ok" };
    },
  });
  assert.equal(result.status, "completed");
  const activity = tracker.get(Object.keys(result.executions)[0]!)!;
  assert.deepEqual(activity.limitations, ["Provider stream events are unavailable"]);
  assert.ok(activity.entries.some(entry => entry.kind === "model_error" && entry.isError));
});
