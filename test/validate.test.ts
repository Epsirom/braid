import assert from "node:assert/strict";
import test from "node:test";
import {
  GraphValidationError,
  validateGraph,
  type BraidInput,
  type BraidOptions,
} from "../src/index.js";
import { braid, decision, execute, graph } from "./helpers.js";
import { compileGraph } from "../src/validate.js";

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
  ...[null, false, "", "readonly", "merge", {}].map(value => [
    `invalid workspace ${JSON.stringify(value)}`,
    { goal: "x", nodes: [{ ...execute("a"), workspace: value }], edges: [] },
  ] as [string, unknown]),
  ["workspace on merge node", {
    goal: "x", nodes: [{ type: "merge", id: "merge", workspace: "read-only" }], edges: [],
  }],
  ...["execute", "decision", "merge"].flatMap((type) =>
    [null, "true", 1, {}, []].map((notifyOnCompletion) => [
      `invalid notifyOnCompletion on ${type}: ${JSON.stringify(notifyOnCompletion)}`,
      { goal: "x", nodes: [{ type, id: "a", prompt: "work", notifyOnCompletion,
        ...(type === "decision" ? { choices: ["left"] } : {}) }], edges: [] },
    ] as [string, unknown])),
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

test("completion notification preferences are optional, validated, and preserved for every node type", async () => {
  for (const notifyOnCompletion of [undefined, false, true]) {
    const nodes = [execute("a"), decision(), { type: "merge" as const, id: "merge" }]
      .map((node) => ({ ...node, ...(notifyOnCompletion !== undefined ? { notifyOnCompletion } : {}) }));
    for (const node of compileGraph(graph(nodes)).nodes) {
      assert.equal(node.notifyOnCompletion, notifyOnCompletion);
      assert.equal(Object.hasOwn(node, "notifyOnCompletion"), notifyOnCompletion !== undefined);
    }
    const seen: string[] = [];
    const result = await braid(graph(nodes.filter((node) => node.type !== "merge")), {
      runner: async ({ node, decide }) => {
        assert.equal(node.notifyOnCompletion, notifyOnCompletion);
        assert.equal(Object.hasOwn(node, "notifyOnCompletion"), notifyOnCompletion !== undefined);
        if (decide) decide("left");
        seen.push(node.id);
        return { output: "done" };
      },
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(seen.sort(), ["a", "route"]);
  }
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
