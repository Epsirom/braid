import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createBraidTools } from "../index.js";
import { BraidJobs, type NodeCompletion } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const until = async (condition: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!condition() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), "condition not reached");
};

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;
const text = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

test("focused status includes current control state and renders the superseded execution", { timeout: 5_000 }, async t => {
  const completions: NodeCompletion[] = [];
  const jobs = new BraidJobs(undefined, value => { completions.push(value); });
  t.after(() => jobs.dispose());
  const ctx = context(async () => response("The selected execution's complete output.\nSecond line."));
  const job = jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, ctx);
  await until(() => completions.length === 1);
  const paused = completions[0]!;
  // Replacing the held execution runs a@2 and holds it too.
  jobs.update(job.handle, { expectedRevision: 0,
    upsertNodes: [{ ...input.nodes[0]!, prompt: "new definition", pauseAfter: true }] });
  await until(() => completions.length === 2);
  assert.equal(completions[1]!.executionId, "a@2");
  const { statusTool } = createBraidTools(jobs);
  for (const selector of [{ executionId: paused.executionId }, { nodeId: "a" }]) {
    const result = await statusTool.execute("focused", { jobId: job.handle, ...selector }, undefined, undefined, ctx);
    const body = text(result);
    assert.match(body, /^Braid job job-1 · running · Graph \w+ · revision 1 · paused executions: a@2\n/);
    if (selector.executionId) assert.ok(body.includes(`Execution ${paused.executionId} · node a (execute) · completed\nSuperseded by a@2; it no longer feeds successors.\n`));
    else assert.ok(body.includes("Execution a@2 · node a (execute) · completed · held\nIt replaces a@1.\n"));
    assert.match(body, /Output:\nThe selected execution's complete output\.\nSecond line\./);
    assert.doesNotMatch(body, /new definition/);
    assert.equal(result.usage, undefined);
    for (const expanded of [false, true]) {
      const rendered = statusTool.renderResult!(result, { expanded, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
      assert.match(rendered, /Braid node a · completed/);
      assert.ok(rendered.includes(selector.executionId ?? "a@2"));
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
});

test("large running status keeps control fields first and saves the full text", { timeout: 5_000 }, async t => {
  const held = deferred<NodeCompletion>();
  const jobs = new BraidJobs(undefined, value => held.resolve(value));
  t.after(() => jobs.dispose());
  const output = "finding\n".repeat(15_000);
  const ctx = context(async () => response(output));
  const job = jobs.start({ ...input, goal: "g".repeat(70_000), nodes: [{ ...input.nodes[0]!, pauseAfter: true }] }, {}, ctx);
  const paused = await held.promise;
  const { statusTool } = createBraidTools(jobs);
  const claimUsage = t.mock.method(jobs, "claimUsage");
  const read = await statusTool.execute("running", { jobId: job.handle }, undefined, undefined, ctx);
  assert.equal(claimUsage.mock.callCount(), 0, "a running snapshot must not claim terminal usage after asynchronous file export");
  const content = text(read);
  assert.ok(content.length < 52_000);
  assert.match(content, new RegExp(`^Braid job job-1 · running\nID: \\S+\nGraph \\w+ · revision 0 · paused executions: ${paused.executionId}\nStarted .*\nGoal: g{2000}… \\[70000 chars\\]\n`));
  const path = content.match(/\[Truncated\. Full text: (.+)\]$/)![1]!;
  assert.equal(read.details!.fullOutputPath, path);
  t.after(() => rm(dirname(path), { recursive: true }));
  const saved = await readFile(path, "utf8");
  assert.ok(saved.includes(`## a · ${paused.executionId}\n${output}`));
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
});

test("failed-node provider usage survives in focused and whole-job status", { timeout: 5_000 }, async t => {
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
  const { statusTool } = createBraidTools(jobs);
  const focused = await statusTool.execute("failed-node", { jobId: job.handle, nodeId: "a" }, undefined, undefined, ctx);
  const rendered = statusTool.renderResult!(focused, { expanded: false, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
  assert.match(rendered, /Braid node a · failed/);
  assert.match(rendered, /MODEL_ERROR: provider interrupted after a billed round/);
  assert.equal(focused.usage, undefined);
  const whole = await statusTool.execute("failed-job", { jobId: job.handle }, undefined, undefined, ctx);
  const content = text(whole);
  assert.match(content, /^Error: REQUIRED_NODE_FAILED: /m);
  assert.match(content, /^Usage: input \d+, output \d+ \(2 tokens\)$/m);
  assert.match(content, /^Graph failed · revision 0 · paused executions: none$/m);
  assert.equal(whole.usage!.totalTokens, 2);
  const again = await statusTool.execute("again", { jobId: job.handle }, undefined, undefined, ctx);
  assert.equal(again.usage, undefined);
});
