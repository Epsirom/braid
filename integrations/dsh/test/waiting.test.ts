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
    "or cancel the job with braid_cancel.");
  // Only a job with a graph timeout is told that its deadline keeps running.
  assert.match(formatWaiting({ ...waiting[0]!, graphTimeoutMs: 60_000 }), /braid_cancel\. The graph timeout keeps running while it waits\.$/);
  assert.doesNotMatch(formatWaiting({ ...waiting[0]!, graphTimeoutMs: 60_000, waitingOn: [{ kind: "job", source: "graph_timeout" }] }), /keeps running/);
  // A job pause names the executions it suspended, so the cause is stated once.
  assert.match(formatWaiting({ ...waiting[0]!, waitingOn: [{ kind: "suspended", executionId: "merge@2", nodeId: "merge", source: "graph_timeout" }, { kind: "job", source: "graph_timeout" }] }),
    /It waits on the job pause \(by the job's graphTimeoutMs limit\), which suspended node "merge" execution merge@2\. Check/);
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

test("status says which choice a node that runs only through a choice edge waits for", async () => {
  const join = gate();
  const { jobs, run, calls } = setup({ join: join.promise });
  const job = jobs.start({ goal: "Loop", nodes: [node("impl"), node("tests"), node("join"),
    { type: "decision", id: "review", prompt: "task:review", choices: ["again", "done"] }], edges: [
    { from: "impl", to: "join" }, { from: "tests", to: "join" }, { from: "join", to: "review" }, { from: "review", to: "impl", choice: "again" },
  ] }, {}, context());
  await until(() => calls("join") === 1);
  assert.match((await run("braid_status", { jobId: job.handle })).text, /^- impl@1 · node impl · pending · waiting: runs only after review chooses again$/m);
  assert.match((await run("braid_status", { jobId: job.handle, executionId: "impl@1" })).text,
    /^Execution impl@1 · node impl \(execute\) · pending · waiting: runs only after review chooses again$/m);
  join.release();
  await run("braid_cancel", { jobId: job.handle });
});

test("braid_status shows running progress, answers an unchanged job briefly, and says what releasing a changed held result does", async () => {
  const impl = gate();
  const { jobs, run, calls } = setup({ impl: impl.promise });
  const job = jobs.start({ goal: "Impl and test", nodes: [node("impl"), node("test", { pauseAfter: true })], edges: [] }, {}, context());
  await until(() => calls("impl") === 1 && jobs.get(job.handle).execution.pausedExecutionIds.length === 1);
  const status = async () => (await run("braid_status", { jobId: job.handle })).text;
  assert.match(await status(), /^- impl@1 · node impl · running · \d+ms so far · model for \d+ms · model requests 1, tool calls 0$/m);
  const unchanged = await status();
  assert.match(unchanged, /^Braid job job-\d+ · running · nothing changed since your full braid_status \d+ms ago \(revision 0\); that read still applies\.$/m);
  assert.match(unchanged, /^Running:\n- impl@1 · \d+ms so far · model for \d+ms · model requests 1, tool calls 0$/m);
  assert.doesNotMatch(unchanged, /Executions/);
  await run("braid_update", { jobId: job.handle, expectedRevision: 0, addEdges: [{ from: "impl", to: "test" }] });
  assert.match(await status(), /^- test@1 · node test · completed · held, inputs changed; releasing it reruns its node with the new inputs, and this result does not go downstream/m);
  assert.match((await run("braid_status", { jobId: job.handle, executionId: "test@1" })).text,
    /^Its inputs changed; releasing it reruns its node with the new inputs, and this result does not go downstream\.$/m);
  await assert.rejects(run("braid_cancel", { jobId: job.handle, executionIds: ["test@1"] }),
    /test@1 is completed and held: .*\. braid_cancel with executionIds fails only running or paused executions: release a held result with braid_resume, or replace its node with braid_update\./);
  impl.release();
  await run("braid_cancel", { jobId: job.handle });
});

test("resuming a running execution that will be held says when and what to do now; job reads name each execution's inputs", async () => {
  const a = gate();
  const { jobs, run, calls } = setup({ a: a.promise });
  const job = jobs.start({ goal: "Chain", nodes: [node("a", { pauseAfter: true }), node("b")], edges: [{ from: "a", to: "b" }] }, {}, context());
  await until(() => calls("a") === 1);
  const hint = /a@1 is running and is held when it finishes: resume it then; its completion reminder says when\. To change it now, upsert its node in braid_update without resuming it: that replaces the running execution/;
  await assert.rejects(run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: ["a@1"] }), hint);
  await assert.rejects(run("braid_update", { jobId: job.handle, expectedRevision: 0, resume: ["a@1"] }), hint);
  a.release();
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1);
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: ["a@1"] });
  await jobs.wait(job.handle);
  assert.match((await run("braid_status", { jobId: job.handle })).text, /^- b@1 · node b · completed · [^\n]* · inputs a@1$/m);
});
