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
  const flags = new Map<string, Parameters<ExtensionAPI["registerFlag"]>[1]>();
  const flagValues = new Map<string, boolean | string>();
  const reminder = deferred<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }>();
  let reminders = 0;
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  braidExtension({
    registerFlag: (name: string, options: Parameters<ExtensionAPI["registerFlag"]>[1]) => {
      flags.set(name, options);
      if (options.default !== undefined) flagValues.set(name, options.default);
    },
    getFlag: (name: string) => flagValues.get(name),
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
  return { tools, commands, handlers, flags, flagValues, reminder, messages, reminders: () => reminders };
}

test("extension registers background tools, a panel command, and guidance to wait for reminders", async () => {
  const fake = extension();
  assert.equal(fake.flags.get("braid-blocking")?.type, "boolean");
  assert.equal(fake.flags.get("braid-blocking")?.default, false);
  assert.deepEqual(
    [...fake.tools.keys()],
    ["braid_finish", "braid", "braid_status", "braid_cancel", "braid_update", "braid_resume"],
  );
  assert.ok(fake.commands.has("braid"));
  assert.ok(fake.commands.has("braid:blocking"));
  assert.ok(fake.commands.has("braid:review"));
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
  const status = fake.tools.get("braid_status") as ReturnType<typeof createBraidTools>["statusTool"];
  assert.match(prompt.systemPrompt, /returns a jobId immediately/);
  assert.match(prompt.systemPrompt, /ending your turn does not cancel it/);
  assert.match(prompt.systemPrompt, /end your turn and let the reminder resume the task/);
  assert.match(prompt.systemPrompt, /Do not call sleep, run a shell sleep, use a timer, or enter a sleep\/poll loop solely to wait for a Braid job/);
  assert.match(status.description, /do not sleep, use a timer, or poll in a loop to wait for a job/);
  assert.match(prompt.systemPrompt, /fresh worktree/);
  assert.match(prompt.systemPrompt, /Outside Git all filesystem access is read-only/);
  assert.match(prompt.systemPrompt, /integrate writes selected changes to the invoking checkout/);
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  assert.match(tool.description, /current session's Braid execution policy in the system prompt/);
  assert.doesNotMatch(tool.description, /end your turn|Completion reminders are suppressed|Use pauseAfter=true|Set notifyOnCompletion=true/);
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

test("the manual flag enables blocking after extension registration and guides the parent", { timeout: 2_000 }, async t => {
  const fake = extension();
  fake.flagValues.set("braid-blocking", true);
  const started = deferred<void>();
  const completion = deferred<ReturnType<typeof response>>();
  const ctx = context(async () => { started.resolve(); return completion.promise; });
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  const prompt = fake.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, ctx) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Blocking mode is enabled/);
  assert.doesNotMatch(prompt.systemPrompt, /end your turn and let the reminder resume/);
  assert.doesNotMatch(prompt.systemPrompt, /Use pauseAfter=true|Set notifyOnCompletion=true|Use braid_status with the jobId to retrieve terminal outputs/);
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  assert.equal("blocking" in tool.parameters.properties.options.properties, false);
  let returned = false;
  const call = tool.execute("call", input, undefined, undefined, ctx).then(result => { returned = true; return result; });
  await started.promise;
  assert.equal(returned, false);
  completion.resolve(response("CI result"));
  const result = await call;
  assert.equal(result.details!.status, "completed");
  assert.match(JSON.stringify(result.content), /CI result/);
  assert.equal(fake.reminders(), 0);
});

test("cancelled blocking jobs send a reminder with their handle and retain partial outputs", { timeout: 2_000 }, async t => {
  const fake = extension();
  fake.flagValues.set("braid-blocking", true);
  const started = deferred<void>();
  let calls = 0;
  const ctx = context(async () => {
    if (++calls === 1) return response("retained partial output");
    started.resolve();
    return new Promise(() => {});
  });
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  const status = fake.tools.get("braid_status") as ReturnType<typeof createBraidTools>["statusTool"];
  const controller = new AbortController();
  const running = tool.execute("cancel", {
    ...input,
    nodes: ["saved", "running"].map(id => ({ type: "execute", id, prompt: "work" })),
    options: { maxConcurrency: 1 },
  }, controller.signal, undefined, ctx);
  await started.promise;
  controller.abort();
  const cancelled = await running;
  assert.equal(cancelled.usage, undefined);
  const { message } = await fake.reminder.promise;
  assert.equal(message.customType, "braid-completed");
  assert.match(String(message.content), /job-1 finished with status cancelled/);
  assert.match(String(message.content), /partial outputs/);
  const read = await status.execute("retained", { jobId: "job-1" }, undefined, undefined, ctx);
  assert.equal(read.details!.result!.nodes.saved!.output, "retained partial output");
  assert.equal(read.usage!.totalTokens, 2);
  const again = await status.execute("again", { jobId: "job-1" }, undefined, undefined, ctx);
  assert.equal(again.usage, undefined);
  assert.equal(fake.reminders(), 1);
});

test("the session command reports the mode, overrides the CLI flag, and rejects invalid arguments", async t => {
  const fake = extension();
  fake.flagValues.set("braid-blocking", true);
  const notices: string[] = [];
  const ctx = context(async () => response());
  ctx.ui = { notify: (message: string) => notices.push(message) } as never;
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  const command = fake.commands.get("braid:blocking")!;
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /mode: on/);
  await command.handler("off", ctx);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /mode: off/);
  await assert.rejects(command.handler("off extra", ctx), /Usage: \/braid:blocking \[on\|off\]/);
  await command.handler("", ctx);
  assert.match(notices.at(-1)!, /mode: off/);
  await command.handler(" ON ", ctx);
  assert.match(notices.at(-1)!, /mode: on/);
});

for (const initiallyBlocking of [false, true]) test(`switching ${initiallyBlocking ? "off" : "on"} affects new calls and preserves the running job's mode`, { timeout: 2_000 }, async t => {
  const fake = extension();
  fake.flagValues.set("braid-blocking", initiallyBlocking);
  const started = deferred<void>();
  const completion = deferred<ReturnType<typeof response>>();
  const ctx = context(async () => { started.resolve(); return completion.promise; });
  ctx.ui = { notify() {} } as never;
  t.after(() => fake.handlers.get("session_shutdown")!({} as never, ctx));
  const tool = fake.tools.get("braid") as ReturnType<typeof createBraidTools>["braidTool"];
  let returned = false;
  const running = tool.execute("running", input, undefined, undefined, ctx).then(result => { returned = true; return result; });
  await started.promise;
  assert.equal(returned, !initiallyBlocking);
  await fake.commands.get("braid:blocking")!.handler(initiallyBlocking ? "off" : "on", ctx);
  assert.equal(returned, !initiallyBlocking);
  const prompt = fake.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, ctx) as { systemPrompt: string };
  assert.equal(prompt.systemPrompt.includes("Blocking mode is enabled"), !initiallyBlocking);
  completion.resolve(response("original result"));
  const original = await running;
  assert.equal(original.details!.status, initiallyBlocking ? "completed" : "running");
  if (!initiallyBlocking) await fake.reminder.promise;
  assert.equal(fake.reminders(), initiallyBlocking ? 0 : 1);
  const next = await tool.execute("next", input, undefined, undefined, ctx);
  assert.equal(next.details!.status, initiallyBlocking ? "running" : "completed");
  if (initiallyBlocking) await fake.reminder.promise;
  assert.equal(fake.reminders(), 1);
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
      const result = block.type === "text" ? block.text : "";
      assert.match(result, /^Braid job job-1 · running · /);
      assert.ok(result.includes(`Execution ${details.executionId} · node ${nodeId} (execute) · ${details.status}\n`), result);
      assert.ok(result.includes(failed ? `Error: MODEL_ERROR: ${output}` : `Output:\n${output}`));
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
