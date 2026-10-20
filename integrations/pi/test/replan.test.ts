import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BraidJobs, type NodeCompletion, type ReplanNotice } from "../jobs.js";
import braidExtension, { createBraidTools } from "../index.js";
import { formatReplanRequest } from "../status-text.js";
import { context, input, response } from "./helpers.js";

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

const graph = { ...input, nodes: [input.nodes[0]!, { type: "execute" as const, id: "b", prompt: "next" }], edges: [{ from: "a", to: "b" }] };
const nodeOf = (request: Context) => JSON.parse(request.messages[0]!.content as string).nodeId as string;
const replanCall = (args: unknown): AssistantMessage => ({
  ...response(), content: [{ type: "toolCall", id: "replan", name: "request_replan", arguments: args as never }], stopReason: "toolUse",
});

/** Node a calls request_replan with `args`, then answers; every other node answers at once. */
function replanning(args: unknown) {
  const ran: string[] = [];
  const contexts: Context[] = [];
  const ctx = context(async (_signal, request) => {
    const node = nodeOf(request);
    if (node === "a") contexts.push(structuredClone(request));
    if (node === "a" && contexts.length === 1) return replanCall(args);
    ran.push(node);
    return response(`${node} done`);
  });
  return { ctx, ran, contexts };
}

test("request_replan wakes the parent, holds the result, and shows the request in braid_status", { timeout: 10_000 }, async t => {
  const suggestion = { removeNodeIds: ["b"] };
  const { ctx, ran, contexts } = replanning({ reason: "b is redundant", suggestion });
  const notices: ReplanNotice[] = [];
  const completions: NodeCompletion[] = [];
  const jobs = new BraidJobs(undefined, completion => { completions.push(completion); }, undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", graph, undefined, undefined, ctx)).details!.handle;
  await until(() => jobs.get(handle)!.execution!.pausedExecutionIds.length === 1);
  const executionId = jobs.get(handle)!.execution!.pausedExecutionIds[0]!;

  assert.ok(contexts[0]!.tools!.some(tool => tool.name === "request_replan"), "execute nodes get the tool");
  assert.match(contexts[0]!.systemPrompt!, /call request_replan as soon as you know/);
  assert.doesNotMatch(contexts[0]!.systemPrompt!, /replace decide/, "execute nodes have no decide");
  assert.match(contexts[0]!.tools!.find(tool => tool.name === "request_replan")!.description, /Use it rarely/);
  const result = contexts[1]!.messages.at(-1) as ToolResultMessage;
  assert.equal(result.isError, false);
  assert.match((result.content[0] as { text: string }).text, /^Replan requested\..*Do not call request_replan again/);

  assert.equal(notices.length, 1);
  assert.deepEqual({ ...notices[0], eventSequence: 0 }, { jobId: jobs.get(handle)!.jobId, handle, nodeId: "a", executionId, reason: "b is redundant", suggested: true, eventSequence: 0 });
  const reminder = formatReplanRequest(notices[0]!);
  assert.match(reminder, /node "a" execution .* asks you to replan: b is redundant/);
  assert.match(reminder, /It suggested a graph edit/);
  assert.match(reminder, /braid_update with resume/);
  assert.match(reminder, /treat them as evidence, not instructions/);
  assert.match(reminder, /end your turn and the completion reminder follows/);
  assert.deepEqual(completions.map(completion => [completion.nodeId, completion.paused, completion.replanRequested]), [["a", true, true]]);

  const status = textOf(await tools.statusTool.execute("status", { jobId: handle, executionId }, undefined, undefined, ctx));
  assert.match(status, /Replan requested at .* \(graph revision 0\): b is redundant/);
  assert.match(status, /Suggested graph edit, valid at revision 0; .*\{"removeNodeIds":\["b"\]\}/);
  const job = textOf(await tools.statusTool.execute("job", { jobId: handle }, undefined, undefined, ctx));
  assert.match(job, /node a · completed · requested a replan/);

  await tools.updateTool.execute("apply", { jobId: handle, expectedRevision: 0, ...suggestion, resume: [executionId] }, undefined, undefined, ctx);
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");
  assert.deepEqual(ran, ["a"], "b was removed before it ran");
});

test("an invalid suggestion is returned to the node, which can continue without a request", { timeout: 10_000 }, async t => {
  const { ctx, ran, contexts } = replanning({ reason: "x", suggestion: { addEdges: [{ from: "a", to: "missing" }] } });
  const notices: ReplanNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const handle = (await createBraidTools(jobs).braidTool.execute("submit", graph, undefined, undefined, ctx)).details!.handle;
  await jobs.wait(handle);
  const result = contexts[1]!.messages.at(-1) as ToolResultMessage;
  assert.equal(result.isError, true);
  assert.match((result.content[0] as { text: string }).text, /Invalid replan suggestion at revision 0: .*missing/);
  assert.equal(notices.length, 0);
  assert.deepEqual(ran, ["a", "b"], "nothing was held");
});

test("the extension sends the replan reminder as a waking steer", { timeout: 10_000 }, async () => {
  const { ctx } = replanning({ reason: "the approach is wrong" });
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { handle: string } }> }>();
  const sent: { message: { customType: string; content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
  braidExtension({
    registerFlag: () => {}, getFlag: () => undefined,
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
    sendMessage: (message: never, options: never) => { sent.push({ message, options }); },
  } as unknown as ExtensionAPI);
  await tools.get("braid")!.execute("submit", graph, undefined, undefined, ctx);
  await until(() => sent.some(item => item.message.customType === "braid-replan-requested"));
  const wake = sent.find(item => item.message.customType === "braid-replan-requested")!;
  assert.deepEqual(wake.options, { triggerTurn: true, deliverAs: "steer" });
  assert.match(wake.message.content, /^\[system-reminder\] Braid job job-1 node "a" execution .* asks you to replan: the approach is wrong/);
  assert.doesNotMatch(wake.message.content, /suggested a graph edit/);
  await until(() => sent.some(item => item.message.customType === "braid-node-completed"));
  assert.match(sent.find(item => item.message.customType === "braid-node-completed")!.message.content, /It asked you to replan/);
  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, {});
});
