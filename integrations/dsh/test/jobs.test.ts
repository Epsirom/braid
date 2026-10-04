import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BraidJobs, type Completion } from "../jobs.js";
import { boundedResult, createBraidTools } from "../tools.js";
import { answer, calls, context, input, llm, payload, until } from "./helpers.js";

test("immediate submission, exact handles, snapshots, and terminal reminders", async () => {
  const notifications: Completion[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const jobs = new BraidJobs(llm(async () => { await held; return answer(); }), value => notifications.push(value));
  const job = jobs.start(input, {}, context());
  assert.equal(job.status, "running"); assert.equal(job.handle, "job-1"); assert.equal(notifications.length, 0);
  assert.equal(jobs.get(job.jobId).handle, job.handle);
  assert.throws(() => jobs.get("job"), /exact session handle/);
  (job.execution.graph.nodes as unknown[]).length = 0;
  assert.equal(jobs.get(job.handle).execution.graph.nodes.length, 1);
  release(); await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed"); assert.equal(notifications.length, 1);
  assert.equal(jobs.get(job.handle).usage.totalTokens, 10);
  await jobs.dispose(); assert.throws(() => jobs.start(input, {}, context()), /closed/);
});

test("pause reminders, atomic update/resume, stale revisions and focused historical reads", async () => {
  const notifications: Completion[] = [];
  const jobs = new BraidJobs(llm(), value => notifications.push(value));
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true, notifyOnCompletion: true }] }, {}, context());
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1);
  const before = jobs.get(job.handle).execution;
  const executionId = before.pausedExecutionIds[0]!;
  assert.equal(notifications.length, 1); assert.equal(notifications[0]!.paused, true);
  assert.throws(() => jobs.update(job.handle, { expectedRevision: 100, upsertNodes: [{ type: "execute", id: "b", prompt: "new" }] }), /revision/i);
  assert.deepEqual(jobs.get(job.handle).execution, before);
  jobs.update(job.handle, { expectedRevision: before.revision, upsertNodes: [{ type: "execute", id: "b", prompt: "new" }], addEdges: [{ from: "a", to: "b", executionId }], resume: [executionId] });
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  assert.equal(jobs.getNode(job.handle, "a", executionId).output, "done");
  assert.throws(() => jobs.getNode(job.handle, "b", executionId), /Unknown/);
  assert.throws(() => jobs.resume(job.handle, [executionId], 1), /no longer accepting/i);
  await jobs.dispose();
});

test("failed provider rounds remain in usage and optional failures can recover", async () => {
  const jobs = new BraidJobs(llm(options => payload(options).nodeId === "bad" ? [
    { type: "usage", usage: { inputTokens: 5, outputTokens: 6 } },
    { type: "finish", reason: { kind: "error", failure: { code: "TEST", message: "provider failed" } } },
  ] : answer()));
  const job = jobs.start({ goal: "recover", nodes: [{ type: "execute", id: "bad", prompt: "bad" }, { type: "execute", id: "recover", prompt: "recover" }], edges: [{ from: "bad", to: "recover" }] }, {}, context());
  await jobs.wait(job.handle);
  assert.equal(jobs.getNode(job.handle, "recover").status, "completed");
  assert.equal(jobs.get(job.handle).usage.totalTokens, 21);
  assert.deepEqual(jobs.get(job.handle).usage, jobs.get(job.handle).usage);
  await jobs.dispose();
});

test("cancellation and disposal abort providers, wait for cleanup, and suppress disposed reminders", async () => {
  for (const dispose of [false, true]) {
    let entered = false, cleaned = false;
    const notifications: Completion[] = [];
    const jobs = new BraidJobs(llm(async options => {
      entered = true;
      await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
      cleaned = true; options.signal!.throwIfAborted(); return answer();
    }), value => notifications.push(value));
    const job = jobs.start(input, {}, context());
    await until(() => entered);
    if (dispose) await jobs.dispose(); else { jobs.cancel(job.handle); await jobs.wait(job.handle); }
    assert.ok(cleaned); assert.equal(jobs.get(job.handle).status, "cancelled");
    assert.equal(notifications.length, dispose ? 0 : 1);
    await jobs.dispose();
  }
});

test("graph timeout keeps running through pauses", async () => {
  const jobs = new BraidJobs(llm());
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, { graphTimeoutMs: 60 }, context());
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "failed");
  assert.equal(jobs.get(job.handle).execution.pausedExecutionIds.length, 0);
  await jobs.dispose();
});

test("large running and focused results preserve current controls and save full JSON", async () => {
  const original = { jobId: "uuid", handle: "job-1", status: "running", execution: { status: "waiting", revision: 4, pausedExecutionIds: ["execution"] }, node: { output: "x".repeat(100_000) } };
  const result = await boundedResult(original) as typeof original & { fullOutputPath: string; truncated: boolean };
  try {
    assert.equal(result.truncated, true); assert.deepEqual(result.execution, original.execution);
    assert.deepEqual(JSON.parse(await readFile(result.fullOutputPath, "utf8")), original);
  } finally { await rm(dirname(result.fullOutputPath), { recursive: true }); }
});

test("schemas reject malformed graph fields and invalid options before publishing jobs", async () => {
  const jobs = new BraidJobs(llm());
  const tools = createBraidTools(() => jobs, () => { throw new Error("should not submit"); });
  const exec = { signal: new AbortController().signal } as import("@deepseek-ai/dsh-tools").ToolRunContext;
  for (const invalid of [
    { ...input, nodes: [{ type: "bogus", id: "a", prompt: "bad" }] },
    { ...input, options: { maxToolCalls: 0 } },
    { ...input, options: { maxConcurrency: 1.2 } },
    { ...input, edges: [{ from: "a", to: "b", executionId: "no" }] },
  ]) await assert.rejects(tools[0]!.execute(invalid, exec), /Invalid braid arguments/);
  assert.equal(jobs.list().length, 0);
  assert.throws(() => jobs.start(input, { maxToolCalls: 0 }, context()), /positive/);
  await assert.rejects(tools[1]!.execute({ executionId: "no" }, exec), /requires jobId/);
  await jobs.dispose();
});

test("merge and integrate require explicit dispositions even outside Git", async () => {
  const seen = new Set<string>();
  const jobs = new BraidJobs(llm(options => {
    const id = payload(options).nodeId;
    if (id === "a" || seen.has(id)) return answer();
    seen.add(id);
    return calls({ name: "finish_merge", args: { dispositions: [] } });
  }));
  const job = jobs.start({ ...input, nodes: [...input.nodes, { type: "merge", id: "merge" }, { type: "integrate", id: "apply" }], edges: [{ from: "a", to: "merge" }, { from: "merge", to: "apply" }] }, {}, context());
  await jobs.wait(job.handle); assert.equal(jobs.get(job.handle).status, "completed");
  await jobs.dispose();
});
