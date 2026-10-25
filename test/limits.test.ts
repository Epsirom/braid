import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  braid,
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
const loop = (limit?: number): BraidInput => ({
  goal: "refine",
  nodes: [node("work"), { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }, node("end")],
  edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", ...(limit === undefined ? {} : { limit }) }, { from: "check", to: "end", choice: "done" }],
});
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

async function start(t: TestContext, graph: BraidInput, options: Omit<BraidOptions, "cwd">, events: ExecutionEvent[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "braid-limits-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); } });
  t.after(() => run.cancel());
  return run;
}
const executions = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).filter(record => record.id === nodeId);
/** Always repeats the loop. */
const repeating: ModelRunner = async request => { request.decide?.("again"); return { output: request.execution.executionId! }; };

test("limits default to unlimited", async t => {
  const deadlines: (ModelRequest["deadlines"])[] = [];
  const rounds = 501;
  const run = await start(t, loop(), { runner: async request => {
    deadlines.push(request.deadlines);
    request.decide?.(request.execution.generation === rounds ? "done" : "again");
    return { output: "ok" };
  } });
  assert.deepEqual(run.snapshot().limits, {});
  const result = await run.result;
  assert.equal(result.status, "completed");
  // More than the former default of 1000 executions, with no node or graph deadline.
  assert.equal(Object.keys(result.executions).length, rounds * 2 + 1);
  assert.ok(deadlines.every(value => value === undefined));
});

test("an edge at its limit holds the decision until the owner raises the limit or ends the cycle", async t => {
  const events: ExecutionEvent[] = [];
  const run = await start(t, loop(1), { runner: repeating }, events);
  await until(() => run.snapshot().status === "waiting");
  const [first, second] = executions(run, "check");
  assert.equal(first!.holdAfter, undefined);
  assert.deepEqual(run.snapshot().pausedExecutionIds, [second!.executionId]);
  assert.equal(second!.holdAfter?.source, "edge_limit");
  assert.equal(second!.held, true);
  const reached = events.find(event => event.type === "limit_reached");
  assert.deepEqual(reached && { limit: reached.limit, value: reached.value, nodeId: reached.nodeId, executionId: reached.executionId, edge: reached.edge },
    { limit: "edge", value: 1, nodeId: "check", executionId: "check@2", edge: { from: "check", to: "work", choice: "again", limit: 1 } });
  assert.deepEqual(events.filter(event => event.executionId === second!.executionId && event.type.startsWith("execution_") && event.type !== "execution_created").map(event => event.type),
    ["execution_hold_added", "execution_paused"]);
  assert.equal(run.snapshot().nodes.end!.waitReason, "hold");

  // Raising the limit in the same update continues with the next round; the edge keeps its count.
  const edge = { from: "check", to: "work", choice: "again" };
  run.update({ expectedRevision: run.snapshot().revision, removeEdges: [edge], addEdges: [{ ...edge, limit: 2 }], resume: [second!.executionId] });
  await until(() => executions(run, "check").length === 3 && run.snapshot().status === "waiting");
  const third = executions(run, "check")[2]!;
  assert.deepEqual(run.snapshot().pausedExecutionIds, [third.executionId]);

  // Releasing it without a higher limit ends the cycle; its exit is not taken.
  run.resume([third.executionId], run.snapshot().revision);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.end!.status, "skipped");
  assert.equal(result.nodes.end!.skipReason, "inactive");
  assert.deepEqual(result.terminalExecutionIds, [third.executionId]);
  assert.equal(executions(run, "work").length, 3);
});

test("onLimit fail fails the run at an edge limit", async t => {
  const run = await start(t, loop(1), { runner: repeating, onLimit: "fail" });
  const result = await run.result;
  assert.equal(result.error?.code, "EDGE_LIMIT");
});

test("maxExecutions stops admission, lets admitted work finish, and resumes after setLimits", async t => {
  const events: ExecutionEvent[] = [];
  const gate = deferred();
  const run = await start(t, { goal: "count", nodes: [node("a"), node("b"), node("c")], edges: [] }, {
    maxExecutions: 2, maxConcurrency: 2,
    runner: async request => { if (request.node.id === "a") await gate.promise; return { output: request.node.id }; },
  }, events);
  await until(() => run.snapshot().pause !== undefined);
  assert.equal(run.snapshot().pause?.source, "execution_limit");
  assert.deepEqual(run.snapshot().limits, { maxExecutions: 2 });
  // The admitted execution is not paused, only admission stops.
  assert.equal(executions(run, "a")[0]!.suspension, undefined);
  gate.resolve();
  await until(() => run.snapshot().status === "waiting");
  assert.deepEqual(Object.values(run.snapshot().executions).filter(record => record.status !== "pending").map(record => record.id).sort(), ["a", "b"]);
  assert.equal(run.snapshot().nodes.c!.waitReason, "run_paused");
  assert.throws(() => run.resumeRun(), /maxExecutions limit of 2; raise it with setLimits/);

  assert.deepEqual(run.setLimits({ maxExecutions: 3 }).limits, { maxExecutions: 3 });
  run.resumeRun();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.c!.output, "c");
  const types = events.map(event => event.type);
  assert.ok(types.indexOf("limit_reached") < types.indexOf("graph_paused"));
  const updated = events.find(event => event.type === "limits_updated");
  assert.deepEqual(updated?.type === "limits_updated" && updated.limits, { maxExecutions: 3 });
});

test("the graph timeout pauses running work and moves the deadline it reports", async t => {
  const gate = deferred();
  let request!: ModelRequest;
  const steps: number[] = [];
  const runner = Object.assign(async (value: ModelRequest) => {
    request = value;
    for (const step of [1, 2]) {
      await value.checkpoint!();
      steps.push(step);
      if (step === 1) await gate.promise;
    }
    return { output: "done" };
  }, { pausable: true });
  const run = await start(t, { goal: "slow", nodes: [node("a")], edges: [] }, { runner, graphTimeoutMs: 50 });
  await until(() => steps.length === 1);
  assert.equal(typeof request.deadlines?.graph, "number");
  await until(() => run.snapshot().pause !== undefined, 2_000);
  assert.equal(run.snapshot().pause?.source, "graph_timeout");
  const id = executions(run, "a")[0]!.executionId;
  assert.equal(run.snapshot().executions[id]!.suspension?.source, "graph_timeout");
  gate.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(id));
  assert.throws(() => run.resumeRun(), /graphTimeoutMs limit of 50/);

  run.setLimits({ graphTimeoutMs: Infinity });
  assert.equal(request.deadlines?.graph, undefined);
  run.resumeRun();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(steps, [1, 2]);
});

test("maxTokens pauses the run once settled executions reach it", async t => {
  const events: ExecutionEvent[] = [];
  const chain: BraidInput = { goal: "spend", nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const runner: ModelRunner = async request => ({ output: request.node.id, usage: { inputTokens: 6, outputTokens: 4 } });
  const run = await start(t, chain, { runner, maxTokens: 15 }, events);
  await until(() => run.snapshot().status === "waiting");
  assert.equal(run.snapshot().pause?.source, "token_limit");
  assert.deepEqual(Object.values(run.snapshot().executions).filter(record => record.status !== "pending").map(record => record.id), ["a", "b"]);
  assert.deepEqual(events.filter(event => event.type === "limit_reached").map(event => [event.limit, event.value]), [["maxTokens", 15]]);
  assert.throws(() => run.resumeRun(), /maxTokens limit of 15/);
  run.setLimits({ maxTokens: 100 });
  run.resumeRun();
  assert.equal((await run.result).nodes.c!.status, "completed");

  const failing = await start(t, chain, { runner, maxTokens: 15, onLimit: "fail" });
  const result = await failing.result;
  assert.equal(result.error?.code, "TOKEN_LIMIT");
  assert.equal(result.nodes.c!.status, "skipped");
});

test("limit options and setLimits are validated, and braid() cannot pause at a limit", async t => {
  const runner: ModelRunner = async () => ({ output: "ok" });
  const graph = { goal: "x", nodes: [node("a")], edges: [] };
  for (const options of [{ maxExecutions: 0 }, { maxExecutions: 1.5 }, { maxTokens: -1 }, { graphTimeoutMs: 0 }, { onLimit: "wait" }])
    assert.throws(() => startBraid(graph, { runner, ...options } as BraidOptions), TypeError);
  await assert.rejects(braid(graph, { runner, onLimit: "pause" }), /braid\(\) cannot resume a run at a limit/);
  const gate = deferred();
  const run = await start(t, graph, { runner: async () => { await gate.promise; return { output: "ok" }; } });
  assert.throws(() => run.setLimits({ maxConcurrency: 2 } as never), /setLimits accepts only/);
  assert.throws(() => run.setLimits({ maxTokens: 0 }), /maxTokens/);
  assert.deepEqual(run.setLimits({ maxTokens: 10, graphTimeoutMs: 60_000 }).limits, { graphTimeoutMs: 60_000, maxTokens: 10 });
  assert.deepEqual(run.setLimits({ maxTokens: Infinity }).limits, { graphTimeoutMs: 60_000 });
  gate.resolve();
  assert.equal((await run.result).status, "completed");
});
