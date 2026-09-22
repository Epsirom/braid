import assert from "node:assert/strict";
import test from "node:test";
import {
  braid,
  GraphValidationError,
  validateGraph,
  type BraidInput,
  type BraidOptions,
} from "../src/index.js";
import { decision, execute, graph } from "./helpers.js";

const invalid: [string, unknown][] = [
  ["null graph", null],
  ["missing goal", { nodes: [execute("a")], edges: [] }],
  ["blank goal", { ...graph([execute("a")]), goal: "  " }],
  ["empty graph", graph([])],
  ["nodes not array", { goal: "x", nodes: {}, edges: [] }],
  ["missing edges", { goal: "x", nodes: [execute("a")] }],
  ["null node", { goal: "x", nodes: [null], edges: [] }],
  [
    "unknown node type",
    {
      goal: "x",
      nodes: [{ type: "parallel", id: "p", prompt: "x" }],
      edges: [],
    },
  ],
  ["blank id", graph([execute(" ")])],
  ["duplicate id", graph([execute("a"), execute("a")])],
  [
    "missing prompt",
    { goal: "x", nodes: [{ type: "execute", id: "a" }], edges: [] },
  ],
  ["blank model", graph([{ ...execute("a"), model: " " }])],
  ["empty choices", graph([decision("a", [])])],
  ["duplicate choices", graph([decision("a", ["same", "same"])])],
  ["blank choice", graph([decision("a", [""])])],
  [
    "non-string choice",
    { goal: "x", nodes: [{ ...decision(), choices: [1] }], edges: [] },
  ],
  ["missing source", graph([execute("a")], [{ from: "missing", to: "a" }])],
  ["missing target", graph([execute("a")], [{ from: "a", to: "missing" }])],
  ["null edge", { ...graph([execute("a")]), edges: [null] }],
  [
    "non-string edge choice",
    {
      ...graph([decision(), execute("b")]),
      edges: [{ from: "route", to: "b", choice: 1 }],
    },
  ],
  [
    "choice on execute edge",
    graph(
      [execute("a"), execute("b")],
      [{ from: "a", to: "b", choice: "left" }],
    ),
  ],
  [
    "undeclared choice",
    graph(
      [decision(), execute("b")],
      [{ from: "route", to: "b", choice: "unknown" }],
    ),
  ],
  [
    "duplicate edge",
    graph(
      [execute("a"), execute("b")],
      [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    ),
  ],
  ["self cycle", graph([execute("a")], [{ from: "a", to: "a" }])],
  [
    "cycle with independent root",
    graph(
      [execute("root"), execute("a"), execute("b")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    ),
  ],
  [
    "conditional cycle",
    graph(
      [decision(), execute("a")],
      [
        { from: "route", to: "a", choice: "left" },
        { from: "a", to: "route" },
      ],
    ),
  ],
  ["unsupported graph field", { ...graph([execute("a")]), templates: [] }],
  [
    "unsupported node field",
    {
      goal: "x",
      nodes: [{ ...execute("a"), code: "doSomething()" }],
      edges: [],
    },
  ],
  [
    "unsupported edge field",
    {
      ...graph([execute("a"), execute("b")]),
      edges: [{ from: "a", to: "b", condition: "x" }],
    },
  ],
];

for (const [name, input] of invalid) {
  test(`rejects ${name} before invoking any model`, async () => {
    let calls = 0;
    assert.throws(
      () => validateGraph(input as BraidInput),
      GraphValidationError,
    );
    await assert.rejects(
      braid(input as BraidInput, {
        runner: async () => {
          calls++;
          return { output: "must not run" };
        },
      }),
      GraphValidationError,
    );
    assert.equal(calls, 0);
  });
}

test("validation allows terminal decisions, unconnected roots, conditional fan-out, and distinct edges to one target", () => {
  assert.doesNotThrow(() => validateGraph(graph([decision()])));
  assert.doesNotThrow(() => validateGraph(graph([execute("a"), execute("b")])));
  assert.doesNotThrow(() =>
    validateGraph(
      graph(
        [decision(), execute("a"), execute("b")],
        [
          { from: "route", to: "a", choice: "left" },
          { from: "route", to: "a", choice: "right" },
          { from: "route", to: "b", choice: "left" },
        ],
      ),
    ),
  );
});

test("validation is iterative for deep DAGs", () => {
  const nodes = Array.from({ length: 10_000 }, (_, i) => execute(String(i)));
  const edges = nodes
    .slice(1)
    .map((node, i) => ({ from: String(i), to: node.id }));
  assert.doesNotThrow(() => validateGraph(graph(nodes, edges)));
});

test("invalid runtime options are rejected before model execution", async () => {
  let calls = 0;
  const runner = async () => {
    calls++;
    return { output: "not called" };
  };
  for (const options of [
    { maxConcurrency: 0 },
    { maxConcurrency: -1 },
    { maxConcurrency: 1.5 },
    { maxConcurrency: Infinity },
    { maxConcurrency: null },
    { maxConcurrency: "2" },
    { defaultModel: "" },
    { nodeTimeoutMs: 0 },
    { graphTimeoutMs: -1 },
    { nodeTimeoutMs: NaN },
    { nodeTimeoutMs: -Infinity },
    { graphTimeoutMs: null },
    { graphTimeoutMs: 2_147_483_648 },
    { graphTimeoutMs: "20" },
  ]) {
    await assert.rejects(
      braid(graph([execute("a")]), { runner, ...options } as BraidOptions),
      TypeError,
    );
  }
  await assert.rejects(
    braid(graph([execute("a")]), {} as BraidOptions),
    TypeError,
  );
  assert.equal(calls, 0);
});
