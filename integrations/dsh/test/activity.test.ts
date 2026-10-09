import assert from "node:assert/strict";
import test from "node:test";
import type { StreamChunk, ToolCallBlock } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { BraidJobs } from "../jobs.js";
import { renderPanel } from "../display.js";
import { panelJob } from "../panel.js";
import { runCommand } from "../shell-tools.js";
import { createBraidTools } from "../tools.js";
import { answer, context, input, until } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function running(jobs: BraidJobs, handle: string): string {
  return Object.values(jobs.get(handle).execution.executions).find(execution => execution.status === "running")?.executionId ?? "";
}

test("stream chunks, tool calls, and lifecycle are visible while an execution runs", async () => {
  const gate = deferred();
  let requests = 0;
  const jobs = new BraidJobs({
    async *stream(): AsyncIterable<StreamChunk> {
      if (requests++ === 0) {
        yield { type: "reasoning-delta", index: 0, text: "Need to read the file" };
        yield { type: "tool-call-delta", index: 1, id: "call-0" as ToolCallBlock["id"], name: "read", argumentsDelta: '{"path":' };
        await gate.promise;
        yield { type: "tool-call-delta", index: 1, id: "call-0" as ToolCallBlock["id"], argumentsDelta: '"missing.txt"}' };
        yield { type: "block-end", index: 1, block: { type: "tool-call", id: "call-0" as ToolCallBlock["id"], name: "read", arguments: '{"path":"missing.txt"}' } };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      } else {
        for (const chunk of answer("Reported the missing file")) yield chunk;
      }
    },
  });
  try {
    const job = jobs.start(input, {}, context());
    await until(() => {
      const id = running(jobs, job.handle);
      return !!id && jobs.getActivity(job.handle, id)?.model?.receiving === "tool_call";
    });
    const executionId = running(jobs, job.handle);
    const live = jobs.getActivity(job.handle, executionId)!;
    assert.equal(live.phase, "model");
    assert.equal(live.model!.toolName, "read");
    assert.equal(live.model!.tail, '{"path":');
    assert.deepEqual(live.limitations, []);
    assert.match(renderPanel(jobs.get(job.handle), id => jobs.getActivity(job.handle, id)), /activity: model for .* streaming tool_call \(read\)/);
    const frame = panelJob(jobs.get(job.handle), id => jobs.getActivity(job.handle, id, { limit: 0 }));
    const projected = frame.executions.find(execution => execution.executionId === executionId)!.activity!;
    assert.equal(projected.phase, "model");
    assert.equal(projected.model!.toolName, "read");
    assert.equal((projected as { entries?: unknown }).entries, undefined, "graph frames carry summaries, not history");

    const exec = { signal: new AbortController().signal } as ToolRunContext;
    const [, status] = createBraidTools(() => jobs, () => { throw new Error("should not submit"); });
    const read = await status!.execute({ jobId: job.handle, executionId }, exec) as { activity: { phase: string }; node: unknown };
    assert.equal(read.activity.phase, "model");
    assert.ok(Object.keys(read).indexOf("activity") < Object.keys(read).indexOf("node"));
    await assert.rejects(status!.execute({ jobId: job.handle, activityBefore: 2 }, exec), /activityBefore requires/);

    gate.resolve();
    await jobs.wait(job.handle);
    assert.equal(jobs.get(job.handle).status, "completed");
    const done = jobs.getActivity(job.handle, executionId)!;
    assert.equal(done.phase, "completed");
    const kinds = done.entries.map(entry => `${entry.kind}:${entry.toolName ?? ""}`);
    for (const kind of ["reasoning:", "tool_call:read", "tool_result:read", "assistant:"]) assert.ok(kinds.includes(kind), kinds.join(", "));
    assert.ok(done.entries.find(entry => entry.kind === "tool_result")!.isError);
    const page = await status!.execute({ jobId: job.handle, executionId, activityBefore: 3 }, exec) as { activity: { entries: { sequence: number }[] } };
    assert.deepEqual(page.activity.entries.map(entry => entry.sequence), [1, 2]);
    assert.equal(panelJob(jobs.get(job.handle), id => jobs.getActivity(job.handle, id)).executions[0]!.activity, undefined);
  } finally { gate.resolve(); await jobs.dispose(); }
});

test("shell commands report incremental output to observers without changing the result", async () => {
  const chunks: string[] = [];
  const result = JSON.parse(await runCommand(process.execPath, ["-e", "console.log('first'); setTimeout(() => console.log('second'), 20)"],
    process.cwd(), new AbortController().signal, undefined, text => { chunks.push(text); throw new Error("observer"); }));
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /first\n.*second/s);
  assert.match(chunks.join(""), /first\n.*second/s);
});
