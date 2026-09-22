import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BraidPanel, registerBraidCommand } from "../command.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;

test(
  "panel shows live flow, navigates jobs, cancels selected work, and closes without cancelling other jobs",
  { timeout: 2_000 },
  async (t) => {
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const ready = deferred<void>();
    let calls = 0;
    const ctx = context(async () => {
      if (++calls === 2) ready.resolve();
      return new Promise(() => {});
    });
    const first = jobs.start(input, {}, ctx);
    const second = jobs.start({ ...input, goal: "Second goal" }, {}, ctx);
    await ready.promise;
    let renders = 0;
    let closed = 0;
    const panel = new BraidPanel(
      jobs,
      {
        requestRender: () => {
          renders++;
        },
        terminal: { rows: 30 },
      } as never,
      theme,
      () => {
        closed++;
      },
    );
    t.after(() => panel.dispose());
    const lines = panel.render(100);
    assert.match(lines.join("\n"), /Second goal/);
    assert.match(lines.join("\n"), /▶ ACTIVE/);
    assert.ok(lines.length <= 28);
    assert.ok(lines.every((line) => visibleWidth(line) === 100));
    assert.match(lines[0]!, /^╭.*╮$/);
    assert.match(lines.at(-1)!, /^╰─+╯$/);
    assert.match(lines.at(-2)!, /Esc close/);
    panel.handleInput("\x1b[C");
    assert.match(panel.render(100).join("\n"), new RegExp(first.jobId));
    panel.handleInput("c");
    await jobs.wait(first.jobId);
    assert.match(panel.render(100).join("\n"), /cancelled/);
    panel.handleInput("\x1b");
    assert.equal(closed, 1);
    assert.equal(jobs.get(second.jobId)!.status, "running");
    const before = renders;
    jobs.cancel(second.jobId);
    await jobs.wait(second.jobId);
    assert.equal(renders, before);
  },
);

test("panel handles empty jobs, narrow terminals, and completed results", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const panel = new BraidPanel(
    jobs,
    { requestRender: () => {}, terminal: { rows: 15 } } as never,
    theme,
    () => {},
  );
  t.after(() => panel.dispose());
  assert.match(panel.render(100).join("\n"), /No Braid jobs/);
  panel.handleInput("\x1b[C");
  const job = jobs.start(
    { ...input, goal: "Review 中文 layout 🚀 with long labels" },
    {},
    context(async () => response()),
  );
  await jobs.wait(job.jobId);
  assert.match(panel.render(100).join("\n"), /completed/);
  for (const width of [20, 40, 100]) {
    const lines = panel.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.match(lines.at(-1)!, /^╰─+╯$/);
  }
});

test("/braid opens the panel in an overlay and disposes it after close", async () => {
  const jobs = new BraidJobs();
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  registerBraidCommand(
    {
      registerCommand: (
        _name: string,
        command: { handler: typeof handler },
      ) => {
        handler = command.handler;
      },
    } as never,
    jobs,
  );
  let options: unknown;
  await handler("", {
    mode: "tui",
    ui: {
      custom: async (
        factory: (...args: unknown[]) => BraidPanel,
        value: unknown,
      ) => {
        options = value;
        const panel = factory(
          { requestRender: () => {}, terminal: { rows: 20 } },
          theme,
          {},
          () => {},
        );
        assert.match(panel.render(100).join("\n"), /No Braid jobs/);
        panel.handleInput("q");
      },
    },
  });
  assert.equal((options as { overlay: boolean }).overlay, true);
  assert.equal(
    (options as { overlayOptions: { maxHeight: string } }).overlayOptions
      .maxHeight,
    "90%",
  );
  await assert.rejects(handler("", { mode: "rpc" }), /interactive Pi/);
  jobs.dispose();
});

test("panel scrolls long execution logs within the terminal viewport", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(
    {
      ...input,
      nodes: Array.from({ length: 12 }, (_, index) => ({
        type: "execute",
        id: `node${index}`,
        prompt: "work",
      })),
    },
    {},
    context(async () => response()),
  );
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(
    jobs,
    { requestRender: () => {}, terminal: { rows: 18 } } as never,
    theme,
    () => {},
  );
  t.after(() => panel.dispose());
  const initial = panel.render(100);
  assert.match(initial.at(-3)!, /Lines 1–/);
  panel.handleInput("\x1b[6~");
  const scrolled = panel.render(100);
  assert.match(scrolled.at(-3)!, /Lines 11–/);
  assert.ok(scrolled.length <= 16);
  panel.handleInput("\x1b[A");
  assert.match(panel.render(100).at(-3)!, /Lines 10–/);
  panel.handleInput("\x1b[5~");
  assert.match(panel.render(100).at(-3)!, /Lines 1–/);
});
