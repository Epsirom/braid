import assert from "node:assert/strict";
import test from "node:test";
import { BraidJobs, type Completion, type WaitingNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatEdgeLimit, formatWaiting } from "../status-text.js";
import { answer, calls, context, llm, payload, until } from "./helpers.js";

const node = (id: string) => ({ type: "execute" as const, id, prompt: `task:${id}` });

test("a job paused at maxExecutions wakes the parent and resumes once braid_resume raises the limit", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = llm(async options => {
    if (JSON.stringify(options.messages).includes("task:a")) await gate;
    return answer("done");
  });
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  const tools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
  const job = jobs.start({ goal: "count", nodes: [node("a"), node("b"), node("c")], edges: [] }, { maxExecutions: 2, maxConcurrency: 2 }, context());
  await until(() => jobs.get(job.handle).execution.pause !== undefined);
  release();
  await until(() => waiting.length === 1);
  assert.deepEqual(waiting[0]!.waitingOn, [{ kind: "job", source: "execution_limit" }]);
  assert.match(formatWaiting(waiting[0]!), /raise its maxExecutions and resume the job with braid_resume\(\{"jobId":"job-1","limits":\{"maxExecutions":<higher>\}\}\)/);

  await assert.rejects(run("braid_resume", { jobId: job.handle }), /maxExecutions limit of 2; raise it with setLimits/);
  await assert.rejects(run("braid_resume", { jobId: job.handle, executionIds: ["x"], expectedRevision: 0, limits: { maxExecutions: 3 } }), /limits applies to the whole job/);
  await run("braid_resume", { jobId: job.handle, limits: { maxExecutions: 3 } });
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  await jobs.dispose();
});

test("a loop decision held at maxIterations sends a reminder that says how to continue or stop", async () => {
  const rounds = new Set<string>();
  const runtime = llm(options => {
    const data = payload(options);
    if (data.nodeId !== "check" || rounds.has(data.execution.executionId)) return answer(data.nodeId);
    rounds.add(data.execution.executionId);
    return calls({ name: "decide", args: { choice: "again" } });
  });
  const completions: Completion[] = [];
  const jobs = new BraidJobs(runtime, completion => { completions.push(completion); });
  const job = jobs.start({
    goal: "refine", nodes: [node("work"), { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again", limit: 1 }],
  }, {}, context());
  await until(() => completions.length === 1);
  const [held] = completions;
  assert.equal(held!.paused, true);
  assert.equal(held!.executionId, "check@2");
  assert.deepEqual(held!.edgeLimit, { from: "check", to: "work", choice: "again", limit: 1 });
  assert.match(formatEdgeLimit(job.handle, held!.executionId!, held!.edgeLimit!), /already fired its limit of 1 times.*the cycle ends/);
  jobs.resume(job.handle, [held!.executionId!], 0);
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  await jobs.dispose();
});
