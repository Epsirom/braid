import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createBraidTools } from "../index.js";
import { BraidJobs, type NodeCompletion } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;
const text = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("focused status includes current control state and renders the historical execution", { timeout: 5_000 }, async t => {
  const held = deferred<NodeCompletion>();
  const jobs = new BraidJobs(undefined, value => held.resolve(value));
  t.after(() => jobs.dispose());
  const ctx = context(async () => response("The selected execution's complete output.\nSecond line."));
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, ctx);
  const paused = await held.promise;
  jobs.update(job.handle, { expectedRevision: 0,
    upsertNodes: [{ ...input.nodes[0]!, prompt: "new definition" }] });
  const { statusTool } = createBraidTools(jobs);
  for (const selector of [{ executionId: paused.executionId }, { nodeId: "a" }]) {
    const result = await statusTool.execute("focused", { jobId: job.handle, ...selector }, undefined, undefined, ctx);
    const body = JSON.parse(text(result));
    assert.equal(body.execution.revision, 1);
    assert.equal(body.node.revision, 0);
    assert.deepEqual(body.execution.pausedExecutionIds, [paused.executionId]);
    assert.equal(body.node.node.prompt, "work");
    assert.equal(result.usage, undefined);
    for (const expanded of [false, true]) {
      const rendered = statusTool.renderResult!(result, { expanded, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
      assert.match(rendered, /Braid node a · completed/);
      assert.ok(rendered.includes(paused.executionId));
      assert.match(rendered, /selected execution's complete output/);
      assert.match(rendered, /Second line/);
      assert.doesNotMatch(rendered, /Braid executing|new definition/);
    }
  }
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
  const final = jobs.get(job.handle)!;
  assert.equal(final.status, "cancelled");
  assert.equal(final.live.status, "failed");
  assert.equal(final.live.error?.code, "CANCELLED");
  assert.deepEqual(final.live.pausedExecutionIds, []);
  assert.deepEqual(final.execution!.pausedExecutionIds, []);
  if (final.fullOutputPath) t.after(() => rm(dirname(final.fullOutputPath!), { recursive: true }));
});

test("large running status retains control fields and saves a retrievable current snapshot", { timeout: 5_000 }, async t => {
  const held = deferred<NodeCompletion>();
  const jobs = new BraidJobs(undefined, value => held.resolve(value));
  t.after(() => jobs.dispose());
  const ctx = context(async () => response("complete"));
  const job = jobs.start({ ...input, goal: "g".repeat(70_000), nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, ctx);
  const paused = await held.promise;
  const { statusTool } = createBraidTools(jobs);
  const claimUsage = t.mock.method(jobs, "claimUsage");
  const read = await statusTool.execute("running", { jobId: job.handle }, undefined, undefined, ctx);
  assert.equal(claimUsage.mock.callCount(), 0, "a running snapshot must not claim terminal usage after asynchronous file export");
  const content = text(read);
  assert.ok(content.length < 52_000);
  assert.match(content, /"revision": 0/);
  assert.match(content, /"pausedExecutionIds"/);
  assert.ok(content.includes(paused.executionId));
  assert.match(content, /Full status snapshot:/);
  const path = read.details!.fullOutputPath!;
  assert.ok(path);
  t.after(() => rm(dirname(path), { recursive: true }));
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.execution.graph.goal.length, 70_000);
  assert.equal(saved.execution.nodes.a.output, "complete");
  assert.deepEqual(saved.execution.pausedExecutionIds, [paused.executionId]);
  assert.equal(jobs.get(job.handle)!.fullOutputPath, undefined, "a running snapshot must not become the final result path");
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
  const finalPath = jobs.get(job.handle)!.fullOutputPath;
  if (finalPath) t.after(() => rm(dirname(finalPath), { recursive: true }));
});

test("failed-node provider usage survives truncated status and final result export", { timeout: 5_000 }, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  let calls = 0;
  const ctx = context(async () => {
    if (++calls > 1) throw new Error("provider interrupted after a billed round");
    return { ...response(), stopReason: "toolUse", content: [
      { type: "toolCall", id: "inspect", name: "ls", arguments: { path: "." } },
    ] };
  });
  const job = jobs.start({ ...input, goal: "g".repeat(70_000), nodes: [{ ...input.nodes[0]!, requireSuccess: true }] }, {}, ctx);
  await jobs.wait(job.handle);
  const final = jobs.get(job.handle)!;
  assert.equal(final.status, "failed");
  assert.equal(final.live.status, "failed");
  assert.equal(final.result!.metadata.usage.inputTokens, 0);
  assert.equal(final.usage!.totalTokens, 2, "Pi must retain the billed round even though the runner never returned usage");
  const path = final.fullOutputPath!;
  assert.ok(path);
  t.after(() => rm(dirname(path), { recursive: true }));
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.piUsage, final.usage);
  const { statusTool } = createBraidTools(jobs);
  const focused = await statusTool.execute("failed-node", { jobId: job.handle, nodeId: "a" }, undefined, undefined, ctx);
  const rendered = statusTool.renderResult!(focused, { expanded: false, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
  assert.match(rendered, /Braid node a · failed/);
  assert.match(rendered, /MODEL_ERROR: provider interrupted after a billed round/);
  assert.equal(focused.usage, undefined);
  const whole = await statusTool.execute("failed-job", { jobId: job.handle }, undefined, undefined, ctx);
  const content = text(whole);
  assert.match(content, /"code": "REQUIRED_NODE_FAILED"/);
  assert.match(content, /"totalTokens": 2/);
  assert.match(content, /"revision": 0/);
  assert.match(content, /Full result\/log:/);
  assert.equal(whole.usage!.totalTokens, 2);
  const again = await statusTool.execute("again", { jobId: job.handle }, undefined, undefined, ctx);
  assert.equal(again.usage, undefined);
});
