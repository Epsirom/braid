import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { startBraid } from "@chrok/braid";
import { BraidJobs, type ControlNotice, type TimeoutPause } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatControlNotice, formatTimeoutPause } from "../status-text.js";
import { BraidPanel, panelJob } from "../panel.js";
import { createDshRunner } from "../runner.js";
import { answer, calls, context, directory, input, llm, payload, until } from "./helpers.js";

/** Each execution's first model request runs until the node timeout interrupts it; later ones answer at once. */
function slowFirstRequest() {
  const requests: GenerateOptions[] = [];
  const started = new Set<string>();
  const runtime = llm(async options => {
    requests.push(structuredClone({ ...options, signal: undefined }) as unknown as GenerateOptions);
    const executionId = payload(options).execution.executionId as string;
    if (!started.has(executionId) && started.add(executionId)) await new Promise((_, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    return answer("finished after timeout");
  });
  return { runtime, requests };
}
const timed = { nodeTimeoutMs: 200 };

test("a node timeout pauses the execution, reports what it was doing, and resumes with a new budget", async () => {
  const { runtime, requests } = slowFirstRequest();
  const pauses: TimeoutPause[] = [];
  const jobs = new BraidJobs(runtime, undefined, undefined, pause => { pauses.push(pause); });
  const tools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
  const job = jobs.start(input, timed, context());
  await until(() => pauses.length === 1);
  const executionId = Object.keys(jobs.get(job.handle).execution.executions)[0]!;
  const pause = pauses[0]!;
  assert.deepEqual([pause.executionId, pause.nodeId, pause.nodeTimeoutMs], [executionId, "a", 200]);
  assert.ok(pause.activeMs >= 200);
  assert.match(pause.activity!, /^model for /);
  assert.match(formatTimeoutPause(pause), new RegExp(`node "a" execution ${executionId} was paused because it exceeded its node timeout`));
  assert.equal(requests.length, 1);

  const status = await run("braid_status", { jobId: job.handle, executionId });
  assert.match(status.text, /Execution is suspended, paused by node timeout after \d+ms \(budget 200ms\)/);
  assert.match(status.text, /Its node timeout ran out/);
  const projection = panelJob(jobs.get(job.handle)).executions[0]!.suspension!;
  assert.equal(projection.source, "node_timeout");
  assert.equal(projection.timeout!.nodeTimeoutMs, 200);

  await assert.rejects(run("braid_resume", { jobId: job.handle, nodeTimeoutMs: 1000 }), /requires executionIds/);
  await run("braid_resume", { jobId: job.handle, expectedRevision: 0, executionIds: [executionId], nodeTimeoutMs: 5_000 });
  await jobs.wait(job.handle);
  const result = jobs.get(job.handle).result!;
  assert.equal(result.nodes.a!.output, "finished after timeout", JSON.stringify(result.nodes.a!.error));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages, requests[0]!.messages, "the interrupted response never entered the context");
  assert.match(requests[1]!.system!, /Node time budget: (4\d{3}|5000) ms remaining/);
  await jobs.dispose();
});

test("braid_cancel and the panel cancel a single execution; the panel's cancellation is a notice", async () => {
  const { runtime } = slowFirstRequest();
  const notices: ControlNotice[] = [];
  let paused = 0;
  const jobs = new BraidJobs(runtime, undefined, notice => { notices.push(notice); }, () => { paused++; });
  const tools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const first = jobs.start(input, timed, context());
  await until(() => paused === 1);
  const firstId = Object.keys(jobs.get(first.handle).execution.executions)[0]!;
  const cancelled = await tools.find(tool => tool.name === "braid_cancel")!.execute({ jobId: first.handle, executionIds: [firstId] } as never,
    { signal: new AbortController().signal } as never) as unknown as ToolValue;
  assert.match(cancelled.text, new RegExp(`cancellation requested for ${firstId}\\. They fail`));
  await jobs.wait(first.handle);
  assert.equal(jobs.get(first.handle).result!.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.deepEqual(notices, []);

  const ctx = new Context();
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  await ctx.inject(["typert"], ctx => { new BraidPanel(ctx, id => id === "owner" ? jobs : undefined, () => () => {}); });
  const second = jobs.start(input, timed, context());
  await until(() => paused === 2);
  const secondId = Object.keys(jobs.get(second.handle).execution.executions)[0]!;
  await ctx.typertGateway.invoke({ namespace: "braidPanel", method: "control",
    args: { request: { sessionId: "owner", jobId: second.jobId, action: "cancel", revision: 0, executionIds: [secondId] } } });
  await jobs.wait(second.handle);
  assert.equal(jobs.get(second.handle).status, "completed", "only the execution was cancelled");
  assert.equal(jobs.get(second.handle).result!.nodes.a!.error!.code, "NODE_TIMEOUT");
  assert.equal(formatControlNotice(notices[0]!),
    `The user cancelled node "a" execution ${secondId} of Braid job ${second.handle}. It failed; its successors follow the usual failure rules. Check the current state with braid_status(${JSON.stringify({ jobId: second.handle, executionId: secondId })}).`);
  await jobs.dispose();
  await ctx.fiber.dispose();
});

test("a node timeout interrupts a shell call, keeps its partial work, and does not run the rest of the batch", { timeout: 20_000 }, async () => {
  const cwd = directory(true);
  const requests: GenerateOptions[] = [];
  const runtime = llm((options, index): StreamChunk[] => {
    requests.push(structuredClone({ ...options, signal: undefined }) as unknown as GenerateOptions);
    return index === 0
      ? calls({ name: "bash", args: { command: "printf partial > partial.txt; echo started; sleep 30", description: "Long command" } },
        { name: "bash", args: { command: "printf later > later.txt", description: "Later" } })
      : answer("resumed");
  });
  let worktree: string | undefined;
  const run = startBraid(input, { cwd, defaultModel: "fake/model", nodeTimeoutMs: 1_500,
    runner: createDshRunner(runtime, { cwd }),
    onEvent: event => { if (event.type === "workspace_updated" && event.workspace.worktreeRoot) worktree = event.workspace.worktreeRoot; } });
  await until(() => run.snapshot().suspendedExecutionIds.length === 1, 10_000);
  assert.equal(readFileSync(join(worktree!, "partial.txt"), "utf8"), "partial", "the worktree is kept");
  assert.throws(() => readFileSync(join(worktree!, "later.txt")));
  run.resume(run.snapshot().suspendedExecutionIds, 0);
  const result = await run.result;
  assert.equal(result.nodes.a!.status, "completed", JSON.stringify(result.nodes.a!.error));
  const results = requests[1]!.messages.filter(message => message.role === "tool").map(message => JSON.stringify(message));
  assert.match(results[0]!, /Interrupted: the node timeout paused this execution before this call finished/);
  assert.match(results[0]!, /started/, "partial output is kept");
  assert.match(results[1]!, /Not run: the node timeout paused this execution before this call started/);
  assert.equal(execFileSync("git", ["show", `${result.nodes.a!.workspace!.checkpointRef}:partial.txt`], { cwd, encoding: "utf8" }), "partial");
});
