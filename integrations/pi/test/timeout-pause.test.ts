import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BraidJobs, type ControlNotice, type TimeoutPause } from "../jobs.js";
import braidExtension, { createBraidTools, formatControlNotice } from "../index.js";
import type { BraidPanel } from "../command.js";
import { formatTimeoutPause } from "../status-text.js";
import { context, input, response } from "./helpers.js";

const plainTheme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 5000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), "condition not reached");
};

/** The first model request runs until the node timeout interrupts it; later ones answer at once. */
function slowFirstRequest() {
  const requests: Context[] = [];
  const ctx = context(async () => response());
  const complete = async (_model: unknown, worker: Context, options: { signal: AbortSignal }): Promise<AssistantMessage> => {
    requests.push(structuredClone(worker));
    if (requests.length === 1) {
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    }
    return response("finished after timeout");
  };
  (ctx.modelRegistry as unknown as { complete: typeof complete }).complete = complete;
  return { ctx, requests };
}

const timed = { ...input, options: { nodeTimeoutMs: 200 } };

test("a node timeout pauses the execution, reports what it was doing, and resumes with a new budget", { timeout: 10_000 }, async t => {
  const { ctx, requests } = slowFirstRequest();
  const pauses: TimeoutPause[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, pause => { pauses.push(pause); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const submitted = await tools.braidTool.execute("submit", timed, undefined, undefined, ctx);
  const handle = submitted.details!.handle;
  await until(() => pauses.length === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;
  const pause = pauses[0]!;
  assert.equal(pause.executionId, executionId);
  assert.equal(pause.nodeId, "a");
  assert.equal(pause.nodeTimeoutMs, 200);
  assert.ok(pause.activeMs >= 200);
  assert.match(pause.activity!, /^model for /, "it was waiting for the model when the timeout fired");
  assert.equal(requests.length, 1, "the interrupted request is not resent before resume");

  const reminder = formatTimeoutPause(pause);
  assert.match(reminder, new RegExp(`Braid job ${handle} node "a" execution ${executionId} was paused because it exceeded its node timeout`));
  assert.match(reminder, /budget of 200ms/);
  assert.match(reminder, /braid_resume\(.*"executionIds":\[".*"\].*\)/);
  assert.match(reminder, /braid_cancel\(.*"executionIds"/);

  const status = textOf(await tools.statusTool.execute("status", { jobId: handle, executionId }, undefined, undefined, ctx));
  assert.match(status, /Execution is suspended, paused by node timeout after \d+ms \(budget 200ms\)/);
  assert.match(status, /Its node timeout ran out\. Resume it with braid_resume/);
  assert.deepEqual(jobs.outstanding()[0]!.timedOutExecutionIds, [executionId]);

  await assert.rejects(tools.resumeTool.execute("job", { jobId: handle, nodeTimeoutMs: 1000 }, undefined, undefined, ctx), /requires executionIds/);
  await tools.resumeTool.execute("resume", { jobId: handle, expectedRevision: 0, executionIds: [executionId], nodeTimeoutMs: 5_000 }, undefined, undefined, ctx);
  await jobs.wait(handle);
  const job = jobs.get(handle)!;
  assert.equal(job.status, "completed", JSON.stringify(job.result?.nodes.a?.error));
  assert.equal(job.result!.nodes.a!.output, "finished after timeout");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages, requests[0]!.messages, "the interrupted response never entered the context");
  assert.match(requests[1]!.systemPrompt!, /Node time budget: (4\d{3}|5000) ms remaining/);
});

test("braid_cancel with executionIds fails a timeout pause; a user cancellation sends a notice", { timeout: 10_000 }, async t => {
  for (const source of ["agent", "user"] as const) {
    const { ctx } = slowFirstRequest();
    const notices: ControlNotice[] = [];
    let paused = false;
    const jobs = new BraidJobs(undefined, undefined, notice => { notices.push(notice); }, () => { paused = true; });
    t.after(() => jobs.dispose());
    const tools = createBraidTools(jobs);
    const handle = (await tools.braidTool.execute("submit", timed, undefined, undefined, ctx)).details!.handle;
    await until(() => paused);
    const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;
    if (source === "agent") {
      const cancelled = await tools.cancelTool.execute("cancel", { jobId: handle, executionIds: [executionId] }, undefined, undefined, ctx);
      assert.match(textOf(cancelled), new RegExp(`cancellation requested for ${executionId}\\. They fail`));
    } else jobs.cancelExecutions(handle, [executionId], "user");
    await jobs.wait(handle);
    const job = jobs.get(handle)!;
    assert.equal(job.status, "completed", "an optional failure does not fail the job");
    assert.equal(job.result!.nodes.a!.error!.code, "NODE_TIMEOUT");
    assert.match(job.result!.nodes.a!.error!.message, new RegExp(`cancelled by ${source} while paused`));
    if (source === "agent") assert.deepEqual(notices, []);
    else assert.equal(formatControlNotice(notices[0]!),
      `The user cancelled node "a" execution ${executionId} of Braid job ${handle}. It failed; its successors follow the usual failure rules. Check the current state with braid_status(${JSON.stringify({ jobId: handle, executionId })}).`);
  }
});

test("onNodeTimeout=fail keeps failing on timeout", { timeout: 10_000 }, async t => {
  const { ctx } = slowFirstRequest();
  let paused = false;
  const jobs = new BraidJobs(undefined, undefined, undefined, () => { paused = true; });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", { ...input, options: { nodeTimeoutMs: 100, onNodeTimeout: "fail" } }, undefined, undefined, ctx)).details!.handle;
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.result!.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(paused, false);
});

test("a timeout pause wakes the parent, and x in /braid cancels the execution after confirmation", { timeout: 10_000 }, async () => {
  const { ctx } = slowFirstRequest();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { handle: string } }> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: { message: { customType: string; content: string }; options: { triggerTurn?: boolean } }[] = [];
  braidExtension({
    registerFlag: () => {}, getFlag: () => undefined,
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    sendMessage: (message: never, options: never) => { sent.push({ message, options }); },
  } as unknown as ExtensionAPI);
  const handle = (await tools.get("braid")!.execute("submit", timed, undefined, undefined, ctx)).details.handle;
  await until(() => sent.some(item => item.message.customType === "braid-node-timeout"));
  const wake = sent.find(item => item.message.customType === "braid-node-timeout")!;
  assert.equal(wake.options.triggerTurn, true, "only the parent can decide what happens next");
  assert.match(wake.message.content, /^\[system-reminder\] Braid job job-1 node "a" execution .* was paused because it exceeded its node timeout/);

  let panel!: BraidPanel;
  await commands.get("braid")!.handler("", { mode: "tui", ui: { custom: async (factory: (...args: unknown[]) => BraidPanel) => {
    panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, plainTheme, {}, () => {});
  } } });
  assert.match(panel.render(160).join("\n"), /‖ PAUSED a suspended ·[\s│]*timed out/);
  panel.handleInput("v");
  panel.handleInput("x");
  assert.match(panel.render(160).join("\n"), /Press x again to cancel this execution/);
  panel.handleInput("x");
  assert.match(panel.render(160).join("\n"), /Execution cancelled/);
  const notice = handlers.get("before_agent_start")!.map(handler => handler({}, { mode: "tui" }) as { message?: { content: string } } | undefined).find(result => result?.message);
  assert.match(notice!.message!.content, /The user cancelled node "a" execution/);
  panel.handleInput("q");
  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
  assert.ok(handle);
});
