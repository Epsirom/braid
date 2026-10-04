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
    const agent = { id: session.id, session, ctx: owner.ctx, options: { provider: "fake", model: "model" },
      status: "idle", steer: (message: UserMessage) => { messages.push(message); },
      whenIdle: async () => {}, cancel: () => {},
    } as unknown as Agent;
    await ctx.agents.register(agent);
    return { agent, messages, owner };
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
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ["braid", "braid_cancel", "braid_resume", "braid_status", "braid_update"]);
    const assembly = await ctx.systemPrompt.assemble();
    assert.match(JSON.stringify(assembly), /Braid is a proactive/);
    const submitted = await invoke(a.agent, "braid", input);
    assert.equal(submitted.isError, false, JSON.stringify(submitted));
    assert.ok("value" in submitted);
    const receipt = submitted.value as { jobId: string; canonicalJobId: string; nativeJobId: string };
    assert.equal(receipt.jobId, "job-1");
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
