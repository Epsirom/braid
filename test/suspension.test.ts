import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionActivityTracker,
  startBraid,
  type BraidInput,
  type BraidOptions,
  type BraidRun,
  type ExecutionEvent,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
} from "../src/index.js";
import { deferred } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const input = (ids: string[], edges: BraidInput["edges"] = []): BraidInput => ({ goal: "pause", nodes: ids.map(node), edges });
const pausable = (run: (request: ModelRequest) => Promise<ModelResponse>): ModelRunner => Object.assign(run, { pausable: true });
// Bound the wait by time, not ticks: workspace setup awaits file-system calls,
// which can take many event-loop turns on slow runners (notably Windows).
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};
async function cwd(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "braid-suspend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A runner that takes `steps` model steps, each behind a checkpoint, and waits on `gates` per node. */
function stepper(steps = 3, gates: Record<string, Promise<void>> = {}) {
  const log: string[] = [];
  const runner = pausable(async request => {
    const id = request.node.id;
    const conversation: string[] = [];
    for (let step = 1; step <= steps; step++) {
      await request.checkpoint!();
      log.push(`${id}:${step}`);
      conversation.push(`step ${step}`);
      if (step === 1) await gates[id];
    }
    return { output: `${id}: ${conversation.join(", ")}` };
  });
  return { runner, log };
}

function start(t: TestContext, graph: BraidInput, options: Omit<BraidOptions, "cwd">, events: ExecutionEvent[] = []) {
  return cwd(t).then(directory => startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); options.onEvent?.(event); } }));
}

const executionOf = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).find(record => record.id === nodeId)!;

test("a paused execution suspends at its next checkpoint and resumes the same conversation", async t => {
  const gate = deferred();
  const { runner, log } = stepper(3, { a: gate.promise });
  const events: ExecutionEvent[] = [];
  const run = await start(t, input(["a"]), { runner }, events);
  await until(() => log.includes("a:1"));
  const id = executionOf(run, "a").executionId;
  const pausing = run.pause([id], { source: "user" });
  assert.equal(pausing.executions[id]!.suspension!.state, "pausing");
  assert.equal(pausing.executions[id]!.suspension!.source, "user");
  assert.deepEqual(pausing.suspendedExecutionIds, []);
  assert.equal(run.pause([id]).executions[id]!.suspension!.source, "user", "a repeated pause changes nothing");
  gate.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(id));
  assert.deepEqual(log, ["a:1"]);
  const suspended = run.snapshot();
  assert.equal(suspended.status, "waiting");
  assert.equal(suspended.executions[id]!.status, "running");
  assert.equal(suspended.executions[id]!.suspension!.state, "suspended");
  run.resume([id], suspended.revision);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.a!.output, "a: step 1, step 2, step 3");
  assert.equal(result.executions[id]!.suspension, undefined);
  assert.deepEqual(events.filter(event => event.type.startsWith("execution_")).map(event => event.type),
    ["execution_suspending", "execution_suspended", "execution_resumed"]);
  assert.equal(events.find(event => event.type === "execution_suspended")!.executionId, id);
});

test("pause is rejected for runners without checkpoints and for executions that are not running", async t => {
  const gate = deferred();
  const unpausable = await start(t, input(["a"]), { runner: async () => { await gate.promise; return { output: "a" }; } });
  await until(() => executionOf(unpausable, "a") !== undefined);
  assert.throws(() => unpausable.pause([executionOf(unpausable, "a").executionId]), /does not support pausing/);
  gate.resolve();
  await unpausable.result;

  const { runner } = stepper(1);
  const run = await start(t, { ...input(["a"]), nodes: [{ ...node("a"), pauseAfter: true }] }, { runner });
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  const held = run.snapshot().pausedExecutionIds[0]!;
  assert.throws(() => run.pause([held]), /running execution IDs/);
  assert.throws(() => run.pause(["missing"]), /running execution IDs/);
  assert.throws(() => run.pause([]), /running execution IDs/);
  assert.throws(() => run.pause([held], { source: " " }), /non-empty/);
  run.resume([held], 0);
  await run.result;
  assert.throws(() => run.pause([held]), /no longer accepting/);
});

test("resuming a still-pausing execution withdraws the request without suspending", async t => {
  const gate = deferred();
  const { runner, log } = stepper(2, { a: gate.promise });
  const events: ExecutionEvent[] = [];
  const run = await start(t, input(["a"]), { runner }, events);
  await until(() => log.includes("a:1"));
  const id = executionOf(run, "a").executionId;
  run.pause([id]);
  const state = run.resume([id], 0);
  assert.equal(state.executions[id]!.suspension, undefined);
  gate.resolve();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(events.filter(event => event.type.startsWith("execution_")).map(event => event.type),
    ["execution_suspending", "execution_resumed"]);
});

test("a suspended execution releases its slot and a resumed one waits for a slot before new admissions", async t => {
  const gates = { a: deferred(), b: deferred() };
  const { runner, log } = stepper(2, { a: gates.a.promise, b: gates.b.promise });
  const run = await start(t, input(["a", "b", "c"]), { runner, maxConcurrency: 1 });
  await until(() => log.includes("a:1"));
  const a = executionOf(run, "a").executionId;
  run.pause([a]);
  gates.a.resolve();
  await until(() => log.includes("b:1"));
  assert.ok(run.snapshot().suspendedExecutionIds.includes(a), "b runs in the slot a released");
  const resuming = run.resume([a], 0);
  assert.equal(resuming.executions[a]!.suspension!.state, "resuming");
  assert.ok(resuming.suspendedExecutionIds.includes(a), "still without a slot");
  gates.b.resolve();
  await run.result;
  assert.deepEqual(log, ["a:1", "b:1", "b:2", "a:2", "c:1", "c:2"], "a continues before c is admitted");
});

test("suspension stops the node timeout and moves the node deadline", async t => {
  const gate = deferred();
  let firstDeadline = 0;
  let resumedDeadline = 0;
  const runner = pausable(async request => {
    firstDeadline = request.deadlines!.node!;
    await request.checkpoint!();
    await gate.promise;
    await request.checkpoint!();
    resumedDeadline = request.deadlines!.node!;
    return { output: "done" };
  });
  const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 150 });
  await until(() => firstDeadline > 0);
  const id = executionOf(run, "a").executionId;
  run.pause([id]);
  gate.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(id));
  await new Promise(resolve => setTimeout(resolve, 300));
  run.resume([id], 0);
  const result = await run.result;
  assert.equal(result.status, "completed", JSON.stringify(result.nodes.a!.error));
  assert.ok(resumedDeadline - firstDeadline >= 250, `deadline moved by ${resumedDeadline - firstDeadline}ms`);
});

test("the graph deadline and cancellation still end a suspended execution", async t => {
  for (const [code, options] of [["GRAPH_TIMEOUT", { graphTimeoutMs: 100, onLimit: "fail" }], ["CANCELLED", {}]] as const) {
    const gate = deferred();
    const { runner, log } = stepper(2, { a: gate.promise });
    const run = await start(t, input(["a"]), { runner, ...options });
    await until(() => log.includes("a:1"));
    const id = executionOf(run, "a").executionId;
    run.pause([id]);
    gate.resolve();
    await until(() => run.snapshot().suspendedExecutionIds.includes(id));
    if (code === "CANCELLED") run.cancel();
    const result = await run.result;
    assert.equal(result.error?.code, code);
    assert.equal(result.executions[id]!.status, "failed");
    assert.equal(result.executions[id]!.suspension, undefined);
    assert.deepEqual(log, ["a:1"]);
  }
});

test("a graph update can resume a suspended execution atomically", async t => {
  const gate = deferred();
  const { runner, log } = stepper(2, { a: gate.promise });
  const run = await start(t, input(["a"]), { runner });
  await until(() => log.includes("a:1"));
  const id = executionOf(run, "a").executionId;
  run.pause([id]);
  gate.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(id));
  run.update({ expectedRevision: 0, upsertNodes: [node("b")], addEdges: [{ from: "a", to: "b" }], resume: [id] });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.b!.status, "completed");
  assert.deepEqual(log, ["a:1", "a:2", "b:1", "b:2"]);
});

test("pauseRun stops admission and pauses running work; resumeRun resumes only what it paused", async t => {
  const gates = { a: deferred(), b: deferred() };
  const { runner, log } = stepper(2, { a: gates.a.promise, b: gates.b.promise });
  const events: ExecutionEvent[] = [];
  const run = await start(t, input(["a", "b", "c"], [{ from: "a", to: "c" }]), { runner }, events);
  await until(() => log.includes("a:1") && log.includes("b:1"));
  const a = executionOf(run, "a").executionId;
  const b = executionOf(run, "b").executionId;
  run.pause([b], { source: "agent" });
  const paused = run.pauseRun({ source: "user" });
  assert.equal(paused.pause!.source, "user");
  assert.equal(paused.executions[a]!.suspension!.source, "user");
  assert.equal(paused.executions[b]!.suspension!.source, "agent", "an earlier pause keeps its source");
  assert.equal(run.pauseRun().pause!.source, "user", "a repeated run pause changes nothing");
  gates.a.resolve();
  gates.b.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.length === 2);
  assert.equal(run.snapshot().status, "waiting");
  run.resumeRun();
  await until(() => log.includes("a:2"));
  await until(() => log.includes("c:1"));
  const state = run.snapshot();
  assert.equal(state.pause, undefined);
  assert.deepEqual(state.suspendedExecutionIds, [b], "b was paused separately and stays suspended");
  run.resume([b], state.revision);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(events.filter(event => event.type === "graph_paused" || event.type === "graph_resumed").map(event => event.type),
    ["graph_paused", "graph_resumed"]);
});

test("a paused run with nothing running waits instead of finishing", async t => {
  const gate = deferred();
  const runner = async (request: ModelRequest) => { if (request.node.id === "a") await gate.promise; return { output: request.node.id }; };
  const run = await start(t, input(["a", "b"], [{ from: "a", to: "b" }]), { runner });
  await until(() => executionOf(run, "a") !== undefined);
  run.pauseRun();
  gate.resolve();
  await until(() => executionOf(run, "a").status === "completed");
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = run.snapshot();
  assert.equal(state.status, "waiting");
  assert.equal(state.nodes.b!.status, "pending", "a runner without checkpoints still stops admission");
  run.resumeRun();
  const result = await run.result;
  assert.equal(result.nodes.b!.status, "completed");
});

test("the activity tracker shows a suspended phase", () => {
  const tracker = new ExecutionActivityTracker();
  const base = { sequence: 1, timestamp: 1000, executionId: "x", nodeId: "a" };
  tracker.observe({ ...base, type: "node_started" } as ExecutionEvent);
  tracker.observe({ ...base, type: "execution_suspending", source: "user", timestamp: 1100 } as ExecutionEvent);
  assert.equal(tracker.get("x")!.phase, "worker");
  tracker.observe({ ...base, type: "execution_suspended", source: "user", timestamp: 1200 } as ExecutionEvent);
  assert.equal(tracker.get("x")!.phase, "suspended");
  assert.equal(tracker.get("x")!.phaseStartedAt, 1200);
  tracker.observe({ ...base, type: "execution_resumed", timestamp: 1300 } as ExecutionEvent);
  assert.equal(tracker.get("x")!.phase, "worker");
  assert.deepEqual(tracker.get("x")!.entries.map(entry => entry.summary).slice(-3),
    ["Pause requested by user · stops before the next model request", "Suspended · paused by user", "Resumed"]);
});
