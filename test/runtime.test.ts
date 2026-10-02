import { predecessorText } from "./helpers.js";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import {
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
} from "../src/index.js";
import { braid, decision, deferred, execute, graph } from "./helpers.js";
import { mockClock } from "./clock.js";

const bounds = { timeout: 2_000 };
const echo: ModelRunner = async (request) => ({ output: request.node.id });

test(
  "sequential execution is topological and passes only direct predecessors with provenance",
  bounds,
  async () => {
    const calls: ModelRequest[] = [];
    const result = await braid(
      graph(
        [execute("c"), execute("b"), execute("a")],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      ),
      {
        runner: async (request) => {
          calls.push(request);
          assert.equal(request.decide, undefined);
          assert.equal(request.goal, "Test Braid");
          return {
            output: `result:${request.node.id}`,
            usage: { inputTokens: 2, outputTokens: 3 },
          };
        },
      },
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(
      calls.map((call) => call.node.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      calls.map((call) => predecessorText(call.predecessors)),
      [
        [],
        [{ nodeId: "a", output: "result:a" }],
        [{ nodeId: "b", output: "result:b" }],
      ],
    );
    assert.deepEqual(result.terminalOutputs, { c: { output: "result:c" } });
    assert.deepEqual(result.metadata.usage, {
      inputTokens: 6,
      outputTokens: 9,
    });
    assert.equal(result.metadata.usageReportedNodes, 3);
    assert.equal(result.metadata.rootRunId, result.metadata.runId);
    for (const node of Object.values(result.nodes)) {
      assert.equal(node.status, "completed");
      assert.ok(node.latencyMs! >= 0);
      assert.ok(node.finishedAt! >= node.startedAt!);
    }
    assert.ok(result.metadata.latencyMs >= 0);
    assert.ok(
      calls.every((call) => call.execution.runId === result.metadata.runId),
    );
  },
);

test(
  "parallel fan-out starts both successors before either completes",
  bounds,
  async () => {
    const bothStarted = deferred();
    const release = deferred();
    const started: string[] = [];
    const run = braid(
      graph(
        [execute("root"), execute("a"), execute("b")],
        [
          { from: "root", to: "a" },
          { from: "root", to: "b" },
        ],
      ),
      {
        maxConcurrency: 2,
        runner: async (request) => {
          if (request.node.id !== "root") {
            assert.deepEqual(predecessorText(request.predecessors), [
              { nodeId: "root", output: "root" },
            ]);
            started.push(request.node.id);
            if (started.length === 2) bothStarted.resolve();
            await release.promise;
          }
          return { output: request.node.id };
        },
      },
    );
    await bothStarted.promise;
    assert.deepEqual(started, ["a", "b"]);
    release.resolve();
    assert.deepEqual((await run).terminalOutputs, {
      a: { output: "a" },
      b: { output: "b" },
    });
  },
);

test(
  "fan-in waits for every active predecessor, even when one finishes early",
  bounds,
  async () => {
    const started = deferred();
    const releaseA = deferred();
    const releaseB = deferred();
    let roots = 0;
    let joinStarted = false;
    const run = braid(
      graph(
        [execute("a"), execute("b"), execute("join")],
        [
          { from: "a", to: "join" },
          { from: "b", to: "join" },
        ],
      ),
      {
        runner: async (request) => {
          if (request.node.id === "join") {
            joinStarted = true;
            assert.deepEqual(predecessorText(request.predecessors), [
              { nodeId: "a", output: "a" },
              { nodeId: "b", output: "b" },
            ]);
          } else {
            if (++roots === 2) started.resolve();
            await (request.node.id === "a"
              ? releaseA.promise
              : releaseB.promise);
          }
          return { output: request.node.id };
        },
      },
    );
    await started.promise;
    releaseA.resolve();
    await tick();
    assert.equal(joinStarted, false);
    releaseB.resolve();
    assert.equal((await run).nodes.join!.status, "completed");
    assert.equal(joinStarted, true);
  },
);

test(
  "independent roots execute concurrently but never exceed maxConcurrency",
  bounds,
  async () => {
    const ready = deferred();
    const release = deferred();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const run = braid(
      graph(Array.from({ length: 8 }, (_, i) => execute(String(i)))),
      {
        maxConcurrency: 2,
        runner: async (request) => {
          calls++;
          peak = Math.max(peak, ++active);
          if (calls === 2) ready.resolve();
          await release.promise;
          active--;
          return { output: request.node.id };
        },
      },
    );
    await ready.promise;
    assert.equal(calls, 2);
    release.resolve();
    const result = await run;
    assert.equal(peak, 2);
    assert.equal(calls, 8);
    assert.equal(Object.keys(result.terminalOutputs).length, 8);
  },
);

test(
  "decision routing retains text and choice; unlabelled edges remain unconditional",
  bounds,
  async () => {
    const called: string[] = [];
    const result = await braid(
      graph(
        [decision(), execute("left"), execute("right"), execute("audit")],
        [
          { from: "route", to: "left", choice: "left" },
          { from: "route", to: "right", choice: "right" },
          { from: "route", to: "audit" },
        ],
      ),
      {
        runner: async (request) => {
          called.push(request.node.id);
          if (request.node.type === "decision") request.decide!("left");
          else
            assert.deepEqual(predecessorText(request.predecessors), [
              { nodeId: "route", output: "route", decision: "left" },
            ]);
          return { output: request.node.id };
        },
      },
    );
    assert.deepEqual(called, ["route", "left", "audit"]);
    assert.equal(result.nodes.route!.output, "route");
    assert.equal(result.nodes.route!.decision, "left");
    assert.equal(result.nodes.right!.status, "skipped");
    assert.equal(result.nodes.right!.skipReason, "inactive");
    assert.equal(result.nodes.right!.startedAt, undefined);
    assert.equal(result.nodes.right!.output, undefined);
    assert.deepEqual(result.terminalOutputs, {
      left: { output: "left" },
      audit: { output: "audit" },
    });
  },
);

test(
  "one decision choice activates multiple successors concurrently",
  bounds,
  async () => {
    const ready = deferred();
    const release = deferred();
    let branches = 0;
    const run = braid(
      graph(
        [decision(), execute("a"), execute("b"), execute("unused")],
        [
          { from: "route", to: "a", choice: "left" },
          { from: "route", to: "b", choice: "left" },
          { from: "route", to: "unused", choice: "right" },
        ],
      ),
      {
        runner: async (request) => {
          if (request.decide) request.decide("left");
          else {
            assert.notEqual(request.node.id, "unused");
            if (++branches === 2) ready.resolve();
            await release.promise;
          }
          return { output: request.node.id };
        },
      },
    );
    await ready.promise;
    release.resolve();
    const result = await run;
    assert.equal(result.status, "completed");
    assert.deepEqual(Object.keys(result.terminalOutputs), ["a", "b"]);
    assert.equal(result.nodes.unused!.status, "skipped");
  },
);

test(
  "skipped branches propagate through nested decisions and deep paths into a join",
  bounds,
  async () => {
    const calls: string[] = [];
    const result = await braid(
      graph(
        [
          execute("join"),
          execute("dead2"),
          decision("deadDecision"),
          execute("dead1"),
          execute("live"),
          decision(),
        ],
        [
          { from: "route", to: "live", choice: "left" },
          { from: "route", to: "deadDecision", choice: "right" },
          { from: "deadDecision", to: "dead1", choice: "left" },
          { from: "dead1", to: "dead2" },
          { from: "dead2", to: "join" },
          { from: "live", to: "join" },
        ],
      ),
      {
        runner: async (request) => {
          calls.push(request.node.id);
          if (request.decide) request.decide("left");
          if (request.node.id === "join") {
            assert.deepEqual(predecessorText(request.predecessors), [
              { nodeId: "live", output: "live" },
            ]);
          }
          return { output: request.node.id };
        },
      },
    );
    assert.deepEqual(calls, ["route", "live", "join"]);
    for (const id of ["deadDecision", "dead1", "dead2"]) {
      assert.equal(result.nodes[id]!.status, "skipped");
      assert.equal(result.nodes[id]!.skipReason, "inactive");
    }
    assert.equal(result.nodes.join!.status, "completed");
  },
);

test(
  "a join waits for possible predecessor paths to resolve inactive",
  bounds,
  async () => {
    const ready = deferred();
    const releaseDecision = deferred();
    let joined = false;
    const run = braid(
      graph(
        [execute("fast"), decision(), execute("maybe"), execute("join")],
        [
          { from: "route", to: "maybe", choice: "left" },
          { from: "maybe", to: "join" },
          { from: "fast", to: "join" },
        ],
      ),
      {
        runner: async (request) => {
          if (request.decide) {
            ready.resolve();
            await releaseDecision.promise;
            request.decide("right");
          }
          if (request.node.id === "join") {
            joined = true;
            assert.deepEqual(predecessorText(request.predecessors), [
              { nodeId: "fast", output: "fast" },
            ]);
          }
          return { output: request.node.id };
        },
      },
    );
    await ready.promise;
    await tick();
    assert.equal(joined, false);
    releaseDecision.resolve();
    const result = await run;
    assert.equal(result.nodes.maybe!.skipReason, "inactive");
    assert.equal(joined, true);
    // A successful decision with no active outgoing edge is an execution terminal.
    assert.deepEqual(result.terminalOutputs, {
      route: { output: "route", decision: "right" },
      join: { output: "join" },
    });
  },
);

test(
  "multiple edges between a pair contribute the predecessor only once",
  bounds,
  async () => {
    const result = await braid(
      graph(
        [decision(), execute("target")],
        [
          { from: "route", to: "target", choice: "left" },
          { from: "route", to: "target", choice: "right" },
          { from: "route", to: "target" },
        ],
      ),
      {
        runner: async (request) => {
          if (request.decide) request.decide("left");
          else assert.equal(request.predecessors.length, 1);
          return { output: request.node.id };
        },
      },
    );
    assert.equal(result.nodes.target!.status, "completed");
  },
);

test(
  "all-inactive joins and their descendants are skipped without model calls",
  bounds,
  async () => {
    const result = await braid(
      graph(
        [
          decision(),
          execute("a"),
          execute("b"),
          execute("join"),
          execute("end"),
        ],
        [
          { from: "route", to: "a", choice: "left" },
          { from: "route", to: "b", choice: "left" },
          { from: "a", to: "join" },
          { from: "b", to: "join" },
          { from: "join", to: "end" },
        ],
      ),
      {
        runner: async (request) => {
          assert.equal(request.node.id, "route");
          request.decide!("right");
          return { output: "No work needed" };
        },
      },
    );
    for (const id of ["a", "b", "join", "end"])
      assert.equal(result.nodes[id]!.skipReason, "inactive");
    assert.equal(result.status, "completed");
    assert.deepEqual(Object.keys(result.terminalOutputs), ["route"]);
  },
);

for (const [name, choose, code] of [
  ["missing", (_request: ModelRequest) => {}, "DECISION_REQUIRED"],
  [
    "invalid",
    (request: ModelRequest) => request.decide!("unknown"),
    "INVALID_DECISION",
  ],
  [
    "repeated",
    (request: ModelRequest) => {
      request.decide!("left");
      request.decide!("left");
    },
    "INVALID_DECISION",
  ],
  [
    "caught invalid",
    (request: ModelRequest) => {
      assert.throws(() => request.decide!("unknown"));
      request.decide!("left");
    },
    "INVALID_DECISION",
  ],
] as const) {
  test(
    `${name} decide calls fail the node and pass errors to unconditional descendants`,
    bounds,
    async () => {
      const result = await braid(
        graph([decision(), execute("child")], [{ from: "route", to: "child" }]),
        {
          runner: async (request) => {
            if (request.node.id === "child") {
              assert.equal(request.predecessors[0]!.error!.code, code);
              return { output: "Recovered" };
            }
            assert.equal(request.node.id, "route");
            choose(request);
            return {
              output: "Explanation",
              usage: { inputTokens: 5, outputTokens: 2 },
            };
          },
        },
      );
      assert.equal(result.status, "completed");
      assert.equal(result.nodes.route!.error!.code, code);
      assert.equal(result.nodes.child!.status, "completed");
      assert.deepEqual(result.terminalOutputs, { child: { output: "Recovered" } });
      if (name === "missing" || name === "caught invalid") {
        assert.equal(result.nodes.route!.output, "Explanation");
        assert.deepEqual(result.metadata.usage, {
          inputTokens: 5,
          outputTokens: 2,
        });
      }
    },
  );
}

test(
  "per-node model selection overrides the run default for both node types",
  bounds,
  async () => {
    const models: (string | undefined)[] = [];
    const result = await braid(
      graph(
        [execute("a", "writer"), decision("b", ["go"], "router"), execute("c")],
        [
          { from: "a", to: "b" },
          { from: "b", to: "c", choice: "go" },
        ],
      ),
      {
        defaultModel: "default",
        runner: async (request) => {
          models.push(request.model);
          request.decide?.("go");
          return { output: request.node.id, model: `${request.model}-version` };
        },
      },
    );
    assert.deepEqual(models, ["writer", "router", "default"]);
    assert.equal(result.nodes.a!.model, "writer-version");
    assert.equal(result.nodes.b!.model, "router-version");
    assert.equal(result.terminalOutputs.c!.model, "default-version");
    assert.equal(result.metadata.usageReportedNodes, 0);
  },
);

test(
  "failures pass through dependent joins while independent terminal outputs survive",
  bounds,
  async () => {
    const calls: string[] = [];
    const result = await braid(
      graph(
        [
          execute("bad"),
          execute("dependent"),
          execute("good"),
          execute("join"),
          execute("tail"),
          execute("independent"),
        ],
        [
          { from: "bad", to: "dependent" },
          { from: "dependent", to: "join" },
          { from: "good", to: "join" },
          { from: "join", to: "tail" },
        ],
      ),
      {
        runner: async (request) => {
          calls.push(request.node.id);
          if (request.node.id === "bad")
            throw new Error("provider unavailable");
          if (request.node.id === "dependent")
            assert.equal(request.predecessors[0]!.error!.message, "provider unavailable");
          return { output: request.node.id };
        },
      },
    );
    assert.deepEqual(calls, ["bad", "good", "independent", "dependent", "join", "tail"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.nodes.bad!.error, {
      code: "MODEL_ERROR",
      message: "provider unavailable",
    });
    for (const id of ["dependent", "join", "tail"]) {
      assert.equal(result.nodes[id]!.status, "completed");
    }
    assert.deepEqual(result.terminalOutputs, {
      independent: { output: "independent" },
      tail: { output: "tail" },
    });
  },
);

test(
  "a failed decision does not route, even if it called decide before failing",
  bounds,
  async () => {
    const result = await braid(
      graph(
        [decision(), execute("a"), execute("b")],
        [
          { from: "route", to: "a", choice: "left" },
          { from: "route", to: "b", choice: "right" },
        ],
      ),
      {
        runner: async (request) => {
          assert.equal(request.node.id, "route");
          request.decide!("left");
          throw new Error("failed after tool call");
        },
      },
    );
    assert.equal(result.nodes.route!.decision, "left");
    assert.equal(result.nodes.a!.skipReason, "upstream_failed");
    assert.equal(result.nodes.b!.skipReason, "upstream_failed");
  },
);

test(
  "node contexts, graph snapshots, and sibling data are isolated",
  bounds,
  async () => {
    const rootStarted = deferred();
    const release = deferred();
    const nodes = [execute("root"), execute("a"), execute("b")];
    const edges = [
      { from: "root", to: "a" },
      { from: "root", to: "b" },
    ];
    const input = { goal: "original goal", nodes, edges };
    const run = braid(input, {
      maxConcurrency: 1,
      runner: async (request) => {
        assert.equal(request.goal, "original goal");
        assert.equal(request.node.prompt, `Do ${request.node.id}`);
        if (request.node.id === "root") {
          rootStarted.resolve();
          await release.promise;
        } else {
          assert.deepEqual(predecessorText(request.predecessors), [
            { nodeId: "root", output: "root" },
          ]);
        }
        assert.equal(request.execution.rootRunId, request.execution.runId);
        request.execution.rootRunId = "tampered";
        request.node.prompt = "tampered";
        if (request.predecessors[0])
          request.predecessors[0].output = "tampered";
        return { output: request.node.id };
      },
    });
    await rootStarted.promise;
    input.goal = "changed goal";
    nodes[1]!.prompt = "changed prompt";
    edges.length = 0;
    release.resolve();
    const result = await run;
    assert.equal(result.status, "completed");
    assert.equal(result.nodes.root!.output, "root");
    assert.equal(result.metadata.rootRunId, result.metadata.runId);
  },
);

test(
  "a runner cannot mutate the declared decision choices",
  bounds,
  async () => {
    const input = graph([decision()]);
    const result = await braid(input, {
      runner: async (request) => {
        assert.equal(request.node.type, "decision");
        if (request.node.type === "decision")
          request.node.choices = ["injected"];
        request.decide!("injected");
        return { output: "should fail" };
      },
    });
    assert.equal(result.nodes.route!.error!.code, "INVALID_DECISION");
    const original = input.nodes[0];
    assert.ok(original?.type === "decision");
    assert.deepEqual(original.choices, ["left", "right"]);
  },
);

test(
  "node timeout aborts its signal, passes the failure onward, and ignores a late response",
  bounds,
  async (t) => {
    const clock = mockClock(t);
    const started = deferred();
    const goodCompleted = deferred();
    const late = deferred<ModelResponse>();
    let request!: ModelRequest;
    const run = braid(
      graph(
        [decision(), execute("child"), execute("good")],
        [{ from: "route", to: "child" }],
      ),
      {
        nodeTimeoutMs: 25,
        onEvent: (event) => {
          if (event.type === "node_completed" && event.nodeId === "good")
            goodCompleted.resolve();
        },
        runner: async (invocation) => {
          if (invocation.node.id === "good") return { output: "good" };
          if (invocation.node.id === "child") {
            assert.equal(invocation.predecessors[0]!.error!.code, "NODE_TIMEOUT");
            return { output: "Recovered" };
          }
          request = invocation;
          started.resolve();
          return late.promise; // Deliberately ignores the abort signal.
        },
      },
    );
    await Promise.all([started.promise, goodCompleted.promise]);
    clock.advance(24);
    assert.equal(request.signal.aborted, false);
    clock.advance(1);
    const result = await run;
    assert.equal(result.status, "completed");
    assert.equal(result.nodes.route!.error!.code, "NODE_TIMEOUT");
    assert.equal(request.signal.aborted, true);
    assert.equal(result.nodes.child!.status, "completed");
    assert.deepEqual(result.terminalOutputs, { good: { output: "good" }, child: { output: "Recovered" } });
    const snapshot = structuredClone(result);
    assert.throws(() => request.decide!("left"), /after invocation ended/);
    late.resolve({
      output: "too late",
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    await tick();
    assert.deepEqual(result, snapshot);
  },
);

test(
  "late runner rejections after a timeout are observed",
  bounds,
  async (t) => {
    const clock = mockClock(t);
    const started = deferred();
    const late = deferred<ModelResponse>();
    const run = braid(graph([execute("late")]), {
      runner: () => {
        started.resolve();
        return late.promise;
      },
      nodeTimeoutMs: 10,
    });
    await started.promise;
    clock.advance(10);
    const result = await run;
    assert.equal(result.nodes.late!.error!.code, "NODE_TIMEOUT");
    late.reject(new Error("late failure"));
    await tick(); // node:test would fail on an unhandled rejection.
  },
);

test(
  "graph timeout aborts running calls, skips queued work, and retains earlier terminal outputs",
  bounds,
  async (t) => {
    const clock = mockClock(t);
    const started = deferred();
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const run = braid(
      graph(
        [execute("done"), execute("hang"), execute("queued"), execute("child")],
        [{ from: "hang", to: "child" }],
      ),
      {
        maxConcurrency: 1,
        nodeTimeoutMs: 1_000,
        graphTimeoutMs: 30,
        runner: async (request) => {
          calls.push(request.node.id);
          if (request.node.id === "done") return { output: "saved" };
          signals.push(request.signal);
          started.resolve();
          return new Promise(() => {});
        },
      },
    );
    await started.promise;
    clock.advance(29);
    assert.equal(signals[0]!.aborted, false);
    clock.advance(1);
    const result = await run;
    assert.deepEqual(calls, ["done", "hang"]);
    assert.equal(result.status, "failed");
    assert.equal(result.error!.code, "GRAPH_TIMEOUT");
    assert.equal(result.nodes.hang!.status, "failed");
    assert.equal(result.nodes.hang!.error!.code, "GRAPH_TIMEOUT");
    assert.equal(signals[0]!.aborted, true);
    for (const id of ["queued", "child"])
      assert.equal(result.nodes[id]!.skipReason, "graph_timeout");
    assert.deepEqual(result.terminalOutputs, { done: { output: "saved" } });
  },
);

test(
  "graph timeout cancels every concurrently running invocation",
  bounds,
  async (t) => {
    const clock = mockClock(t);
    const started = deferred();
    const signals: AbortSignal[] = [];
    const run = braid(
      graph([execute("a"), execute("b"), execute("c")]),
      {
        maxConcurrency: 2,
        nodeTimeoutMs: 1_000,
        graphTimeoutMs: 20,
        runner: async (request) => {
          signals.push(request.signal);
          if (signals.length === 2) started.resolve();
          return new Promise(() => {});
        },
      },
    );
    await started.promise;
    clock.advance(19);
    assert.ok(signals.every((signal) => !signal.aborted));
    clock.advance(1);
    const result = await run;
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(result.nodes.a!.error!.code, "GRAPH_TIMEOUT");
    assert.equal(result.nodes.b!.error!.code, "GRAPH_TIMEOUT");
    assert.equal(result.nodes.c!.skipReason, "graph_timeout");
  },
);

test("malformed model responses fail cleanly", bounds, async () => {
  for (const response of [
    null,
    { output: 12 },
    { output: "ok", usage: { inputTokens: -1, outputTokens: 0 } },
  ]) {
    const result = await braid(graph([execute("a")]), {
      runner: async () => response as unknown as ModelResponse,
    });
    assert.equal(result.nodes.a!.error!.code, "INVALID_RESPONSE");
    assert.deepEqual(result.terminalOutputs, {});
  }
});

test(
  "arbitrary string IDs are safe as result keys; concurrent runs have distinct identities",
  bounds,
  async () => {
    const [a, b] = await Promise.all([
      braid(graph([execute("__proto__"), execute("constructor")]), {
        runner: echo,
      }),
      braid(graph([execute("__proto__")]), { runner: echo }),
    ]);
    assert.equal(Object.hasOwn(a.terminalOutputs, "__proto__"), true);
    assert.equal(a.terminalOutputs.__proto__!.output, "__proto__");
    assert.equal(
      Object.values(a.nodes).find((node) => node.id === "constructor")!.status,
      "completed",
    );
    assert.notEqual(a.metadata.runId, b.metadata.runId);
  },
);
