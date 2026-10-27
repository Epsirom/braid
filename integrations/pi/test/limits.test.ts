import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments, type Context, type Tool } from "@earendil-works/pi-ai";
import { BraidJobs, type WaitingNotice } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { formatWaiting } from "../status-text.js";
import { context, deferred, response } from "./helpers.js";

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};
function validate(tool: Tool, args: Record<string, unknown>) {
  const definition: Tool = JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  return validateToolArguments(definition, { type: "toolCall", id: "schema", name: tool.name, arguments: JSON.parse(JSON.stringify(args)) });
}
const node = (id: string) => ({ type: "execute" as const, id, prompt: `task:${id}` });

test("Pi schemas accept maxRuns on nodes, job limits, and limits on job resume, but no edge limit", () => {
  const tools = createBraidTools(new BraidJobs());
  const graph = {
    goal: "refine", nodes: [{ ...node("work"), maxRuns: 3 }, { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }],
    options: { maxExecutions: 10, maxTokens: 1_000, onLimit: "pause" },
  };
  assert.deepEqual(validate(tools.braidTool, graph), graph);
  assert.deepEqual(validate(tools.resumeTool, { jobId: "job-1", limits: { maxExecutions: 20, graphTimeoutMs: 1_000, maxTokens: 5 } }),
    { jobId: "job-1", limits: { maxExecutions: 20, graphTimeoutMs: 1_000, maxTokens: 5 } });
  for (const limits of [{}, { maxExecutions: 0 }, { maxConcurrency: 2 }])
    assert.throws(() => validate(tools.resumeTool, { jobId: "job-1", limits }), /Validation failed/);
  const closing = { ...graph, edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", closesCycle: true }] };
  assert.deepEqual(validate(tools.braidTool, closing), closing);
  assert.throws(() => validate(tools.braidTool, { ...graph, options: { onLimit: "wait" } }), /Validation failed/);
  assert.throws(() => validate(tools.braidTool, { ...graph, nodes: [{ ...node("work"), maxRuns: 0 }] }), /Validation failed/);
  assert.throws(() => validate(tools.braidTool, { ...graph, edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", limit: 2 }] }),
    /Validation failed/);
});

test("a job paused at maxExecutions wakes the parent and resumes once braid_resume raises the limit", { timeout: 10_000 }, async t => {
  const gate = deferred<void>();
  const ctx = context(async (_signal, request: Context) => {
    if (JSON.stringify(request.messages).includes("task:a")) await gate.promise;
    return response("done");
  });
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const handle = (await tools.braidTool.execute("submit", { goal: "count", nodes: [node("a"), node("b"), node("c")], edges: [],
    options: { maxExecutions: 2, maxConcurrency: 2 } }, undefined, undefined, ctx)).details!.handle;
  await until(() => jobs.get(handle)!.execution?.pause !== undefined);
  assert.equal(waiting.length, 0, "a is still running");
  gate.resolve();
  await until(() => waiting.length === 1);
  assert.deepEqual(waiting[0]!.waitingOn, [{ kind: "job", source: "execution_limit" }]);
  assert.match(formatWaiting(waiting[0]!), new RegExp(`It waits on the job pause \\(by the job's maxExecutions limit\\)\\. .*` +
    `raise its maxExecutions and resume the job with braid_resume\\(\\{"jobId":"${handle}","limits":\\{"maxExecutions":<higher>\\}\\}\\)`));

  await assert.rejects(tools.resumeTool.execute("resume", { jobId: handle }, undefined, undefined, ctx), /maxExecutions limit of 2; raise it with setLimits/);
  await assert.rejects(tools.resumeTool.execute("resume", { jobId: handle, executionIds: ["x"], expectedRevision: 0, limits: { maxExecutions: 3 } }, undefined, undefined, ctx),
    /limits applies to the whole job/);
  const resumed = await tools.resumeTool.execute("resume", { jobId: handle, limits: { maxExecutions: 3 } }, undefined, undefined, ctx);
  assert.match(JSON.stringify(resumed.content), /resumed at revision 0/);
  await jobs.wait(handle);
  assert.equal(jobs.get(handle)!.status, "completed");
  assert.equal(jobs.get(handle)!.result!.nodes.c!.status, "completed");
});

test("a rerun at its node's maxRuns wakes the parent with how to continue or stop", { timeout: 10_000 }, async t => {
  const ctx = context(async (_signal, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string };
    if (payload.nodeId === "check" && worker.messages.length === 1) return {
      ...response(), stopReason: "toolUse" as const,
      content: [{ type: "toolCall" as const, id: "choice", name: "decide", arguments: { choice: "again" } }],
    };
    return response(payload.nodeId);
  });
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(undefined, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  t.after(() => jobs.dispose());
  const { braidTool, updateTool } = createBraidTools(jobs);
  const handle = (await braidTool.execute("loop", {
    goal: "refine", nodes: [{ ...node("work"), maxRuns: 1 }, { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }],
  }, undefined, undefined, ctx)).details!.handle;
  await until(() => waiting.length === 1);
  assert.deepEqual(waiting[0]!.waitingOn, [{ kind: "limited", executionId: "work@2", nodeId: "work", source: "maxRuns" }]);
  assert.match(formatWaiting(waiting[0]!),
    /It waits on the rerun of node "work" execution work@2 \(its node's maxRuns\)\..*higher maxRuns in braid_update.*release it to end the rerun/);
  assert.deepEqual(jobs.outstanding()[0]!.limitedExecutionIds, ["work@2"]);

  // Raising maxRuns starts the waiting rerun; releasing the next one ends the cycle.
  await updateTool.execute("raise", { jobId: handle, expectedRevision: 0, upsertNodes: [{ ...node("work"), maxRuns: 2 }] }, undefined, undefined, ctx);
  await until(() => waiting.length === 2);
  assert.deepEqual(jobs.get(handle)!.execution!.limitedExecutionIds, ["work@3"]);
  jobs.resume(handle, ["work@3"], 1);
  await jobs.wait(handle);
  const result = jobs.get(handle)!.result!;
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.work!.executionId, "work@2");
  assert.equal(result.executions["work@3"], undefined);
});
