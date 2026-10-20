import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { BraidJobs, type Completion, type ReplanNotice } from "../jobs.js";
import { createBraidTools, type ToolValue } from "../tools.js";
import { formatReplanRequest } from "../status-text.js";
import { answer, calls, context, input, llm, payload, until } from "./helpers.js";

const graph = { ...input, nodes: [input.nodes[0]!, { type: "execute" as const, id: "b", prompt: "next" }], edges: [{ from: "a", to: "b" }] };

/** Node a calls request_replan with `args`, then answers; every other node answers at once. */
function replanning(args: object) {
  const ran: string[] = [];
  const requests: GenerateOptions[] = [];
  const runtime = llm(options => {
    const node = payload(options).nodeId as string;
    if (node === "a") requests.push(structuredClone({ ...options, signal: undefined }) as unknown as GenerateOptions);
    if (node === "a" && requests.length === 1) return calls({ name: "request_replan", args });
    ran.push(node);
    return answer(`${node} done`);
  });
  return { runtime, ran, requests };
}
const lastResult = (options: GenerateOptions) => {
  const message = options.messages.at(-1)! as unknown as { content: { type: string; text?: string }[]; isError?: boolean };
  return { text: message.content.map(block => block.text ?? "").join(""), isError: message.isError };
};

test("request_replan wakes the parent, holds the result, and shows the request in braid_status", async t => {
  const suggestion = { removeNodeIds: ["b"] };
  const { runtime, ran, requests } = replanning({ reason: "b is redundant", suggestion });
  const notices: ReplanNotice[] = [];
  const completions: Completion[] = [];
  const jobs = new BraidJobs(runtime, completion => { completions.push(completion); }, undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const tools = createBraidTools(() => jobs, () => { throw new Error("unused"); });
  const run = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute(args as never, { signal: new AbortController().signal } as never) as unknown as Promise<ToolValue>;
  const job = jobs.start(graph, {}, context());
  await until(() => jobs.get(job.handle).execution.pausedExecutionIds.length === 1);
  const executionId = jobs.get(job.handle).execution.pausedExecutionIds[0]!;

  assert.ok(requests[0]!.tools!.some(tool => tool.name === "request_replan"), "execute nodes get the tool");
  assert.match(requests[0]!.system!, /call request_replan with the reason/);
  assert.match(lastResult(requests[1]!).text, /^Replan requested\./);

  assert.equal(notices.length, 1);
  assert.deepEqual({ ...notices[0], sequence: 0 }, { jobId: job.jobId, handle: job.handle, nodeId: "a", executionId, reason: "b is redundant", suggested: true, sequence: 0 });
  assert.match(formatReplanRequest(notices[0]!), /node "a" execution .* asks you to replan: b is redundant/);
  const paused = completions.find(completion => completion.paused)!;
  assert.equal(paused.replanRequested, true);

  const status = await run("braid_status", { jobId: job.handle, executionId });
  assert.match(status.text, /Replan requested at .* \(graph revision 0\): b is redundant/);
  assert.match(status.text, /Suggested graph edit, valid at revision 0; .*\{"removeNodeIds":\["b"\]\}/);

  await run("braid_update", { jobId: job.handle, expectedRevision: 0, ...suggestion, resume: [executionId] });
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle).status, "completed");
  assert.deepEqual(ran, ["a"], "b was removed before it ran");
});

test("an invalid suggestion is returned to the node, which can continue without a request", async t => {
  const { runtime, ran, requests } = replanning({ reason: "x", suggestion: { addEdges: [{ from: "a", to: "missing" }] } });
  const notices: ReplanNotice[] = [];
  const jobs = new BraidJobs(runtime, undefined, undefined, undefined, notice => { notices.push(notice); });
  t.after(() => jobs.dispose());
  const job = jobs.start(graph, {}, context());
  await jobs.wait(job.handle);
  assert.match(lastResult(requests[1]!).text, /Invalid replan suggestion at revision 0: .*missing/);
  assert.equal(notices.length, 0);
  assert.deepEqual(ran, ["a", "b"], "nothing was held");
});
