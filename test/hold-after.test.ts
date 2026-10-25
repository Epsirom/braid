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
  const directory = await mkdtemp(join(tmpdir(), "braid-hold-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); } });
}

/** Each node waits on its gate, if any, then returns its ID or throws for `fail`. */
function gated(gates: Record<string, Promise<void>>, fail: string[] = []) {
  const ran: string[] = [];
  const runner: ModelRunner = async request => {
    const id = request.node.id;
    await gates[id];
    ran.push(id);
    if (fail.includes(id)) throw new Error(`${id} failed`);
    return { output: id };
  };
  return { runner, ran };
}

/** The node's first started instance. */
const executionOf = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).find(record => record.id === nodeId && record.status !== "pending")!;
const holdEvents = (events: ExecutionEvent[]) =>
  events.filter(event => event.type.startsWith("execution_") && event.type !== "execution_created").map(event => event.type);

test("a hold added to a running execution holds its result like pauseAfter", async t => {
  const gate = deferred();
  const { runner, ran } = gated({ a: gate.promise });
  const events: ExecutionEvent[] = [];
  const run = await start(t, { goal: "hold", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, { runner }, events);
  await until(() => executionOf(run, "a")?.status === "running");
  const id = executionOf(run, "a").executionId;
  const state = run.holdAfter([id], true, { source: "agent" });
  assert.equal(state.executions[id]!.holdAfter!.source, "agent");
  assert.equal(state.executions[id]!.node.pauseAfter, undefined, "the captured definition is unchanged");
  assert.equal(state.graph.nodes[0]!.pauseAfter, undefined, "the graph definition is unchanged");
  assert.equal(state.revision, 0, "a hold is not a graph revision");
  assert.equal(run.holdAfter([id], true).executions[id]!.holdAfter!.source, "agent", "a repeated hold changes nothing");
  gate.resolve();
  await until(() => run.snapshot().pausedExecutionIds.includes(id));
  assert.equal(run.snapshot().status, "waiting");
  assert.deepEqual(ran, ["a"], "b waits for the hold");
  run.resume([id], 0);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(holdEvents(events), ["execution_hold_added", "execution_paused", "execution_resumed"]);
  const added = events.find(event => event.type === "execution_hold_added")!;
  assert.equal(added.executionId, id);
  assert.equal(added.type === "execution_hold_added" && added.source, "agent");
});

test("removing a definition's hold releases only that execution", async t => {
  const gate = deferred();
  const { runner, ran } = gated({ a: gate.promise });
  const events: ExecutionEvent[] = [];
  const run = await start(t, { goal: "unhold", nodes: [{ ...node("a"), pauseAfter: true }, node("b")], edges: [{ from: "a", to: "b" }] },
    { runner }, events);
  await until(() => executionOf(run, "a")?.status === "running");
  const id = executionOf(run, "a").executionId;
  assert.equal(executionOf(run, "a").holdAfter!.source, "definition");
  const state = run.holdAfter([id], false, { source: "user" });
  assert.equal(state.executions[id]!.holdAfter, undefined);
  assert.equal(state.executions[id]!.node.pauseAfter, true, "the captured definition is unchanged");
  assert.equal(state.graph.nodes[0]!.pauseAfter, true, "later executions still pause");
  gate.resolve();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(ran, ["a", "b"], "b runs without a resume");
  assert.deepEqual(holdEvents(events), ["execution_hold_removed"]);
});

test("holds apply to failed executions and to suspended ones once they finish", async t => {
  const gates = { a: deferred() };
  const { runner, ran } = gated({ a: gates.a.promise }, ["a"]);
  const run = await start(t, { goal: "fail", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, { runner });
  await until(() => executionOf(run, "a")?.status === "running");
  const id = executionOf(run, "a").executionId;
  run.holdAfter([id], true);
  gates.a.resolve();
  await until(() => run.snapshot().pausedExecutionIds.includes(id));
  assert.equal(run.snapshot().executions[id]!.status, "failed");
  assert.equal(executionOf(run, "b"), undefined, "the failure has not been routed yet");
  run.resume([id], 0);
  await run.result;
  assert.deepEqual(ran, ["a", "b"], "the failure reaches b only after the resume");

  const gate = deferred();
  let steps = 0;
  const pausable: ModelRunner = Object.assign(async (request: Parameters<ModelRunner>[0]) => {
    for (let step = 1; step <= 2; step++) {
      await request.checkpoint!();
      steps++;
      if (step === 1) await gate.promise;
    }
    return { output: "done" };
  }, { pausable: true });
  const suspended = await start(t, { goal: "suspend", nodes: [node("a")], edges: [] }, { runner: pausable });
  await until(() => steps === 1);
  const a = executionOf(suspended, "a").executionId;
  suspended.pause([a]);
  suspended.holdAfter([a], true);
  gate.resolve();
  await until(() => suspended.snapshot().suspendedExecutionIds.includes(a));
  suspended.resume([a], 0);
  await until(() => suspended.snapshot().pausedExecutionIds.includes(a));
  assert.equal(steps, 2, "resuming the suspension does not clear the hold");
  suspended.resume([a], 0);
  assert.equal((await suspended.result).status, "completed");
});

test("holdAfter rejects executions that are not running and invalid arguments", async t => {
  const gate = deferred();
  const { runner } = gated({ a: gate.promise });
  const run = await start(t, { goal: "reject", nodes: [{ ...node("held"), pauseAfter: true }, node("a")], edges: [] }, { runner });
  await until(() => run.snapshot().pausedExecutionIds.length === 1 && executionOf(run, "a")?.status === "running");
  const held = run.snapshot().pausedExecutionIds[0]!;
  const id = executionOf(run, "a").executionId;
  assert.throws(() => run.holdAfter([held], false), /running execution IDs/, "a settled execution's hold cannot change");
  assert.throws(() => run.holdAfter(["missing"], true), /running execution IDs/);
  assert.throws(() => run.holdAfter([], true), /running execution IDs/);
  assert.throws(() => run.holdAfter([id, id], true), /running execution IDs/);
  assert.throws(() => run.holdAfter([id], "yes" as unknown as boolean), /boolean/);
  assert.throws(() => run.holdAfter([id], true, { source: " " }), /non-empty/);
  assert.equal(run.snapshot().executions[id]!.holdAfter, undefined, "rejected calls change nothing");
  gate.resolve();
  await until(() => executionOf(run, "a").status === "completed");
  run.resume([held], 0);
  await run.result;
  assert.throws(() => run.holdAfter([id], true), /no longer accepting/);
});

test("the activity tracker records hold changes", () => {
  const tracker = new ExecutionActivityTracker();
  const base = { sequence: 1, timestamp: 1000, executionId: "x", nodeId: "a" };
  tracker.observe({ ...base, type: "node_started" } as ExecutionEvent);
  tracker.observe({ ...base, type: "execution_hold_added", source: "agent", timestamp: 1100 } as ExecutionEvent);
  tracker.observe({ ...base, type: "execution_hold_removed", source: "user", timestamp: 1200 } as ExecutionEvent);
  assert.equal(tracker.get("x")!.phase, "worker");
  assert.deepEqual(tracker.get("x")!.entries.map(entry => entry.summary).slice(-2),
    ["Hold after completion added by agent", "Hold after completion removed by user"]);
});
