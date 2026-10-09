import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import braidExtension, { createBraidTools } from "../index.js";
import { context, deferred, input, response } from "./helpers.js";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
function extension(onSend?: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => void) {
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
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
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
      messages.push(message);
      onSend?.(message);
      reminder.resolve({ message, options });
    },
  } as unknown as ExtensionAPI);
  return { tools, commands, handlers, reminder, messages, reminders: () => reminders };
}

test("extension registers background tools, a panel command, and guidance to wait for reminders", async () => {
  const fake = extension();
  assert.deepEqual(
    [...fake.tools.keys()],
    ["braid", "braid_status", "braid_cancel", "braid_update", "braid_resume"],
  );
  assert.ok(fake.commands.has("braid"));
  assert.ok(fake.handlers.has("session_start"));
  assert.equal(fake.handlers.has("input"), false);
  assert.equal(fake.handlers.has("tool_call"), false);
  const prompt = fake.handlers.get("before_agent_start")!(
    { systemPrompt: "base" } as never,
    {} as never,
  ) as { systemPrompt: string };
  assert.match(
    prompt.systemPrompt,
    /two or more concerns can be handled independently/,
  );
  assert.match(prompt.systemPrompt, /do not poll repeatedly/);
  assert.match(prompt.systemPrompt, /fresh worktree/);
  assert.match(prompt.systemPrompt, /Outside Git all filesystem access is read-only/);
  assert.match(prompt.systemPrompt, /integrate writes selected changes to the invoking checkout/);
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  assert.deepEqual(tool.parameters.properties.nodes.items.properties.workspace.enum, ["read-only", "worktree"]);
  assert.equal(tool.parameters.properties.nodes.items.properties.notifyOnCompletion.type, "boolean");
  assert.match(prompt.systemPrompt, /notifyOnCompletion=true/);
  for (const guidance of [prompt.systemPrompt, tool.description, tool.promptGuidelines!.join("\n")]) {
    assert.match(guidance, /workspace=read-only/);
    assert.match(guidance, /predecessor execution checkpoint/);
    assert.match(guidance, /Set workspace=read-only to disable writes/);
    assert.match(guidance, /Do not set workspace on merge\/integrate nodes/);
    assert.match(guidance, /no automatic final integration/);
  }
  assert.match(
    prompt.systemPrompt,
    /Completion reminders refer to existing jobs/,
  );
  fake.handlers.get("session_shutdown")!({} as never, {} as never);
});

for (const idle of [true, false]) {
  for (const failed of [false, true]) {
    test(`opted-in node ${failed ? "failure" : "success"} resumes an ${idle ? "idle" : "streaming"} parent before the job finishes`, { timeout: 2_000 }, async (t) => {
      const finished = deferred<void>();
      const fake = extension((message) => {
        if (message.customType === "braid-completed") finished.resolve();
      });
      t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
      const otherStarted = deferred<void>();
      const other = deferred<ReturnType<typeof response>>();
      let calls = 0;
      const output = "Full finding\n".repeat(100);
      const ctx = context(async () => {
        if (++calls === 1) {
          if (failed) throw new Error(output);
          return response(output);
        }
        otherStarted.resolve();
        return other.promise;
      });
      ctx.isIdle = () => idle;
      const nodeId = 'survey "quoted"\nnode';
      const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
      const status = fake.tools.get("braid_status") as ReturnType<typeof createBraidTools>["statusTool"];
      const submitted = await tool.execute("call", {
        ...input,
        nodes: [
          { type: "execute", id: nodeId, prompt: "survey", notifyOnCompletion: true },
          { type: "execute", id: "other", prompt: "other", notifyOnCompletion: false },
        ],
        options: { maxConcurrency: 1 },
      }, undefined, undefined, ctx);
      assert.equal(fake.reminders(), 0);
      const { message, options } = await fake.reminder.promise;
      await otherStarted.promise;
      assert.equal(message.customType, "braid-node-completed");
      const details = message.details as { jobId: string; handle: string; executionId: string; nodeId: string; status: string; eventSequence: number; errorCode?: string };
      assert.equal(details.jobId, submitted.details!.jobId);
      assert.equal(details.nodeId, nodeId);
      assert.equal(details.status, failed ? "failed" : "completed");
      assert.equal(details.errorCode, failed ? "MODEL_ERROR" : undefined);
      assert.ok(details.eventSequence > 0);
      assert.ok(String(message.content).includes(`braid_status(${JSON.stringify({ jobId: details.handle, executionId: details.executionId })})`));
      assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
      const read = await status.execute("read", { jobId: details.handle, executionId: details.executionId }, undefined, undefined, ctx);
      const block = read.content[0]!;
      assert.equal(block.type, "text");
      const result = JSON.parse(block.type === "text" ? block.text : "");
      assert.equal(result.status, "running");
      assert.equal(result.node.status, details.status);
      assert.equal(failed ? result.node.error.message : result.node.output, output);
      assert.equal(read.usage, undefined);
      fake.handlers.get("message_start")!({ message: { ...message, role: "custom" } } as never, ctx);
      fake.handlers.get("agent_settled")!({} as never, ctx);
      assert.equal(fake.reminders(), 1);
      other.resolve(response("other result"));
      await finished.promise;
      assert.deepEqual(fake.messages.map((item) => item.customType), ["braid-node-completed", "braid-completed"]);
    });
  }
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
        new RegExp(submitted.details!.handle),
      );
      assert.match(String(message.content), /braid_status/);
      assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
      assert.equal(fake.reminders(), 1);
      fake.handlers.get("session_shutdown")!({} as never, ctx);
    },
  );
}

test("node and job reminder acknowledgements are independent, and failed deliveries can retry", { timeout: 2_000 }, async (t) => {
  const finished = deferred<void>();
  let throwOnce = true;
  const fake = extension((message) => {
    if (message.customType === "braid-completed") finished.resolve();
    if (throwOnce) {
      throwOnce = false;
      throw new Error("delivery unavailable");
    }
  });
  const ctx = context(async () => response());
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  await tool.execute("call", {
    ...input,
    nodes: ["a", "b"].map((id) => ({ type: "execute", id, prompt: "work", notifyOnCompletion: true })),
    options: { maxConcurrency: 1 },
  }, undefined, undefined, ctx);
  await finished.promise;
  assert.deepEqual(fake.messages.map((message) => message.customType), ["braid-node-completed", "braid-node-completed", "braid-completed"]);
  assert.equal((fake.messages[2]!.details as { status: string }).status, "completed");
  const acknowledge = (index: number) => fake.handlers.get("message_start")!({ message: { ...fake.messages[index], role: "custom" } } as never, ctx);
  acknowledge(1);
  ctx.hasPendingMessages = () => true;
  fake.handlers.get("agent_settled")!({} as never, ctx);
  assert.equal(fake.reminders(), 3);
  ctx.hasPendingMessages = () => false;
  fake.handlers.get("agent_settled")!({} as never, ctx);
  assert.equal(fake.reminders(), 5);
  assert.deepEqual(fake.messages[3], fake.messages[0]);
  assert.deepEqual(fake.messages[4], fake.messages[2]);
  acknowledge(3);
  acknowledge(4);
  fake.handlers.get("agent_settled")!({} as never, ctx);
  assert.equal(fake.reminders(), 5);
});

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

test("extension automatically shows editor job status and clears it on shutdown", { timeout: 3_000 }, async (t) => {
  const fake = extension();
  const started = deferred<void>();
  const completion = deferred<ReturnType<typeof response>>();
  const ctx = context(async () => { started.resolve(); return completion.promise; });
  let widget: { render(width: number): string[] } | undefined;
  ctx.ui = {
    setWidget: (_key: string, factory: ((...args: unknown[]) => typeof widget) | undefined) => {
      widget = factory?.({}, { fg: (_color: string, value: string) => value });
    },
  } as never;
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  fake.handlers.get("session_start")!({} as never, ctx);
  assert.equal(widget, undefined);
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  await tool.execute("call", input, undefined, undefined, ctx);
  await started.promise;
  assert.match(widget!.render(120).join("\n"), /Braid job-1 · running · 0\/1 done · a/);
  completion.resolve(response());
  await fake.reminder.promise;
  assert.match(widget!.render(120).join("\n"), /completed · 1\/1 done/);
  fake.handlers.get("session_shutdown")!({} as never, ctx);
  assert.equal(widget, undefined);
});
