import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { BraidJobs } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { context, deferred, input, response } from "./helpers.js";

const bounds = { timeout: 2_000 };

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
    assert.deepEqual(finished, ["failed"]);
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

test(
  "large results are saved in full and status responses remain bounded",
  bounds,
  async (t) => {
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const ctx = context(async () => response("x".repeat(100_000)));
    const job = jobs.start(input, {}, ctx);
    await jobs.wait(job.jobId);
    const saved = jobs.get(job.jobId)!;
    t.after(() => rm(dirname(saved.fullOutputPath!), { recursive: true }));
    // Windows uses ACLs and does not implement POSIX owner/group mode bits.
    if (process.platform !== "win32")
      assert.equal((await stat(saved.fullOutputPath!)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(saved.fullOutputPath!, "utf8")).terminalOutputs
        .a.output.length,
      100_000,
    );
    const result = await createBraidTools(jobs).statusTool.execute(
      "status",
      { jobId: job.jobId },
      undefined,
      undefined,
      ctx,
    );
    const output = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    assert.ok(output.length < 52_000);
    assert.match(output, /Full result\/log:/);
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
