import assert from "node:assert/strict";
import test from "node:test";
import { BraidJobs, type WaitingNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatWaiting } from "../status-text.js";
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

test("a rerun at its node's maxRuns wakes the parent with how to continue or stop", async () => {
  const rounds = new Set<string>();
  const runtime = llm(options => {
    const data = payload(options);
    if (data.nodeId !== "check" || rounds.has(data.execution.executionId)) return answer(data.nodeId);
    rounds.add(data.execution.executionId);
    return calls({ name: "decide", args: { choice: "again" } });
  });
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  const job = jobs.start({
    goal: "refine", nodes: [{ ...node("work"), maxRuns: 1 }, { type: "decision", id: "check", prompt: "review", choices: ["again", "done"] }],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "again" }],
  }, {}, context());
  await until(() => waiting.length === 1);
  assert.deepEqual(waiting[0]!.waitingOn, [{ kind: "limited", executionId: "work@2", nodeId: "work", source: "maxRuns" }]);
  assert.match(formatWaiting(waiting[0]!),
    /It waits on the rerun of node "work" execution work@2 \(its node's maxRuns\)\..*higher maxRuns in braid_update.*release it to end the rerun/);
  jobs.resume(job.handle, ["work@2"], 0);
  await jobs.wait(job.handle);
  const state = jobs.get(job.handle);
  assert.equal(state.status, "completed");
  assert.equal(state.execution.nodes.work!.executionId, "work@1");
  await jobs.dispose();
});
