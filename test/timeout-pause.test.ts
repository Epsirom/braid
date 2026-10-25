import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  braid,
  ExecutionActivityTracker,
  formatPauseSource,
  isStepInterrupted,
  startBraid,
  type BraidInput,
  type BraidOptions,
  type BraidRun,
  type ExecutionEvent,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
} from "../src/index.js";
import { mockClock } from "./clock.js";
import { deferred } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const input = (ids: string[], edges: BraidInput["edges"] = []): BraidInput => ({ goal: "timeout", nodes: ids.map(node), edges });
const interruptible = (run: (request: ModelRequest) => Promise<ModelResponse>): ModelRunner =>
  Object.assign(run, { pausable: true, interruptible: true });
const until = async (condition: () => boolean, turns = 5000) => {
  for (let i = 0; i < turns && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), "condition not reached");
};
async function cwd(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "braid-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function start(t: TestContext, graph: BraidInput, options: Omit<BraidOptions, "cwd">, events: ExecutionEvent[] = []) {
  return cwd(t).then(directory => startBraid(graph, { ...options, cwd: directory, onEvent: event => { events.push(event); } }));
}
/** The node's first started instance. */
const executionOf = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).find(record => record.id === nodeId && record.status !== "pending")!;

/** A tool that runs for `ms` (forever by default) unless its step signal aborts. */
function tool(signal: AbortSignal, ms = Infinity): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = Number.isFinite(ms) ? setTimeout(resolve, ms) : undefined;
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Each step passes a checkpoint, then runs one tool on its step signal. An
 * interrupted tool is recorded in the conversation, as an adapter would.
 */
function worker(steps: number, toolMs: (step: number) => number) {
  // Only node "a" is slow; its successors finish at once.
  const deadlines: (number | undefined)[] = [];
  const runner = interruptible(async request => {
    const conversation: string[] = [];
    for (let step = 1; step <= steps; step++) {
      await request.checkpoint!();
      const remaining = request.deadlines?.node;
      deadlines.push(remaining === undefined ? undefined : remaining - performance.now());
      const signal = request.stepSignal!();
      try {
        await tool(signal, request.node.id === "a" ? toolMs(step) : 0);
        conversation.push(`tool ${step} done`);
      } catch (error) {
        if (!isStepInterrupted(request, signal)) throw error;
        conversation.push(`tool ${step} interrupted`);
      }
    }
    await request.checkpoint!();
    return { output: conversation.join(", ") };
  });
  return { runner, deadlines };
}

test("a node timeout interrupts the current step and suspends the execution with its conversation", async t => {
  const { runner, deadlines } = worker(2, step => step === 1 ? Infinity : 0);
  const events: ExecutionEvent[] = [];
  const run = await start(t, input(["a", "b"], [{ from: "a", to: "b" }]), { runner, nodeTimeoutMs: 150 }, events);
  await until(() => run.snapshot().suspendedExecutionIds.length === 1);
  const id = executionOf(run, "a").executionId;
  const state = run.snapshot();
  assert.equal(state.status, "waiting");
  assert.equal(state.executions[id]!.status, "running");
  const suspension = state.executions[id]!.suspension!;
  assert.equal(suspension.state, "suspended");
  assert.equal(suspension.source, "node_timeout");
  assert.equal(suspension.timeout!.nodeTimeoutMs, 150);
  // Node timers truncate fractional delays and may fire a few milliseconds early.
  assert.ok(suspension.timeout!.activeMs >= suspension.timeout!.nodeTimeoutMs - 5,
    `ran ${suspension.timeout!.activeMs}ms`);
  assert.equal(state.nodes.b!.status, "pending", "successors wait");
  const pauseEvents = events.filter(event => event.type === "execution_suspending" || event.type === "execution_suspended");
  assert.deepEqual(pauseEvents.map(event => [event.type, "source" in event && event.source]),
    [["execution_suspending", "node_timeout"], ["execution_suspended", "node_timeout"]]);

  // Without a budget, a timeout pause gets the run's nodeTimeoutMs again.
  run.resume([id], state.revision);
  const result = await run.result;
  assert.equal(result.status, "completed", JSON.stringify(result.nodes.a!.error));
  assert.equal(result.nodes.a!.output, "tool 1 interrupted, tool 2 done");
  assert.equal(result.nodes.b!.status, "completed");
  assert.ok(deadlines[1]! > 100 && deadlines[1]! <= 150, `renewed budget ${deadlines[1]}ms`);
});

test("resume can set a new node budget or remove it", async t => {
  for (const nodeTimeoutMs of [1_000, Infinity]) {
    const { runner, deadlines } = worker(2, step => step === 1 ? Infinity : 0);
    const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 100 });
    await until(() => run.snapshot().suspendedExecutionIds.length === 1);
    const id = executionOf(run, "a").executionId;
    run.resume([id], 0, { nodeTimeoutMs });
    const result = await run.result;
    assert.equal(result.status, "completed");
    if (nodeTimeoutMs === Infinity) assert.equal(deadlines[1], undefined, "no node deadline after Infinity");
    else assert.ok(deadlines[1]! > 900 && deadlines[1]! <= 1_000, `budget ${deadlines[1]}ms`);
  }
});

test("a graph update can resume a timeout pause with a new budget", async t => {
  const { runner, deadlines } = worker(2, step => step === 1 ? Infinity : 0);
  const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 100 });
  await until(() => run.snapshot().suspendedExecutionIds.length === 1);
  const id = executionOf(run, "a").executionId;
  assert.throws(() => run.update({ expectedRevision: 0, resumeOptions: { nodeTimeoutMs: 500 } }), /requires resume/);
  assert.throws(() => run.update({ expectedRevision: 0, resume: [id], resumeOptions: { nodeTimeoutMs: -1 } }), /nodeTimeoutMs/);
  assert.throws(() => run.resume([id], 0, { nodeTimeoutMs: 0 }), /nodeTimeoutMs/);
  run.update({ expectedRevision: 0, upsertNodes: [node("b")], addEdges: [{ from: "a", to: "b" }], resume: [id], resumeOptions: { nodeTimeoutMs: 500 } });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.b!.status, "completed");
  assert.ok(deadlines[1]! > 400 && deadlines[1]! <= 500, `budget ${deadlines[1]}ms`);
});

test("without an interruptible runner, or with onNodeTimeout: fail, a timeout still fails", async t => {
  const pausableOnly: ModelRunner = Object.assign(async (request: ModelRequest) => {
    await request.checkpoint!();
    await tool(request.signal);
    return { output: "never" };
  }, { pausable: true });
  for (const [runner, policy] of [[pausableOnly, undefined], [worker(1, () => Infinity).runner, "fail"]] as const) {
    const events: ExecutionEvent[] = [];
    const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 50, ...(policy ? { onNodeTimeout: policy } : {}) }, events);
    const result = await run.result;
    assert.equal(result.nodes.a!.error?.code, "NODE_TIMEOUT");
    assert.ok(!events.some(event => event.type === "execution_suspending"));
  }
  assert.throws(() => startBraid(input(["a"]), { runner: pausableOnly, onNodeTimeout: "later" as "fail" }), /onNodeTimeout/);
});

test("braid() fails on node timeout and rejects the pause policy", async t => {
  const directory = await cwd(t);
  await assert.rejects(braid(input(["a"]), { runner: worker(1, () => Infinity).runner, cwd: directory, onNodeTimeout: "pause" }), /startBraid/);
  const result = await braid(input(["a"]), { runner: worker(1, () => Infinity).runner, cwd: directory, nodeTimeoutMs: 50 });
  assert.equal(result.nodes.a!.error?.code, "NODE_TIMEOUT");
});

test("cancelling a timeout pause fails it with NODE_TIMEOUT and successors follow failure rules", async t => {
  const { runner } = worker(2, step => step === 1 ? Infinity : 0);
  const run = await start(t, input(["a", "b"], [{ from: "a", to: "b" }]), { runner, nodeTimeoutMs: 50 });
  await until(() => run.snapshot().suspendedExecutionIds.length === 1);
  const id = executionOf(run, "a").executionId;
  run.cancelExecutions([id], { source: "agent" });
  const result = await run.result;
  assert.equal(result.status, "completed", "an optional failure does not fail the run");
  assert.equal(result.nodes.a!.error?.code, "NODE_TIMEOUT");
  assert.match(result.nodes.a!.error!.message, /exceeded 50ms; cancelled by agent while paused/);
  assert.equal(result.nodes.b!.status, "completed", "an unconditional successor receives the error");
});

test("cancelExecutions fails one running execution; requireSuccess still aborts the run", async t => {
  const gate = deferred();
  const runner = interruptible(async request => {
    await request.checkpoint!();
    if (request.node.id === "a") await tool(request.stepSignal!());
    await gate.promise;
    return { output: request.node.id };
  });
  const run = await start(t, input(["a", "b"]), { runner });
  await until(() => executionOf(run, "a")?.status === "running" && executionOf(run, "b")?.status === "running");
  const a = executionOf(run, "a").executionId;
  assert.throws(() => run.cancelExecutions([]), /running execution IDs/);
  assert.throws(() => run.cancelExecutions(["missing"]), /running execution IDs/);
  assert.throws(() => run.cancelExecutions([a], { source: "" }), /non-empty/);
  run.cancelExecutions([a]);
  await until(() => executionOf(run, "a").status === "failed");
  assert.equal(run.snapshot().status, "running", "the rest of the run continues");
  gate.resolve();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.nodes.a!.error, { code: "CANCELLED", message: "Execution cancelled by caller" });
  assert.equal(result.nodes.b!.output, "b");

  const required = await start(t, { ...input(["a"]), nodes: [{ ...node("a"), requireSuccess: true }] }, { runner });
  await until(() => executionOf(required, "a")?.status === "running");
  required.cancelExecutions([executionOf(required, "a").executionId], { source: "user" });
  assert.equal((await required.result).error?.code, "REQUIRED_NODE_FAILED");
});

test("a timeout replaces a pending pause and is not resumed by resumeRun", async t => {
  const { runner } = worker(2, step => step === 1 ? Infinity : 0);
  const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 150 });
  await until(() => executionOf(run, "a")?.status === "running");
  const id = executionOf(run, "a").executionId;
  run.pauseRun({ source: "user" });
  assert.equal(run.snapshot().executions[id]!.suspension!.source, "user");
  await until(() => run.snapshot().suspendedExecutionIds.length === 1);
  assert.equal(run.snapshot().executions[id]!.suspension!.source, "node_timeout");
  run.resumeRun();
  assert.deepEqual(run.snapshot().suspendedExecutionIds, [id], "the parent decides about a timeout pause");
  run.resume([id], 0);
  assert.equal((await run.result).status, "completed");
});

test("resuming a timeout pause before it suspends renews its budget", async t => {
  const interrupted = deferred();
  const proceed = deferred();
  const deadlines: number[] = [];
  const runner = interruptible(async request => {
    await request.checkpoint!();
    const signal = request.stepSignal!();
    await tool(signal).catch(() => {});
    interrupted.resolve();
    // The runner is slow to reach its checkpoint; the pause is withdrawn meanwhile.
    await proceed.promise;
    await request.checkpoint!();
    deadlines.push(request.deadlines!.node! - performance.now());
    assert.equal(request.stepSignal!().aborted, false, "later steps get a fresh signal");
    return { output: "done" };
  });
  const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 100 });
  await interrupted.promise;
  const id = executionOf(run, "a").executionId;
  assert.equal(run.snapshot().executions[id]!.suspension!.state, "pausing");
  run.resume([id], 0, { nodeTimeoutMs: 2_000 });
  proceed.resolve();
  const result = await run.result;
  assert.equal(result.status, "completed", JSON.stringify(result.nodes.a!.error));
  assert.ok(deadlines[0]! > 1_900, `budget ${deadlines[0]}ms`);
});

test("a runner that does not reach a checkpoint after the interruption fails after the grace period", { timeout: 5_000 }, async t => {
  const clock = mockClock(t);
  const started = deferred();
  const runner = interruptible(async request => {
    await request.checkpoint!();
    started.resolve();
    // Ignores its step signal.
    return new Promise<ModelResponse>(() => {});
  });
  const events: ExecutionEvent[] = [];
  const run = await start(t, input(["a"]), { runner, nodeTimeoutMs: 100, graphTimeoutMs: Infinity }, events);
  await started.promise;
  clock.advance(100);
  assert.equal(executionOf(run, "a").suspension?.source, "node_timeout");
  clock.advance(9_999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executionOf(run, "a").status, "running");
  clock.advance(1);
  const result = await run.result;
  assert.equal(result.nodes.a!.error?.code, "NODE_TIMEOUT");
  assert.equal(result.nodes.a!.suspension, undefined);
});

test("the activity tracker describes a node timeout pause", () => {
  const tracker = new ExecutionActivityTracker();
  const base = { sequence: 1, timestamp: 1000, executionId: "x", nodeId: "a" };
  tracker.observe({ ...base, type: "node_started" } as ExecutionEvent);
  tracker.observe({ ...base, type: "execution_suspending", source: "node_timeout", timestamp: 1100 } as ExecutionEvent);
  tracker.observe({ ...base, type: "execution_suspended", source: "node_timeout", timestamp: 1200 } as ExecutionEvent);
  assert.deepEqual(tracker.get("x")!.entries.map(entry => entry.summary).slice(-2),
    ["Node timeout · interrupting the current step to pause", "Suspended · paused by node timeout"]);
  assert.equal(formatPauseSource("node_timeout"), "node timeout");
  assert.equal(formatPauseSource("user"), "user");
});
