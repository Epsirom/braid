import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BraidJobs, type ControlNotice, type NodeCompletion } from "../jobs.js";
import braidExtension, { createBraidTools, formatControlNotice } from "../index.js";
import type { BraidPanel } from "../command.js";
import { context, deferred, input, response } from "./helpers.js";

const plainTheme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

/** a → b; the first model request (a's) waits for `gate`. */
function chain(pauseAfter = false) {
  const gate = deferred<void>();
  let calls = 0;
  const ctx = context(async () => {
    if (++calls === 1) await gate.promise;
    return response(`answer ${calls}`);
  });
  const graph = { ...input, nodes: [{ ...input.nodes[0]!, ...pauseAfter ? { pauseAfter: true } : {} }, { type: "execute" as const, id: "b", prompt: "next" }],
    edges: [{ from: "a", to: "b" }] };
  return { ctx, graph, gate, calls: () => calls };
}

test("braid_pause after=true holds a running execution's result until braid_resume", { timeout: 10_000 }, async t => {
  const { ctx, graph, gate, calls } = chain();
  const notices: ControlNotice[] = [];
  const reminders: NodeCompletion[] = [];
  const jobs = new BraidJobs(undefined, node => { reminders.push(node); }, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", graph, undefined, undefined, ctx)).details!.handle;
  await until(() => calls() === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;

  await assert.rejects(tools.pauseTool.execute("no ids", { jobId: handle, after: true }, undefined, undefined, ctx), /requires executionIds/);
  const held = await tools.pauseTool.execute("hold", { jobId: handle, executionIds: [executionId], after: true }, undefined, undefined, ctx);
  assert.match(textOf(held), new RegExp(`${executionId} keep running and will be held when they finish`));
  assert.match(textOf(held), /"after":true/);
  assert.equal(jobs.get(handle)!.execution!.executions[executionId]!.suspension, undefined, "a hold does not suspend");
  const status = textOf(await tools.statusTool.execute("status", { jobId: handle, executionId }, undefined, undefined, ctx));
  assert.match(status, /Its result will be held when it finishes \(set by agent\)\./);
  assert.doesNotMatch(status, /The user/);

  gate.resolve();
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.includes(executionId));
  assert.equal(calls(), 1, "b waits for the release");
  assert.deepEqual(reminders.map(reminder => [reminder.nodeId, reminder.paused]), [["a", true]], "one pause reminder");
  await assert.rejects(tools.resumeTool.execute("late unhold", { jobId: handle, executionIds: [executionId], after: true }, undefined, undefined, ctx),
    /released with braid_resume\(\{jobId, expectedRevision, executionIds\}\) without after/);
  await tools.resumeTool.execute("release", { jobId: handle, expectedRevision: 0, executionIds: [executionId] }, undefined, undefined, ctx);
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");
  assert.equal(calls(), 2);
  assert.deepEqual(notices, [], "the parent's own holds send no notice");
});

test("braid_resume after=true removes a pauseAfter hold from a running execution only", { timeout: 10_000 }, async t => {
  const { ctx, graph, gate, calls } = chain(true);
  const reminders: NodeCompletion[] = [];
  const jobs = new BraidJobs(undefined, node => { reminders.push(node); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", graph, undefined, undefined, ctx)).details!.handle;
  await until(() => calls() === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;
  const status = textOf(await tools.statusTool.execute("status", { jobId: handle }, undefined, undefined, ctx));
  assert.match(status, new RegExp(`${executionId} · node a · running · holds when finished, set by pauseAfter`));
  const removed = await tools.resumeTool.execute("unhold", { jobId: handle, executionIds: [executionId], after: true }, undefined, undefined, ctx);
  assert.match(textOf(removed), /hold removed for .*; their results go downstream when they finish\./);
  assert.equal(jobs.get(handle)!.execution!.graph.nodes[0]!.pauseAfter, true, "the definition keeps pauseAfter");
  gate.resolve();
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");
  assert.equal(calls(), 2, "b ran without a resume");
  assert.deepEqual(reminders, [], "no pause reminder for a removed hold");
});

test("holds by the user notify the parent", { timeout: 10_000 }, async t => {
  const { ctx, graph, gate, calls } = chain();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const handle = jobs.start(graph, {}, ctx).handle;
  await until(() => calls() === 1);
  const executionId = Object.keys(jobs.get(handle)!.execution!.executions)[0]!;
  jobs.holdAfter(handle, [executionId], true, "user");
  const status = textOf(await createBraidTools(jobs).statusTool.execute("status", { jobId: handle, executionId }, undefined, undefined, ctx));
  assert.match(status, /set by user\)\. The user set this hold; do not remove it or release the result unless the user asks\./);
  jobs.holdAfter(handle, [executionId], false, "user");
  assert.deepEqual(notices.map(notice => notice.action), ["held", "unheld"]);
  assert.equal(formatControlNotice(notices[0]!),
    `The user set node "a" execution ${executionId} of Braid job ${handle} to hold its result once it finishes; downstream work waits for a resume. Do not release it unless the user asks; check the current state with braid_status({"jobId":"${handle}","executionId":"${executionId}"}).`);
  assert.equal(formatControlNotice(notices[1]!),
    `The user removed the hold on node "a" execution ${executionId} of Braid job ${handle}; its result goes downstream when it finishes.`);
  gate.resolve();
  await jobs.wait(handle);

});

test("h in /braid holds, unholds, and releases the selected execution with one notice per change kind", { timeout: 10_000 }, async () => {
  const { ctx, graph, gate, calls } = chain();
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
    { message: { content: string; details: { notices: string[] } } } | undefined;
  await tools.get("braid")!.execute("submit", graph, undefined, undefined, ctx);
  await until(() => calls() === 1);
  let panel!: BraidPanel;
  await commands.get("braid")!.handler("", { mode: "tui", ui: { custom: async (factory: (...args: unknown[]) => BraidPanel) => {
    panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, plainTheme, {}, () => {});
  } } });
  panel.render(160);
  panel.handleInput("h");
  assert.doesNotMatch(panel.render(160).join("\n"), /Holding/, "h needs a selected node");
  panel.handleInput("v");
  assert.match(panel.render(160).join("\n"), /h hold/);
  panel.handleInput("h");
  assert.match(panel.render(160).join("\n"), /Holding · the execution keeps running/);
  panel.handleInput("h");
  assert.match(panel.render(160).join("\n"), /Hold removed/);
  panel.handleInput("h");
  gate.resolve();
  await until(() => panel.render(160).join("\n").includes("1 paused"));
  panel.handleInput("h");
  assert.match(panel.render(160).join("\n"), /Released · the result goes downstream/);
  await until(() => calls() === 2);
  assert.deepEqual(sent.filter(message => (message as { customType?: string }).customType === "braid-control"), [], "user holds do not wake the parent");
  const notices = nextTurn()!.message.details.notices;
  assert.equal(notices.length, 2, "the latest hold change and the release, one each");
  assert.match(notices[0]!, /^The user set node "a" execution .* to hold its result/);
  assert.match(notices[1]!, /^The user resumed node "a" execution/);
  panel.handleInput("q");
  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
});
