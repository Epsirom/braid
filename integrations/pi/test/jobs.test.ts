import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { BraidJobs, type NodeCompletion } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { context, deferred, input, response } from "./helpers.js";

const bounds = { timeout: 2_000 };

test("blocking waits for parallel branches and their join, returns outputs and claims usage once", bounds, async t => {
  const rootsStarted = deferred<void>();
  const firstFinished = deferred<void>();
  const first = deferred<ReturnType<typeof response>>();
  const second = deferred<ReturnType<typeof response>>();
  const notifications: string[] = [];
  const jobs = new BraidJobs(job => notifications.push(job.status), node => notifications.push(node.nodeId));
  t.after(() => jobs.dispose());
  const unsubscribe = jobs.subscribe(() => {
    if (Object.values(jobs.get("job-1")?.live.nodes ?? {}).some(node => node.status === "completed")) firstFinished.resolve();
  });
  t.after(unsubscribe);
  let calls = 0;
  const ctx = context(async () => {
    if (++calls === 1) return first.promise;
    if (calls === 2) { rootsStarted.resolve(); return second.promise; }
    return response("joined result");
  });
  const { braidTool, statusTool } = createBraidTools(jobs, () => true);
  let returned = false;
  const call = braidTool.execute("blocking", {
    ...input,
    nodes: ["a", "b", "join"].map(id => ({ type: "execute", id, prompt: "work", notifyOnCompletion: true })),
    edges: [{ from: "a", to: "join" }, { from: "b", to: "join" }],
  }, undefined, undefined, ctx).then(result => { returned = true; return result; });
  await rootsStarted.promise;
  assert.equal(returned, false);
  assert.throws(() => jobs.update("job-1", {
    expectedRevision: 0, upsertNodes: [{ type: "execute", id: "a", prompt: "work", pauseAfter: true }],
  }), /cannot use pauseAfter/);
  assert.equal(jobs.get("job-1")!.execution!.revision, 0);
  first.resolve(response("first branch"));
  await firstFinished.promise;
  assert.equal(returned, false);
  assert.equal(calls, 2);
  second.resolve(response("second branch"));
  const result = await call;
  assert.equal(result.details!.status, "completed");
  assert.equal(result.details!.result!.terminalOutputs.join!.output, "joined result");
  assert.match(JSON.stringify(result.content), /joined result/);
  assert.doesNotMatch(JSON.stringify(result.content), /runs asynchronously/);
  assert.equal(result.usage!.totalTokens, 6);
  const again = await statusTool.execute("again", { jobId: "job-1" }, undefined, undefined, ctx);
  assert.equal(again.usage, undefined);
  assert.deepEqual(notifications, []);
});

test("blocking returns required failures with successful partial outputs", bounds, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  let calls = 0;
  const result = await createBraidTools(jobs, () => true).braidTool.execute("failure", {
    ...input,
    nodes: ["saved", "bad"].map(id => ({ type: "execute", id, prompt: "work", requireSuccess: true })),
    options: { maxConcurrency: 1 },
  }, undefined, undefined, context(async () => {
    if (++calls === 1) return response("saved output");
    throw new Error("provider failed");
  }));
  assert.equal(result.details!.status, "failed");
  assert.equal(result.details!.result!.nodes.saved!.output, "saved output");
  assert.match(JSON.stringify(result.content), /provider failed/);
});

test("foreground abort cancels blocking work and queued nodes before returning", bounds, async t => {
  const started = deferred<void>();
  let workerSignal!: AbortSignal;
  const ctx = context(async signal => {
    workerSignal = signal;
    started.resolve();
    return new Promise(() => {});
  });
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool } = createBraidTools(jobs, () => true);
  const controller = new AbortController();
  const call = braidTool.execute("cancel", {
    ...input,
    nodes: ["running", "queued"].map(id => ({ type: "execute", id, prompt: "work" })),
    options: { maxConcurrency: 1 },
  }, controller.signal, undefined, ctx);
  await started.promise;
  controller.abort();
  const result = await call;
  assert.equal(workerSignal.aborted, true);
  assert.equal(result.details!.status, "cancelled");
  assert.equal(result.details!.result!.nodes.queued!.skipReason, "cancelled");
  assert.equal(result.details!.execution!.status, "failed");
});

test("blocking rejects pauses and pre-aborted calls before allocating a job", bounds, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool } = createBraidTools(jobs, () => true);
  const ctx = context(async () => { throw new Error("must not invoke provider"); });
  await assert.rejects(braidTool.execute("pause", {
    ...input, nodes: [{ ...input.nodes[0]!, pauseAfter: true }],
  }, undefined, undefined, ctx), /cannot use pauseAfter/);
  await assert.rejects(braidTool.execute("aborted", input, AbortSignal.abort(), undefined, ctx), /abort/i);
  assert.deepEqual(jobs.list(), []);
});

test("invalid template submissions fail before allocating a job or invoking a provider", bounds, async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  let calls = 0;
  const ctx = context(async () => { calls++; return response(); });
  const { braidTool } = createBraidTools(jobs);
  await assert.rejects(braidTool.execute("bad-template", {
    ...input,
    promptTemplates: { inspect: "Inspect {{target}}." },
    nodes: [...input.nodes, { type: "execute", id: "invalid", prompt: { template: "inspect", variables: {} } }],
  }, undefined, undefined, ctx), /Node 'invalid'.*template 'inspect'.*missing variable 'target'/);
  assert.deepEqual(jobs.list(), []);
  assert.equal(calls, 0);
});

test(
  "submission returns before the provider starts; foreground abort does not cancel the job",
  bounds,
  async (t) => {
    const ready = deferred<void>();
    const completion = deferred<ReturnType<typeof response>>();
    let nodeSignal!: AbortSignal;
    const ctx = context(async (signal) => {
      nodeSignal = signal;
      ready.resolve();
      return completion.promise;
    });
    const finished: string[] = [];
    const jobs = new BraidJobs((job) => finished.push(job.jobId));
    t.after(() => jobs.dispose());
    const { braidTool, statusTool } = createBraidTools(jobs);
    const foreground = new AbortController();
    const submitted = await braidTool.execute(
      "call",
      input,
      foreground.signal,
      undefined,
      ctx,
    );
    const id = submitted.details!.jobId;
    assert.equal(submitted.details!.status, "running");
    assert.equal(Boolean(nodeSignal), false);
    foreground.abort();
    await ready.promise;
    assert.equal(nodeSignal.aborted, false);
    const running = await statusTool.execute(
      "status",
      { jobId: id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(running.details!.live.nodes.a!.status, "running");
    completion.resolve(response("background answer"));
    await jobs.wait(id);
    const done = await statusTool.execute(
      "status",
      { jobId: id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      done.details!.result!.terminalOutputs.a!.output,
      "background answer",
    );
    assert.equal(done.usage!.totalTokens, 2);
    const again = await statusTool.execute(
      "again",
      { jobId: id },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(again.usage, undefined);
    assert.deepEqual(finished, [id]);
  },
);

test(
  "cancel aborts noncooperative work, skips queued nodes, and retains finished outputs",
  bounds,
  async (t) => {
    const ready = deferred<void>();
    let signal!: AbortSignal;
    let calls = 0;
    const ctx = context(async (value) => {
      if (++calls === 1) return response("saved");
      signal = value;
      ready.resolve();
      return new Promise(() => {});
    });
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const { braidTool, cancelTool } = createBraidTools(jobs);
    const submitted = await braidTool.execute(
      "call",
      {
        ...input,
        nodes: ["done", "hang", "queued"].map((id) => ({
          type: "execute",
          id,
          prompt: "work",
        })),
        options: { maxConcurrency: 1 },
      },
      undefined,
      undefined,
      ctx,
    );
    const id = submitted.details!.jobId;
    await ready.promise;
    await cancelTool.execute(
      "cancel",
      { jobId: id },
      undefined,
      undefined,
      ctx,
    );
    await jobs.wait(id);
    const job = jobs.get(id)!;
    assert.equal(signal.aborted, true);
    assert.equal(job.status, "cancelled");
    assert.equal(job.result!.nodes.queued!.skipReason, "cancelled");
    assert.equal(job.result!.terminalOutputs.done!.output, "saved");
  },
);

test(
  "shutdown aborts background jobs and suppresses reminders and late completions",
  bounds,
  async () => {
    const ready = deferred<void>();
    const late = deferred<ReturnType<typeof response>>();
    let signal!: AbortSignal;
    const ctx = context(async (value) => {
      signal = value;
      ready.resolve();
      return late.promise;
    });
    let reminders = 0;
    const jobs = new BraidJobs(() => {
      reminders++;
    });
    const job = jobs.start(input, {}, ctx);
    await ready.promise;
    jobs.dispose();
    await jobs.wait(job.jobId);
    late.reject(new Error("late provider failure"));
    assert.equal(signal.aborted, true);
    assert.equal(reminders, 0);
    assert.throws(() => jobs.start(input, {}, ctx), /closed/);
  },
);

test(
  "invalid submissions and unknown IDs report errors; job failures send a completion",
  bounds,
  async (t) => {
    const finished: string[] = [];
    const jobs = new BraidJobs((job) => finished.push(job.status));
    t.after(() => jobs.dispose());
    const { braidTool, statusTool, cancelTool } = createBraidTools(jobs);
    const ctx = context(async () => {
      throw new Error("provider failed");
    });
    await assert.rejects(
      braidTool.execute(
        "bad",
        { ...input, edges: [{ from: "missing", to: "a" }] },
        undefined,
        undefined,
        ctx,
      ),
      /submission failed/,
    );
    assert.equal(jobs.list().length, 0);
    await assert.rejects(
      statusTool.execute(
        "status",
        { jobId: "missing" },
        undefined,
        undefined,
        ctx,
      ),
      /Unknown Braid job/,
    );
    await assert.rejects(
      cancelTool.execute(
        "cancel",
        { jobId: "missing" },
        undefined,
        undefined,
        ctx,
      ),
      /Unknown Braid job/,
    );
    const job = jobs.start(input, {}, ctx);
    await jobs.wait(job.jobId);
    assert.equal(
      jobs.get(job.jobId)!.result!.nodes.a!.error!.message,
      "provider failed",
    );
    assert.deepEqual(finished, ["completed"]);
    const listed = await statusTool.execute(
      "list",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      listed.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
      new RegExp(job.jobId),
    );
  },
);

for (const blocking of [false, true]) test(
  `large ${blocking ? "blocking" : "status"} results are saved in full and responses remain bounded`,
  bounds,
  async (t) => {
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const ctx = context(async () => response("x".repeat(100_000)));
    const { braidTool, statusTool } = createBraidTools(jobs, () => blocking);
    const submitted = await braidTool.execute("submit", input, undefined, undefined, ctx);
    await jobs.wait(submitted.details!.jobId);
    const result = blocking
      ? submitted
      : await statusTool.execute("status", { jobId: submitted.details!.jobId }, undefined, undefined, ctx);
    const output = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.ok(output.length < 52_000);
    const path = output.match(/\[Truncated\. Full text: (.+)\]$/)![1]!;
    t.after(() => rm(dirname(path), { recursive: true }));
    assert.equal(result.details?.fullOutputPath, path);
    // Windows uses ACLs and does not implement POSIX owner/group mode bits.
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    const saved = await readFile(path, "utf8");
    assert.match(saved, /^Braid job job-1 · completed\n/);
    assert.ok(saved.includes(`## a · ${result.details!.result!.nodes.a!.executionId} · terminal\n${"x".repeat(100_000)}`));
  },
);

test("short handles resolve exactly across status, cancellation, waiting, and usage without fuzzy matching", bounds, async (t) => {
  const ready = deferred<void>();
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const done = jobs.start(input, {}, context(async () => response("done")));
  const running = jobs.start(input, {}, context(async () => { ready.resolve(); return new Promise(() => {}); }));
  assert.equal(done.handle, "job-1");
  assert.equal(running.handle, "job-2");
  await jobs.wait("job-1");
  await ready.promise;
  assert.equal(jobs.get("job-1")!.jobId, done.jobId);
  assert.equal(jobs.get(done.jobId)!.handle, "job-1");
  assert.equal(jobs.get("job-01"), undefined);
  assert.equal(jobs.get(done.jobId.slice(0, -1)), undefined);
  assert.match(jobs.unknownJob("job-01").message, /job-1.*completed/);
  assert.match(jobs.unknownJob("job-01").message, /job-2.*running/);
  assert.ok(jobs.claimUsage("job-1"));
  assert.equal(jobs.claimUsage(done.jobId), undefined);
  assert.equal(jobs.cancel("job-2"), true);
  await jobs.wait("job-2");
  assert.equal(jobs.get(running.jobId)!.status, "cancelled");
});

test("large intermediate node results can be retrieved in full without claiming job usage", bounds, async (t) => {
  const nodeFinished = deferred<NodeCompletion>();
  const jobs = new BraidJobs(undefined, (node) => nodeFinished.resolve(node));
  t.after(() => jobs.dispose());
  const other = deferred<ReturnType<typeof response>>();
  let calls = 0;
  const output = "finding\n".repeat(15_000);
  const ctx = context(async () => ++calls === 1 ? response(output) : other.promise);
  const job = jobs.start({ ...input, nodes: [
    { type: "execute", id: "__proto__", prompt: "work", notifyOnCompletion: true },
    { type: "execute", id: "other", prompt: "work" },
  ] }, { maxConcurrency: 1 }, ctx);
  assert.equal(jobs.getNode(job.handle, "__proto__").status, "pending");
  await nodeFinished.promise;
  const { statusTool } = createBraidTools(jobs);
  const result = await statusTool.execute("read", { jobId: job.handle, nodeId: "__proto__" }, undefined, undefined, ctx);
  const block = result.content[0]!;
  assert.equal(block.type, "text");
  const text = block.type === "text" ? block.text : "";
  assert.ok(text.length < 52_000);
  const path = text.match(/\[Truncated\. Full text: (.+)\]$/)![1]!;
  t.after(() => rm(dirname(path), { recursive: true }));
  assert.equal(result.details?.nodeOutputPath, path);
  const saved = await readFile(path, "utf8");
  assert.match(saved, /^Braid job job-1 · running · /);
  assert.ok(saved.includes(`Output:\n${output}`));
  assert.equal(result.usage, undefined);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  const copy = jobs.getNode(job.jobId, "__proto__");
  copy.output = "mutated";
  assert.equal(jobs.getNode(job.handle, "__proto__").output, output);
  await assert.rejects(statusTool.execute("missing-job", { nodeId: "a" }, undefined, undefined, ctx), /nodeId.*requires jobId/);
  await assert.rejects(statusTool.execute("missing-node", { jobId: job.handle, nodeId: "toString" }, undefined, undefined, ctx), /Unknown Braid node/);
  other.resolve(response());
  await jobs.wait(job.handle);
  const read = await statusTool.execute("finished-node", { jobId: job.handle, nodeId: "other" }, undefined, undefined, ctx);
  assert.equal(read.usage, undefined);
  assert.ok(jobs.claimUsage(job.handle));
  assert.throws(() => jobs.getNode(job.handle, "toString"), /Unknown Braid node/);
});

test("cancelled running nodes notify as failures; skipped queued nodes and shutdown do not notify", bounds, async (t) => {
  for (const shutdown of [false, true]) {
    const started = deferred<void>();
    const notifications: NodeCompletion[] = [];
    const jobs = new BraidJobs(undefined, (node) => notifications.push(node));
    t.after(() => jobs.dispose());
    const job = jobs.start({ ...input, nodes: ["running", "queued"].map((id) => ({
      type: "execute", id, prompt: "work", notifyOnCompletion: true,
    })) }, { maxConcurrency: 1 }, context(async () => {
      started.resolve();
      return new Promise(() => {});
    }));
    await started.promise;
    if (shutdown) jobs.dispose();
    else jobs.cancel(job.handle);
    await jobs.wait(job.handle);
    assert.equal(jobs.getNode(job.handle, "queued").status, "skipped");
    assert.equal(notifications.length, shutdown ? 0 : 1);
    if (!shutdown) {
      assert.equal(notifications[0]!.nodeId, "running");
      assert.equal(notifications[0]!.status, "failed");
      assert.equal(notifications[0]!.errorCode, "CANCELLED");
    }
  }
});

test("async notification failures do not affect downstream execution; preferences are snapshotted", bounds, async (t) => {
  const notifications: NodeCompletion[] = [];
  const jobs = new BraidJobs(undefined, async (node) => {
    notifications.push(node);
    throw new Error("notification failure");
  });
  t.after(() => jobs.dispose());
  const submission = { ...input, nodes: [
    { type: "execute" as const, id: "a", prompt: "work", notifyOnCompletion: true },
    { type: "execute" as const, id: "b", prompt: "work", notifyOnCompletion: false },
  ], edges: [{ from: "a", to: "b" }] };
  const job = jobs.start(submission, {}, context(async () => response()));
  submission.nodes[0]!.notifyOnCompletion = false;
  submission.nodes[1]!.notifyOnCompletion = true;
  await jobs.wait(job.handle);
  assert.equal(jobs.get(job.handle)!.status, "completed");
  assert.deepEqual(notifications.map((node) => node.nodeId), ["a"]);
  assert.equal(jobs.getNode(job.handle, "b").status, "completed");
});
