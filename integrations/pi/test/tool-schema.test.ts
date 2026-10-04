import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { KIMI_CODING_MODELS } from "@earendil-works/pi-ai/providers/kimi-coding.models";
import { GraphValidationError, validateGraph, type BraidInput } from "@chrok/braid";
import { createBraidTools } from "../index.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const tools = createBraidTools(new BraidJobs());

function validate(tool: Tool, args: Record<string, unknown>) {
  // Exercise Pi's validator with the JSON schema a provider actually receives.
  const definition: Tool = JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  return validateToolArguments(definition, { type: "toolCall", id: "schema", name: tool.name, arguments: JSON.parse(JSON.stringify(args)) });
}

for (const templated of [false, true]) {
  test(`Pi schema and core accept all node types with ${templated ? "templated" : "plain"} prompts`, () => {
    const prompt = templated ? { template: "task", variables: { target: "runtime" } } : "Inspect the runtime";
    const graph = {
      goal: "Review and integrate",
      nodes: [
        { type: "execute", id: "work", prompt, model: "provider/model-id", workspace: "worktree", pauseAfter: true, notifyOnCompletion: true, requireSuccess: false },
        { type: "decision", id: "check", prompt, choices: ["retry", "done"], workspace: "read-only" },
        { type: "merge", id: "merge", prompt, requireSuccess: true },
        { type: "integrate", id: "integrate", prompt },
        { type: "merge", id: "defaultMerge" },
        { type: "integrate", id: "defaultIntegrate" },
      ],
      edges: [
        { from: "work", to: "check" },
        { from: "check", to: "work", choice: "retry", feedback: "retryLoop" },
        { from: "check", to: "merge", choice: "done" },
        { from: "merge", to: "integrate" },
      ],
      loops: [{ id: "retryLoop", entry: "work", maxIterations: 3 }],
      ...(templated ? { promptTemplates: { task: "Inspect {{target}}" } } : {}),
    };
    assert.deepEqual(validate(tools.braidTool, graph), graph);
    assert.deepEqual(validateToolArguments(tools.braidTool, { type: "toolCall", id: "raw", name: "braid", arguments: graph }), graph);
    assert.doesNotThrow(() => validateGraph(graph as BraidInput));
    assert.doesNotThrow(() => validate(tools.updateTool, { jobId: "job-1", expectedRevision: 0, upsertNodes: graph.nodes }));
  });
}

const invalidNodes = [
  { type: "execute", id: "a" },
  { type: "decision", id: "a", choices: ["done"] },
  { type: "decision", id: "a", prompt: "Choose" },
  { type: "decision", id: "a", prompt: "Choose", choices: [] },
  { type: "decision", id: "a", prompt: "Choose", choices: ["done", "done"] },
  { type: "execute", id: "a", prompt: "Work", choices: ["done"] },
  { type: "merge", id: "a", workspace: "worktree" },
  { type: "integrate", id: "a", workspace: "read-only" },
  { type: "merge", id: "a", choices: ["done"] },
  { type: "integrate", id: "a", choices: ["done"] },
  { type: "execute", id: " ", prompt: "Work" },
  { type: "execute", id: "a", prompt: " \n " },
  { type: "execute", id: "a", prompt: { template: "task" } },
];

test("Pi schema plus core reject invalid submissions and updates before any mutation", async t => {
  const worker = deferred<ReturnType<typeof response>>();
  const ctx = context(() => worker.promise);
  const jobs = new BraidJobs();
  t.after(() => { jobs.dispose(); worker.resolve(response()); });
  const tools = createBraidTools(jobs);
  const original = jobs.start(input, {}, ctx);
  for (const node of invalidNodes) {
    const graph = { ...input, nodes: [node] };
    assert.throws(() => validateGraph(graph as BraidInput), GraphValidationError, JSON.stringify(node));
    await assert.rejects(async () => {
      const args = validate(tools.braidTool, graph);
      await tools.braidTool.execute("invalid", args as never, undefined, undefined, ctx);
    }, /Validation failed|Braid submission failed/, JSON.stringify(node));
    await assert.rejects(async () => {
      const args = validate(tools.updateTool, { jobId: original.handle, expectedRevision: 0, upsertNodes: [node] });
      await tools.updateTool.execute("invalid", args as never, undefined, undefined, ctx);
    }, /Validation failed|Braid update rejected; no changes or resumes were applied/, JSON.stringify(node));
    assert.equal(jobs.list().length, 1);
    assert.equal(jobs.get(original.handle)!.execution!.revision, 0);
    assert.deepEqual(jobs.get(original.handle)!.execution!.graph, input);
  }
});

test("Pi normalizes unused optional null fields without dropping node policies", () => {
  const node = { id: "probe", type: "execute", prompt: "hi", model: "openai/does-not-exist", requireSuccess: false, pauseAfter: true };
  const graph = { ...input, nodes: [{ ...node, workspace: null, choices: null, notifyOnCompletion: null }] };
  assert.deepEqual(validate(tools.braidTool, graph), { ...input, nodes: [node] });
});

test("actual Kimi/Anthropic request exposes flat nodes for both submission and updates", async () => {
  type NodeSchema = { type: string; anyOf?: unknown; properties: Record<string, unknown> };
  let payload: { tools: { name: string; input_schema: { properties: Record<string, { items: NodeSchema }> } }[] } | undefined;
  const result = await streamSimple(KIMI_CODING_MODELS.k3, normalizeContext({
    messages: [{ role: "user", content: "Define an execute probe with a model override followed by a paused summary.", timestamp: 0 }],
    tools: [tools.braidTool, tools.updateTool],
  }), { apiKey: "offline-schema-test", onPayload(value) {
    payload = value as typeof payload;
    // Inspect the real provider serialization without making a network request.
    throw new Error("schema captured before network");
  } }).result();
  assert.match(result.errorMessage ?? "", /schema captured before network/);
  assert.ok(payload);
  for (const [name, field] of [["braid", "nodes"], ["braid_update", "upsertNodes"]]) {
    const schema: NodeSchema = payload.tools.find(tool => tool.name === name)!.input_schema.properties[field!]!.items;
    assert.equal(schema.type, "object");
    assert.equal(schema.anyOf, undefined);
    for (const key of ["type", "id", "prompt", "model", "workspace", "choices", "pauseAfter", "notifyOnCompletion", "requireSuccess"]) {
      assert.ok(Object.hasOwn(schema.properties, key), `${name}: missing ${key}`);
    }
  }
});

test("historical edge pins are available only in graph updates", () => {
  const edge = { from: "a", to: "b", executionId: "historical-execution" };
  assert.throws(() => validate(tools.braidTool, { ...input, edges: [edge] }), /Validation failed/);
  const patch = { jobId: "job-1", expectedRevision: 0, addEdges: [edge], removeEdges: [edge], resume: ["paused-execution"] };
  assert.deepEqual(validate(tools.updateTool, patch), patch);
});

test("loop feedback is a loop ID and rounds are positive safe integers", () => {
  for (const maxIterations of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validate(tools.braidTool, { ...input, loops: [{ id: "retry", entry: "a", maxIterations }] }), /Validation failed/);
  }
  // Pi coerces primitive values (e.g. true to "true"); core still checks loop references.
  for (const feedback of [{}, " "]) {
    assert.throws(() => validate(tools.braidTool, { ...input, edges: [{ from: "a", to: "a", feedback }] }), /Validation failed/);
  }
});

test("status, cancellation, and resume schemas accept their documented ID forms", () => {
  for (const args of [{}, { jobId: "job-1" }, { jobId: "job-1", nodeId: "a" }, { jobId: "job-1", executionId: "execution-1" }]) {
    assert.deepEqual(validate(tools.statusTool, args), args);
  }
  assert.deepEqual(validate(tools.cancelTool, { jobId: "job-1" }), { jobId: "job-1" });
  const resume = { jobId: "job-1", expectedRevision: 0, executionIds: ["execution-1"] };
  assert.deepEqual(validate(tools.resumeTool, resume), resume);
  for (const executionIds of [[], ["execution-1", "execution-1"], [" "]]) {
    assert.throws(() => validate(tools.resumeTool, { ...resume, executionIds }), /Validation failed/);
  }
});
