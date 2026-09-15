import assert from "node:assert/strict";
import test from "node:test";
import braidExtension, { braidTool } from "../index.js";
test("Pi adapter teaches proactive selection without forcing Braid for simple work", async () => {
  let registered: unknown;
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  let inputHandler:
    | ((
        event: { text: string; source: string },
        ctx: unknown,
      ) => { action: "transform"; text: string } | undefined)
    | undefined;
  let toolCallHandler:
    | ((event: { toolName: string }, ctx: unknown) => unknown)
    | undefined;
  let toolResultHandler:
    | ((
        event: { toolName: string; details?: unknown },
        ctx: unknown,
      ) => unknown)
    | undefined;
  let beforeAgentStart:
    | ((event: { systemPrompt: string }) => { systemPrompt: string })
    | undefined;
  const fakePi = {
    getActiveTools() {
      return ["braid", "read"];
    },
    registerTool(tool: unknown) {
      registered = tool;
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, options);
    },
    on(event: string, handler: unknown) {
      if (event === "before_agent_start")
        beforeAgentStart = handler as typeof beforeAgentStart;
      if (event === "input") inputHandler = handler as typeof inputHandler;
      if (event === "tool_call")
        toolCallHandler = handler as typeof toolCallHandler;
      if (event === "tool_result")
        toolResultHandler = handler as typeof toolResultHandler;
    },
  } as never;
  braidExtension(fakePi);
  assert.equal(registered, braidTool);
  assert.ok(commands.has("braid"));
  assert.ok(
    braidTool.description.includes(
      "Use this tool FIRST for nontrivial engineering work",
    ),
  );
  assert.ok(
    braidTool.description.includes("the user does not need to mention Braid"),
  );
  assert.ok(beforeAgentStart);
  assert.ok(inputHandler);
  let notified = "";
  await commands.get("braid")!.handler("", {
    hasUI: true,
    isIdle: () => true,
    getActiveTools: () => ["braid", "read"],
    ui: {
      notify: (message: string) => {
        notified = message;
      },
      setStatus: () => {},
    },
  } as never);
  assert.match(notified, /armed/);
  const transformed = inputHandler!(
    { text: "Review this diff", source: "interactive" },
    { isIdle: () => true, hasUI: true, ui: { setStatus: () => {} } } as never,
  );
  assert.equal(transformed?.action, "transform");
  assert.match(
    transformed?.text ?? "",
    /Call the braid tool as your first action/,
  );
  const prompt = beforeAgentStart!({
    systemPrompt: "base prompt",
  }).systemPrompt;
  assert.match(prompt, /Braid execution policy/);
  assert.match(prompt, /Selection rule: for a code review, bug investigation/);
  assert.match(prompt, /two or more concerns can be analyzed independently/);
  assert.match(
    prompt,
    /nodes can inspect the current project with read-only read, grep, find, and ls tools/,
  );
  assert.match(prompt, /Do not use braid for a simple one-step answer/);
  assert.match(
    prompt,
    /make this delegation choice before using read, grep, find, edit, write, or bash/,
  );
  // The command guard is exercised below; before_agent_start is intentionally
  // called after the synchronous input hook in this fixture, so it sees the ordinary policy.
  assert.ok(toolCallHandler);
  const toolContext = {
    hasUI: true,
    signal: undefined,
    ui: { setStatus: () => {} },
  };
  const blocked = toolCallHandler!(
    { toolName: "read" },
    toolContext as never,
  ) as { block?: boolean };
  assert.equal(blocked.block, true);
  assert.ok(toolResultHandler);
  toolCallHandler!({ toolName: "braid" }, toolContext as never);
  toolResultHandler!(
    {
      toolName: "braid",
      details: {
        events: [{ type: "graph_created" }, { type: "node_started" }],
      },
    },
    { hasUI: true, signal: undefined, ui: { setStatus: () => {} } } as never,
  );
  assert.equal(
    inputHandler!(
      { text: "This second prompt must not be armed", source: "interactive" },
      { isIdle: () => true } as never,
    ),
    undefined,
  );
  const ordinaryPrompt = beforeAgentStart!({
    systemPrompt: "base prompt",
  }).systemPrompt;
  assert.doesNotMatch(ordinaryPrompt, /Mandatory Braid turn/);
});
