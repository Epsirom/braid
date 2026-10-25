import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startBraid,
  type BraidInput,
  type BraidNode,
  type BraidOptions,
  type BraidRun,
  type ExecutionEvent,
  type ModelRequest,
  type ModelRunner,
} from "../src/index.js";
import { deferred } from "./helpers.js";

const node = (id: string, extra: Partial<BraidNode> = {}) => ({ type: "execute" as const, id, prompt: id, ...extra }) as BraidNode;
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

async function start(t: TestContext, graph: BraidInput, options: Omit<BraidOptions, "cwd">, events: ExecutionEvent[]) {
  const directory = await mkdtemp(join(tmpdir(), "braid-waiting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); } });
  t.after(() => run.cancel());
  return run;
}

/** Each node takes one checkpointed step per gate, waiting on that gate, then returns its ID or throws for `fail`. */
function gated(gates: Record<string, Promise<void>[]>, fail: string[] = []): ModelRunner {
  return Object.assign(async (request: ModelRequest) => {
    const id = request.node.id;
    for (const gate of gates[id] ?? []) {
      await request.checkpoint!();
      await gate;
    }
    await request.checkpoint!();
    if (fail.includes(id)) throw new Error(`${id} failed`);
    return { output: id };
  }, { pausable: true });
}

const executionOf = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).find(record => record.id === nodeId)!;
const waiting = (events: ExecutionEvent[]) =>
  events.filter((event): event is Extract<ExecutionEvent, { type: "graph_waiting" }> => event.type === "graph_waiting");

for (const outcome of ["succeeds", "fails"] as const) {
  test(`graph_waiting is reported once when the last active execution ${outcome} while held work remains`, async t => {
    const gate = deferred();
    const events: ExecutionEvent[] = [];
    const run = await start(t, { goal: "wait", nodes: [node("held", { pauseAfter: true }), node("a"), node("after")],
      edges: [{ from: "held", to: "after" }] }, { runner: gated({ a: [gate.promise] }, outcome === "fails" ? ["a"] : []) }, events);
    await until(() => run.snapshot().pausedExecutionIds.length === 1);
    await settle();
    assert.equal(waiting(events).length, 0, "a held result is not reported while other work is active");
    const a = executionOf(run, "a").executionId;
    gate.resolve();
    await until(() => run.snapshot().status === "waiting");
    await settle();
    const [event, ...rest] = waiting(events);
    assert.equal(rest.length, 0);
    const held = executionOf(run, "held").executionId;
    assert.deepEqual({ ...event, sequence: 0, timestamp: 0 }, {
      type: "graph_waiting", settledExecutionId: a, pausedExecutionIds: [held], suspendedExecutionIds: [], revision: 0, sequence: 0, timestamp: 0,
    });
    const settled = events.findIndex(item => item.executionId === a && (item.type === "node_completed" || item.type === "node_failed"));
    assert.ok(events.indexOf(event!) > settled, "it follows the settling execution's own event");
    run.resume([held], 0);
    await run.result;
    assert.equal(waiting(events).length, 1, "a run that finishes is not reported as waiting");
  });
}

test("graph_waiting re-arms only when work starts again, not for updates that start nothing", async t => {
  const events: ExecutionEvent[] = [];
  const run = await start(t, { goal: "rearm", nodes: [node("one", { pauseAfter: true }), node("two", { pauseAfter: true }), node("next")],
    edges: [{ from: "one", to: "next" }] }, { runner: gated({}) }, events);
  await until(() => run.snapshot().pausedExecutionIds.length === 2 && run.snapshot().status === "waiting");
  await settle();
  assert.equal(waiting(events).length, 1);
  run.update({ expectedRevision: 0, upsertNodes: [node("next", { prompt: "next, revised" })] });
  await settle();
  assert.equal(run.snapshot().status, "waiting");
  assert.equal(waiting(events).length, 1, "an update without resume starts nothing and is not reported again");
  const one = executionOf(run, "one").executionId;
  const two = executionOf(run, "two").executionId;
  run.resume([one], 1);
  await until(() => executionOf(run, "next")?.status === "completed");
  await until(() => waiting(events).length === 2);
  const second = waiting(events)[1]!;
  assert.equal(second.settledExecutionId, executionOf(run, "next").executionId);
  assert.deepEqual(second.pausedExecutionIds, [two]);
  assert.equal(second.revision, 1);
  run.resume([two], 1);
  assert.equal((await run.result).status, "completed");
  assert.equal(waiting(events).length, 2);
});

test("graph_waiting reports suspended executions, and a suspension can be what leaves nothing active", async t => {
  const [a1, a2, b1] = [deferred(), deferred(), deferred()];
  const events: ExecutionEvent[] = [];
  const run = await start(t, { goal: "suspend", nodes: [node("a"), node("b")], edges: [] },
    { runner: gated({ a: [a1.promise, a2.promise], b: [b1.promise] }) }, events);
  await until(() => executionOf(run, "a")?.status === "running" && executionOf(run, "b")?.status === "running");
  const a = executionOf(run, "a").executionId;
  const b = executionOf(run, "b").executionId;
  run.pause([a], { source: "agent" });
  a1.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(a));
  await settle();
  assert.equal(waiting(events).length, 0, "b is still active");
  b1.resolve();
  await until(() => waiting(events).length === 1);
  assert.equal(waiting(events)[0]!.settledExecutionId, b);
  assert.deepEqual(waiting(events)[0]!.suspendedExecutionIds, [a]);
  run.resume([a], 0);
  await until(() => run.snapshot().suspendedExecutionIds.length === 0);
  run.pause([a]);
  a2.resolve();
  await until(() => waiting(events).length === 2);
  assert.equal(waiting(events)[1]!.settledExecutionId, a, "the suspension itself left nothing active");
  run.resume([a], 0);
  assert.equal((await run.result).status, "completed");
  assert.equal(waiting(events).length, 2);
});

test("cancelling a suspended execution while the run waits is not reported again", async t => {
  const [a1, held] = [deferred(), deferred()];
  const events: ExecutionEvent[] = [];
  const run = await start(t, { goal: "cancel", nodes: [node("a"), node("held", { pauseAfter: true })], edges: [] },
    { runner: gated({ a: [a1.promise], held: [held.promise] }) }, events);
  await until(() => executionOf(run, "a")?.status === "running");
  const a = executionOf(run, "a").executionId;
  run.pause([a]);
  a1.resolve();
  await until(() => run.snapshot().suspendedExecutionIds.includes(a));
  held.resolve();
  await until(() => waiting(events).length === 1);
  run.cancelExecutions([a]);
  await until(() => executionOf(run, "a").status === "failed");
  await settle();
  assert.equal(run.snapshot().status, "waiting");
  assert.equal(waiting(events).length, 1, "the cancelled execution was not active work");
  run.resume([executionOf(run, "held").executionId], 0);
  await run.result;
});

test("graph_waiting carries the run's pause when its last running execution settles", async t => {
  const gate = deferred();
  const events: ExecutionEvent[] = [];
  const runner = async (request: ModelRequest) => { await gate.promise; return { output: request.node.id }; };
  const run = await start(t, { goal: "paused", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, { runner }, events);
  await until(() => executionOf(run, "a")?.status === "running");
  run.pauseRun({ source: "agent" });
  gate.resolve();
  await until(() => waiting(events).length === 1);
  const [event] = waiting(events);
  assert.equal(event!.pause?.source, "agent");
  assert.deepEqual(event!.pausedExecutionIds, []);
  run.resumeRun();
  await run.result;
  assert.equal(waiting(events).length, 1);
});
