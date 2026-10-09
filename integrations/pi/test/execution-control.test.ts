import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { BraidJobs, type NodeCompletion } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { context, deferred, input, response } from "./helpers.js";

test("Pi atomically updates a paused job, resumes, and retrieves immutable executions", { timeout: 5_000 }, async t => {
  const held = deferred<NodeCompletion>();
  const ctx = context(async () => response("old result"));
  const jobs = new BraidJobs(undefined, value => held.resolve(value));
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const submitted = await tools.braidTool.execute("submit", {
    ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }],
  }, undefined, undefined, ctx);
  const paused = await held.promise;
  assert.equal(paused.paused, true);
  assert.ok(paused.executionId);
  assert.equal(jobs.claimUsage(paused.handle), undefined);
  assert.deepEqual(jobs.progress(paused.handle), {
    total: 1, done: 1, failed: 0, running: [], paused: 1,
  });
  const receipt = JSON.parse((submitted.content[0] as { text: string }).text);
  assert.deepEqual(receipt.graph.nodes, [{ type: "execute", id: "a", pauseAfter: true }]);
  assert.deepEqual(receipt.graph.edges, []);
  await assert.rejects(tools.updateTool.execute("invalid topology", {
    jobId: paused.handle, expectedRevision: 0,
    upsertNodes: [{ type: "merge", id: "check" }],
    addEdges: [{ from: "a", to: "check", choice: "pass" }], resume: [paused.executionId],
  }, undefined, undefined, ctx), /no changes or resumes were applied.*Choice edge.*Retry the complete corrected patch/);
  assert.equal(jobs.get(paused.handle)!.execution!.revision, 0);
  assert.deepEqual(jobs.get(paused.handle)!.execution!.graph.nodes.map(node => node.id), ["a"]);
  assert.deepEqual(jobs.get(paused.handle)!.execution!.pausedExecutionIds, [paused.executionId]);
  await assert.rejects(tools.updateTool.execute("stale", { jobId: paused.handle, expectedRevision: 1, removeNodeIds: ["a"] }, undefined, undefined, ctx), /Revision conflict/);
  const updated = await tools.updateTool.execute("edit", {
    jobId: submitted.details!.handle, expectedRevision: 0,
    upsertNodes: [{ type: "execute", id: "a", prompt: "updated definition" }, { type: "execute", id: "b", prompt: "next" }],
    addEdges: [{ from: "a", executionId: paused.executionId, to: "b" }], resume: [paused.executionId],
  }, undefined, undefined, ctx);
  assert.equal(updated.details.execution!.revision, 1);
  assert.equal(jobs.progress(paused.handle)!.total, 2);
  const updateReceipt = JSON.parse((updated.content[0] as { text: string }).text);
  assert.deepEqual(updateReceipt.graph.nodes, [{ type: "execute", id: "a" }, { type: "execute", id: "b" }]);
  assert.deepEqual(updateReceipt.graph.edges, [{ from: "a", executionId: paused.executionId, to: "b" }]);
  await jobs.wait(paused.handle);
  const exact = jobs.getNode(paused.handle, undefined, paused.executionId);
  assert.equal(exact.output, "old result");
  assert.equal(jobs.get(paused.handle)!.result!.executions[paused.executionId]!.node.prompt, "work");
  assert.equal(jobs.get(paused.handle)!.result!.nodes.b!.status, "completed");
  assert.deepEqual(jobs.progress(paused.handle), {
    total: 2, done: 2, failed: 0, running: [], paused: 0,
  });
  await assert.rejects(tools.resumeTool.execute("late", { jobId: paused.handle, expectedRevision: 1, executionIds: [paused.executionId] }, undefined, undefined, ctx), /no longer/);
  assert.ok(jobs.claimUsage(paused.handle));
  assert.equal(jobs.claimUsage(paused.handle), undefined);
});

test("Pi loop reminders and status use a distinct execution ID for each iteration", { timeout: 5_000 }, async t => {
  const notifications: NodeCompletion[] = [];
  const ctx = context(async () => response());
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string; execution: { iteration: number } };
    if (payload.nodeId === "work" && payload.execution.iteration === 2) {
      const progress = jobs.progress(jobs.list()[0]!.handle)!;
      assert.equal(progress.total, 2);
      assert.ok(progress.done < progress.total, "a rerun resets the current definition progress");
      assert.deepEqual(progress.running, ["work"]);
    }
    if (payload.nodeId === "review" && worker.messages.length === 1) return {
      ...response(), stopReason: "toolUse" as const,
      content: [{ type: "toolCall" as const, id: "choice", name: "decide", arguments: { choice: payload.execution.iteration === 2 ? "done" : "again" } }],
    };
    return response(`iteration ${payload.execution.iteration}`);
  });
  const jobs = new BraidJobs(undefined, value => { notifications.push(value); });
  t.after(() => jobs.dispose());
  const { braidTool, statusTool } = createBraidTools(jobs);
  const job = await braidTool.execute("loop", { goal: "repeat", nodes: [
    { type: "execute", id: "work", prompt: "work", notifyOnCompletion: true },
    { type: "decision", id: "review", prompt: "review", choices: ["again", "done"] },
  ], edges: [{ from: "work", to: "review" }, { from: "review", to: "work", choice: "again", feedback: "cycle" }],
  loops: [{ id: "cycle", entry: "work", maxIterations: 2 }],
  }, undefined, undefined, ctx);
  await jobs.wait(job.details!.handle);
  assert.equal(jobs.get(job.details!.handle)!.status, "completed");
  assert.deepEqual(jobs.progress(job.details!.handle), {
    total: 2, done: 2, failed: 0, running: [], paused: 0,
  });
  assert.equal(Object.keys(jobs.get(job.details!.handle)!.result!.executions).length, 4);
  assert.deepEqual(notifications.map(value => value.iteration), [1, 2]);
  assert.notEqual(notifications[0]!.executionId, notifications[1]!.executionId);
  const first = await statusTool.execute("first", { jobId: job.details!.handle, executionId: notifications[0]!.executionId }, undefined, undefined, ctx);
  assert.match(JSON.stringify(first.content), /iteration 1/);
  assert.equal(jobs.getNode(job.details!.handle, "work").output, "iteration 2");
  const { selectedNode: _selected, ...legacyDetails } = first.details!;
  const theme = { fg: (_color: string, value: string) => value } as never;
  const legacyRender = statusTool.renderResult!({ ...first, details: legacyDetails }, { expanded: true, isPartial: false }, theme, {
    isError: false, args: { jobId: job.details!.handle, executionId: notifications[0]!.executionId },
  } as never).render(200).join("\n");
  assert.match(legacyRender, /iteration 1/);
  assert.doesNotMatch(legacyRender, /iteration 2/);
  assert.equal(jobs.claimUsage(job.details!.handle)!.input, 6);
});

test("Pi resume tool releases a held leaf without reopening the job", { timeout: 5_000 }, async t => {
  const held = deferred<NodeCompletion>();
  const ctx = context(async () => response());
  const jobs = new BraidJobs(undefined, value => held.resolve(value));
  t.after(() => jobs.dispose());
  const tools = createBraidTools(jobs);
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, ctx);
  const completion = await held.promise;
  await tools.resumeTool.execute("continue", { jobId: job.handle, expectedRevision: 0, executionIds: [completion.executionId] }, undefined, undefined, ctx);
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle)!.result!.revision, 0);
  assert.deepEqual(jobs.get(job.handle)!.execution!.pausedExecutionIds, []);
});

test("cancelled paused-policy executions still send one opted-in failure reminder", { timeout: 5_000 }, async t => {
  const ready = deferred<void>();
  const notifications: NodeCompletion[] = [];
  const ctx = context(async () => { ready.resolve(); return new Promise(() => {}); });
  const jobs = new BraidJobs(undefined, value => { notifications.push(value); });
  t.after(() => jobs.dispose());
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true, notifyOnCompletion: true }] }, {}, ctx);
  await ready.promise;
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.status, "failed");
  assert.equal(notifications[0]!.errorCode, "CANCELLED");
  assert.equal(notifications[0]!.paused, undefined);
});
