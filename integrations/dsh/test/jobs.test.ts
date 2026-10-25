import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { BraidJobs, type Completion } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
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

test("graph timeout keeps running through holds, then pauses the job, or fails it with onLimit fail", async () => {
  const held = { ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] };
  const jobs = new BraidJobs(llm());
  const failing = jobs.start(held, { graphTimeoutMs: 60, onLimit: "fail" }, context());
  await jobs.wait(failing.handle);
  assert.equal(jobs.get(failing.handle).status, "failed");
  assert.equal(jobs.get(failing.handle).execution.pausedExecutionIds.length, 0);
  const pausing = jobs.start(held, { graphTimeoutMs: 60 }, context());
  await until(() => jobs.get(pausing.handle).execution.pause?.source === "graph_timeout");
  assert.equal(jobs.get(pausing.handle).status, "running");
  assert.equal(jobs.get(pausing.handle).execution.pausedExecutionIds.length, 1);
  await jobs.dispose();
});

test("status results are text documents; long ones keep controls first and save the full text", async () => {
  const output = "finding\n".repeat(15_000);
  const jobs = new BraidJobs(llm(() => answer(output)));
  const exec = { signal: new AbortController().signal } as import("@deepseek-ai/dsh-tools").ToolRunContext;
  const [, status] = createBraidTools(() => jobs, () => { throw new Error("should not submit"); });
  const paths: string[] = [];
  try {
    const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, context());
    await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1);
    const executionId = jobs.get(job.handle).execution.pausedExecutionIds[0]!;
    const whole = await status!.execute({ jobId: job.handle }, exec) as ToolValue;
    const focused = await status!.execute({ jobId: job.handle, executionId }, exec) as ToolValue;
    for (const [value, name] of [[whole, "status.txt"], [focused, "node.txt"]] as const) {
      assert.ok(Buffer.byteLength(value.text) < 51_000);
      assert.equal(value.truncated, true);
      const path = value.fullOutputPath as string; paths.push(path);
      assert.ok(path.endsWith(name));
      assert.ok(value.text.endsWith(`\n[Truncated. Full text: ${path}]`));
      assert.ok((await readFile(path, "utf8")).includes(output));
      assert.deepEqual(status!.output.render({}, value as never), [{ type: "text", text: value.text }]);
      const meta = status!.output.presentationMeta!({}, value as never) as Record<string, unknown>;
      assert.equal(meta.text, undefined);
      assert.deepEqual(meta.execution, { status: "waiting", revision: 0, pausedExecutionIds: [executionId], suspendedExecutionIds: [], total: 1, completed: 1 });
    }
    assert.match(whole.text, new RegExp(`^Braid job job-1 · running\nID: \\S+\nGraph waiting · revision 0 · paused executions: ${executionId}\n`));
    assert.match(focused.text, new RegExp(`^Braid job job-1 · running · Graph waiting · revision 0 · paused executions: ${executionId}\nExecution ${executionId} · node a \\(execute\\) · completed\n`));
    assert.deepEqual(focused.node, { id: "a", executionId, status: "completed" });
    const list = await status!.execute({}, exec) as ToolValue;
    assert.match(list.text, /^1 Braid job in this session, newest first:\n- job-1 · running · /);
    assert.deepEqual(list.jobs, [{ jobId: job.jobId, handle: "job-1", status: "running" }]);
  } finally {
    await jobs.dispose();
    for (const path of paths) await rm(dirname(path), { recursive: true });
  }
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
