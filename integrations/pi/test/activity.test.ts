import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { BraidPanel } from "../command.js";
import { createBraidTools } from "../index.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;
const text = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.filter(block => block.type === "text").map(block => block.text).join("\n");

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function runningExecution(jobs: BraidJobs, handle: string): string {
  const executions = Object.values(jobs.get(handle)!.execution?.executions ?? {});
  return executions.find(execution => execution.status === "running")?.executionId ?? "";
}

test("focused status and panel show a model wait, host limitations, and bounded history", { timeout: 5_000 }, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const reply = deferred<AssistantMessage>();
  const ctx = context(() => reply.promise);
  const job = jobs.start(input, {}, ctx);
  await until(() => {
    const id = runningExecution(jobs, job.handle);
    return !!id && jobs.getActivity(job.handle, id)?.phase === "model";
  });
  const executionId = runningExecution(jobs, job.handle);
  const { statusTool } = createBraidTools(jobs);
  const waiting = await statusTool.execute("focused", { jobId: job.handle, executionId }, undefined, undefined, ctx);
  const body = JSON.parse(text(waiting));
  assert.equal(body.activity.phase, "model");
  assert.equal(body.activity.model.firstStreamAt, undefined);
  assert.match(body.activity.limitations[0], /does not stream/);
  assert.ok(Object.keys(body).indexOf("activity") < Object.keys(body).indexOf("node"), "running activity precedes the node");
  const rendered = statusTool.renderResult!(waiting, { expanded: false, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
  assert.match(rendered, /activity: model for .* request #1 awaiting first stream event · last activity .* ago · total/);
  assert.match(rendered, /no stream events received yet/);
  assert.match(rendered, /unavailable: This Pi model registry does not stream/);
  assert.match(rendered, /Model request #1 sent/);

  const panel = new BraidPanel(jobs, { requestRender: () => {}, terminal: { rows: 60 } } as never, theme, () => {}, job.handle, { executionId });
  t.after(() => panel.dispose());
  const lines = panel.render(140).join("\n");
  assert.match(lines, /activity: model for/);
  assert.match(lines, /no stream events received yet/);
  assert.match(lines, /goal: Investigate in background/, "the session view shows the worker's task");

  reply.resolve(response("All done"));
  await jobs.wait(job.handle);
  const final = await statusTool.execute("focused", { jobId: job.handle, executionId }, undefined, undefined, ctx);
  const done = JSON.parse(text(final));
  assert.equal(done.activity.phase, "completed");
  assert.ok(Object.keys(done).indexOf("node") < Object.keys(done).indexOf("activity"), "final output precedes history");
  assert.ok(done.activity.entries.some((entry: { kind: string; summary: string }) => entry.kind === "assistant" && entry.summary === "All done"));
  const earlier = JSON.parse(text(await statusTool.execute("page", { jobId: job.handle, executionId, activityBefore: 3 }, undefined, undefined, ctx)));
  assert.deepEqual(earlier.activity.entries.map((entry: { sequence: number }) => entry.sequence), [1, 2]);
  await assert.rejects(statusTool.execute("page", { jobId: job.handle, activityBefore: 3 }, undefined, undefined, ctx), /activityBefore requires/);
  const collapsed = statusTool.renderResult!(final, { expanded: false, isPartial: false }, theme, { isError: false } as never).render(300).join("\n");
  assert.match(collapsed, /history · \d+ events/);
  assert.match(collapsed, /Completed in/);
});

test("streamed tool-call arguments, tool results, and assistant output are recorded per execution", { timeout: 5_000 }, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const gate = deferred<void>();
  const ctx = context(async () => response("unused"));
  let calls = 0;
  const registry = ctx.modelRegistry as unknown as Record<string, unknown>;
  registry.stream = () => {
    const stream = createAssistantMessageEventStream();
    const index = calls++;
    void (async () => {
      if (index === 0) {
        const call = { type: "toolCall" as const, id: "c1", name: "read", arguments: { path: "missing.txt" } };
        const partial: AssistantMessage = { ...response(), content: [call], stopReason: "toolUse" };
        stream.push({ type: "start", partial });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"missing.txt"}', partial });
        await gate.promise;
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
        stream.push({ type: "done", reason: "toolUse", message: partial });
      } else {
        const message = response("Finished after reading");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Finished after reading", partial: message });
        stream.push({ type: "done", reason: "stop", message });
      }
    })();
    return stream;
  };
  const job = jobs.start(input, {}, ctx);
  await until(() => {
    const id = runningExecution(jobs, job.handle);
    return !!id && jobs.getActivity(job.handle, id)?.model?.receiving === "tool_call";
  });
  const executionId = runningExecution(jobs, job.handle);
  const streaming = jobs.getActivity(job.handle, executionId)!;
  assert.equal(streaming.phase, "model");
  assert.equal(streaming.model!.toolName, "read");
  assert.match(streaming.model!.tail!, /missing\.txt/);
  assert.ok(streaming.model!.firstStreamAt !== undefined);
  assert.deepEqual(streaming.limitations, []);
  gate.resolve();
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle)!.status, "completed");
  const activity = jobs.getActivity(job.handle, executionId)!;
  assert.equal(activity.modelRequests, 2);
  assert.equal(activity.toolCalls, 1);
  const summaries = activity.entries.map(entry => `${entry.kind}: ${entry.summary}`);
  assert.ok(summaries.some(line => /^model_response: Model response #1 .* toolUse · 1 tool call: read/.test(line)), summaries.join("\n"));
  assert.ok(summaries.some(line => /^tool_call: read \{"path":"missing.txt"\}/.test(line)), summaries.join("\n"));
  assert.ok(activity.entries.some(entry => entry.kind === "tool_result" && entry.toolName === "read" && entry.isError));
  assert.ok(summaries.includes("assistant: Finished after reading"));
  assert.ok(summaries.includes("lifecycle: Worker returned · checkpoint and cleanup"));
});
