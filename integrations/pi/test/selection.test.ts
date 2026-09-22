import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import braidExtension, { createBraidTools } from "../index.js";
import { context, deferred, input, response } from "./helpers.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
function extension() {
  const tools = new Map<string, unknown>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const handlers = new Map<string, Handler>();
  const reminder = deferred<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }>();
  let reminders = 0;
  braidExtension({
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: never) =>
      commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    sendMessage: (
      message: Parameters<ExtensionAPI["sendMessage"]>[0],
      options: Parameters<ExtensionAPI["sendMessage"]>[1],
    ) => {
      reminders++;
      reminder.resolve({ message, options });
    },
  } as unknown as ExtensionAPI);
  return { tools, commands, handlers, reminder, reminders: () => reminders };
}

test("extension registers background tools, a panel command, and guidance to wait for reminders", async () => {
  const fake = extension();
  assert.deepEqual(
    [...fake.tools.keys()],
    ["braid", "braid_status", "braid_cancel"],
  );
  assert.ok(fake.commands.has("braid"));
  assert.equal(fake.handlers.has("input"), false);
  assert.equal(fake.handlers.has("tool_call"), false);
  const prompt = fake.handlers.get("before_agent_start")!(
    { systemPrompt: "base" } as never,
    {} as never,
  ) as { systemPrompt: string };
  assert.match(
    prompt.systemPrompt,
    /two or more concerns can be analyzed independently/,
  );
  assert.match(prompt.systemPrompt, /do not poll repeatedly/);
  assert.match(
    prompt.systemPrompt,
    /Completion reminders refer to existing jobs/,
  );
  fake.handlers.get("session_shutdown")!({} as never, {} as never);
});

for (const idle of [true, false]) {
  test(
    `completion sends one system reminder with automatic continuation while ${idle ? "idle" : "streaming"}`,
    { timeout: 2_000 },
    async () => {
      const fake = extension();
      const completion = deferred<ReturnType<typeof response>>();
      const ctx = context(async () => completion.promise);
      ctx.isIdle = () => idle;
      const tool = fake.tools.get("braid") as ReturnType<
        typeof createBraidTools
      >["braidTool"];
      const submitted = await tool.execute(
        "call",
        input,
        undefined,
        undefined,
        ctx,
      );
      assert.equal(fake.reminders(), 0);
      completion.resolve(response());
      const { message, options } = await fake.reminder.promise;
      assert.match(String(message.content), /system-reminder/);
      assert.match(
        String(message.content),
        new RegExp(submitted.details!.jobId),
      );
      assert.match(String(message.content), /braid_status/);
      assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
      assert.equal(fake.reminders(), 1);
      fake.handlers.get("session_shutdown")!({} as never, ctx);
    },
  );
}

test(
  "a reminder dropped by foreground abort is retried after settling, but delivered reminders are not repeated",
  { timeout: 2_000 },
  async () => {
    const fake = extension();
    const ctx = context(async () => response());
    const tool = fake.tools.get("braid") as ReturnType<
      typeof createBraidTools
    >["braidTool"];
    const submitted = await tool.execute(
      "call",
      input,
      undefined,
      undefined,
      ctx,
    );
    const { message } = await fake.reminder.promise;
    ctx.isIdle = () => true;
    ctx.hasPendingMessages = () => true;
    fake.handlers.get("agent_settled")!({} as never, ctx);
    assert.equal(fake.reminders(), 1);
    ctx.hasPendingMessages = () => false;
    fake.handlers.get("agent_settled")!({} as never, ctx);
    assert.equal(fake.reminders(), 2);
    fake.handlers.get("message_start")!(
      { message: { ...message, role: "custom" } } as never,
      ctx,
    );
    fake.handlers.get("agent_settled")!({} as never, ctx);
    assert.equal(fake.reminders(), 2);
    assert.ok(submitted.details!.jobId);
    fake.handlers.get("session_shutdown")!({} as never, ctx);
  },
);

test(
  "session replacement suppresses completion reminders from the old session",
  { timeout: 2_000 },
  async () => {
    const fake = extension();
    const ctx = context(async () => new Promise(() => {}));
    const tool = fake.tools.get("braid") as ReturnType<
      typeof createBraidTools
    >["braidTool"];
    await tool.execute("call", input, undefined, undefined, ctx);
    fake.handlers.get("session_shutdown")!({ reason: "new" } as never, ctx);
    // Allow the cancelled run and its completion callback to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.handlers.get("agent_settled")!({} as never, ctx);
    assert.equal(fake.reminders(), 0);
  },
);
