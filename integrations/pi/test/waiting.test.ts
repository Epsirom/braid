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
    "or cancel the job with braid_cancel. [/system-reminder]");
  // Only a job with a graph timeout is told that its deadline keeps running.
  const notice: WaitingNotice = { jobId: "id", handle, revision: 0, eventSequence: 0, waitingOn: [{ kind: "held", executionId: held, nodeId: "held", source: "definition" }] };
  assert.match(formatWaiting({ ...notice, graphTimeoutMs: 60_000 }), /braid_cancel\. The graph timeout keeps running while it waits\.$/);
  assert.doesNotMatch(formatWaiting({ ...notice, graphTimeoutMs: 60_000, waitingOn: [{ kind: "job", source: "graph_timeout" }] }), /keeps running/);
  // A job pause names the executions it suspended, so the cause is stated once.
  assert.match(formatWaiting({ ...notice, waitingOn: [{ kind: "suspended", executionId: "merge@2", nodeId: "merge", source: "graph_timeout" }, { kind: "job", source: "graph_timeout" }] }),
    /It waits on the job pause \(by the job's graphTimeoutMs limit\), which suspended node "merge" execution merge@2\. Check/);
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

test("status says which choice a node that runs only through a choice edge waits for", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ join: gate.promise });
  const { jobs, tools } = setup(t);
  const job = jobs.start({ goal: "Loop", nodes: [node("impl"), node("tests"), node("join"),
    { type: "decision", id: "review", prompt: "task:review", choices: ["again", "done"] }], edges: [
    { from: "impl", to: "join" }, { from: "tests", to: "join" }, { from: "join", to: "review" }, { from: "review", to: "impl", choice: "again" },
  ] }, {}, ctx);
  await until(() => calls("join") === 1);
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  assert.match(text(await tools.statusTool.execute("status", { jobId: job.handle }, undefined, undefined, ctx)),
    /^- impl@1 · node impl · pending · waiting: runs only after review chooses again$/m);
  assert.match(text(await tools.statusTool.execute("focused", { jobId: job.handle, executionId: "impl@1" }, undefined, undefined, ctx)),
    /^Execution impl@1 · node impl \(execute\) · pending · waiting: runs only after review chooses again$/m);
  gate.resolve();
});

test("braid_status shows running progress, answers an unchanged job briefly, and says what releasing a changed held result does", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ impl: gate.promise });
  const { jobs, tools } = setup(t);
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  const status = async () => text(await tools.statusTool.execute("status", { jobId: job.handle }, undefined, undefined, ctx));
  const job = jobs.start({ goal: "Impl and test", nodes: [node("impl"), node("test", { pauseAfter: true })], edges: [] }, {}, ctx);
  await until(() => calls("impl") === 1 && jobs.get(job.handle)!.execution!.pausedExecutionIds.length === 1);
  const full = await status();
  assert.match(full, /^- impl@1 · node impl · running · \d+ms so far · model for \d+ms · model requests 1, tool calls 0$/m);
  const unchanged = await status();
  assert.match(unchanged, /^Braid job job-\d+ · running · nothing changed since your full braid_status \d+ms ago \(revision 0\); that read still applies\.$/m);
  assert.match(unchanged, /^Running:\n- impl@1 · \d+ms so far · model for \d+ms · model requests 1, tool calls 0$/m);
  assert.match(unchanged, /end your turn instead of reading again/);
  assert.doesNotMatch(unchanged, /Executions/);
  // A new edge into the held test changes its inputs.
  await tools.updateTool.execute("edge", { jobId: job.handle, expectedRevision: 0, addEdges: [{ from: "impl", to: "test" }] }, undefined, undefined, ctx);
  const changed = await status();
  assert.match(changed, /^- test@1 · node test · completed · held, inputs changed; releasing it reruns its node with the new inputs, and this result does not go downstream/m);
  assert.match(text(await tools.statusTool.execute("focused", { jobId: job.handle, executionId: "test@1" }, undefined, undefined, ctx)),
    /^Its inputs changed; releasing it reruns its node with the new inputs, and this result does not go downstream\.$/m);
  await assert.rejects(tools.cancelTool.execute("cancel", { jobId: job.handle, executionIds: ["test@1"] }, undefined, undefined, ctx),
    /test@1 is completed and held: .*\. braid_cancel with executionIds fails only running or paused executions: release a held result with braid_resume, or replace its node with braid_update\./);
  gate.resolve();
});

test("a waiting reminder says when a held result's inputs changed, and offers braid_cancel with executionIds only for suspended work", () => {
  const notice: WaitingNotice = { jobId: "id", handle: "job-1", revision: 2, eventSequence: 0,
    waitingOn: [{ kind: "held", executionId: "test@2", nodeId: "test", source: "replan", inputsChanged: true }] };
  const held = formatWaiting(notice);
  assert.match(held, /the held result of node "test" execution test@2 \(its replan request; inputs changed; releasing it reruns its node with the new inputs, and this result does not go downstream\)/);
  assert.match(held, /braid_update with resume, or cancel the job with braid_cancel\.$/);
  assert.match(formatWaiting({ ...notice, waitingOn: [{ kind: "suspended", executionId: "a@1", nodeId: "a", source: "agent" }] }),
    /fail suspended executions with braid_cancel and executionIds, or cancel the job with braid_cancel\.$/);
});

test("resuming a running execution that will be held says when and what to do now; job reads name each execution's inputs", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const { ctx, calls } = workers({ a: gate.promise });
  const { jobs, tools } = setup(t);
  const job = jobs.start({ goal: "Chain", nodes: [node("a", { pauseAfter: true }), node("b")], edges: [{ from: "a", to: "b" }] }, {}, ctx);
  await until(() => calls("a") === 1);
  const hint = /a@1 is running and is held when it finishes: resume it then; its completion reminder says when\. To change it now, upsert its node in braid_update without resuming it: that replaces the running execution/;
  await assert.rejects(tools.resumeTool.execute("resume", { jobId: job.handle, expectedRevision: 0, executionIds: ["a@1"] }, undefined, undefined, ctx), hint);
  await assert.rejects(tools.updateTool.execute("update", { jobId: job.handle, expectedRevision: 0, resume: ["a@1"] }, undefined, undefined, ctx), hint);
  gate.resolve();
  await until(() => jobs.get(job.handle)!.execution!.pausedExecutionIds.length === 1);
  await tools.resumeTool.execute("release", { jobId: job.handle, expectedRevision: 0, executionIds: ["a@1"] }, undefined, undefined, ctx);
  await jobs.wait(job.jobId);
  const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
  assert.match(text(await tools.statusTool.execute("status", { jobId: job.handle }, undefined, undefined, ctx)), /^- b@1 · node b · completed · [^\n]* · inputs a@1$/m);
});
