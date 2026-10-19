import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BraidJobs, type ControlNotice } from "../jobs.js";
import braidExtension, { createBraidTools, formatControlNotice } from "../index.js";
import type { BraidPanel } from "../command.js";
import { context, deferred, input, response } from "./helpers.js";

const plainTheme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 2000 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

/** The first model request asks for a tool, so the worker makes a second request after it. */
function twoStepWorker() {
  const first = deferred<void>();
  const requests: Context[] = [];
  const ctx = context(async () => response());
  const complete = async (_model: unknown, worker: Context): Promise<AssistantMessage> => {
    requests.push(structuredClone(worker));
    if (requests.length === 1) {
      await first.promise;
      return { ...response(), stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "missing_tool", arguments: {} }] };
    }
    return response("finished after resume");
  };
  (ctx.modelRegistry as unknown as { complete: typeof complete }).complete = complete;
  return { ctx, requests, first };
}

test("braid_pause suspends before the next model request and braid_resume continues the same conversation", { timeout: 10_000 }, async t => {
  const { ctx, requests, first } = twoStepWorker();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const submitted = await tools.braidTool.execute("submit", input, undefined, undefined, ctx);
  const handle = submitted.details!.handle;
  await until(() => requests.length === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;

  const paused = await tools.pauseTool.execute("pause", { jobId: handle, executionIds: [executionId] }, undefined, undefined, ctx);
  assert.match(textOf(paused), new RegExp(`pause requested for ${executionId}`));
  assert.match(textOf(paused), new RegExp(`Pausing \\(each stops before its next model request.*\\): ${executionId}`));
  first.resolve();
  await until(() => jobs.get(handle)!.execution!.suspendedExecutionIds.includes(executionId));
  assert.equal(requests.length, 1, "the second request waits for resume");
  assert.deepEqual(jobs.progress(handle)!.running, [], "a suspended execution is not running");
  assert.equal(jobs.progress(handle)!.paused, 1);
  assert.deepEqual(jobs.outstanding(), [{
    jobId: submitted.details!.jobId, handle, stalled: true, revision: 0, pausedExecutionIds: [], suspendedExecutionIds: [executionId],
  }]);
  const status = textOf(await tools.statusTool.execute("status", { jobId: handle, executionId }, undefined, undefined, ctx));
  assert.match(status, /suspended executions: /);
  assert.match(status, /Execution is suspended, paused by agent since /);
  assert.match(status, /Activity: suspended for /);
  assert.doesNotMatch(status, /The user paused this/);

  jobs.sendInput(handle, executionId, "Use the other approach.");
  await assert.rejects(tools.resumeTool.execute("no revision", { jobId: handle, executionIds: [executionId] }, undefined, undefined, ctx), /expectedRevision is required/);
  const resumed = await tools.resumeTool.execute("resume", { jobId: handle, expectedRevision: 0, executionIds: [executionId] }, undefined, undefined, ctx);
  assert.match(textOf(resumed), /Still suspended: none\./);
  await jobs.wait(handle);
  const job = jobs.get(handle)!;
  assert.equal(job.status, "completed");
  assert.equal(job.result!.nodes.a!.output, "finished after resume");
  assert.equal(requests.length, 2);
  const second = requests[1]!.messages;
  assert.equal(second[0]!.content, requests[0]!.messages[0]!.content, "the same conversation continues");
  assert.ok(second.some(message => message.role === "toolResult" && message.toolCallId === "call-1"));
  assert.match(JSON.stringify(second.at(-1)), /Use the other approach\./, "a message sent while suspended arrives after resume");
  assert.deepEqual(notices, [], "the parent's own pause and resume send no notice");
});

test("a pause by the user sends the parent a notice and asks it not to resume", { timeout: 10_000 }, async t => {
  const { ctx, requests, first } = twoStepWorker();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", input, undefined, undefined, ctx)).details!.handle;
  await until(() => requests.length === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;

  jobs.pause(handle, undefined, "user");
  assert.equal(jobs.get(handle)!.execution!.pause!.source, "user");
  first.resolve();
  await until(() => jobs.get(handle)!.execution!.suspendedExecutionIds.length === 1);
  const status = textOf(await tools.statusTool.execute("status", { jobId: handle }, undefined, undefined, ctx));
  assert.match(status, /job paused by user at /);
  assert.match(status, /The user paused this; do not resume it unless the user asks\./);
  assert.match(status, new RegExp(`${executionId} · node a · running · suspended, paused by user`));
  jobs.resumeJob(handle, "user");
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");

  assert.deepEqual(notices.map(notice => [notice.action, notice.source, notice.executions]), [["paused", "user", undefined], ["resumed", "user", undefined]]);
  assert.equal(formatControlNotice(notices[0]!),
    `The user paused the whole job of Braid job ${handle}. Paused work keeps its conversation and workspace. Do not resume it unless the user asks; check the current state with braid_status({"jobId":"${handle}"}).`);
  assert.equal(formatControlNotice({ ...notices[1]!, executions: [{ executionId, nodeId: "a" }] }),
    `The user resumed node "a" execution ${executionId} of Braid job ${handle}; it continues where it stopped.`);
});

test("pausing a finished job or an execution that is not running is rejected", { timeout: 10_000 }, async t => {
  const ctx = context(async () => response());
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", { ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, undefined, undefined, ctx)).details!.handle;
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.length === 1);
  const held = jobs.get(handle)!.execution!.pausedExecutionIds[0]!;
  await assert.rejects(tools.pauseTool.execute("held", { jobId: handle, executionIds: [held] }, undefined, undefined, ctx), /running execution IDs/);
  await tools.resumeTool.execute("release", { jobId: handle, expectedRevision: 0, executionIds: [held] }, undefined, undefined, ctx);
  await jobs.wait(handle);
  await assert.rejects(tools.pauseTool.execute("late", { jobId: handle }, undefined, undefined, ctx), /not accepting updates/);
});

test("pauses from /braid wait for the parent's next turn as one coalesced notice and never wake it", { timeout: 10_000 }, async () => {
  const { ctx, requests, first } = twoStepWorker();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { handle: string } }> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: unknown[] = [];
  braidExtension({
    registerFlag: () => {}, getFlag: () => undefined,
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as ExtensionAPI);
  const nextTurn = () => handlers.get("before_agent_start")!.map(handler => handler({}, { mode: "tui" }) as { message?: unknown } | undefined).find(result => result?.message) as
    { message: { customType: string; content: string } } | undefined;
  const handle = (await tools.get("braid")!.execute("submit", input, undefined, undefined, ctx)).details.handle;
  await until(() => requests.length === 1);
  let panel!: BraidPanel;
  await commands.get("braid")!.handler("", { mode: "tui", ui: { custom: async (factory: (...args: unknown[]) => BraidPanel) => {
    panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, plainTheme, {}, () => {});
  } } });
  panel.render(120);
  panel.handleInput("p");
  assert.match(panel.render(120).join("\n"), /Job paused · no new executions start/);
  panel.handleInput("p");
  panel.handleInput("p");
  assert.deepEqual(sent, [], "a user pause does not wake the parent");
  const notice = nextTurn();
  assert.equal(notice!.message.customType, "braid-control");
  assert.equal(notice!.message.content, `[system-reminder] The user paused the whole job of Braid job ${handle}. Paused work keeps its conversation and workspace. Do not resume it unless the user asks; check the current state with braid_status({"jobId":"${handle}"}). [/system-reminder]`);
  assert.equal(nextTurn(), undefined, "each notice is delivered once");
  first.resolve();
  panel.handleInput("p");
  panel.handleInput("q");
  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
});
