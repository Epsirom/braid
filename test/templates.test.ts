import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, validateGraph, type BraidInput, type ModelRequest } from "../src/index.js";
import { braid, deferred } from "./helpers.js";

function input(prompt: unknown = { template: "inspect", variables: { target: "runtime" } }, promptTemplates: unknown = { inspect: "Inspect {{target}}." }): BraidInput {
  return {
    goal: "Review the repository",
    promptTemplates,
    nodes: [{ type: "execute", id: "review", prompt }],
    edges: [],
  } as BraidInput;
}

test("templates render for execute, decision, and merge nodes while plain and omitted prompts keep their behavior", async () => {
  const requests: ModelRequest[] = [];
  const graph: BraidInput = {
    goal: "Review",
    promptTemplates: { task: "Inspect {{ target }}; then report on {{target}}. {{suffix}}" },
    nodes: [
      { type: "execute", id: "a", workspace: "read-only", model: "reviewer", prompt: { template: "task", variables: { target: "runtime", suffix: "" } } },
      { type: "decision", id: "route", choices: ["accept"], prompt: { template: "task", variables: { target: "validation", suffix: "Choose accept." } } },
      { type: "merge", id: "merge", prompt: { template: "task", variables: { target: "changes", suffix: "Integrate." } } },
      { type: "execute", id: "plain", prompt: "Leave {{target}} unchanged in plain prompts." },
      { type: "merge", id: "default" },
    ],
    edges: [{ from: "a", to: "route" }, { from: "route", to: "merge", choice: "accept" }],
  };
  const original = structuredClone(graph);
  const result = await braid(graph, {
    runner: async request => {
      requests.push(request);
      request.decide?.("accept");
      if (request.merge) await request.merge.finish([]);
      return { output: request.node.prompt!, usage: { inputTokens: 2, outputTokens: 1 } };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.a!.output, "Inspect runtime; then report on runtime. ");
  assert.equal(result.nodes.route!.output, "Inspect validation; then report on validation. Choose accept.");
  assert.equal(result.nodes.merge!.output, "Inspect changes; then report on changes. Integrate.");
  assert.equal(result.nodes.plain!.output, "Leave {{target}} unchanged in plain prompts.");
  assert.match(result.nodes.default!.output!, /finish_merge/);
  const first = requests.find(request => request.node.id === "a")!;
  assert.equal(first.model, "reviewer");
  assert.ok(first.node.type === "execute");
  assert.equal(first.node.workspace, "read-only");
  assert.equal(requests.find(request => request.node.id === "route")!.predecessors[0]!.output, result.nodes.a!.output);
  assert.deepEqual(result.metadata.usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(graph, original);
});

test("variable values are inserted literally once, including braces and replacement metacharacters", async () => {
  const value = "$& $$ $` $' {{missing}} ${process.env.SECRET}\n中文";
  const result = await braid(input({ template: "inspect", variables: { target: value } }), {
    runner: async request => ({ output: request.node.prompt! }),
  });
  assert.equal(result.terminalOutputs.review!.output, `Inspect ${value}.`);
});

test("template and variable names do not read or modify object prototypes", async () => {
  const graph = input(
    JSON.parse('{"template":"__proto__","variables":{"__proto__":"literal","constructor":"value"}}'),
    JSON.parse('{"__proto__":"{{__proto__}} {{constructor}}"}'),
  );
  const result = await braid(graph, { runner: async request => ({ output: request.node.prompt! }) });
  assert.equal(result.terminalOutputs.review!.output, "literal value");
});

test("rendering snapshots caller data before asynchronous execution and isolates worker prompts", async () => {
  const started = deferred();
  const release = deferred();
  const variables = { target: "original" };
  const templates = { inspect: "Inspect {{target}}." };
  const graph = input({ template: "inspect", variables }, templates);
  graph.nodes = [graph.nodes[0]!, { type: "execute", id: "later", prompt: { template: "inspect", variables } }];
  const pending = braid(graph, {
    maxConcurrency: 1,
    runner: async request => {
      const prompt = request.node.prompt!;
      if (request.node.id === "review") {
        started.resolve();
        await release.promise;
        request.node.prompt = "worker mutation";
      }
      return { output: prompt };
    },
  });
  await started.promise;
  variables.target = "caller mutation";
  templates.inspect = "changed";
  release.resolve();
  const result = await pending;
  assert.equal(result.nodes.review!.output, "Inspect original.");
  assert.equal(result.nodes.later!.output, "Inspect original.");
});

test("constant templates accept an empty variables object", async () => {
  const result = await braid(input({ template: "inspect", variables: {} }, { inspect: "A constant prompt" }), {
    runner: async request => ({ output: request.node.prompt! }),
  });
  assert.equal(result.terminalOutputs.review!.output, "A constant prompt");
});

const invalid: [string, BraidInput, RegExp][] = [
  ...[null, [], "text"].map(value => ["invalid template dictionary", input(undefined, value), /promptTemplates must be an object/] as [string, BraidInput, RegExp]),
  ...[null, 1, {}, "", "  "].map(value => ["invalid template body", input(undefined, { inspect: value }), /template 'inspect'.*non-empty string/] as [string, BraidInput, RegExp]),
  ["blank template name", input(undefined, { " ": "text" }), /template name/],
  ...["{{target", "target}}", "{{}}", "{{a.b}}", "{{a + b}}", "{{0name}}", "{{{{target}}"].map(source => ["invalid template syntax", input(undefined, { inspect: source }), /template 'inspect'.*(unclosed|unmatched|invalid variable)/] as [string, BraidInput, RegExp]),
  ["unused invalid template", input(undefined, { inspect: "Inspect {{target}}.", unused: "{{bad" }), /template 'unused'.*unclosed/],
  ["unknown template", input({ template: "missing", variables: {} }), /Node 'review'.*template 'missing'.*unknown/],
  ["inherited template", input({ template: "constructor", variables: {} }), /template 'constructor'.*unknown/],
  ["absent template dictionary", { ...input(), promptTemplates: undefined } as unknown as BraidInput, /template 'inspect'.*unknown/],
  ["invalid template reference", input({ template: 2, variables: {} }), /Node 'review'.*template reference/],
  ["extra prompt field", input({ template: "inspect", variables: { target: "x" }, code: "x" }), /Node 'review'.*unsupported field 'code'/],
  ...[undefined, null, [], "text"].map(variables => ["invalid variables", input({ template: "inspect", variables }), /Node 'review'.*template 'inspect'.*variables must be an object/] as [string, BraidInput, RegExp]),
  ...[null, 3, true, {}].map(target => ["non-string variable", input({ template: "inspect", variables: { target } }), /Node 'review'.*template 'inspect'.*variable 'target'.*string/] as [string, BraidInput, RegExp]),
  ["missing variable", input({ template: "inspect", variables: {} }), /Node 'review'.*template 'inspect'.*missing variable 'target'/],
  ["inherited variable", input({ template: "inspect", variables: Object.create({ target: "inherited" }) }), /missing variable 'target'/],
  ["unused variable", input({ template: "inspect", variables: { target: "x", typo: "y" } }), /Node 'review'.*template 'inspect'.*unused variable 'typo'/],
  ["empty rendered prompt", input({ template: "inspect", variables: { target: "  " } }, { inspect: "{{target}}" }), /Node 'review'.*template 'inspect'.*empty prompt/],
];

for (const [name, graph, error] of invalid) {
  test(`rejects ${name} before any model call`, async () => {
    let calls = 0;
    // A valid independent root must not start before the invalid node is checked.
    const withRoot = { ...graph, nodes: [{ type: "execute" as const, id: "root", prompt: "Run" }, ...graph.nodes] };
    assert.throws(() => validateGraph(withRoot), error);
    await assert.rejects(braid(withRoot, {
      runner: async () => { calls++; return { output: "unexpected" }; },
    }), failure => failure instanceof GraphValidationError && error.test(failure.message));
    assert.equal(calls, 0);
  });
}
