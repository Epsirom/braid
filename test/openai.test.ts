import { predecessorText } from "./helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { type BraidInput } from "../src/index.js";
import { createOpenAICompatibleRunner } from "../src/adapters/openai.js";
import { braid, decision, deferred, execute, graph } from "./helpers.js";
import { mockClock } from "./clock.js";

type WireMessage = {
  role: string;
  content: string | null;
  tool_call_id?: string;
};
type WireRequest = {
  model: string;
  messages: WireMessage[];
  tools?: {
    function: {
      name: string;
      parameters: {
        properties: { choice: { enum: string[] } };
        additionalProperties: boolean;
      };
    };
  }[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
};

function decode<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error("Invalid JSON in test fixture/request", { cause });
  }
}

function toolCall(args = '{"choice":"left"}', name = "decide") {
  return {
    id: "call-1",
    type: "function",
    function: { name, arguments: args },
  };
}

function completion(
  content: string | null,
  calls?: ReturnType<typeof toolCall>[],
  model = "actual-model",
) {
  return {
    model,
    choices: [
      {
        finish_reason: calls ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content,
          ...(calls ? { tool_calls: calls } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

function queuedFetch(responses: unknown[]) {
  const calls: WireRequest[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    assert.ok(typeof init?.body === "string");
    calls.push(decode<WireRequest>(init.body));
    assert.ok(responses.length > 0, "unexpected extra API call");
    const next = responses.shift();
    return next instanceof Response ? next : Response.json(next);
  };
  return { fetch, calls };
}

test("OpenAI base URLs preserve internal slashes and remove only trailing slashes", async () => {
  const longPath = `https://example.invalid/${"/".repeat(100_000)}v1`;
  for (const [baseURL, expected] of [
    [undefined, "https://api.openai.com/v1"],
    ["https://example.invalid/v1///", "https://example.invalid/v1"],
    [longPath, longPath],
    [`${longPath}///`, longPath],
    ["///", ""],
  ] as const) {
    let calls = 0;
    const runner = createOpenAICompatibleRunner({
      ...(baseURL === undefined ? {} : { baseURL }),
      defaultModel: "fake",
      fetch: async (url) => {
        calls++;
        assert.equal(url, `${expected}/chat/completions`);
        return Response.json(completion("PASS"));
      },
    });
    const result = await braid(graph([execute("a")]), { runner });
    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
  }
});

test("OpenAI time reminders refresh on the decision continuation", async (t) => {
  const clock = mockClock(t);
  const fake = queuedFetch([completion(null, [toolCall()]), completion("Done")]);
  const runner = createOpenAICompatibleRunner({
    defaultModel: "fake",
    fetch: async (...args) => {
      const response = await fake.fetch(...args);
      clock.advance(50);
      return response;
    },
  });
  const result = await braid(graph([decision("route", ["left", "right"])]), {
    runner, nodeTimeoutMs: 200, graphTimeoutMs: 300,
  });
  assert.equal(result.status, "completed");
  assert.match(fake.calls[0]!.messages[0]!.content!, /Node time budget: 200 ms remaining/);
  assert.match(fake.calls[1]!.messages[0]!.content!, /Node time budget: 150 ms remaining/);
  assert.match(fake.calls[1]!.messages[0]!.content!, /Graph time budget: 250 ms remaining/);
});

test("OpenAI-compatible adapter runs decision -> parallel branches -> join end to end", async () => {
  const calls: WireRequest[] = [];
  const input: BraidInput = graph(
    [
      decision("route", ["left", "right"], "router"),
      execute("a", "writer"),
      execute("b"),
      execute("unused"),
      execute("join"),
    ],
    [
      { from: "route", to: "a", choice: "left" },
      { from: "route", to: "b", choice: "left" },
      { from: "route", to: "unused", choice: "right" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
    ],
  );
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://example.invalid/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer test-key",
    );
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(typeof init.body === "string");
    const body = decode<WireRequest>(init.body);
    calls.push(body);
    const payload = decode<{
      nodeId: string;
      goal: string;
      prompt: string;
      predecessors: unknown[];
    }>(body.messages[1]!.content!);
    assert.equal(payload.goal, input.goal);
    assert.ok(payload.prompt.length > 0);
    if (payload.nodeId === "route" && body.messages.length === 2) {
      assert.equal(body.model, "router");
      assert.deepEqual(predecessorText(payload.predecessors as import("../src/types.js").PredecessorOutput[]), []);
      assert.deepEqual(body.tool_choice, {
        type: "function",
        function: { name: "decide" },
      });
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.tools!.length, 1);
      const tool = body.tools![0]!.function;
      assert.equal(tool.name, "decide");
      assert.deepEqual(tool.parameters.properties.choice.enum, [
        "left",
        "right",
      ]);
      assert.equal(tool.parameters.additionalProperties, false);
      return Response.json(
        completion("I will use two perspectives.", [toolCall()], "router-v1"),
      );
    }
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    if (payload.nodeId === "route") {
      assert.deepEqual(
        body.messages.map((message) => message.role),
        ["system", "user", "assistant", "tool"],
      );
      assert.equal(body.messages[3]!.tool_call_id, "call-1");
      assert.deepEqual(decode(body.messages[3]!.content!), { choice: "left" });
      return Response.json(
        completion(
          "Proceed with the two perspectives.",
          undefined,
          "router-v1",
        ),
      );
    }
    // Every other node has a new conversation, not the decision's tool history.
    assert.equal(body.messages.length, 2);
    if (payload.nodeId === "join") {
      assert.deepEqual(predecessorText(payload.predecessors as import("../src/types.js").PredecessorOutput[]), [
        { nodeId: "a", output: "answer:a", model: "writer-v1" },
        { nodeId: "b", output: "answer:b", model: "default-v1" },
      ]);
    } else {
      assert.ok(payload.nodeId === "a" || payload.nodeId === "b");
      assert.deepEqual(predecessorText(payload.predecessors as import("../src/types.js").PredecessorOutput[]), [
        {
          nodeId: "route",
          decision: "left",
          model: "router-v1",
          output:
            "I will use two perspectives.\n\nProceed with the two perspectives.",
        },
      ]);
    }
    return Response.json(
      completion(`answer:${payload.nodeId}`, undefined, `${body.model}-v1`),
    );
  };
  const result = await braid(input, {
    runner: createOpenAICompatibleRunner({
      fetch,
      apiKey: "test-key",
      baseURL: "https://example.invalid/v1/",
    }),
    defaultModel: "default",
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 5);
  assert.equal(result.nodes.unused!.skipReason, "inactive");
  assert.deepEqual(result.terminalOutputs, {
    join: { output: "answer:join", model: "default-v1" },
  });
  assert.deepEqual(result.metadata.usage, {
    inputTokens: 50,
    outputTokens: 10,
  });
  assert.deepEqual(result.nodes.route!.usage, {
    inputTokens: 20,
    outputTokens: 4,
  });
});

for (const [name, responses, expectedCode, node] of [
  [
    "missing decide",
    [completion("Forgot the tool")],
    "DECISION_REQUIRED",
    decision(),
  ],
  [
    "invalid choice",
    [completion(null, [toolCall('{"choice":"invalid"}')])],
    "INVALID_DECISION",
    decision(),
  ],
  [
    "malformed arguments",
    [completion(null, [toolCall("not JSON")])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "multiple arguments",
    [completion(null, [toolCall('{"choice":"left","extra":true}')])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "array arguments",
    [completion(null, [toolCall('["left"]')])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "non-string choice",
    [completion(null, [toolCall('{"choice":["left","right"]}')])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "multiple tool calls",
    [completion(null, [toolCall(), toolCall()])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "unsupported tool",
    [completion(null, [toolCall("{}", "braid")])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "tool on execute node",
    [completion(null, [toolCall()])],
    "MODEL_ERROR",
    execute("route"),
  ],
  [
    "repeated decide in follow-up",
    [completion(null, [toolCall()]), completion(null, [toolCall()])],
    "MODEL_ERROR",
    decision(),
  ],
  [
    "HTTP error",
    [new Response("rate limited", { status: 429 })],
    "MODEL_ERROR",
    execute("route"),
  ],
  [
    "malformed response JSON",
    [new Response("not JSON")],
    "MODEL_ERROR",
    execute("route"),
  ],
  ["missing response fields", [{}], "MODEL_ERROR", execute("route")],
  ["empty text", [completion("")], "MODEL_ERROR", execute("route")],
  [
    "truncated output",
    [
      {
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      },
    ],
    "MODEL_ERROR",
    execute("route"),
  ],
] as const) {
  test(`adapter rejects ${name} and passes the failure to children without retrying`, async () => {
    const mock = queuedFetch([...responses, completion("Recovered")]);
    const result = await braid(
      graph([node, execute("child")], [{ from: "route", to: "child" }]),
      {
        runner: createOpenAICompatibleRunner({
          fetch: mock.fetch,
          defaultModel: "test",
        }),
      },
    );
    assert.equal(result.status, "completed");
    assert.equal(result.nodes.route!.error!.code, expectedCode);
    assert.equal(result.nodes.child!.status, "completed");
    assert.equal(mock.calls.length, responses.length + 1);
    const payload = JSON.parse(mock.calls.at(-1)!.messages[1]!.content!);
    assert.equal(payload.predecessors[0].error.code, expectedCode);
    assert.equal(result.terminalOutputs.child!.output, "Recovered");
  });
}

test("adapter default model is used when the run and node leave model unspecified", async () => {
  const mock = queuedFetch([
    { choices: [{ finish_reason: "stop", message: { content: "answer" } }] },
  ]);
  const result = await braid(graph([execute("a")]), {
    runner: createOpenAICompatibleRunner({
      fetch: mock.fetch,
      defaultModel: "adapter-default",
    }),
  });
  assert.equal(mock.calls[0]!.model, "adapter-default");
  assert.equal(result.nodes.a!.model, "adapter-default");
  assert.equal(result.nodes.a!.usage, undefined);
  assert.equal(result.metadata.usageReportedNodes, 0);
});

test("adapter fails before HTTP if no model is configured", async () => {
  const mock = queuedFetch([]);
  const result = await braid(graph([execute("a")]), {
    runner: createOpenAICompatibleRunner({ fetch: mock.fetch }),
  });
  assert.equal(result.nodes.a!.error!.code, "MODEL_ERROR");
  assert.match(result.nodes.a!.error!.message, /model must be set/);
  assert.equal(mock.calls.length, 0);
});

test("adapter forwards cancellation to fetch", { timeout: 2_000 }, async (t) => {
  const clock = mockClock(t);
  const started = deferred();
  let aborted = false;
  const fetch: typeof globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init?.signal);
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(init.signal!.reason);
        },
        { once: true },
      );
      started.resolve();
    });
  const run = braid(graph([execute("a")]), {
    runner: createOpenAICompatibleRunner({ fetch, defaultModel: "test" }),
    nodeTimeoutMs: 20,
  });
  await started.promise;
  clock.advance(19);
  assert.equal(aborted, false);
  clock.advance(1);
  const result = await run;
  assert.equal(result.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(aborted, true);
});

test("OpenAI merge tools expose agent-selected Git operations and finish dispositions", async () => {
  const fake = queuedFetch([
    completion("Inspect first", [toolCall('{"command":"status","args":["--short"]}', "git")]),
    completion(null, [toolCall('{"command":"cherry-pick","args":["checkpoint"]}', "git")]),
    completion(null, [toolCall('{"dispositions":[{"executionId":"work","disposition":"integrated","reason":"Reviewed and picked"}]}', "finish_merge")]),
    completion("Integrated"),
  ]);
  const gitCalls: string[][] = [];
  const dispositions: unknown[] = [];
  const runner = createOpenAICompatibleRunner({ defaultModel: "fake", fetch: fake.fetch });
  const result = await runner({
    goal: "Integrate reviewed work", node: { type: "merge", id: "merge" },
    predecessors: [], execution: { runId: "run", rootRunId: "run" }, signal: new AbortController().signal,
    workspace: { nodeId: "merge", mode: "integrate", sourceRoot: "/repo", workingDirectory: "/repo", state: "ready" },
    git: async args => { gitCalls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; },
    merge: {
      sources: [{ nodeId: "work", executionId: "work", mode: "worktree", workingDirectory: "/work", state: "ready", checkpointRef: "checkpoint",
        changes: { files: ["chosen.txt"], filesTruncated: false, stat: { text: "1 file changed", truncated: false }, diff: { text: "+chosen change", truncated: false } } }],
      sourceStatus: { text: " M user.txt\n", truncated: false, dirty: true },
      finish: async values => { dispositions.push(...values); },
    },
  });
  assert.deepEqual(gitCalls, [["status", "--short"], ["cherry-pick", "checkpoint"]]);
  assert.deepEqual(dispositions, [{ executionId: "work", disposition: "integrated", reason: "Reviewed and picked" }]);
  assert.equal(result.output, "Inspect first\n\nIntegrated");
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 8 });
  assert.deepEqual(fake.calls[0]!.tools!.map(tool => tool.function.name), ["git", "finish_merge"]);
  assert.equal(fake.calls[0]!.tool_choice, "auto");
  assert.match(fake.calls[0]!.messages[0]!.content!, /core has not merged anything/);
  assert.match(fake.calls[0]!.messages[0]!.content!, /Only process the current mergeSources IDs \["work"\]/);
  const payload = JSON.parse(fake.calls[0]!.messages[1]!.content!);
  assert.deepEqual(payload.mergeSources[0].changes.files, ["chosen.txt"]);
  assert.equal(payload.sourceCheckoutStatus.dirty, true);
  const finishSchema = fake.calls[0]!.tools![1]!.function.parameters as unknown as {
    properties: { dispositions: { minItems: number; maxItems: number; items: { properties: { executionId: { enum: string[] } } } } };
  };
  assert.equal(finishSchema.properties.dispositions.minItems, 1);
  assert.equal(finishSchema.properties.dispositions.maxItems, 1);
  assert.deepEqual(finishSchema.properties.dispositions.items.properties.executionId.enum, ["work"]);
  assert.equal(fake.calls[3]!.messages.filter(message => message.role === "tool").length, 3);
});

test("OpenAI rejects duplicate Git commands before invoking the runner capability", async () => {
  const fake = queuedFetch([
    completion(null, [toolCall('{"command":"status","args":["status"]}', "git")]),
    completion(null, [toolCall('{"command":"status","args":["--short"]}', "git")]),
    completion(null, [toolCall('{"dispositions":[]}', "finish_merge")]),
    completion("Dirty checkout confirmed"),
  ]);
  const calls: string[][] = [];
  await createOpenAICompatibleRunner({ defaultModel: "fake", fetch: fake.fetch })({
    goal: "Inspect", node: { type: "merge", id: "work", prompt: "Inspect status" },
    predecessors: [], execution: { runId: "run", rootRunId: "run" }, signal: new AbortController().signal,
    git: async args => { calls.push(args); return { exitCode: 0, stdout: "?? change.txt\n", stderr: "" }; },
    merge: { sources: [], finish: async () => {} },
  });
  assert.deepEqual(calls, [["status", "--short"]]);
  assert.match(fake.calls[1]!.messages.at(-1)!.content!, /DUPLICATE_GIT_COMMAND/);
  assert.match(fake.calls[2]!.messages.at(-1)!.content!, /change.txt/);
});
