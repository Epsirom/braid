import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { registerBraidWidget } from "../command.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

function fixture(t: TestContext) {
  const jobs = new BraidJobs();
  let widget: Component | undefined;
  let updates = 0;
  let placement: string | undefined;
  let handler!: (event: never, ctx: ExtensionContext) => void;
  const dispose = registerBraidWidget({
    on: (_event: string, callback: typeof handler) => { handler = callback; },
  } as never, jobs);
  const ui = {
    setWidget: (
      key: string,
      factory: ((...args: unknown[]) => Component) | undefined,
      options?: { placement: string },
    ) => {
      assert.equal(key, "braid-status");
      updates++;
      placement = options?.placement;
      widget = factory?.({}, {
        fg: (_color: string, value: string) => `\x1b[32m${value}\x1b[0m`,
      });
    },
  };
  t.after(() => { jobs.dispose(); dispose(); });
  const lines = (width = 120) => widget?.render(width) ?? [];
  return {
    jobs,
    dispose,
    start: (mode: ExtensionContext["mode"] = "tui") => handler({} as never, { mode, ui } as never),
    lines,
    text: (width = 120) => lines(width).map(stripTerminalSequences).join("\n"),
    updates: () => updates,
    placement: () => placement,
  };
}

test("editor widget follows node progress automatically and retains the final status", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  view.start();
  assert.deepEqual(view.lines(), []);
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const first = deferred<ReturnType<typeof response>>();
  const second = deferred<ReturnType<typeof response>>();
  let calls = 0;
  const job = view.jobs.start({
    ...input,
    nodes: [input.nodes[0]!, { type: "execute", id: "b", prompt: "follow up" }],
    edges: [{ from: "a", to: "b" }],
  }, {}, context(async () => {
    if (++calls === 1) { firstStarted.resolve(); return first.promise; }
    secondStarted.resolve();
    return second.promise;
  }));
  await firstStarted.promise;
  assert.equal(view.placement(), "aboveEditor");
  assert.match(view.text(), /Braid job-1 · running · 0\/2 done · a/);
  assert.equal(view.jobs.progress("unknown"), undefined);
  const snapshots = t.mock.method(view.jobs, "get");
  view.start();
  view.text();
  assert.equal(snapshots.mock.callCount(), 0, "the status widget must not copy full results");
  snapshots.mock.restore();
  first.resolve(response());
  await secondStarted.promise;
  assert.match(view.text(), /running · 1\/2 done · b/);
  assert.deepEqual(view.jobs.progress(job.handle), {
    total: 2, done: 1, failed: 0, running: ["b"], paused: 0,
  });
  second.resolve(response());
  await view.jobs.wait(job.handle);
  assert.match(view.text(), /Braid job-1 · completed · 2\/2 done/);
});

test("editor widget distinguishes a paused gate from independent running work and follows resume", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  view.start();
  const otherStarted = deferred<void>();
  const nextStarted = deferred<void>();
  const other = deferred<ReturnType<typeof response>>();
  const next = deferred<ReturnType<typeof response>>();
  const paused = deferred<void>();
  const fullyPaused = deferred<void>();
  let otherWasStarted = false;
  const ctx = context(async () => response());
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const { nodeId } = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string };
    if (nodeId === "a") return response();
    if (nodeId === "other") {
      otherWasStarted = true;
      otherStarted.resolve();
      return other.promise;
    }
    assert.equal(nodeId, "b");
    nextStarted.resolve();
    return next.promise;
  });
  const job = view.jobs.start({
    ...input,
    nodes: [
      { ...input.nodes[0]!, pauseAfter: true },
      { type: "execute", id: "other", prompt: "independent work" },
      { type: "execute", id: "b", prompt: "follow up" },
    ],
    edges: [{ from: "a", to: "b" }],
  }, {}, ctx);
  const unsubscribe = view.jobs.subscribe(() => {
    const progress = view.jobs.progress(job.handle)!;
    if (progress.paused) {
      paused.resolve();
      if (otherWasStarted && !progress.running.length) fullyPaused.resolve();
    }
  });
  t.after(unsubscribe);
  await Promise.all([paused.promise, otherStarted.promise]);
  assert.match(view.text(), /running · 1\/3 done · 1 paused · other/);
  other.resolve(response());
  await fullyPaused.promise;
  assert.match(view.text(), /paused · 2\/3 done/);
  const execution = view.jobs.get(job.handle)!.execution!;
  view.jobs.resume(job.handle, execution.pausedExecutionIds, execution.revision);
  await nextStarted.promise;
  assert.match(view.text(), /running · 2\/3 done · b/);
  next.resolve(response());
  await view.jobs.wait(job.handle);
  assert.match(view.text(), /completed · 3\/3 done/);
});

test("editor widget tracks a running execution after its definition is removed", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  view.start();
  const otherStarted = deferred<void>();
  const other = deferred<ReturnType<typeof response>>();
  const paused = deferred<void>();
  const fullyPaused = deferred<void>();
  let otherWasStarted = false;
  const ctx = context(async () => response());
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const { nodeId } = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string };
    if (nodeId === "a") return response();
    assert.equal(nodeId, "other");
    otherWasStarted = true;
    otherStarted.resolve();
    return other.promise;
  });
  const job = view.jobs.start({
    ...input,
    nodes: [
      { ...input.nodes[0]!, pauseAfter: true },
      { type: "execute", id: "other", prompt: "independent work" },
      { type: "execute", id: "b", prompt: "follow up" },
    ],
    edges: [{ from: "a", to: "b" }],
  }, {}, ctx);
  const unsubscribe = view.jobs.subscribe(() => {
    const progress = view.jobs.progress(job.handle)!;
    if (progress.paused) {
      paused.resolve();
      if (otherWasStarted && !progress.running.length) fullyPaused.resolve();
    }
  });
  t.after(unsubscribe);
  await Promise.all([paused.promise, otherStarted.promise]);
  const updated = view.jobs.update(job.handle, {
    expectedRevision: view.jobs.get(job.handle)!.execution!.revision,
    removeNodeIds: ["other"],
  });
  assert.equal(Object.hasOwn(updated.live.nodes, "other"), false);
  assert.equal(Object.hasOwn(updated, "runningExecutions"), false, "execution tracking stays internal");
  assert.deepEqual(view.jobs.progress(job.handle), {
    total: 2, done: 1, failed: 0, running: ["other"], paused: 1,
  });
  assert.match(view.text(), /running · 1\/2 done · 1 paused · other/);
  other.resolve(response());
  await fullyPaused.promise;
  assert.deepEqual(view.jobs.progress(job.handle), {
    total: 2, done: 1, failed: 0, running: [], paused: 1,
  });
  assert.match(view.text(), /paused · 1\/2 done/);
  view.jobs.cancel(job.handle);
  await view.jobs.wait(job.handle);
  assert.deepEqual(view.jobs.progress(job.handle)!.running, []);
});

test("editor widget prioritizes active jobs and bounds concurrent-job rows", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  view.start();
  const ready = deferred<void>();
  const results = Array.from({ length: 5 }, () => deferred<ReturnType<typeof response>>());
  let calls = 0;
  const jobs = results.map((result, index) => view.jobs.start(
    { ...input, goal: `Task ${index}` }, {}, context(async () => {
      if (++calls === results.length) ready.resolve();
      return result.promise;
    }),
  ));
  await ready.promise;
  assert.equal(view.lines().length, 4);
  assert.match(view.text(), /Braid job-5 · running/);
  assert.match(view.text(), /\+2 active jobs · \/braid details/);
  results[4]!.resolve(response());
  await view.jobs.wait(jobs[4]!.handle);
  assert.doesNotMatch(view.text(), /job-5/);
  assert.match(view.text(), /Braid job-4 · running/);
  assert.match(view.text(), /\+1 active jobs/);
  for (const job of jobs.slice(0, 4)) view.jobs.cancel(job.handle);
  await Promise.all(jobs.map(job => view.jobs.wait(job.handle)));
  assert.equal(view.lines().length, 1);
  assert.match(view.text(), /Braid job-5 · completed/);
});

test("editor widget counts skipped nodes, reports failures, and follows cancellation", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  view.start();
  const failed = view.jobs.start({
    ...input,
    nodes: [
      { ...input.nodes[0]!, requireSuccess: true },
      { type: "execute", id: "b", prompt: "follow up" },
    ],
    edges: [{ from: "a", to: "b" }],
  }, {}, context(async () => { throw new Error("offline provider failure"); }));
  await view.jobs.wait(failed.handle);
  assert.match(view.text(), /Braid job-1 · failed · 2\/2 done · 1 failed/);
  const started = deferred<void>();
  const cancelled = view.jobs.start(input, {}, context(async () => {
    started.resolve();
    return new Promise(() => {});
  }));
  await started.promise;
  view.jobs.cancel(cancelled.handle);
  await view.jobs.wait(cancelled.handle);
  assert.match(view.text(), /Braid job-2 · cancelled/);
});

test("editor widget handles Unicode and narrow widths, skips non-TUI modes, and unsubscribes on cleanup", { timeout: 3_000 }, async (t) => {
  const view = fixture(t);
  for (const mode of ["rpc", "json", "print"] as const) view.start(mode);
  assert.equal(view.updates(), 0);
  const started = deferred<void>();
  const result = deferred<ReturnType<typeof response>>();
  const job = view.jobs.start({
    ...input,
    goal: "Review 中文 🚀\n\x1b[2Jlayout",
    nodes: [{ type: "execute", id: "worker 中文 🚀\n\x1b[2Jbad", prompt: "work" }],
  }, {}, context(async () => { started.resolve(); return result.promise; }));
  await started.promise;
  assert.deepEqual(view.lines(), []);
  view.start();
  assert.match(view.text(), /worker 中文 🚀 bad/);
  for (const width of [0, 1, 8, 20, 40, 120]) {
    const lines = view.lines(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.ok(lines.every(line => !line.includes("\x1b[2J") && !/[\n\r]/u.test(line)));
  }
  view.start("rpc");
  assert.deepEqual(view.lines(), []);
  const before = view.updates();
  result.resolve(response());
  await view.jobs.wait(job.handle);
  assert.equal(view.updates(), before, "the old UI observer must be removed");
  view.start();
  assert.match(view.text(), /completed · 1\/1 done · Review 中文 🚀 layout/);
  view.dispose();
  view.dispose();
  assert.deepEqual(view.lines(), []);
  const disposedUpdates = view.updates();
  const following = view.jobs.start(input, {}, context(async () => response()));
  await view.jobs.wait(following.handle);
  assert.equal(view.updates(), disposedUpdates);
});
