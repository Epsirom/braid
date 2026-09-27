import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiRunner, sumPiUsage } from "../runner.js";
import type { ModelRequest } from "@chrok/braid";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAvailableReadTools } from "../read-tools.js";
import { readOnlyCwd } from "./helpers.js";

const readToolNames = (await createAvailableReadTools(readOnlyCwd)).tools.map(tool => tool.name);

const model = {
  provider: "fake",
  id: "model",
  api: "fake",
} as unknown as Model<"fake">;
const usage = (
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
});
const message = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "fake",
  provider: "fake",
  model: "model",
  usage: usage(1, 2),
  stopReason,
  timestamp: Date.now(),
});

function fakeRegistry(responses: AssistantMessage[]) {
  const contexts: unknown[] = [];
  const options: unknown[] = [];
  const registry = {
    find(provider: string, id: string) {
      assert.equal(provider, "fake");
      assert.equal(id, "model");
      return model;
    },
    async complete(_model: unknown, context: unknown, requestOptions: unknown) {
      contexts.push(structuredClone(context));
      options.push(structuredClone(requestOptions));
      const response = responses.shift();
      if (!response) throw new Error("unexpected completion");
      return response;
    },
  } as unknown as Pick<ModelRegistry, "find" | "complete">;
  return { registry, contexts, options };
}

function request(node: ModelRequest["node"]): ModelRequest {
  return {
    goal: "goal",
    node,
    model: "fake/model",
    predecessors: [],
    execution: { runId: "run", rootRunId: "run" },
    signal: new AbortController().signal,
  };
}

function reads(count: number): AssistantMessage {
  return message(Array.from({ length: count }, (_, i) => ({
    type: "toolCall" as const,
    id: `read-${i}`,
    name: "read",
    arguments: { path: new URL("../../../package.json", import.meta.url).pathname, limit: 1 },
  })), "toolUse");
}

for (const options of [{}, { maxToolRounds: Infinity, maxToolCalls: Infinity }]) {
  test(`tool budgets are unlimited with ${JSON.stringify(Object.keys(options))}`, async () => {
    const fake = fakeRegistry([
      ...Array.from({ length: 13 }, () => reads(3)),
      message([{ type: "text", text: "Finished after 39 calls" }]),
    ]);
    const output = await createPiRunner(fake.registry, { ...options, cwd: readOnlyCwd })(
      request({ type: "execute", id: "work", prompt: "Work" }),
    );
    assert.equal(output.output, "Finished after 39 calls");
    assert.equal(fake.contexts.length, 14);
    for (const context of fake.contexts as Context[]) {
      assert.doesNotMatch(context.systemPrompt!, /system-reminder/);
    }
  });
}

test("finite tool budgets refresh the system reminder and allow a final answer at the cap", async () => {
  const fake = fakeRegistry([reads(2), message([{ type: "text", text: "Done" }])]);
  const output = await createPiRunner(fake.registry, { cwd: readOnlyCwd, maxToolRounds: 1, maxToolCalls: 2 })(
    request({ type: "execute", id: "work", prompt: "Work" }),
  );
  assert.equal(output.output, "Done");
  const [first, last] = fake.contexts as Context[];
  assert.match(first!.systemPrompt!, /Tool round budget: 0\/1 used; 1 remaining/);
  assert.match(first!.systemPrompt!, /Tool call budget: 0\/2 used; 2 remaining/);
  assert.match(last!.systemPrompt!, /Tool round budget: 1\/1 used; 0 remaining/);
  assert.match(last!.systemPrompt!, /Tool call budget: 2\/2 used; 0 remaining/);
  assert.match(last!.systemPrompt!, /make no further tool calls/);
  assert.equal(last!.systemPrompt!.match(/<system-reminder>/g)?.length, 1);
});

for (const scenario of [
  { options: { maxToolRounds: 1 }, responses: [reads(1), reads(1)], completions: 2 },
  { options: { maxToolCalls: 1 }, responses: [reads(2)], completions: 1 },
]) {
  test(`finite tool budget is enforced: ${JSON.stringify(scenario.options)}`, async () => {
    const fake = fakeRegistry(scenario.responses);
    await assert.rejects(createPiRunner(fake.registry, { ...scenario.options, cwd: readOnlyCwd })(
      request({ type: "execute", id: "work", prompt: "Work" }),
    ), /exceeded its tool budget/);
    assert.equal(fake.contexts.length, scenario.completions);
  });
}

test("invalid finite tool budgets are rejected", () => {
  const fake = fakeRegistry([]);
  for (const key of ["maxToolRounds", "maxToolCalls"]) {
    for (const value of [0, -1, 1.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => createPiRunner(fake.registry, { [key]: value }), TypeError);
    }
  }
});

test("decision calls count toward finite budgets and can finish at the cap", async () => {
  const fake = fakeRegistry([
    message([{ type: "toolCall", id: "decision", name: "decide", arguments: { choice: "go" } }], "toolUse"),
    message([{ type: "text", text: "Go" }]),
  ]);
  const choices: string[] = [];
  const output = await createPiRunner(fake.registry, { cwd: readOnlyCwd, maxToolRounds: 1, maxToolCalls: 1 })({
    ...request({ type: "decision", id: "route", prompt: "Choose", choices: ["go"] }),
    decide: choice => { choices.push(choice); },
  });
  assert.equal(output.output, "Go");
  assert.deepEqual(choices, ["go"]);
  assert.match((fake.contexts[1] as Context).systemPrompt!, /Tool call budget: 1\/1 used; 0 remaining/);
});

test("time reminders refresh before each model call", async (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const fake = fakeRegistry([reads(1), message([{ type: "text", text: "Done" }])]);
  const original = fake.registry.complete;
  t.mock.method(fake.registry, "complete", async (...args: Parameters<typeof original>) => {
    const response = await original(...args);
    now += 100;
    return response;
  });
  await createPiRunner(fake.registry, { cwd: readOnlyCwd })({
    ...request({ type: "execute", id: "work", prompt: "Work" }),
    deadlines: { node: 1_000, graph: 2_000 },
  });
  const [first, last] = fake.contexts as Context[];
  assert.match(first!.systemPrompt!, /Node time budget: 900 ms remaining/);
  assert.match(first!.systemPrompt!, /Graph time budget: 1900 ms remaining/);
  assert.match(last!.systemPrompt!, /Node time budget: 800 ms remaining/);
  assert.match(last!.systemPrompt!, /Graph time budget: 1800 ms remaining/);
  assert.doesNotMatch(last!.systemPrompt!, /Tool call budget/);
});

test("Pi runner uses exact model lookup, fresh context, decide, and one bounded tool continuation", async () => {
  const responses = [
    message(
      [
        { type: "text", text: "I choose go." },
        {
          type: "toolCall",
          id: "call-1",
          name: "decide",
          arguments: { choice: "go" },
        },
      ],
      "toolUse",
    ),
    message([{ type: "text", text: "Proceeding." }]),
  ];
  const fake = fakeRegistry(responses);
  const reports: Usage[] = [];
  const progress: {
    contextTokens: number;
    contextSource: string;
    toolCalls: number;
    toolRounds: number;
    phase: string;
  }[] = [];
  const runner = createPiRunner(fake.registry, {
    cwd: readOnlyCwd,
    onUsage: (report) => reports.push(report),
    onProgress: (update) => progress.push(update),
  });
  const invocation = request({
    type: "decision",
    id: "route",
    prompt: "Choose",
    choices: ["go", "stop"],
  });
  let choice: string | undefined;
  invocation.decide = (selected) => {
    choice = selected;
  };
  // The adapter calls its own callback, so the request callback is replaced only to type the fixture.
  const output = await runner({
    ...invocation,
    decide: (selected) => {
      choice = selected;
    },
  });
  assert.equal(choice, "go");
  assert.equal(output.output, "I choose go.\n\nProceeding.");
  assert.equal(output.model, "fake/model");
  assert.deepEqual(output.usage, { inputTokens: 2, outputTokens: 4 });
  assert.equal(fake.contexts.length, 2);
  const first = fake.contexts[0] as { tools: unknown[]; messages: unknown[] };
  const second = fake.contexts[1] as { tools: unknown[]; messages: unknown[] };
  assert.equal(first.tools.length, readToolNames.length + 1);
  assert.equal((first.tools as { name: string }[]).at(-1)?.name, "decide");
  assert.equal(second.tools.length, readToolNames.length);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 3);
  assert.deepEqual(
    fake.options.map(
      (item) => (item as { cacheRetention: string }).cacheRetention,
    ),
    ["none", "none"],
  );
  assert.equal(reports.length, 2);
  assert.ok(progress.every((update) => update.contextTokens > 0));
  assert.ok(
    progress.every(
      (update) =>
        update.contextSource === "estimate" ||
        update.contextSource === "reported",
    ),
  );
  assert.ok(
    progress.some(
      (update) => update.phase === "tool" && update.toolCalls === 1,
    ),
  );
  assert.ok(
    progress.some(
      (update) => update.phase === "model" && update.toolRounds === 1,
    ),
  );
});

test("Pi runner gives execute nodes read-only filesystem tools and refuses non-provider model names", async () => {
  const fake = fakeRegistry([message([{ type: "text", text: "done" }])]);
  const runner = createPiRunner(fake.registry, { cwd: readOnlyCwd });
  const output = await runner(
    request({ type: "execute", id: "work", prompt: "Work" }),
  );
  assert.equal(output.output, "done");
  assert.deepEqual(
    (fake.contexts[0] as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
    readToolNames,
  );
  await assert.rejects(
    runner({
      ...request({ type: "execute", id: "work", prompt: "Work" }),
      model: "model",
    }),
    /provider\/modelId/,
  );
});

test("Pi runner executes read-only node tools and returns their results to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "braid-pi-runner-"));
  const file = join(directory, "notes.txt");
  await writeFile(file, "read-only content", "utf8");
  const fake = fakeRegistry([
    message(
      [
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: file },
        },
      ],
      "toolUse",
    ),
    message([{ type: "text", text: "I inspected the file." }]),
  ]);
  const runner = createPiRunner(fake.registry, undefined, directory);
  const output = await runner(
    request({ type: "execute", id: "inspect", prompt: "Inspect notes.txt" }),
  );
  assert.equal(output.output, "I inspected the file.");
  const followUp = fake.contexts[1] as {
    messages: {
      role: string;
      toolName?: string;
      content?: { text?: string }[];
    }[];
    tools: { name: string }[];
  };
  assert.equal(followUp.messages.at(-1)?.role, "toolResult");
  assert.equal(followUp.messages.at(-1)?.toolName, "read");
  assert.match(
    followUp.messages.at(-1)?.content?.[0]?.text ?? "",
    /read-only content/,
  );
  assert.deepEqual(
    followUp.tools.map((tool) => tool.name),
    readToolNames,
  );
});

test("Pi runner keeps write and shell tools unavailable", async () => {
  const fake = fakeRegistry([
    message(
      [
        {
          type: "toolCall",
          id: "write-1",
          name: "write",
          arguments: { path: "notes.txt", content: "bad" },
        },
      ],
      "toolUse",
    ),
    message([
      { type: "text", text: "I cannot write files from a Braid node." },
    ]),
  ]);
  const runner = createPiRunner(fake.registry, undefined, readOnlyCwd);
  const output = await runner(
    request({ type: "execute", id: "safe", prompt: "Do not edit anything." }),
  );
  assert.match(output.output, /cannot write files/);
  const toolResult = (
    fake.contexts[1] as {
      messages: {
        role: string;
        toolName?: string;
        isError?: boolean;
        content?: { text?: string }[];
      }[];
    }
  ).messages.at(-1)!;
  assert.equal(toolResult.toolName, "write");
  assert.equal(toolResult.isError, true);
  assert.match(toolResult.content?.[0]?.text ?? "", /unavailable/);
  assert.deepEqual(
    (fake.contexts[0] as { tools: { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
    readToolNames,
  );
});

test("Pi usage aggregation preserves cache and cost fields", () => {
  const first = usage(10, 20, 3, 4);
  const second = usage(1, 2);
  second.reasoning = 1;
  assert.deepEqual(sumPiUsage([first, second]), {
    input: 11,
    output: 22,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 40,
    reasoning: 1,
    cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
  });
});
