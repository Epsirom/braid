import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReplanArguments,
  replanToolDefinition,
  startBraid,
  type BraidInput,
  type BraidOptions,
  type BraidRun,
  type ExecutionEvent,
  type ModelRequest,
  type ModelRunner,
} from "../src/index.js";
import { deferred } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

async function start(t: TestContext, graph: BraidInput, options: Omit<BraidOptions, "cwd">, events: ExecutionEvent[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "braid-replan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); } });
}

/** Runs `act` inside node `id` while it runs; other nodes return their ID. */
function within(id: string, act: (request: ModelRequest) => void | Promise<void>) {
  const ran: string[] = [];
  const runner: ModelRunner = async request => {
    if (request.node.id === id) await act(request);
    ran.push(request.node.id);
    return { output: request.node.id };
  };
  return { runner, ran };
}

const executionOf = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).find(record => record.id === nodeId)!;
const chain: BraidInput = { goal: "replan", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] };

test("a replan request holds the result, records the reason, and lets the node finish", async t => {
  const events: ExecutionEvent[] = [];
  const { runner, ran } = within("a", request => request.requestReplan!({ reason: "b is no longer needed" }));
  const run = await start(t, chain, { runner }, events);
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  const a = executionOf(run, "a");
  assert.equal(a.status, "completed", "the node finished its work");
  assert.equal(a.replan!.reason, "b is no longer needed");
  assert.equal(a.replan!.revision, 0);
  assert.equal(a.holdAfter!.source, "replan");
  assert.equal(run.snapshot().revision, 0, "a request does not change the graph");
  assert.deepEqual(ran, ["a"], "b waits for the parent");
  const types = events.filter(event => ["execution_hold_added", "replan_requested", "execution_paused"].includes(event.type)).map(event => event.type);
  assert.deepEqual(types, ["execution_hold_added", "replan_requested", "execution_paused"]);
  const requested = events.find(event => event.type === "replan_requested")!;
  assert.equal(requested.executionId, a.executionId);
  assert.equal(requested.type === "replan_requested" && requested.reason, "b is no longer needed");

  // The parent replans with an ordinary update and releases the execution atomically.
  run.update({ expectedRevision: 0, removeNodeIds: ["b"], upsertNodes: [node("c")], addEdges: [{ from: "a", to: "c" }], resume: [a.executionId] });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(ran, ["a", "c"]);
  assert.equal(result.executions[a.executionId]!.replan!.reason, "b is no longer needed", "the request stays in history");
});

test("a suggestion is validated against the current graph and recorded for the parent", async t => {
  const errors: string[] = [];
  const suggestion = { upsertNodes: [node("c")], addEdges: [{ from: "a", to: "c" }], removeNodeIds: ["b"] };
  const { runner, ran } = within("a", request => {
    for (const invalid of [
      { addEdges: [{ from: "a", to: "missing" }] },
      {},
      { loops: [] },
      { upsertNodes: "c" },
    ]) {
      try { request.requestReplan!({ reason: "fix", suggestion: invalid as never }); }
      catch (error) { errors.push((error as Error).message); }
    }
    request.requestReplan!({ reason: "replace b with c", suggestion });
  });
  const run = await start(t, chain, { runner });
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  assert.equal(errors.length, 4, "every invalid suggestion is rejected");
  assert.match(errors[0]!, /Invalid replan suggestion at revision 0: .*missing/);
  assert.match(errors[1]!, /at least one of/);
  assert.match(errors[2]!, /at least one of/);
  assert.match(errors[3]!, /upsertNodes must be an array/);
  const a = executionOf(run, "a");
  assert.deepEqual(a.replan!.suggestion, suggestion);
  assert.equal(a.replan!.reason, "replace b with c");
  assert.equal(run.snapshot().graph.nodes.length, 2, "nothing was applied");

  run.update({ expectedRevision: 0, ...a.replan!.suggestion!, resume: [a.executionId] });
  await run.result;
  assert.deepEqual(ran, ["a", "c"]);
});

test("a repeated request replaces the first, and an existing hold keeps its source", async t => {
  const events: ExecutionEvent[] = [];
  const { runner } = within("a", request => {
    request.requestReplan!({ reason: "first" });
    request.requestReplan!({ reason: "second" });
  });
  const graph: BraidInput = { ...chain, nodes: [{ ...node("a"), pauseAfter: true }, node("b")] };
  const run = await start(t, graph, { runner }, events);
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  const a = executionOf(run, "a");
  assert.equal(a.replan!.reason, "second");
  assert.equal(a.holdAfter!.source, "definition");
  assert.equal(events.filter(event => event.type === "execution_hold_added").length, 0);
  assert.equal(events.filter(event => event.type === "replan_requested").length, 2);
  run.resume([a.executionId], 0);
  assert.equal((await run.result).status, "completed");
});

test("the parent can let the plan continue by removing the hold", async t => {
  const gate = deferred();
  const { runner, ran } = within("a", async request => {
    request.requestReplan!({ reason: "maybe skip b" });
    await gate.promise;
  });
  const run = await start(t, chain, { runner });
  await until(() => executionOf(run, "a")?.replan !== undefined);
  const a = executionOf(run, "a").executionId;
  run.holdAfter([a], false, { source: "agent" });
  gate.resolve();
  const result = await run.result;
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(result.executions[a]!.replan!.reason, "maybe skip b");
});

test("requests are rejected when invalid or after the invocation ends", async t => {
  const errors: string[] = [];
  let late: ModelRequest["requestReplan"];
  const { runner } = within("a", request => {
    for (const invalid of [{ reason: " " }, { reason: 1 }, { reason: "x", extra: true }, null]) {
      try { request.requestReplan!(invalid as never); }
      catch (error) { errors.push((error as Error).message); }
    }
    late = request.requestReplan;
  });
  const run = await start(t, chain, { runner });
  const result = await run.result;
  assert.equal(result.status, "completed", "rejected requests hold nothing");
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /non-empty/);
  assert.match(errors[2]!, /only reason/);
  assert.equal(Object.values(result.executions).find(record => record.id === "a")!.replan, undefined);
  assert.throws(() => late!({ reason: "too late" }), /can no longer be requested/);
});

test("requestReplan is offered to execute and decision nodes only", async t => {
  const offered: Record<string, boolean> = {};
  const runner: ModelRunner = async request => {
    offered[request.node.type] = typeof request.requestReplan === "function";
    if (request.merge) await request.merge.finish([]);
    request.decide?.("done");
    return { output: request.node.id };
  };
  const run = await start(t, {
    goal: "types",
    nodes: [node("a"), { type: "decision", id: "d", prompt: "d", choices: ["done"] }, { type: "merge", id: "m" }],
    edges: [{ from: "a", to: "m" }, { from: "d", to: "m" }],
  }, { runner });
  assert.equal((await run.result).status, "completed");
  assert.deepEqual(offered, { execute: true, decision: true, merge: false });
});

test("the shared tool schema matches the argument parser", () => {
  const definition = replanToolDefinition();
  assert.equal(definition.name, "request_replan");
  assert.deepEqual(definition.parameters.required, ["reason"]);
  assert.deepEqual(parseReplanArguments({ reason: "r", suggestion: { removeNodeIds: ["b"] } }), { reason: "r", suggestion: { removeNodeIds: ["b"] } });
  assert.throws(() => parseReplanArguments({ suggestion: {} }), /reason/);
  assert.throws(() => parseReplanArguments({ reason: "r", other: 1 }), /reason/);
  assert.throws(() => parseReplanArguments("r"), /reason/);
});
