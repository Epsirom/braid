import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { BraidJobs, type ControlNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatControlNotice } from "../status-text.js";
import { panelJob } from "../panel.js";
import { answer, calls, context, input, llm, until } from "./helpers.js";

/** The first request asks for a tool, so the worker makes a second request after it. */
function twoStep() {
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const requests: GenerateOptions[] = [];
  const runtime = llm(async (options, index) => {
    requests.push(structuredClone({ ...options, signal: undefined }) as unknown as GenerateOptions);
    if (index === 0) { await first; return calls({ name: "missing_tool", args: {} }); }
    return answer("finished after resume");
  });
  return { runtime, requests, release };
}

test("braid_pause suspends before the next model request; braid_resume continues the same conversation", async () => {
  const { runtime, requests, release } = twoStep();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, notice => { notices.push(notice); });
  const tools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
  const job = jobs.start(input, {}, context());
  await until(() => requests.length === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  const paused = await run("braid_pause", { jobId: job.handle, executionIds: [executionId] });
  assert.match(paused.text, new RegExp(`pause requested for ${executionId}`));
  release();
  await until(() => jobs.get(job.handle).execution.suspendedExecutionIds.includes(executionId));
  assert.equal(requests.length, 1);
  const status = await run("braid_status", { jobId: job.handle, executionId });
  assert.match(status.text, /Execution is suspended, paused by agent/);
  assert.deepEqual((status as unknown as { execution: { suspendedExecutionIds: string[] } }).execution.suspendedExecutionIds, [executionId]);
  await assert.rejects(run("braid_resume", { jobId: job.handle, executionIds: [executionId] }), /expectedRevision is required/);
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: [executionId] });
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).result!.nodes.a!.output, "finished after resume");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages[0], requests[0]!.messages[0], "the same conversation continues");
  assert.equal(requests[1]!.messages.length, 3, "prompt, tool call, and tool result");
  assert.deepEqual(notices, []);
  await jobs.dispose();
});

test("panel pause and resume are the user's: the parent gets notices and the projection shows the state", async () => {
  const { runtime, requests, release } = twoStep();
  const notices: ControlNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, notice => { notices.push(notice); });
  const job = jobs.start(input, {}, context());
  await until(() => requests.length === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  jobs.pause(job.handle, undefined, "user");
  release();
  await until(() => jobs.get(job.handle).execution.suspendedExecutionIds.length === 1);
  const projection = panelJob(jobs.get(job.handle));
  assert.equal(projection.pause!.source, "user");
  assert.deepEqual(projection.suspendedExecutionIds, [executionId]);
  assert.deepEqual(projection.executions[0]!.suspension, { state: "suspended", source: "user", suspendedAt: projection.executions[0]!.suspension!.suspendedAt });
  jobs.resumeJob(job.handle, "user");
  await jobs.wait(job.handle);
  assert.deepEqual(notices.map(notice => [notice.action, notice.source]), [["paused", "user"], ["resumed", "user"]]);
  assert.equal(formatControlNotice(notices[0]!),
    `The user paused the whole job of Braid job ${job.handle}. Paused work keeps its conversation and workspace. Do not resume it unless the user asks; check the current state with braid_status({"jobId":"${job.handle}"}).`);
  await jobs.dispose();
});
