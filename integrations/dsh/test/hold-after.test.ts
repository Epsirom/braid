import assert from "node:assert/strict";
import test from "node:test";
import { BraidJobs, type Completion, type ControlNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatControlNotice } from "../status-text.js";
import { panelJob } from "../panel.js";
import { answer, context, input, llm, until } from "./helpers.js";

/** a → b; a's model request waits for release. */
function chain(pauseAfter = false) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const runtime = llm(async (_options, index) => {
    requests++;
    if (index === 0) await gate;
    return answer(`answer ${index}`);
  });
  const graph = { ...input, nodes: [{ ...input.nodes[0]!, ...pauseAfter ? { pauseAfter: true } : {} }, { type: "execute" as const, id: "b", prompt: "next" }],
    edges: [{ from: "a", to: "b" }] };
  return { runtime, graph, release, requests: () => requests };
}

function tools(jobs: BraidJobs) {
  const all = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  return (name: string, args: object) => all.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
}

test("braid_pause after=true holds a running execution's result until braid_resume", async () => {
  const { runtime, graph, release, requests } = chain();
  const notices: ControlNotice[] = [];
  const reminders: Completion[] = [];
  const jobs = new BraidJobs(runtime, completion => { reminders.push(completion); }, notice => { notices.push(notice); });
  const run = tools(jobs);
  const job = jobs.start(graph, {}, context());
  await until(() => requests() === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  await assert.rejects(run("braid_pause", { jobId: job.handle, after: true }), /requires executionIds/);
  const held = await run("braid_pause", { jobId: job.handle, executionIds: [executionId], after: true });
  assert.match(held.text, new RegExp(`${executionId} keep running and will be held when they finish`));
  assert.equal(jobs.get(job.handle).execution.executions[executionId]!.suspension, undefined, "a hold does not suspend");
  const status = await run("braid_status", { jobId: job.handle, executionId });
  assert.match(status.text, /Its result will be held when it finishes \(set by agent\)\./);
  release();
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.includes(executionId));
  assert.equal(requests(), 1, "b waits for the release");
  assert.deepEqual(reminders.map(reminder => [reminder.nodeId, reminder.paused]), [["a", true]], "one pause reminder");
  await assert.rejects(run("braid_resume", { jobId: job.handle, executionIds: [executionId], after: true }), /without after/);
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: [executionId] });
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  assert.equal(requests(), 2);
  assert.deepEqual(notices, [], "the parent's own holds send no notice");
  await jobs.dispose();
});

test("braid_resume after=true removes a pauseAfter hold from a running execution only", async () => {
  const { runtime, graph, release, requests } = chain(true);
  const jobs = new BraidJobs(runtime);
  const run = tools(jobs);
  const job = jobs.start(graph, {}, context());
  await until(() => requests() === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  const status = await run("braid_status", { jobId: job.handle });
  assert.match(status.text, new RegExp(`${executionId} · node a · running · holds when finished, set by pauseAfter`));
  const removed = await run("braid_resume", { jobId: job.handle, executionIds: [executionId], after: true });
  assert.match(removed.text, /hold removed for .*; their results go downstream when they finish\./);
  assert.deepEqual(removed.pausedExecutionIds, []);
  release();
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  assert.equal(requests(), 2, "b ran without a resume");
  assert.equal(jobs.get(job.handle).execution.graph.nodes[0]!.pauseAfter, true, "the definition keeps pauseAfter");
  await jobs.dispose();
});

test("holds by the user notify the parent and appear in the panel projection", async () => {
  const { runtime, graph, release, requests } = chain();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, notice => { notices.push(notice); });
  const job = jobs.start(graph, {}, context());
  await until(() => requests() === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  jobs.holdAfter(job.handle, [executionId], true, "user");
  assert.deepEqual(panelJob(jobs.get(job.handle)).executions[0]!.holdAfter, { source: "user" });
  const status = await tools(jobs)("braid_status", { jobId: job.handle });
  assert.match(status.text, /The user paused this; do not resume it unless the user asks\./);
  jobs.holdAfter(job.handle, [executionId], false, "user");
  assert.equal(panelJob(jobs.get(job.handle)).executions[0]!.holdAfter, undefined);
  assert.deepEqual(notices.map(notice => notice.action), ["held", "unheld"]);
  assert.equal(formatControlNotice(notices[0]!),
    `The user set node "a" execution ${executionId} of Braid job ${job.handle} to hold its result once it finishes; downstream work waits for a resume. Do not release it unless the user asks; check the current state with braid_status({"jobId":"${job.handle}","executionId":"${executionId}"}).`);
  assert.equal(formatControlNotice(notices[1]!),
    `The user removed the hold on node "a" execution ${executionId} of Braid job ${job.handle}; its result goes downstream when it finishes.`);
  release();
  await jobs.wait(job.handle);
  await jobs.dispose();
});
