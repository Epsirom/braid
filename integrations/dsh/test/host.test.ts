import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type UserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import Registry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import { JobId } from "@deepseek-ai/dsh-jobs";
import * as plugin from "../index.js";
import { answer, directory, input, until } from "./helpers.js";

async function harness(respond: (options: GenerateOptions) => Promise<StreamChunk[]> = async () => answer()) {
  const ctx = new Context();
  await ctx.plugin(Registry);
  await ctx.plugin(Gateway);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: "native" });
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LocalJobRegistry);
  await ctx.plugin(LlmRuntime);
  class Adapter extends LlmAdapter {
    async *stream(options: GenerateOptions) { yield* await respond(options); }
  }
  ctx.llm.registerAdapter(["fake"], new Adapter());
  const fiber = await ctx.plugin(plugin);
  async function agent(name: string) {
    const owner = ctx.plugin(() => {});
    const session = ctx.sessions.create(SessionId(name), { meta: { cwd: directory() } });
    const messages: UserMessage[] = [];
    const injected: UserMessage[] = [];
    const agent = { id: session.id, session, ctx: owner.ctx, options: { provider: "fake", model: "model" },
      status: "idle", steer: (message: UserMessage) => { messages.push(message); },
      inject: (message: UserMessage) => { injected.push(message); },
      whenIdle: async () => {}, cancel: () => {},
    } as unknown as Agent;
    await ctx.agents.register(agent);
    return { agent, messages, injected, owner };
  }
  let count = 0;
  const invoke = (agent: Agent | undefined, name: string, args: object, signal = new AbortController().signal) => ctx.tools.execute({
    callId: ToolCallId(`test-${++count}`), name, arguments: args, ...(agent ? { agent } : {}), signal,
  });
  return { ctx, fiber, agent, invoke };
}

test("loads in actual Cordis/DSH services, produces valid canonical results, native jobs and scoped controls", async () => {
  const { ctx, fiber, agent, invoke } = await harness();
  try {
    const a = await agent("owner-a"), b = await agent("owner-b");
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ["braid", "braid_cancel", "braid_pause", "braid_resume", "braid_status", "braid_update"]);
    const assembly = await ctx.systemPrompt.assemble();
    assert.match(JSON.stringify(assembly), /Braid is a proactive/);
    assert.match(JSON.stringify(assembly), /Do not call sleep, run a shell sleep, use a timer, or enter a sleep\/poll loop/);
    const braidSchema = ctx.tools.schemas().find(tool => tool.name === "braid")!;
    assert.match(braidSchema.description, /ending your turn does not cancel it/);
    assert.match(ctx.tools.schemas().find(tool => tool.name === "braid_status")!.description, /do not sleep, use a timer, or poll in a loop/);
    const submitted = await invoke(a.agent, "braid", input);
    assert.equal(submitted.isError, false, JSON.stringify(submitted));
    assert.ok("value" in submitted);
    const receipt = submitted.value as { jobId: string; canonicalJobId: string; nativeJobId: string; message: string };
    assert.equal(receipt.jobId, "job-1");
    assert.ok("content" in submitted);
    assert.match((submitted.content[0] as { text: string }).text, /^Braid job job-1 started \(running\)\.\nID: \S+\nBraid runs asynchronously and notifies you when the job finishes\./);
    assert.doesNotMatch((submitted.content[0] as { text: string }).text, /Nodes:|Edges:/, "the receipt does not echo the submitted graph");
    assert.equal((submitted.meta as { canonicalJobId: string }).canonicalJobId, receipt.canonicalJobId);
    assert.equal((submitted.meta as { text?: string }).text, undefined);
    assert.match((submitted.content[0] as { text: string }).text, /Do not sleep or poll in a loop to wait for this job/);
    await until(() => Boolean(ctx.get("braidPanel")));
    const observation = await ctx.typertGateway.stream({ namespace: "braidPanel", method: "watch", args: { request: { sessionId: a.agent.id } }, signal: new AbortController().signal });
    const iterator = observation[Symbol.asyncIterator]();
    assert.match(JSON.stringify((await iterator.next()).value), new RegExp(receipt.canonicalJobId));
    await iterator.return?.();
    await until(() => ctx.jobs.get(JobId(receipt.nativeJobId), a.agent.id).status === "completed");
    const result = await invoke(a.agent, "braid_status", { jobId: receipt.jobId });
    assert.equal(result.isError, false); assert.match(JSON.stringify(result), /completed/);
    assert.ok(ctx.jobs.readAt(JobId(receipt.nativeJobId), 0, a.agent.id).chunks.some(chunk => chunk.text.includes("Braid job-1")));
    assert.equal((await invoke(b.agent, "braid_status", { jobId: receipt.canonicalJobId })).isError, true);
    assert.equal((await invoke(undefined, "braid_status", {})).isError, true);
    assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 0);
    assert.equal(a.messages[0]!.source.kind, "braid");
    assert.ok(ctx.commands.find(a.agent, "braid"));
    await fiber.dispose();
    assert.equal(ctx.tools.schemas().length, 0); assert.equal(ctx.commands.find(a.agent, "braid"), undefined);
  } finally { await ctx.fiber.dispose(); }
});

test("foreground abort leaves submitted jobs alive; native kill cancels and settles them", async () => {
  let entered = false;
  const { ctx, agent, invoke } = await harness(async options => {
    entered = true;
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    options.signal!.throwIfAborted(); return answer();
  });
  try {
    const a = await agent("cancel-owner");
    const controller = new AbortController();
    const submission = await invoke(a.agent, "braid", input, controller.signal);
    assert.ok("value" in submission, JSON.stringify(submission));
    const receipt = submission.value as { jobId: string; nativeJobId: string };
    controller.abort(); await until(() => entered);
    assert.equal(ctx.jobs.get(JobId(receipt.nativeJobId), a.agent.id).status, "running");
    ctx.jobs.kill(JobId(receipt.nativeJobId), a.agent.id);
    await until(() => ctx.jobs.get(JobId(receipt.nativeJobId), a.agent.id).status === "killed");
    const status = await invoke(a.agent, "braid_status", { jobId: receipt.jobId });
    assert.match(JSON.stringify(status), /cancelled/);
  } finally { await ctx.fiber.dispose(); }
});

test("dropped reminders retry at idle once and claimed reminders are acknowledged", async () => {
  const { ctx, agent, invoke } = await harness();
  try {
    const a = await agent("reminder-owner");
    await invoke(a.agent, "braid", input);
    await until(() => a.messages.length === 1);
    const message = a.messages[0]!;
    ctx.emit("agent/status", { agent: a.agent, status: "idle" });
    assert.equal(a.messages.length, 1, "queued reminders must not duplicate");
    ctx.emit("agent/inbox/discarded", { agent: a.agent, message });
    ctx.emit("agent/status", { agent: a.agent, status: "idle" });
    assert.equal(a.messages.length, 2);
    ctx.emit("agent/inbox/claimed", { agent: a.agent, message, turn: 1 });
    ctx.emit("agent/status", { agent: a.agent, status: "idle" });
    assert.equal(a.messages.length, 2);
  } finally { await ctx.fiber.dispose(); }
});

test("a pause from the panel never wakes the parent; it is injected as context once the parent runs", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const { ctx, agent, invoke } = await harness(async () => { await held; return answer(); });
  try {
    const a = await agent("notice-owner");
    const receipt = (await invoke(a.agent, "braid", input)).value as { canonicalJobId: string; jobId: string };
    const control = (action: string) => ctx.typertGateway.invoke({ namespace: "braidPanel", method: "control",
      args: { request: { sessionId: "notice-owner", jobId: receipt.canonicalJobId, action, revision: 0, executionIds: [] } } });
    await control("pause");
    await control("resume");
    await control("pause");
    assert.deepEqual(a.messages, [], "no waking reminder");
    assert.equal(a.injected.length, 0, "held while the parent is idle");
    (a.agent as { status: string }).status = "running";
    ctx.emit("agent/status", { agent: a.agent, status: "running" });
    assert.equal(a.injected.length, 1, "coalesced to the latest change");
    assert.match(JSON.stringify(a.injected[0]), new RegExp(`The user paused the whole job of Braid job ${receipt.jobId}\\. .*Do not resume it unless the user asks`));
    ctx.emit("agent/status", { agent: a.agent, status: "running" });
    assert.equal(a.injected.length, 1, "each notice is delivered once");
    await control("resume");
    assert.equal(a.injected.length, 2, "a running parent receives a notice at its next step");
    release();
    await until(() => a.messages.length === 1);
  } finally { release(); await ctx.fiber.dispose(); }
});

test("a node timeout pause wakes the parent with a reminder", async () => {
  let requests = 0;
  const { ctx, agent, invoke } = await harness(async options => {
    // The first request runs until the node timeout interrupts it.
    if (requests++ === 0) await new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    return answer();
  });
  try {
    const a = await agent("timeout-owner");
    const receipt = (await invoke(a.agent, "braid", { ...input, options: { nodeTimeoutMs: 100 } })).value as { jobId: string };
    await until(() => a.messages.length === 1);
    const text = (a.messages[0]!.content[0] as { text: string }).text;
    assert.ok(text.startsWith(`[system-reminder] Braid job ${receipt.jobId} node "a" execution `), text);
    assert.match(text, /was paused because it exceeded its node timeout/);
    assert.equal(a.injected.length, 0, "a reminder, not a background notice");
  } finally { await ctx.fiber.dispose(); }
});

test("unloading the plugin aborts work and suppresses reminders after cleanup", async () => {
  let entered = false, cleaned = false;
  const { ctx, fiber, agent, invoke } = await harness(async options => {
    entered = true;
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    cleaned = true; options.signal!.throwIfAborted(); return answer();
  });
  try {
    const a = await agent("dispose-owner");
    await invoke(a.agent, "braid", input);
    await until(() => entered);
    await fiber.dispose();
    assert.equal(cleaned, true); assert.equal(a.messages.length, 0);
  } finally { await ctx.fiber.dispose(); }
});

test("disposing an owning agent drains its work without notifying that agent", async () => {
  let entered = false, cleaned = false;
  const { ctx, agent, invoke } = await harness(async options => {
    entered = true;
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    cleaned = true; options.signal!.throwIfAborted(); return answer();
  });
  try {
    const a = await agent("owner-disposal");
    await invoke(a.agent, "braid", input);
    await until(() => entered);
    await a.owner.dispose();
    assert.equal(cleaned, true); assert.equal(a.messages.length, 0);
  } finally { await ctx.fiber.dispose(); }
});
