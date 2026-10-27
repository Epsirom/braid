import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  braid,
  startBraid,
  validateGraph,
  type BraidInput,
  type BraidOptions,
  type BraidRun,
  type ExecutionEvent,
  type ModelRequest,
  type ModelRunner,
} from "../src/index.js";
import { deferred } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const loop = (maxRuns?: number): BraidInput => ({
  goal: "refine",
  nodes: [{ ...node("work"), ...(maxRuns === undefined ? {} : { maxRuns }) }, { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }, node("end")],
  edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }, { from: "check", to: "end", choice: "done" }],
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

test("a rerun beyond maxRuns waits pending until the owner raises maxRuns or ends the cycle", async t => {
  const events: ExecutionEvent[] = [];
  const run = await start(t, loop(2), { runner: repeating }, events);
  await until(() => run.snapshot().status === "waiting");
  let state = run.snapshot();
  assert.deepEqual(executions(run, "work").map(record => [record.executionId, record.status]),
    [["work@1", "completed"], ["work@2", "completed"], ["work@3", "pending"]]);
  assert.deepEqual(state.limitedExecutionIds, ["work@3"]);
  assert.deepEqual(state.pausedExecutionIds, []);
  assert.equal(state.nodes.work!.waitReason, "limit");
  // end runs only once check chooses done.
  assert.equal(state.nodes.end!.waitReason, "choice");
  const reached = events.find(event => event.type === "limit_reached");
  assert.deepEqual(reached && { limit: reached.limit, value: reached.value, nodeId: reached.nodeId, executionId: reached.executionId },
    { limit: "maxRuns", value: 2, nodeId: "work", executionId: "work@3" });
  const waiting = events.filter(event => event.type === "graph_waiting").at(-1);
  assert.deepEqual(waiting?.type === "graph_waiting" && waiting.limitedExecutionIds, ["work@3"]);

  // Raising maxRuns edits the pending rerun in place, and it starts.
  run.update({ expectedRevision: state.revision, upsertNodes: [{ ...node("work"), maxRuns: 3 }] });
  await until(() => executions(run, "work").length === 4 && run.snapshot().status === "waiting");
  state = run.snapshot();
  assert.equal(state.executions["work@3"]!.status, "completed");
  assert.equal(state.executions["work@3"]!.supersedes, undefined);
  assert.deepEqual(state.limitedExecutionIds, ["work@4"]);

  // Releasing it without raising maxRuns ends the cycle: the rerun is removed and its exit is not taken.
  run.resume(["work@4"], state.revision);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.end!.status, "skipped");
  assert.equal(result.nodes.end!.skipReason, "inactive");
  assert.deepEqual(result.terminalExecutionIds, ["check@3"]);
  assert.equal(result.executions["work@4"], undefined);
  assert.equal(result.nodes.work!.executionId, "work@3");
  assert.ok(events.some(event => event.type === "execution_removed" && event.executionId === "work@4"));
  assert.deepEqual(run.snapshot().limitedExecutionIds, []);
});

test("onLimit fail fails the run at maxRuns", async t => {
  const run = await start(t, loop(1), { runner: repeating, onLimit: "fail" });
  const result = await run.result;
  assert.equal(result.error?.code, "RUN_LIMIT");
  assert.match(result.error!.message, /Node 'work' reached its maxRuns of 1/);
});

test("maxRuns limits downstream reruns, never the owner's replacement", async t => {
  const run = await start(t, { goal: "rerun", nodes: [node("a"), { ...node("b"), maxRuns: 1 }, { ...node("gate"), pauseAfter: true }],
    edges: [{ from: "a", to: "b" }] }, { runner: async request => ({ output: request.node.prompt! }) });
  await until(() => run.snapshot().status === "waiting");
  // Replacing b starts it even though it has run maxRuns times.
  run.update({ expectedRevision: 0, upsertNodes: [{ ...node("b"), prompt: "b2", maxRuns: 1 }] });
  await until(() => run.snapshot().executions["b@2"]?.status === "completed" && run.snapshot().status === "waiting");
  // A rerun of a reaches b, which is past its limit: b's rerun waits.
  run.update({ expectedRevision: 1, upsertNodes: [{ ...node("a"), prompt: "a2" }] });
  await until(() => run.snapshot().limitedExecutionIds.length > 0 && run.snapshot().status === "waiting");
  let state = run.snapshot();
  assert.deepEqual(state.limitedExecutionIds, ["b@3"]);
  assert.equal(state.executions["b@3"]!.waitReason, "limit");
  assert.throws(() => run.resume(["b@2"], state.revision), /held, paused, or limited/);

  // Ending the rerun in an update keeps b@2, and b is not cloned again for the same input.
  run.update({ expectedRevision: state.revision, resume: ["b@3", state.pausedExecutionIds[0]!] });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(Object.keys(result.executions).filter(id => id.startsWith("b@")), ["b@1", "b@2"]);
  assert.equal(result.nodes.b!.output, "b2");
  state = run.snapshot();
  assert.equal(state.nodes.b!.executionId, "b@2");
});

test("changing only maxRuns keeps a running head and applies to the lineage's later reruns", async t => {
  let run!: BraidRun;
  run = await start(t, loop(2), { runner: async request => {
    if (request.execution.executionId === "work@1") run.update({ expectedRevision: 0, upsertNodes: [{ ...node("work"), maxRuns: 4 }] });
    return repeating(request);
  } });
  await until(() => run.snapshot().limitedExecutionIds.length > 0 && run.snapshot().status === "waiting");
  const state = run.snapshot();
  assert.equal(state.executions["work@1"]!.status, "completed");
  assert.equal(state.executions["work@1"]!.supersededBy, undefined);
  // The started head keeps the definition it ran with; the graph and later reruns use the new limit.
  assert.equal(state.executions["work@1"]!.node.maxRuns, 2);
  assert.equal(state.graph.nodes[0]!.maxRuns, 4);
  assert.deepEqual(state.limitedExecutionIds, ["work@5"]);
});

test("changing only maxRuns keeps a settled, held head; any other change replaces it", async t => {
  const run = await start(t, { goal: "hold", nodes: [{ ...node("a"), pauseAfter: true, maxRuns: 1 }, node("b")], edges: [{ from: "a", to: "b" }] },
    { runner: async request => ({ output: request.node.prompt! }) });
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  let state = run.snapshot();
  state = run.update({ expectedRevision: state.revision, upsertNodes: [{ ...node("a"), pauseAfter: true, maxRuns: 3 }] });
  assert.deepEqual(state.pausedExecutionIds, ["a@1"]);
  assert.deepEqual(Object.keys(state.executions).filter(id => id.startsWith("a@")), ["a@1"]);
  assert.equal(state.nodes.a!.executionId, "a@1");
  state = run.update({ expectedRevision: state.revision, upsertNodes: [{ ...node("a"), prompt: "a2" }] });
  assert.equal(state.executions["a@1"]!.supersededBy, "a@2");
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executions["b@1"]!.predecessorExecutionIds, ["a@2"]);
});

test("ending a limited rerun keeps inputs that are still rerunning, and an update may remove it instead", async t => {
  const gate = deferred();
  const run = await start(t, { goal: "rerun", nodes: [node("a"), { ...node("b"), maxRuns: 1 }, { ...node("hold"), pauseAfter: true }],
    edges: [{ from: "a", to: "b" }] }, { runner: async request => {
    if (request.execution.executionId === "a@3") await gate.promise;
    return { output: request.node.prompt! };
  } });
  await until(() => run.snapshot().status === "waiting");
  run.update({ expectedRevision: 0, upsertNodes: [{ ...node("a"), prompt: "a2" }] });
  await until(() => run.snapshot().limitedExecutionIds.length > 0 && run.snapshot().status === "waiting");
  // a reruns again while b@2 waits; ending b@2 now must not accept a@3 before it settles.
  run.update({ expectedRevision: 1, upsertNodes: [{ ...node("a"), prompt: "a3" }] });
  await until(() => run.snapshot().executions["a@3"]?.status === "running");
  run.resume(["b@2"], 2);
  assert.equal(run.snapshot().executions["b@2"], undefined);
  gate.resolve();
  await until(() => run.snapshot().limitedExecutionIds.includes("b@3") && run.snapshot().status === "waiting");

  // Removing b and releasing its rerun in one update does not fail.
  const state = run.snapshot();
  run.update({ expectedRevision: state.revision, removeNodeIds: ["b"], resume: ["b@3", ...state.pausedExecutionIds] });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.executions["b@3"], undefined);
});

test("skipped reruns do not count toward maxRuns", async t => {
  const result = await braid({ goal: "branch", nodes: [
    { type: "decision", id: "route", prompt: "route", choices: ["left", "right"] }, { ...node("left"), maxRuns: 1 }, node("right"),
    { type: "decision", id: "check", prompt: "check", choices: ["again", "done"] },
  ], edges: [{ from: "route", to: "left", choice: "left" }, { from: "route", to: "right", choice: "right" },
    { from: "left", to: "check" }, { from: "right", to: "check" }, { from: "check", to: "route", choice: "again" }] }, {
    runner: async request => {
      const round = request.execution.generation!;
      if (request.node.id === "route") request.decide!(round === 3 ? "left" : "right");
      if (request.node.id === "check") request.decide!(round === 3 ? "done" : "again");
      return { output: request.execution.executionId! };
    },
  });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.deepEqual(Object.values(result.executions).filter(record => record.id === "left").map(record => record.status),
    ["skipped", "skipped", "completed"]);
});

test("maxRuns is validated on every node type, and edges take no limit", () => {
  for (const maxRuns of [0, 1.5, -1, Number.NaN, "2"])
    assert.throws(() => validateGraph({ goal: "x", nodes: [{ ...node("a"), maxRuns } as never], edges: [] }), /Invalid maxRuns on 'a'/);
  for (const type of ["execute", "decision", "merge", "integrate"] as const)
    validateGraph({ goal: "x", nodes: [{ type, id: "a", prompt: "a", ...(type === "decision" ? { choices: ["x"] } : {}), maxRuns: Infinity } as never], edges: [] });
  assert.throws(() => validateGraph({ ...loop(), edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", limit: 2 } as never] }),
    /unsupported field 'limit'/);
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
