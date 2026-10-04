import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { braid, startBraid, validateGraph, type BraidInput, type BraidRun, type ExecutionEvent } from "../src/index.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: id });
const loop = (): BraidInput => ({ goal: "refine", nodes: [node("work"), { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }, node("end")],
  edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", feedback: "refine" }, { from: "check", to: "end", choice: "done" }],
  loops: [{ id: "refine", entry: "work", maxIterations: 3 }] });
async function outsideGit(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "braid-control-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("bounded feedback creates fresh executions and feeds the previous iteration", async t => {
  const result = await braid(loop(), { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "check") request.decide!(request.execution.iteration === 3 ? "done" : "again");
    if (request.node.id === "work" && request.execution.iteration! > 1) {
      assert.equal(request.predecessors.at(-1)!.nodeId, "check");
      assert.ok(request.predecessors.at(-1)!.executionId);
    }
    return { output: `${request.node.id}:${request.execution.iteration ?? 0}` };
  } });
  assert.equal(result.status, "completed");
  assert.equal(Object.keys(result.executions).length, 7);
  assert.equal(result.nodes.work!.output, "work:3");
  assert.deepEqual(Object.keys(result.terminalOutputs), ["end"]);
});

test("loop limit is fatal even when the feedback node is optional", async t => {
  const result = await braid(loop(), { cwd: await outsideGit(t), runner: async request => {
    request.decide?.("again"); return { output: "keep going" };
  } });
  assert.equal(result.error?.code, "LOOP_LIMIT");
  assert.equal(Object.values(result.executions).filter(value => value.id === "work").length, 3);
});

test("paused execution accepts an atomic revision update and resume", async t => {
  let run!: BraidRun;
  let resumed = false;
  run = startBraid({ goal: "edit", nodes: [{ ...node("a"), pauseAfter: true }, node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), onEvent(event) {
      if (event.type !== "execution_paused") return;
      const before = run.snapshot();
      assert.throws(() => run.update({ expectedRevision: 9, removeNodeIds: ["b"] }), /Revision conflict/);
      assert.throws(() => run.update({ expectedRevision: 0, addEdges: [{ from: "missing", to: "a" }], resume: [event.executionId!] }));
      assert.deepEqual(run.snapshot(), before);
      run.update({ expectedRevision: 0, removeNodeIds: ["b"], upsertNodes: [node("c")], addEdges: [{ from: "a", to: "c" }], resume: [event.executionId!] });
      resumed = true;
    }, runner: async request => ({ output: request.node.id }),
  });
  const result = await run.result;
  assert.ok(resumed);
  assert.equal(result.revision, 1);
  assert.equal(result.nodes.b, undefined);
  assert.equal(result.nodes.c!.output, "c");
  assert.throws(() => run.update({ expectedRevision: 1 }), /no longer/);
  const final = run.snapshot();
  run.cancel();
  assert.deepEqual(run.snapshot(), final);
});

test("editing a running definition preserves its captured prompt and routes through the latest edges", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "edit", nodes: [node("a"), node("b")], edges: [{ from: "a", to: "b" }] }, {
    cwd: await outsideGit(t), runner: async request => {
      if (request.node.id === "a") {
        run.update({ expectedRevision: 0, upsertNodes: [{ ...node("a"), prompt: "new prompt" }, node("c")], removeNodeIds: ["b"], addEdges: [{ from: "a", to: "c" }] });
        assert.equal(request.node.prompt, "a");
      }
      return { output: request.node.id };
    },
  });
  const result = await run.result;
  assert.equal(result.nodes.c!.status, "completed");
  assert.equal(result.executions[result.nodes.a!.executionId!]!.node.prompt, "a");
  assert.equal(run.snapshot().graph.nodes[0]!.prompt, "new prompt");
});

test("optional failures continue; required failures abort sibling invocations using captured policy", async t => {
  const cwd = await outsideGit(t);
  const input: BraidInput = { goal: "recover", nodes: [node("bad"), node("recover")], edges: [{ from: "bad", to: "recover" }] };
  const optional = await braid(input, { cwd, runner: async request => {
    if (request.node.id === "bad") throw new Error("optional failure");
    assert.equal(request.predecessors[0]!.error!.code, "MODEL_ERROR");
    return { output: "recovered" };
  } });
  assert.equal(optional.status, "completed");
  let run!: BraidRun;
  let cancelled = false;
  run = startBraid({ ...input, nodes: [{ ...node("bad"), requireSuccess: true }, node("sibling"), node("recover")] }, { cwd, runner: async request => {
    if (request.node.id === "bad") {
      run.update({ expectedRevision: 0, upsertNodes: [{ ...node("bad"), requireSuccess: false }] });
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error("required failure");
    }
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    return { output: "stopped" };
  } });
  const required = await run.result;
  assert.equal(required.error?.code, "REQUIRED_NODE_FAILED");
  assert.ok(cancelled);
  assert.equal(required.nodes.recover!.status, "skipped");
});

test("graph timeout and cancellation remain active while paused", async t => {
  const result = await braid({ goal: "hold", nodes: [{ ...node("a"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), graphTimeoutMs: 30, runner: async () => ({ output: "waiting" }),
  });
  assert.equal(result.error?.code, "GRAPH_TIMEOUT");
});

test("loop graph can be changed mid-iteration without overlapping rounds", async t => {
  let run!: BraidRun;
  const seen: string[] = [];
  run = startBraid(loop(), { cwd: await outsideGit(t), runner: async request => {
    seen.push(`${request.node.id}:${request.execution.iteration}`);
    if (request.node.id === "work" && request.execution.iteration === 1) run.update({ expectedRevision: 0,
      upsertNodes: [node("extra")], removeEdges: [{ from: "work", to: "check" }], addEdges: [{ from: "work", to: "extra" }, { from: "extra", to: "check" }] });
    request.decide?.(request.execution.iteration === 1 ? "again" : "done");
    return { output: "ok" };
  } });
  assert.equal((await run.result).status, "completed");
  assert.deepEqual(seen, ["work:1", "extra:1", "check:1", "work:2", "extra:2", "check:2", "end:undefined"]);
});

test("historical dependencies survive definition removal", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "history", nodes: [{ ...node("a"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), onEvent(event: ExecutionEvent) {
      if (event.type === "execution_paused") run.update({ expectedRevision: 0, removeNodeIds: ["a"], upsertNodes: [node("b")],
        addEdges: [{ from: "a", executionId: event.executionId!, to: "b" }], resume: [event.executionId!] });
    }, runner: async request => ({ output: request.node.id === "b" ? request.predecessors[0]!.output : "retained" }),
  });
  assert.equal((await run.result).nodes.b!.output, "retained");
});

test("undeclared cycles and unbounded loops fail validation", () => {
  assert.throws(() => validateGraph({ goal: "bad", nodes: [node("a")], edges: [{ from: "a", to: "a" }] }), /feedback/);
  assert.throws(() => validateGraph({ ...loop(), loops: [{ id: "refine", entry: "work", maxIterations: Infinity }] }), /maxIterations/);
});

test("loop validation identifies the bad feedback target and an external edge bypassing entry", () => {
  // Reduced from the Pi session: changing entry alone must not hide the second error.
  const input: BraidInput = { goal: "review", nodes: [node("merge1"), node("fix"),
    { type: "decision", id: "accept", prompt: "review", choices: ["pass", "fail"] }, node("integrate")],
    edges: [{ from: "merge1", to: "accept" }, { from: "fix", to: "accept" },
      { from: "accept", to: "fix", choice: "fail", feedback: "review" },
      { from: "accept", to: "integrate", choice: "pass" }],
    loops: [{ id: "review", entry: "accept", maxIterations: 3 }] };
  assert.throws(() => validateGraph(input), /feedback edge 'accept' -> 'fix'.*entry 'accept'/);
  const correctedEntry = { ...input, loops: [{ id: "review", entry: "fix", maxIterations: 3 }] };
  assert.throws(() => validateGraph(correctedEntry), /edge 'merge1' -> 'accept' bypasses entry 'fix'/);
  assert.doesNotThrow(() => validateGraph({ ...correctedEntry,
    edges: [{ from: "merge1", to: "fix" }, ...input.edges.slice(1)] }));
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
    cwd: await outsideGit(t), maxExecutions: 2,
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
  assert.equal(Object.keys(result.executions).length, 2);
});

test("deleting a running node does not cancel it or discard its result", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "delete definition", nodes: [node("gone"), node("retained")], edges: [] }, {
    cwd: await outsideGit(t), runner: async request => {
      if (request.node.id === "gone") {
        run.update({ expectedRevision: 0, removeNodeIds: ["gone"] });
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(request.signal.aborted, false);
      }
      return { output: request.node.id };
    },
  });
  const result = await run.result;
  assert.equal(result.nodes.gone!.output, "gone");
  assert.equal(result.nodes.gone!.status, "completed");
  assert.equal(run.snapshot().graph.nodes.some(node => node.id === "gone"), false);
});

test("optional failed decisions do not activate feedback or conditional exits", async t => {
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

test("topology updates can remove a loop while an iteration is executing", async t => {
  let run!: BraidRun;
  run = startBraid(loop(), { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "work") run.update({ expectedRevision: 0, loops: [],
      removeEdges: [{ from: "check", to: "work", choice: "again", feedback: "refine" }] });
    request.decide?.("done");
    return { output: request.node.id };
  } });
  const result = await run.result;
  assert.equal(result.nodes.end!.status, "completed");
  assert.equal(Object.keys(result.executions).length, 3);
  assert.ok(Object.values(result.executions).find(value => value.id === "work")!.loopId);
});

test("removing a paused prototype-like node preserves ordinary snapshot objects", async t => {
  let run!: BraidRun;
  run = startBraid({ goal: "safe ids", nodes: [{ ...node("__proto__"), pauseAfter: true }], edges: [] }, {
    cwd: await outsideGit(t), runner: async () => ({ output: "retained" }), onEvent(event) {
      if (event.type === "execution_paused") run.update({ expectedRevision: 0, removeNodeIds: ["__proto__"], upsertNodes: [node("replacement")], resume: [event.executionId!] });
    },
  });
  const result = await run.result;
  assert.equal(Object.getPrototypeOf(result.nodes), Object.prototype);
  assert.equal(Object.hasOwn(result.nodes, "__proto__"), true);
  assert.equal(result.nodes.__proto__!.output, "retained");
});

test("renaming a loop mid-iteration preserves the already running activation", async t => {
  let run!: BraidRun;
  let calls = 0;
  run = startBraid(loop(), { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "work") {
      calls++;
      if (calls === 1) run.update({ expectedRevision: 0,
        loops: [{ id: "renamed", entry: "work", maxIterations: 3 }],
        removeEdges: [{ from: "check", to: "work", choice: "again", feedback: "refine" }],
        addEdges: [{ from: "check", to: "work", choice: "again", feedback: "renamed" }],
      });
    }
    request.decide?.(request.execution.iteration === 1 ? "again" : "done");
    return { output: request.node.id };
  } });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.equal(Object.values(result.executions).filter(record => record.id === "work" && record.iteration === 1).length, 1);
});

test("inactive branches are resolved anew in each loop iteration", async t => {
  const inputs: string[][] = [];
  const result = await braid({ goal: "alternate branches", nodes: [
    { type: "decision", id: "route", prompt: "pick", choices: ["left", "right"] }, node("left"), node("right"),
    { type: "decision", id: "check", prompt: "continue", choices: ["again", "done"] },
  ], edges: [
    { from: "route", to: "left", choice: "left" }, { from: "route", to: "right", choice: "right" },
    { from: "left", to: "check" }, { from: "right", to: "check" },
    { from: "check", to: "route", choice: "again", feedback: "alternating" },
  ], loops: [{ id: "alternating", entry: "route", maxIterations: 2 }],
  }, { cwd: await outsideGit(t), runner: async request => {
    if (request.node.id === "route") request.decide!(request.execution.iteration === 1 ? "left" : "right");
    if (request.node.id === "check") {
      inputs.push(request.predecessors.map(value => value.nodeId));
      request.decide!(request.execution.iteration === 1 ? "again" : "done");
    }
    return { output: request.node.id };
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(inputs, [["left"], ["right"]]);
  assert.deepEqual(Object.values(result.executions).filter(value => value.id === "right").map(value => value.status), ["skipped", "completed"]);
});
