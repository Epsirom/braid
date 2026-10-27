import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./helpers.js";
import { braid, closingEdges, newCycles, startBraid, validateGraph, type BraidInput, type BraidRun, type ExecutionEvent } from "../src/index.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const decision = (id: string, choices: string[]) => ({ type: "decision" as const, id, prompt: id, choices });
async function outsideGit(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "braid-cycles-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("in an unconditional cycle, edges that leave it fire in each round until the owner ends it", async t => {
  let run!: BraidRun;
  const input: BraidInput = { goal: "improve forever", nodes: [{ ...node("improve"), maxRuns: 3 }, node("evaluate"), node("report")], edges: [
    { from: "improve", to: "evaluate" }, { from: "evaluate", to: "improve" }, { from: "evaluate", to: "report" },
  ] };
  run = startBraid(input, { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id !== "report") await delay(10);
    return { output: request.execution.executionId! };
  }, onEvent(event) {
    // At its maxRuns the next improve waits; releasing it without a higher maxRuns ends the cycle.
    if (event.type === "limit_reached") queueMicrotask(() => run.resume([event.executionId!], run.snapshot().revision));
  } });
  const result = await run.result;
  assert.equal(result.status, "completed");
  const reports = Object.values(result.executions).filter(value => value.id === "report");
  assert.deepEqual(reports.map(value => value.predecessorExecutionIds), [["evaluate@1"], ["evaluate@2"], ["evaluate@3"]]);
  assert.deepEqual(result.executions["improve@2"]!.predecessorExecutionIds, ["evaluate@1"]);
  assert.equal(Object.values(result.executions).filter(value => value.id === "improve").length, 3);
});

test("a nested cycle retries inside each round of the enclosing one, and maxRuns counts across rounds", async t => {
  const input = (maxRuns?: number): BraidInput => ({ goal: "ship it", nodes: [
    node("design"), { ...node("implement"), ...(maxRuns ? { maxRuns } : {}) }, decision("test", ["pass", "fail"]),
    decision("review", ["again", "done"]), node("ship"),
  ], edges: [
    { from: "design", to: "implement" }, { from: "implement", to: "test" },
    { from: "test", to: "implement", choice: "fail" },
    { from: "test", to: "review", choice: "pass" }, { from: "review", to: "design", choice: "again" },
    { from: "review", to: "ship", choice: "done" },
  ] });
  const runner = async (request: Parameters<Parameters<typeof braid>[1]["runner"]>[0]) => {
    // Each round of the outer cycle fails its first test.
    if (request.node.id === "test") request.decide!(request.execution.generation! % 2 ? "fail" : "pass");
    if (request.node.id === "review") request.decide!(request.execution.generation === 1 ? "again" : "done");
    return { output: request.execution.executionId! };
  };
  const result = await braid(input(), { cwd: await outsideGit(t), runner });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.events.filter(event => event.type === "node_started").map(event => event.executionId), [
    "design@1", "implement@1", "test@1", "implement@2", "test@2", "review@1",
    "design@2", "implement@3", "test@3", "implement@4", "test@4", "review@2", "ship@1",
  ]);
  assert.deepEqual(result.executions["ship@1"]!.predecessorExecutionIds, ["review@2"]);
  assert.equal(Object.values(result.executions).filter(value => value.id === "ship").length, 1);
  assert.deepEqual(result.executions["implement@3"]!.predecessorExecutionIds, ["design@2"]);
  assert.deepEqual(result.executions["implement@4"]!.predecessorExecutionIds.sort(), ["design@2", "test@3"]);
  // implement's maxRuns is not reset by the outer round: its retry in the second round would be its fourth run.
  const limited = await braid(input(3), { cwd: await outsideGit(t), runner });
  assert.equal(limited.error?.code, "RUN_LIMIT");
  assert.equal(limited.executions["implement@3"]!.status, "completed");
  assert.equal(limited.executions["implement@4"]!.status, "skipped");
});

test("when overlapping cycles reach a shared node together, the first edge clones it and the second attaches", async t => {
  let run!: BraidRun;
  const held: string[] = [];
  const input: BraidInput = { goal: "two loops", nodes: [
    node("shared"), { ...decision("left", ["again", "stop"]), pauseAfter: true }, { ...decision("right", ["again", "stop"]), pauseAfter: true },
  ], edges: [
    { from: "shared", to: "left" }, { from: "shared", to: "right" },
    { from: "left", to: "shared", choice: "again" }, { from: "right", to: "shared", choice: "again" },
  ] };
  run = startBraid(input, { cwd: await outsideGit(t), runner: async request => {
    request.decide?.(request.execution.generation === 1 ? "again" : "stop");
    return { output: request.execution.executionId! };
  }, onEvent(event) {
    if (event.type !== "execution_paused") return;
    held.push(event.executionId!);
    // Release both loops in one call, so both closing edges reach shared together.
    if (held.length % 2 === 0) queueMicrotask(() => run.resume(held.slice(-2), run.snapshot().revision));
  } });
  const result = await run.result;
  assert.equal(result.status, "completed");
  const shared = Object.values(result.executions).filter(value => value.id === "shared");
  assert.equal(shared.length, 2);
  assert.deepEqual(result.executions["shared@2"]!.predecessorExecutionIds.sort(), ["left@1", "right@1"]);
  const created = result.events.filter(event => event.type === "execution_created" && event.nodeId === "shared" && event.cause === "cloned");
  assert.equal(created.length, 1);
});

test("a submission or update that creates a cycle reports it and whether anything stops it", async t => {
  const input: BraidInput = { goal: "fix", nodes: [node("fix"), node("test"), decision("review", ["again", "done"])], edges: [
    { from: "fix", to: "test" }, { from: "test", to: "review" }, { from: "review", to: "fix", choice: "again" },
  ] };
  assert.deepEqual(newCycles(input), { truncated: false, cycles: [{
    nodeIds: ["fix", "test", "review"],
    edges: [{ from: "fix", to: "test" }, { from: "test", to: "review" }, { from: "review", to: "fix", choice: "again" }],
    stops: [{ from: "review", to: "fix", choice: "again" }], limitedNodeIds: [], choiceGated: [],
  }] });
  // An agent meant to share test results but closed a second cycle that nothing stops.
  const accidental = { ...input, edges: [...input.edges, { from: "test", to: "fix" }] };
  assert.deepEqual(newCycles(accidental, input).cycles, [{
    nodeIds: ["fix", "test"], edges: [{ from: "fix", to: "test" }, { from: "test", to: "fix" }], stops: [], limitedNodeIds: [], choiceGated: [],
  }]);
  assert.deepEqual(newCycles(input, input).cycles, []);

  let run!: BraidRun;
  const reports: ExecutionEvent[] = [];
  const bounded = { ...input, nodes: [{ ...node("fix"), maxRuns: 2 }, ...input.nodes.slice(1)] };
  run = startBraid(bounded, { cwd: await outsideGit(t), runner: async request => {
    if (request.execution.executionId === "fix@1")
      run.update({ expectedRevision: 0, addEdges: [{ from: "test", to: "fix" }] });
    request.decide?.("done");
    return { output: "ok" };
  }, onEvent(event) {
    if (event.type === "cycles_created") reports.push(event);
    // fix reruns once, then waits at its maxRuns; releasing it ends the cycle.
    if (event.type === "limit_reached") queueMicrotask(() => run.resume([event.executionId!], run.snapshot().revision));
  } });
  await run.result;
  assert.deepEqual(reports.map(event => event.type === "cycles_created" && [event.revision, event.cycles.map(cycle => cycle.nodeIds)]),
    [[0, [["fix", "test", "review"]]], [1, [["fix", "test"]]]]);
  const update = reports[1]!;
  assert.ok(update.type === "cycles_created");
  assert.deepEqual(update.cycles[0]!.stops, []);
  assert.deepEqual(update.cycles[0]!.limitedNodeIds, ["fix"]);
});

// Implementation, tests, and docs merge for review, which sends the work back to impl.
const queue = (closesCycle?: boolean): BraidInput => ({ goal: "task queue", nodes: [
  { ...node("impl"), maxRuns: 3 }, node("tests"), node("docs"), { type: "merge", id: "merge" }, decision("review", ["again", "done"]), node("ship"),
], edges: [
  { from: "impl", to: "merge" }, { from: "tests", to: "merge" }, { from: "docs", to: "merge" }, { from: "merge", to: "review" },
  { from: "review", to: "impl", choice: "again", ...(closesCycle === undefined ? {} : { closesCycle }) }, { from: "review", to: "ship", choice: "done" },
] });

test("a cycle report names a node that runs only once a choice inside the cycle picks it", () => {
  // merge is the entry, so impl -> merge closes the cycle and impl waits for review.
  assert.deepEqual(closingEdges(queue()), [{ from: "impl", to: "merge" }]);
  const [cycle] = newCycles(queue()).cycles;
  assert.deepEqual(cycle!.nodeIds, ["merge", "review", "impl"]);
  assert.deepEqual(cycle!.choiceGated, [{ from: "review", to: "impl", choice: "again" }]);
  // A choice edge that closes the cycle starts a round instead.
  assert.deepEqual(newCycles(queue(true)).cycles[0]!.choiceGated, []);
});

test("a node that runs only through a choice edge waits for the choice", async t => {
  const gate = deferred();
  const run = startBraid(queue(), { cwd: await outsideGit(t), runner: async request => {
    await gate.promise;
    request.decide?.("done");
    return { output: "ok" };
  } });
  t.after(() => run.cancel());
  const state = run.snapshot();
  assert.equal(state.nodes.impl!.waitReason, "choice");
  assert.equal(state.nodes.merge!.waitReason, "predecessors");
  // With the choice edge closing the cycle, impl is a root of the first round.
  const impl = deferred();
  const started = startBraid(queue(true), { cwd: await outsideGit(t), runner: async request => {
    if (request.execution.executionId === "impl@1") impl.resolve();
    await gate.promise;
    request.decide?.("done");
    return { output: "ok" };
  } });
  t.after(() => started.cancel());
  await impl.promise;
  gate.resolve();
  const result = await run.result;
  assert.equal(result.nodes.impl!.skipReason, "inactive");
});

test("closesCycle picks the edge that closes a cycle, so each round starts at its target", async t => {
  const edge = { from: "review", to: "impl", choice: "again", closesCycle: true };
  assert.deepEqual(closingEdges(queue(true)), [edge]);
  assert.deepEqual(newCycles(queue(true)).cycles[0]!.nodeIds, ["impl", "merge", "review"]);
  // false, like omitting it, lets Braid choose.
  assert.deepEqual(closingEdges(queue(false)), [{ from: "impl", to: "merge" }]);
  const result = await braid(queue(true), { cwd: await outsideGit(t), runner: async request => {
    request.decide?.(request.execution.executionId === "review@1" ? "again" : "done");
    return { output: request.execution.executionId! };
  } });
  assert.equal(result.status, "completed");
  // impl runs in the first round, and merge waits for it.
  assert.deepEqual(result.executions["merge@1"]!.predecessorExecutionIds.sort(), ["docs@1", "impl@1", "tests@1"]);
  assert.deepEqual(result.executions["impl@2"]!.predecessorExecutionIds, ["review@1"]);
  assert.deepEqual(result.executions["merge@2"]!.predecessorExecutionIds.sort(), ["docs@1", "impl@2", "tests@1"]);
  assert.equal(result.nodes.ship!.status, "completed");
});

test("closesCycle must be a boolean on an edge that lies on a cycle, and an update can move it", async t => {
  const chain: BraidInput = { goal: "x", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b", closesCycle: true }] };
  assert.throws(() => validateGraph(chain), /Edge 'a' -> 'b' sets closesCycle but is not on a cycle/);
  assert.throws(() => validateGraph({ ...queue(), edges: [{ from: "impl", to: "merge", closesCycle: "yes" as never }] }),
    /closesCycle must be a boolean/);
  // Edges keep their identity without closesCycle: remove and re-add one to change it.
  const gate = deferred();
  const run = startBraid(queue(), { cwd: await outsideGit(t), runner: async request => {
    await gate.promise;
    request.decide?.("done");
    return { output: "ok" };
  } });
  t.after(() => run.cancel());
  const again = { from: "review", to: "impl", choice: "again" };
  run.update({ expectedRevision: 0, removeEdges: [again], addEdges: [{ ...again, closesCycle: true }] });
  assert.deepEqual(closingEdges(run.snapshot().graph), [{ ...again, closesCycle: true }]);
  gate.resolve();
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executions["merge@1"]!.predecessorExecutionIds.sort(), ["docs@1", "impl@1", "tests@1"]);
});

test("cycle reports are capped", () => {
  // A complete graph on 6 nodes has hundreds of cycles.
  const ids = ["a", "b", "c", "d", "e", "f"];
  const report = newCycles({ nodes: ids.map(node), edges: ids.flatMap(from => ids.filter(to => to !== from).map(to => ({ from, to }))) });
  assert.equal(report.cycles.length, 20);
  assert.equal(report.truncated, true);
});
