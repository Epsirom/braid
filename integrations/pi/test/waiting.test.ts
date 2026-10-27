import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BraidJobs, type WaitingNotice } from "../jobs.js";
import braidExtension, { createBraidTools } from "../index.js";
import { formatWaiting } from "../status-text.js";
import { context, deferred, response } from "./helpers.js";

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const node = (id: string, extra: { pauseAfter?: boolean } = {}) => ({ type: "execute" as const, id, prompt: `task:${id}`, ...extra });
const graph = (...nodes: ReturnType<typeof node>[]) => ({ goal: "Wait for the parent", nodes, edges: [] });

/** Answers each node by the marker in its prompt. A gate holds a node's first answer; `tools` nodes ask for a tool first, so they reach a checkpoint. */
function workers(gates: Record<string, Promise<void>> = {}, tools: string[] = []) {
  const calls = new Map<string, number>();
  const ctx = context(async (_signal, request) => {
    const id = /task:(\w+)/.exec(JSON.stringify(request.messages))?.[1] ?? "?";
    const call = (calls.get(id) ?? 0) + 1;
    calls.set(id, call);
    if (call === 1) await gates[id];
    if (call === 1 && tools.includes(id))
      return { ...response(), stopReason: "toolUse", content: [{ type: "toolCall", id: `call-${id}`, name: "missing_tool", arguments: {} }] };
    return response(`${id} done`);
  });
  return { ctx, calls: (id: string) => calls.get(id) ?? 0 };
}

function setup(t: test.TestContext) {
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  t.after(() => jobs.dispose());
  const executionOf = (handle: string, id: string) => Object.values(jobs.get(handle)!.execution!.executions).find(execution => execution.id === id)?.executionId ?? "";
  return { jobs, tools: createBraidTools(jobs), waiting, executionOf };
}

test("the extension wakes the parent once when the last active execution leaves only held work", { timeout: 10_000 }, async () => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ slow: gate.promise });
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { handle: string; execution?: { executions: Record<string, { id: string }> } } }> }>();
  const sent: { message: { customType: string; content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
  braidExtension({
    registerFlag: () => {}, getFlag: () => undefined,
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    sendMessage: (message: never, options: never) => { sent.push({ message, options }); },
  } as unknown as ExtensionAPI);
  const of = (type: string) => sent.filter(item => item.message.customType === type);
  const handle = (await tools.get("braid")!.execute("submit", graph(node("held", { pauseAfter: true }), node("slow")), undefined, undefined, ctx)).details.handle;
  await until(() => of("braid-node-completed").length === 1 && calls("slow") === 1);
  await settle();
  assert.equal(of("braid-waiting").length, 0, "slow is still running");
  gate.resolve();
  await until(() => of("braid-waiting").length === 1);
  const [wake] = of("braid-waiting");
  assert.deepEqual(wake!.options, { triggerTurn: true, deliverAs: "steer" });
  const status = await tools.get("braid_status")!.execute("status", { jobId: handle }, undefined, undefined, ctx);
  const held = Object.entries(status.details.execution!.executions).find(([, execution]) => execution.id === "held")![0];
  assert.equal(wake!.message.content, `[system-reminder] Braid job ${handle} has no active work at revision 0: nothing more runs until you act. ` +
    `It waits on the held result of node "held" execution ${held} (pauseAfter). ` +
    `Check it with braid_status({"jobId":"${handle}"}), then release held results or resume executions with ` +
    `braid_resume({"jobId":"${handle}","expectedRevision":0,"executionIds":[...]}) or braid_update with resume, ` +
    "fail single executions with braid_cancel and executionIds, or cancel the job with braid_cancel. [/system-reminder]");
  // Only a job with a graph timeout is told that its deadline keeps running.
  const notice: WaitingNotice = { jobId: "id", handle, revision: 0, eventSequence: 0, waitingOn: [{ kind: "held", executionId: held, nodeId: "held", source: "definition" }] };
  assert.match(formatWaiting({ ...notice, graphTimeoutMs: 60_000 }), /braid_cancel\. The graph timeout keeps running while it waits\.$/);
  assert.doesNotMatch(formatWaiting({ ...notice, graphTimeoutMs: 60_000, waitingOn: [{ kind: "job", source: "graph_timeout" }] }), /keeps running/);
  await tools.get("braid_resume")!.execute("release", { jobId: handle, expectedRevision: 0, executionIds: [held] }, undefined, undefined, ctx);
  await until(() => of("braid-completed").length === 1);
  assert.equal(of("braid-waiting").length, 1, "a finished job is not reported as waiting");
  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
});

test("work only the user paused or held does not wake the parent", { timeout: 10_000 }, async t => {
  const [a, b] = [deferred<void>(), deferred<void>()];
  const { ctx, calls } = workers({ a: a.promise, b: b.promise });
  const { jobs, tools, waiting, executionOf } = setup(t);
  const handle = (await tools.braidTool.execute("submit", graph(node("a"), node("b")), undefined, undefined, ctx)).details!.handle;
  await until(() => calls("a") === 1 && calls("b") === 1);
  jobs.holdAfter(handle, [executionOf(handle, "a")], true, "user");
  a.resolve();
  b.resolve();
  await until(() => jobs.get(handle)!.execution!.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0);
  jobs.cancel(handle);
  await jobs.wait(handle);
});

test("a user job pause does not wake the parent even when its own held work remains", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ slow: gate.promise });
  const { jobs, tools, waiting } = setup(t);
  const handle = (await tools.braidTool.execute("submit", graph(node("held", { pauseAfter: true }), node("slow")), undefined, undefined, ctx)).details!.handle;
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.length === 1 && calls("slow") === 1);
  jobs.pause(handle, undefined, "user");
  gate.resolve();
  await until(() => jobs.get(handle)!.execution!.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0);
  jobs.cancel(handle);
  await jobs.wait(handle);
});

test("the reminder names user-paused work to leave alone next to the parent's own", { timeout: 10_000 }, async t => {
  const [a, slow] = [deferred<void>(), deferred<void>()];
  const { ctx, calls } = workers({ a: a.promise, slow: slow.promise });
  const { jobs, tools, waiting, executionOf } = setup(t);
  const handle = (await tools.braidTool.execute("submit", graph(node("held", { pauseAfter: true }), node("a"), node("slow")), undefined, undefined, ctx)).details!.handle;
  await until(() => calls("a") === 1 && calls("slow") === 1);
  const userHeld = executionOf(handle, "a");
  jobs.holdAfter(handle, [userHeld], true, "user");
  a.resolve();
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.length === 2);
  slow.resolve();
  await until(() => waiting.length === 1);
  const held = executionOf(handle, "held");
  assert.deepEqual(new Set(waiting[0]!.waitingOn.map(item => JSON.stringify(item))), new Set([
    JSON.stringify({ kind: "held", executionId: held, nodeId: "held", source: "definition" }),
    JSON.stringify({ kind: "held", executionId: userHeld, nodeId: "a", source: "user" }),
  ]));
  const text = formatWaiting(waiting[0]!);
  assert.match(text, new RegExp(`It waits on the held result of node "held" execution ${held} \\(pauseAfter\\)\\.`));
  assert.match(text, new RegExp(`The user paused the held result of node "a" execution ${userHeld} \\(user\\): leave those unless the user asks\\.`));
  jobs.cancel(handle);
  await jobs.wait(handle);
});

test("the parent's own suspension of the last running execution does not wake it, but its later completion does", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ a: gate.promise }, ["a"]);
  const { jobs, tools, waiting, executionOf } = setup(t);
  const handle = (await tools.braidTool.execute("submit", graph(node("held", { pauseAfter: true }), node("a")), undefined, undefined, ctx)).details!.handle;
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.length === 1 && calls("a") === 1);
  const a = executionOf(handle, "a");
  await tools.pauseTool.execute("pause", { jobId: handle, executionIds: [a] }, undefined, undefined, ctx);
  gate.resolve();
  await until(() => jobs.get(handle)!.execution!.suspendedExecutionIds.includes(a) && jobs.get(handle)!.execution!.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0, "the parent paused it itself");
  await tools.resumeTool.execute("resume", { jobId: handle, expectedRevision: 0, executionIds: [a] }, undefined, undefined, ctx);
  await until(() => waiting.length === 1);
  const held = executionOf(handle, "held");
  assert.deepEqual(waiting[0]!.waitingOn, [{ kind: "held", executionId: held, nodeId: "held", source: "definition" }]);
  await tools.resumeTool.execute("release", { jobId: handle, expectedRevision: 0, executionIds: [held] }, undefined, undefined, ctx);
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");
  assert.equal(waiting.length, 1);
});

test("a timeout pause that leaves nothing active sends only its own reminder", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx } = workers({ a: gate.promise }, ["a"]);
  const timeouts: unknown[] = [];
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, pause => { timeouts.push(pause); }, undefined, notice => { waiting.push(notice); });
  t.after(() => jobs.dispose());
  const handle = (await createBraidTools(jobs).braidTool.execute("submit", { ...graph(node("a")), options: { nodeTimeoutMs: 50 } }, undefined, undefined, ctx)).details!.handle;
  await until(() => Object.values(jobs.get(handle)!.execution!.executions)[0]?.suspension?.source === "node_timeout");
  gate.resolve();
  await until(() => timeouts.length === 1 && jobs.get(handle)!.execution!.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0, "the timeout reminder already asks the parent to act");
  assert.match(formatWaiting({ jobId: "x", handle, revision: 0, eventSequence: 1, waitingOn: [{ kind: "suspended", executionId: "e", nodeId: "a", source: "node_timeout" }] }),
    /It waits on suspended node "a" execution e \(node timeout\)\./);
  jobs.cancel(handle);
  await jobs.wait(handle);
});
