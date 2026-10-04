import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-typert-registry";
import Gateway from "@deepseek-ai/dsh-api-gateway";
import { BraidJobs } from "../jobs.js";
import { BraidPanel } from "../panel.js";
import type { PanelDetail, PanelFrame } from "../panel-types.js";
import { answer, context, input, llm, until } from "./helpers.js";

async function setup() {
  const ctx = new Context();
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  const jobs = new BraidJobs(llm(() => answer("x".repeat(70000))));
  const listeners = new Set<() => void>();
  const off = jobs.subscribe(() => { for (const listener of listeners) listener(); });
  await ctx.inject(["typert"], ctx => { new BraidPanel(ctx, id => id === "owner" ? jobs : undefined,
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }); });
  const invoke = (method: string, request: object) => ctx.typertGateway.invoke({ namespace: "braidPanel", method, args: { request } });
  return { ctx, jobs, listeners, invoke, cleanup: async () => { off(); await jobs.dispose(); await ctx.fiber.dispose(); } };
}

test("native Gateway streams bounded projections, fences controls and pages exact execution output", async () => {
  const h = await setup();
  const abort = new AbortController();
  try {
    const stream = await h.ctx.typertGateway.stream({ namespace: "braidPanel", method: "watch", args: { request: { sessionId: "owner" } }, signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, { rows: [], job: null });
    const receipt = h.jobs.start(input, {}, context());
    await h.jobs.wait(receipt.jobId);
    const frame = (await iterator.next()).value as PanelFrame;
    assert.equal(frame.job!.status, "completed");
    assert.ok(JSON.stringify(frame).length < 6000, "long outputs must not enter live graph frames");
    assert.ok(!JSON.stringify(frame).includes("Do work"), "prompts must not enter graph frames");
    const executionId = frame.job!.executions[0]!.executionId;
    const detail = await h.invoke("detail", { sessionId: "owner", jobId: receipt.jobId, executionId, offset: 0 }) as PanelDetail;
    assert.equal(detail.output.length, 32768); assert.equal(detail.total, 70000);
    const tail = await h.invoke("detail", { sessionId: "owner", jobId: receipt.jobId, executionId, offset: 65536 }) as PanelDetail;
    assert.equal(tail.output.length, 4464); assert.equal(tail.next, 70000);
    await assert.rejects(h.invoke("detail", { sessionId: "other", jobId: receipt.jobId, executionId, offset: 0 }), /no longer available/);
    await assert.rejects(h.invoke("control", { sessionId: "other", jobId: receipt.jobId, action: "cancel", revision: 0, executionIds: [] }), /no longer available/);
    await assert.rejects(h.invoke("detail", { sessionId: "owner", jobId: receipt.jobId, executionId, offset: -1 }), /boundary validation/);
    abort.abort(); await iterator.return?.();
    assert.equal(h.listeners.size, 0);
  } finally { abort.abort(); await h.cleanup(); }
});

test("native panel resumes with revision checks and cancellation settles the original run", async () => {
  const h = await setup();
  try {
    const receipt = h.jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }, { type: "execute", id: "b", prompt: "next" }], edges: [{ from: "a", to: "b" }] }, {}, context());
    await until(() => h.jobs.get(receipt.jobId).execution.pausedExecutionIds.length > 0);
    const snapshot = h.jobs.get(receipt.jobId).execution;
    const request = { sessionId: "owner", jobId: receipt.jobId, action: "resume", revision: snapshot.revision, executionIds: snapshot.pausedExecutionIds };
    await assert.rejects(h.invoke("control", { ...request, revision: snapshot.revision + 1 }), /revision/i);
    await h.invoke("control", request);
    await h.jobs.wait(receipt.jobId);
    assert.equal(h.jobs.get(receipt.jobId).status, "completed");
    const next = h.jobs.start({ ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }, { type: "execute", id: "b", prompt: "next" }], edges: [{ from: "a", to: "b" }] }, {}, context());
    await until(() => h.jobs.get(next.jobId).execution.pausedExecutionIds.length > 0);
    await h.invoke("control", { sessionId: "owner", jobId: next.jobId, action: "cancel", revision: 0, executionIds: [] });
    await h.jobs.wait(next.jobId);
    assert.equal(h.jobs.get(next.jobId).status, "cancelled");
  } finally { await h.cleanup(); }
});

test("legacy tool-card handles resolve in the owning session and reject handles reused after the call", async () => {
  const h = await setup();
  try {
    const receipt = h.jobs.start(input, {}, context()); await h.jobs.wait(receipt.jobId);
    const executionId = Object.keys(h.jobs.get(receipt.jobId).execution.executions)[0]!;
    const request = { sessionId: "owner", jobId: receipt.handle, executionId, offset: 0, createdBefore: receipt.createdAt };
    assert.equal((await h.invoke("detail", request) as PanelDetail).executionId, executionId);
    await assert.rejects(h.invoke("detail", { ...request, createdBefore: receipt.createdAt - 1 }), /no longer available/);
    await assert.rejects(h.invoke("detail", { ...request, sessionId: "other" }), /no longer available/);
  } finally { await h.cleanup(); }
});
