import assert from "node:assert/strict";
import test from "node:test";
import { BraidJobs, type WaitingNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatWaiting } from "../status-text.js";
import { answer, calls, context, llm, until } from "./helpers.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const node = (id: string, extra: { pauseAfter?: boolean } = {}) => ({ type: "execute" as const, id, prompt: `task:${id}`, ...extra });
const graph = (...nodes: ReturnType<typeof node>[]) => ({ goal: "Wait for the parent", nodes, edges: [] });

/** Answers each node by the marker in its prompt. A gate holds a node's first answer; `tools` nodes ask for a tool first, so they reach a checkpoint. */
function setup(gates: Record<string, Promise<void>> = {}, tools: string[] = []) {
  const counts = new Map<string, number>();
  const runtime = llm(async options => {
    const id = /task:(\w+)/.exec(JSON.stringify(options.messages))?.[1] ?? "?";
    const call = (counts.get(id) ?? 0) + 1;
    counts.set(id, call);
    if (call === 1) await gates[id];
    return call === 1 && tools.includes(id) ? calls({ name: "missing_tool", args: {} }) : answer(`${id} done`);
  });
  const waiting: WaitingNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, undefined, undefined, undefined, notice => { waiting.push(notice); });
  const braidTools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const run = (name: string, args: object) => braidTools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
  const executionOf = (handle: string, id: string) => Object.values(jobs.get(handle).execution.executions).find(execution => execution.id === id)?.executionId ?? "";
  return { jobs, run, waiting, executionOf, calls: (id: string) => counts.get(id) ?? 0 };
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

test("the last active execution leaving only held work notifies once", async () => {
  const slow = gate();
  const { jobs, run, waiting, executionOf, calls } = setup({ slow: slow.promise });
  const job = jobs.start(graph(node("held", { pauseAfter: true }), node("slow")), {}, context());
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1 && calls("slow") === 1);
  await settle();
  assert.equal(waiting.length, 0, "slow is still running");
  slow.release();
  await until(() => waiting.length === 1);
  const held = executionOf(job.handle, "held");
  assert.deepEqual(waiting[0], { jobId: job.jobId, handle: job.handle, revision: 0, sequence: waiting[0]!.sequence,
    waitingOn: [{ kind: "held", executionId: held, nodeId: "held", source: "definition" }] });
  assert.equal(formatWaiting(waiting[0]!), `Braid job ${job.handle} has no active work at revision 0: nothing more runs until you act. ` +
    `It waits on the held result of node "held" execution ${held} (pauseAfter). ` +
    `Check it with braid_status({"jobId":"${job.handle}"}), then release held results or resume executions with ` +
    `braid_resume({"jobId":"${job.handle}","expectedRevision":0,"executionIds":[...]}) or braid_update with resume, ` +
    "fail single executions with braid_cancel and executionIds, or cancel the job with braid_cancel. The graph timeout keeps running while it waits.");
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: [held] });
  await jobs.wait(job.handle);
  assert.equal(waiting.length, 1);
  await jobs.dispose();
});

test("work only the user held, or a user job pause, does not notify", async () => {
  for (const pauseJob of [false, true]) {
    const [a, b] = [gate(), gate()];
    const { jobs, waiting, executionOf, calls } = setup({ a: a.promise, b: b.promise });
    const job = jobs.start(graph(node("a"), node("b", { pauseAfter: pauseJob })), {}, context());
    await until(() => calls("a") === 1 && calls("b") === 1);
    if (pauseJob) jobs.pause(job.handle, undefined, "user");
    else jobs.holdAfter(job.handle, [executionOf(job.handle, "a")], true, "user");
    a.release();
    b.release();
    await until(() => jobs.get(job.handle).execution.status === "waiting");
    await settle();
    assert.equal(waiting.length, 0, pauseJob ? "user job pause" : "user hold");
    jobs.cancel(job.handle);
    await jobs.wait(job.handle);
    await jobs.dispose();
  }
});

test("the parent's own suspension of the last running execution does not notify, but its later completion does", async () => {
  const a = gate();
  const { jobs, run, waiting, executionOf, calls } = setup({ a: a.promise }, ["a"]);
  const job = jobs.start(graph(node("held", { pauseAfter: true }), node("a")), {}, context());
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1 && calls("a") === 1);
  const id = executionOf(job.handle, "a");
  await run("braid_pause", { jobId: job.handle, executionIds: [id] });
  a.release();
  await until(() => jobs.get(job.handle).execution.suspendedExecutionIds.includes(id) && jobs.get(job.handle).execution.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0);
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: [id] });
  await until(() => waiting.length === 1);
  assert.deepEqual(waiting[0]!.waitingOn.map(item => item.nodeId), ["held"]);
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
  await jobs.dispose();
});

test("a held result that leaves nothing active sends only its own pause reminder", async () => {
  const held = gate();
  const { jobs, waiting, calls } = setup({ held: held.promise });
  const job = jobs.start(graph(node("held", { pauseAfter: true }), node("quick")), {}, context());
  await until(() => calls("held") === 1 && jobs.get(job.handle).execution.nodes.quick?.status === "completed");
  held.release();
  await until(() => jobs.get(job.handle).execution.status === "waiting");
  await settle();
  assert.equal(waiting.length, 0, "the pause reminder already wakes the parent");
  jobs.cancel(job.handle);
  await jobs.wait(job.handle);
  await jobs.dispose();
});
