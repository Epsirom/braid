import assert from "node:assert/strict";
import test from "node:test";
import { braid, type BraidInput } from "../src/index.js";
import { createOpenAICompatibleRunner } from "../src/adapters/openai.js";
import { decision, execute, graph } from "./helpers.js";

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
      assert.deepEqual(payload.predecessors, []);
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
      assert.deepEqual(payload.predecessors, [
        { nodeId: "a", output: "answer:a", model: "writer-v1" },
        { nodeId: "b", output: "answer:b", model: "default-v1" },
      ]);
    } else {
      assert.ok(payload.nodeId === "a" || payload.nodeId === "b");
      assert.deepEqual(payload.predecessors, [
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
  test(`adapter rejects ${name} without retrying or running children`, async () => {
    const mock = queuedFetch([...responses]);
    const result = await braid(
      graph([node, execute("child")], [{ from: "route", to: "child" }]),
      {
        runner: createOpenAICompatibleRunner({
          fetch: mock.fetch,
          defaultModel: "test",
        }),
      },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.nodes.route!.error!.code, expectedCode);
    assert.equal(result.nodes.child!.skipReason, "upstream_failed");
    assert.equal(mock.calls.length, responses.length);
    assert.deepEqual(result.terminalOutputs, {});
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

test("adapter forwards cancellation to fetch", { timeout: 2_000 }, async () => {
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
    });
  const result = await braid(graph([execute("a")]), {
    runner: createOpenAICompatibleRunner({ fetch, defaultModel: "test" }),
    nodeTimeoutMs: 20,
  });
  assert.equal(result.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(aborted, true);
});
