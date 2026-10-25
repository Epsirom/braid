import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { braid, closingEdges, startBraid, validateGraph, type BraidInput, type BraidRun, type ExecutionEvent, type ModelRunner } from "../src/index.js";
import { deferred } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const loop = (maxRuns = 3): BraidInput => ({ goal: "refine", nodes: [{ ...node("work"), maxRuns }, { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }, node("end")],
  edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }, { from: "check", to: "end", choice: "done" }] });
async function outsideGit(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "braid-control-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};
const instances = (run: BraidRun, nodeId: string) => Object.values(run.snapshot().executions).filter(record => record.id === nodeId);

test("a cycle closed by a choice edge clones one instance per round and feeds the previous round", async t => {
  const result = await braid(loop(), { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "check") request.decide!(request.execution.generation === 3 ? "done" : "again");
    if (request.node.id === "work" && request.execution.generation! > 1) {
      assert.deepEqual(request.predecessors.map(value => value.executionId), [`check@${request.execution.generation! - 1}`]);
    }
    return { output: `${request.node.id}:${request.execution.generation}` };
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(Object.keys(result.executions), ["work@1", "check@1", "end@1", "work@2", "check@2", "work@3", "check@3"]);
  assert.equal(result.nodes.work!.output, "work:3");
  assert.equal(result.nodes.end!.output, "end:1");
  assert.deepEqual(result.executions["end@1"]!.predecessorExecutionIds, ["check@3"]);
  assert.deepEqual(Object.keys(result.terminalOutputs), ["end"]);
  assert.ok(!result.events.some(event => event.type === "node_skipped"));
});

test("maxRuns is fatal under onLimit fail even when the decision is optional", async t => {
  const result = await braid(loop(), { cwd: await outsideGit(t), runner: async request => {
    request.decide?.("again"); return { output: "keep going" };
  } });
  assert.equal(result.error?.code, "RUN_LIMIT");
  assert.match(result.error!.message, /Node 'work' reached its maxRuns of 3/);
  // The rerun that would exceed it never starts.
  assert.deepEqual(Object.values(result.executions).filter(value => value.id === "work").map(value => value.skipReason ?? value.status),
    ["completed", "completed", "completed", "run_failed"]);
});

test("execution IDs name the lineage and generation, so node IDs cannot contain @", async t => {
  assert.throws(() => validateGraph({ goal: "ids", nodes: [node("a@1")], edges: [] }), /must not contain '@'/);
  const result = await braid({ goal: "ids", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), runner: async request => ({ output: request.execution.executionId! }),
  });
  assert.equal(result.nodes.b!.output, "b@1");
  assert.equal(result.executions["a@1"]!.generation, 1);
  assert.deepEqual(result.executions["b@1"]!.predecessorExecutionIds, ["a@1"]);
});

test("submitted nodes are pending instances that report why they wait", async t => {
  const gate = deferred();
  const run = startBraid({ goal: "wait", nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), maxConcurrency: 1, runner: async request => { if (request.node.id === "a") await gate.promise; return { output: "ok" }; },
  });
  t.after(() => run.cancel());
  const initial = run.snapshot();
  assert.deepEqual(Object.keys(initial.executions), ["a@1", "b@1", "c@1"]);
  assert.ok(Object.values(initial.executions).every(record => record.status === "pending"));
  await until(() => run.snapshot().nodes.a!.status === "running");
  const state = run.snapshot();
  assert.equal(state.nodes.b!.waitReason, "predecessors");
  assert.equal(state.nodes.c!.waitReason, "slot");
  assert.equal(state.nodes.a!.waitReason, undefined);
  run.pauseRun();
  assert.equal(run.snapshot().nodes.c!.waitReason, "run_paused");
  run.resumeRun();
  gate.resolve();
  assert.equal((await run.result).status, "completed");
});

test("a paused execution accepts an atomic update and resume; removing a pending node deletes it", async t => {
  let run!: BraidRun;
  let resumed = false;
  run = startBraid({ goal: "edit", nodes: [{ ...node("a"), pauseAfter: true }, node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), onEvent(event) {
      if (event.type !== "execution_paused") return;
      const before = run.snapshot();
      assert.equal(before.nodes.a!.held, true);
      assert.equal(before.nodes.b!.waitReason, "hold");
      assert.throws(() => run.update({ expectedRevision: 9, removeNodeIds: ["b"] }), /Revision conflict/);
      assert.throws(() => run.update({ expectedRevision: 0, addEdges: [{ from: "missing", to: "a" }], resume: [event.executionId!] }));
      assert.throws(() => run.update({ expectedRevision: 0, removeNodeIds: ["missing"] }), /unknown or repeated node 'missing'/);
      assert.throws(() => run.update({ expectedRevision: 0, removeEdges: [{ from: "b", to: "a" }] }), /no edge 'b' -> 'a'/);
      assert.deepEqual(run.snapshot(), before);
      run.update({ expectedRevision: 0, removeNodeIds: ["b"], upsertNodes: [node("c")], addEdges: [{ from: "a", to: "c" }], resume: [event.executionId!] });
      resumed = true;
    }, runner: async request => ({ output: request.node.id }),
  });
  const result = await run.result;
  assert.ok(resumed);
  assert.equal(result.revision, 1);
  assert.equal(result.nodes.b, undefined);
  assert.equal(result.executions["b@1"], undefined);
  assert.ok(result.events.some(event => event.type === "execution_removed" && event.executionId === "b@1"));
  assert.equal(result.nodes.c!.output, "c");
  assert.throws(() => run.update({ expectedRevision: 1 }), /no longer/);
  const final = run.snapshot();
  run.cancel();
  assert.deepEqual(run.snapshot(), final);
});

test("upserting a pending node edits it in place", async t => {
  let run!: BraidRun;
  const prompts: string[] = [];
  run = startBraid({ goal: "edit", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      prompts.push(`${request.execution.executionId}:${request.node.prompt}`);
      if (request.node.id === "a") run.update({ expectedRevision: 0, upsertNodes: [{ ...node("b"), prompt: "new prompt" }] });
      return { output: request.node.id };
    },
  });
  const result = await run.result;
  assert.deepEqual(prompts, ["a@1:a", "b@1:new prompt"]);
  assert.equal(result.executions["b@1"]!.revision, 1);
  assert.equal(result.executions["a@1"]!.revision, 0);
  assert.equal(run.snapshot().graph.nodes[1]!.prompt, "new prompt");
});

test("upserting a running node replaces it: the old instance is cancelled and successors use the new one", async t => {
  let run!: BraidRun;
  const events: ExecutionEvent[] = [];
  const seen: string[] = [];
  run = startBraid({ goal: "replace", nodes: [{ ...node("a"), requireSuccess: true, pauseAfter: true }, node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), onEvent: event => { events.push(event); }, runner: async request => {
      seen.push(`${request.execution.executionId}:${request.node.prompt}`);
      if (request.execution.executionId === "a@1") {
        run.update({ expectedRevision: 0, upsertNodes: [{ ...node("a"), prompt: "better", pauseAfter: true }] });
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { output: "too late" };
      }
      return { output: request.node.prompt ?? "" };
    },
  });
  await until(() => run.snapshot().pausedExecutionIds.length === 1);
  // Only the replacement is held; the cancelled required instance did not fail the run.
  assert.deepEqual(run.snapshot().pausedExecutionIds, ["a@2"]);
  run.resume(["a@2"], 1);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, ["a@1:a", "a@2:better", "b@1:b"]);
  assert.equal(result.executions["a@1"]!.status, "failed");
  assert.equal(result.executions["a@1"]!.error!.code, "CANCELLED");
  assert.equal(result.executions["a@1"]!.supersededBy, "a@2");
  assert.equal(result.executions["a@2"]!.supersedes, "a@1");
  assert.deepEqual(result.executions["b@1"]!.predecessorExecutionIds, ["a@2"]);
  assert.equal(result.nodes.a!.executionId, "a@2");
  const created = events.find(event => event.type === "execution_created" && event.executionId === "a@2");
  assert.equal(created?.type === "execution_created" && created.cause, "replaced");
  assert.ok(events.some(event => event.type === "execution_superseded" && event.executionId === "a@1" && event.supersededBy === "a@2"));
});

test("a lineage runs one instance at a time: a replacement starts after the instance it replaces stops", async t => {
  let run!: BraidRun;
  const events: ExecutionEvent[] = [];
  run = startBraid({ goal: "one at a time", nodes: [node("a")], edges: [] }, {
    cwd: await outsideGit(t), onEvent: event => { events.push(event); }, runner: async request => {
      if (request.execution.executionId === "a@1") {
        run.update({ expectedRevision: 0, upsertNodes: [node("a")] });
        assert.equal(run.snapshot().nodes.a!.status, "pending");
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { output: request.execution.executionId! };
    },
  });
  const result = await run.result;
  assert.equal(result.nodes.a!.output, "a@2");
  const order = events.filter(event => event.type === "node_failed" || event.type === "node_started").map(event => `${event.type}:${event.executionId}`);
  assert.deepEqual(order, ["node_started:a@1", "node_failed:a@1", "node_started:a@2"]);
});

test("replacing a settled node reruns it and its downstream lineages; fan-in waits for stale inputs", async t => {
  let run!: BraidRun;
  const slow = deferred();
  const inputs: Record<string, string[]> = {};
  // edit -> testA -> review alongside edit -> slow -> testB -> review.
  run = startBraid({ goal: "cascade", nodes: [node("edit"), node("testA"), node("slow"), node("testB"), { ...node("review"), pauseAfter: true }],
    edges: [{ from: "edit", to: "testA" }, { from: "testA", to: "review" }, { from: "edit", to: "slow" }, { from: "slow", to: "testB" }, { from: "testB", to: "review" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      inputs[request.execution.executionId!] = request.predecessors.map(value => value.executionId!);
      if (request.execution.executionId === "slow@2") await slow.promise;
      return { output: request.execution.executionId! };
    },
  });
  await until(() => run.snapshot().pausedExecutionIds[0] === "review@1");
  const state = run.snapshot();
  run.update({ expectedRevision: state.revision, upsertNodes: [node("edit")], resume: ["review@1"] });
  await until(() => instances(run, "testA").length === 2 && instances(run, "testA")[1]!.status === "completed" && run.snapshot().nodes.slow!.status === "running");
  await new Promise(resolve => setTimeout(resolve, 20));
  // review has not been cloned with testB@1: testB is stale while slow@2 runs.
  assert.equal(run.snapshot().nodes.review!.executionId, "review@1");
  assert.equal(run.snapshot().nodes.testB!.executionId, "testB@1");
  slow.resolve();
  await until(() => run.snapshot().pausedExecutionIds[0] === "review@2");
  assert.deepEqual(inputs["review@2"], ["testA@2", "testB@2"]);
  assert.deepEqual(Object.keys(run.snapshot().executions).filter(id => id.startsWith("review")), ["review@1", "review@2"]);
  run.resume(["review@2"], run.snapshot().revision);
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.terminalExecutionIds, ["review@2"]);
});

test("waiting on a stale input reports stale, and a held input reports hold", async t => {
  let run!: BraidRun;
  const gate = deferred();
  run = startBraid({ goal: "reasons", nodes: [node("a"), node("b"), node("c")], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      if (request.execution.executionId === "a@2") await gate.promise;
      return { output: "ok" };
    },
  });
  run.pauseRun();
  // Hold the first a once it runs, so the graph is still live after the first pass.
  run.update({ expectedRevision: 0, upsertNodes: [{ ...node("a"), pauseAfter: true }] });
  run.resumeRun();
  await until(() => run.snapshot().pausedExecutionIds[0] === "a@1");
  assert.equal(run.snapshot().nodes.b!.waitReason, "hold");
  assert.equal(run.snapshot().nodes.c!.waitReason, "hold");
  run.update({ expectedRevision: 1, upsertNodes: [node("a")] });
  await until(() => run.snapshot().nodes.a!.status === "running");
  // a has a result that is being replaced, so b waits on a stale input; c waits for b, which never ran.
  assert.equal(run.snapshot().nodes.b!.waitReason, "stale");
  assert.equal(run.snapshot().nodes.c!.waitReason, "predecessors");
  gate.resolve();
  await run.result;
});

test("an edge from a new node into a settled lineage reruns it once", async t => {
  let run!: BraidRun;
  const inputs: Record<string, string[]> = {};
  run = startBraid({ goal: "fix then test", nodes: [node("edit"), { ...node("test"), pauseAfter: true }], edges: [{ from: "edit", to: "test" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      inputs[request.execution.executionId!] = request.predecessors.map(value => value.executionId!);
      return { output: request.execution.executionId! };
    },
    onEvent(event) {
      if (event.type === "execution_paused" && event.executionId === "test@1")
        run.update({ expectedRevision: 0, upsertNodes: [node("fix")], addEdges: [{ from: "fix", to: "test" }], resume: ["test@1"] });
      if (event.type === "execution_paused" && event.executionId === "test@2") run.resume(["test@2"], 1);
    },
  });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(inputs["test@2"], ["edit@1", "fix@1"]);
  assert.deepEqual(Object.keys(result.executions), ["edit@1", "test@1", "fix@1", "test@2"]);
  const clone = result.events.find(event => event.type === "execution_created" && event.executionId === "test@2");
  assert.deepEqual(clone?.type === "execution_created" && [clone.cause, clone.trigger], ["cloned", "fix@1"]);
});

test("rerunning a decision records skipped instances for branches it no longer takes", async t => {
  let run!: BraidRun;
  let choice = "left";
  const inputs: string[][] = [];
  run = startBraid({ goal: "branches", nodes: [{ type: "decision", id: "route", prompt: "pick", choices: ["left", "right"] }, node("left"), node("right"), { ...node("join"), pauseAfter: true }],
    edges: [{ from: "route", to: "left", choice: "left" }, { from: "route", to: "right", choice: "right" }, { from: "left", to: "join" }, { from: "right", to: "join" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      request.decide?.(choice);
      if (request.node.id === "join") inputs.push(request.predecessors.map(value => value.executionId!));
      return { output: request.node.id };
    },
    onEvent(event) {
      if (event.type !== "execution_paused") return;
      if (event.executionId === "join@1") {
        choice = "right";
        run.update({ expectedRevision: 0, upsertNodes: [{ type: "decision", id: "route", prompt: "pick again", choices: ["left", "right"] }], resume: ["join@1"] });
      } else run.resume([event.executionId!], 1);
    },
  });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(inputs, [["left@1"], ["right@2"]]);
  assert.deepEqual(["left@1", "left@2", "right@1", "right@2"].map(id => result.executions[id]!.status), ["completed", "skipped", "skipped", "completed"]);
  assert.equal(result.executions["left@2"]!.skipReason, "inactive");
});

test("an observer may remove a node from inside its skipped event", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "skip", nodes: [{ type: "decision", id: "route", prompt: "pick", choices: ["left", "right"] }, node("left"), node("right")],
    edges: [{ from: "route", to: "left", choice: "left" }, { from: "route", to: "right", choice: "right" }] }, {
    cwd: await outsideGit(t), runner: async request => { request.decide?.("left"); return { output: request.node.id }; },
    onEvent(event) {
      if (event.type === "node_skipped" && event.nodeId === "right") run.update({ expectedRevision: 0, removeNodeIds: ["right"] });
    },
  });
  const result = await run.result;
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(result.nodes.right, undefined);
  assert.equal(result.executions["right@1"]!.skipReason, "inactive");
});

test("optional failures continue; a required failure aborts running siblings", async t => {
  const cwd = await outsideGit(t);
  const input: BraidInput = { goal: "recover", nodes: [node("bad"), node("recover")], edges: [{ from: "bad", to: "recover" }] };
  const optional = await braid(input, { cwd, runner: async request => {
    if (request.node.id === "bad") throw new Error("optional failure");
    assert.equal(request.predecessors[0]!.error!.code, "MODEL_ERROR");
    return { output: "recovered" };
  } });
  assert.equal(optional.status, "completed");
  let cancelled = false;
  const required = await braid({ ...input, nodes: [{ ...node("bad"), requireSuccess: true }, node("sibling"), node("recover")] }, { cwd, runner: async request => {
    if (request.node.id === "bad") {
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error("required failure");
    }
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    return { output: "stopped" };
  } });
  assert.equal(required.error?.code, "REQUIRED_NODE_FAILED");
  assert.ok(cancelled);
  assert.equal(required.nodes.recover!.status, "skipped");
  assert.equal(required.executions["recover@1"]!.skipReason, "run_failed");
});

test("graph timeout and cancellation remain active while paused", async t => {
  const result = await braid({ goal: "hold", nodes: [{ ...node("a"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), graphTimeoutMs: 30, runner: async () => ({ output: "waiting" }),
  });
  assert.equal(result.error?.code, "GRAPH_TIMEOUT");
});

test("a cycle can be changed mid-round; later rounds follow the current edges", async t => {
  let run!: BraidRun;
  const seen: string[] = [];
  run = startBraid(loop(), { cwd: await outsideGit(t), runner: async request => {
    seen.push(request.execution.executionId!);
    if (request.execution.executionId === "work@1") run.update({ expectedRevision: 0,
      upsertNodes: [node("extra")], removeEdges: [{ from: "work", to: "check" }], addEdges: [{ from: "work", to: "extra" }, { from: "extra", to: "check" }] });
    request.decide?.(request.execution.generation === 1 ? "again" : "done");
    return { output: "ok" };
  } });
  assert.equal((await run.result).status, "completed");
  assert.deepEqual(seen, ["work@1", "extra@1", "check@1", "work@2", "extra@2", "check@2", "end@1"]);
});

test("cycles must be closed by a decision's choice edge", () => {
  assert.throws(() => validateGraph({ goal: "bad", nodes: [node("a")], edges: [{ from: "a", to: "a" }] }), /closed by a decision's choice edge/);
  assert.throws(() => validateGraph({ goal: "loops", nodes: [{ type: "decision", id: "check", prompt: "p", choices: ["again"] }, node("work")],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }] }), /needs an exit choice/);
  // Two cycles sharing check overlap.
  assert.throws(() => validateGraph({ goal: "overlap", nodes: [node("a"), node("b"), { type: "decision", id: "check", prompt: "p", choices: ["a", "b", "done"] }],
    edges: [{ from: "a", to: "check" }, { from: "b", to: "check" }, { from: "check", to: "a", choice: "a" }, { from: "check", to: "b", choice: "b" }] }), /nested or overlapping/);
});

test("closingEdges finds the edge that closes each cycle for displays", () => {
  assert.deepEqual(closingEdges(loop()), [{ from: "check", to: "work", choice: "again" }]);
  // Without an external input, the entry listed first wins between two choice edges.
  const decisions = ["a", "b"].map(id => ({ type: "decision" as const, id, prompt: id, choices: ["next", "stop"] }));
  assert.deepEqual(closingEdges({ nodes: decisions, edges: [{ from: "a", to: "b", choice: "next" }, { from: "b", to: "a", choice: "next" }] }),
    [{ from: "b", to: "a", choice: "next" }]);
  assert.deepEqual(closingEdges({ nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] }), []);
});

test("cycle validation names the entry and an exit from another node", () => {
  // Reduced from a Pi session: the edge back to the entry must be the decision's choice.
  const input: BraidInput = { goal: "review", nodes: [node("merge1"), node("fix"),
    { type: "decision", id: "accept", prompt: "review", choices: ["pass", "fail"] }, node("integrate")],
    edges: [{ from: "merge1", to: "accept" }, { from: "fix", to: "accept" },
      { from: "accept", to: "fix", choice: "fail" },
      { from: "accept", to: "integrate", choice: "pass" }] };
  assert.throws(() => validateGraph(input), /entry 'accept' through a decision's choice edge/);
  assert.throws(() => validateGraph({ ...input, edges: [{ from: "merge1", to: "fix" }, { from: "merge1", to: "accept" }, ...input.edges.slice(1)] }),
    /multiple entries \('fix', 'accept'\)/);
  assert.throws(() => validateGraph({ ...input, edges: [{ from: "merge1", to: "fix" }, ...input.edges.slice(1), { from: "fix", to: "integrate" }] }),
    /must exit through its decision 'accept': edge 'fix' -> 'integrate'/);
  assert.doesNotThrow(() => validateGraph({ ...input, edges: [{ from: "merge1", to: "fix" }, ...input.edges.slice(1)] }));
});

test("cancelling a paused graph clears resumable holds but retains pause history", async t => {
  let run!: BraidRun;
  let pausedId: string | undefined;
  run = startBraid({ goal: "cancel hold", nodes: [{ ...node("a"), pauseAfter: true }, node("tail")],
    edges: [{ from: "a", to: "tail" }] }, {
    cwd: await outsideGit(t), runner: async () => ({ output: "retained" }),
    onEvent(event) {
      if (event.type === "execution_paused") {
        pausedId = event.executionId;
        assert.deepEqual(run.snapshot().pausedExecutionIds, [pausedId]);
        run.cancel();
      }
    },
  });
  const result = await run.result;
  assert.ok(pausedId);
  assert.equal(result.error?.code, "CANCELLED");
  assert.equal(result.nodes.tail!.skipReason, "cancelled");
  assert.deepEqual(run.snapshot().pausedExecutionIds, []);
  assert.ok(result.events.some(event => event.type === "execution_paused" && event.executionId === pausedId));
  assert.ok(!result.events.some(event => event.type === "execution_resumed"));
});

test("updates share a finite execution budget and cannot mutate retained event history", async t => {
  let run!: BraidRun;
  let edits = 0;
  run = startBraid({ goal: "bounded JIT", nodes: [{ ...node("one"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), maxExecutions: 2, onLimit: "fail",
    runner: async () => ({ output: "done" }),
    onEvent(event) {
      if (event.type === "graph_updated") {
        assert.ok(Object.isFrozen(event.graph.nodes));
        assert.ok(Object.isFrozen(event.graph.nodes[0]));
      }
      if (event.type === "execution_paused") {
        const next = `next-${++edits}`;
        run.update({ expectedRevision: run.snapshot().revision,
          upsertNodes: [{ ...node(next), pauseAfter: true }],
          addEdges: [{ from: event.nodeId, to: next }], resume: [event.executionId!] });
      }
    },
  });
  const result = await run.result;
  assert.equal(result.error?.code, "EXECUTION_LIMIT");
  assert.equal(edits, 2);
  // The pending instance never started, so it does not count toward the limit.
  assert.deepEqual(Object.values(result.executions).map(record => [record.executionId, record.status]),
    [["one@1", "completed"], ["next-1@1", "completed"], ["next-2@1", "skipped"]]);
});

test("removing a running node cancels it and keeps it in history", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "remove", nodes: [{ ...node("gone"), requireSuccess: true }, node("after"), node("retained")], edges: [{ from: "gone", to: "after" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      if (request.node.id === "gone") {
        run.update({ expectedRevision: 0, removeNodeIds: ["gone"] });
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { output: request.node.id };
    },
  });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.gone, undefined);
  assert.equal(result.executions["gone@1"]!.error!.code, "CANCELLED");
  assert.match(result.executions["gone@1"]!.error!.message, /removed by a graph update/);
  // Its edges went with it, so after became a root.
  assert.deepEqual(result.executions["after@1"]!.predecessorExecutionIds, []);
  assert.equal(run.snapshot().graph.nodes.some(node => node.id === "gone"), false);
});

test("optional failed decisions do not activate the closing edge or conditional exits", async t => {
  const input = loop();
  const result = await braid({ ...input, nodes: [...input.nodes, node("recover")], edges: [...input.edges, { from: "check", to: "recover" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      if (request.node.id === "check") throw new Error("review unavailable");
      return { output: request.node.id };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.end!.skipReason, "upstream_failed");
  assert.equal(result.nodes.recover!.status, "completed");
  assert.equal(Object.values(result.executions).filter(value => value.id === "work").length, 1);
});

test("removing the closing edge while a round runs ends the cycle", async t => {
  let run!: BraidRun;
  run = startBraid(loop(), { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "work") run.update({ expectedRevision: 0, removeEdges: [{ from: "check", to: "work", choice: "again" }] });
    request.decide?.("again");
    return { output: request.node.id };
  } });
  const result = await run.result;
  assert.equal(result.nodes.end!.status, "skipped");
  assert.deepEqual(Object.keys(result.executions), ["work@1", "check@1", "end@1"]);
});

test("node IDs such as __proto__ stay ordinary snapshot properties", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "safe ids", nodes: [{ ...node("__proto__"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), runner: async () => ({ output: "retained" }), onEvent(event) {
      if (event.type === "execution_paused") run.update({ expectedRevision: 0, upsertNodes: [node("replacement")], resume: [event.executionId!] });
    },
  });
  const result = await run.result;
  assert.equal(Object.getPrototypeOf(result.nodes), Object.prototype);
  assert.equal(Object.hasOwn(result.nodes, "__proto__"), true);
  assert.equal(result.nodes.__proto__!.output, "retained");
  assert.equal(result.executions["__proto__@1"]!.output, "retained");
});

test("decision branches are resolved anew in each round", async t => {
  const inputs: string[][] = [];
  const result = await braid({ goal: "alternate branches", nodes: [
    { type: "decision", id: "route", prompt: "pick", choices: ["left", "right"], maxRuns: 2 }, node("left"), node("right"),
    { type: "decision", id: "check", prompt: "continue", choices: ["again", "done"] },
  ], edges: [
    { from: "route", to: "left", choice: "left" }, { from: "route", to: "right", choice: "right" },
    { from: "left", to: "check" }, { from: "right", to: "check" },
    { from: "check", to: "route", choice: "again" },
  ] }, { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "route") request.decide!(request.execution.generation === 1 ? "left" : "right");
    if (request.node.id === "check") {
      inputs.push(request.predecessors.map(value => value.nodeId));
      request.decide!(request.execution.generation === 1 ? "again" : "done");
    }
    return { output: request.node.id };
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(inputs, [["left"], ["right"]]);
  assert.deepEqual(Object.values(result.executions).filter(value => value.id === "right").map(value => value.status), ["skipped", "completed"]);
  assert.deepEqual(Object.values(result.executions).filter(value => value.id === "left").map(value => value.status), ["completed", "skipped"]);
});

test("a replaced held instance is released, and only the replacement routes", async t => {
  const runner: ModelRunner = async request => { request.decide?.("again"); return { output: request.execution.executionId! }; };
  const check = { type: "decision" as const, id: "check", prompt: "review", choices: ["again", "done"], pauseAfter: true };
  let run!: BraidRun;
  run = startBraid(loop(6), { cwd: await outsideGit(t), runner, onEvent(event) {
    if (event.type === "execution_paused" && event.executionId === "check@1")
      run.update({ expectedRevision: 1, upsertNodes: [{ ...check, prompt: "review again" }] });
  } });
  t.after(() => run.cancel());
  run.update({ expectedRevision: 0, upsertNodes: [check] });
  await until(() => run.snapshot().pausedExecutionIds.includes("check@2"));
  const state = run.snapshot();
  assert.deepEqual(state.pausedExecutionIds, ["check@2"]);
  assert.equal(state.executions["check@1"]!.supersededBy, "check@2");
  assert.equal(state.executions["check@1"]!.held, undefined);
  // check@1 never fired its closing edge: work ran once, and check@2 used work@1.
  assert.deepEqual(instances(run, "work").map(record => record.executionId), ["work@1"]);
  assert.deepEqual(state.executions["check@2"]!.predecessorExecutionIds, ["work@1"]);
});
