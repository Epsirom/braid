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
    const selectedByHandle = new BraidPanel(
      jobs,
      { requestRender: () => {}, terminal: { rows: 30 } } as never,
      theme,
      () => {},
      first.handle,
    );
    assert.match(selectedByHandle.render(100).join("\n"), new RegExp(first.jobId));
    assert.doesNotMatch(selectedByHandle.render(100).join("\n"), /Second goal/);
    selectedByHandle.dispose();
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

const focusTui = { requestRender: () => {}, terminal: { rows: 30 } } as never;
const chain = {
  goal: "Inspect one node",
  nodes: [
    { type: "execute" as const, id: "a", prompt: "first" },
    { type: "execute" as const, id: "b", prompt: "second" },
  ],
  edges: [{ from: "a", to: "b" }],
};

function captureCommand(jobs: BraidJobs) {
  let command!: {
    handler: (args: string, ctx: unknown) => Promise<void>;
    getArgumentCompletions: (prefix: string) => unknown;
  };
  registerBraidCommand({ registerCommand: (_name: string, value: typeof command) => { command = value; } } as never, jobs);
  return command;
}

test("panel focuses one node with live details and returns to the graph", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(chain, {}, context(async () => response("Full output line one.\nLine two.")));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle, { nodeId: "b" });
  t.after(() => panel.dispose());
  const focused = panel.render(100).join("\n");
  assert.match(focused, /completed {2}· {2}node b/);
  assert.match(focused, /Braid node b · completed/);
  assert.match(focused, /Line two\./);
  assert.match(focused, /elapsed .* · 1 in \/ 1 out tokens/);
  assert.match(focused, /⌫ graph/);
  assert.doesNotMatch(focused, /Braid completed/);
  assert.ok(panel.render(100).every((line) => visibleWidth(line) === 100));
  panel.handleInput("\x7f");
  const graph = panel.render(100).join("\n");
  assert.match(graph, /Braid completed/);
  assert.doesNotMatch(graph, /Braid node b|⌫ graph/);

  const executionId = jobs.getNode(job.handle, "a").executionId!;
  const byExecution = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle, { executionId });
  t.after(() => byExecution.dispose());
  assert.match(byExecution.render(100).join("\n"), /Braid node a · completed/);
  byExecution.handleInput("\x1b[C");
  assert.doesNotMatch(byExecution.render(100).join("\n"), /Braid node a/, "switching jobs clears the focus");

  const missing = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle, { nodeId: "removed" });
  t.after(() => missing.dispose());
  assert.match(missing.render(100).join("\n"), /no longer in the job's graph/);
});

test("panel shows a running node's elapsed time and tool progress", { timeout: 2_000 }, async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const started = deferred<void>();
  const job = jobs.start(input, {}, context(async () => {
    started.resolve();
    return new Promise(() => {});
  }));
  await started.promise;
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle, { nodeId: "a" });
  t.after(() => panel.dispose());
  const rendered = panel.render(100).join("\n");
  assert.match(rendered, /Braid node a · running/);
  assert.match(rendered, /elapsed \d/);
  assert.match(rendered, /context ~?\d+\S*\/100K · 0 tool calls in 0 rounds · model phase/);
  jobs.cancel(job.jobId);
  await jobs.wait(job.jobId);
});

test("/braid <jobId> <node> opens a focused panel and rejects unknown targets", async () => {
  const jobs = new BraidJobs();
  const job = jobs.start(chain, {}, context(async () => response("node output")));
  await jobs.wait(job.jobId);
  const command = captureCommand(jobs);
  const open = (args: string) => {
    let rendered = "";
    return command.handler(args, {
      mode: "tui",
      ui: {
        custom: async (factory: (...args: unknown[]) => BraidPanel) => {
          const panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, theme, {}, () => {});
          rendered = panel.render(100).join("\n");
          panel.handleInput("q");
        },
      },
    }).then(() => rendered);
  };
  assert.match(await open(`${job.handle} b`), /Braid node b · completed/);
  assert.match(await open(`  ${job.handle}   a  `), /Braid node a · completed/);
  const executionId = jobs.getNode(job.handle, "b").executionId!;
  assert.match(await open(`${job.handle} ${executionId}`), new RegExp(`execution ${executionId}[\\s\\S]*Braid node b`));
  await assert.rejects(open(`${job.handle} missing`), /Unknown Braid node or execution "missing" in job-1\. Open \/braid job-1/);
  await assert.rejects(open(`${job.handle} a b`), /Unknown Braid node or execution "a b"/);
  await assert.rejects(open("job-9 a"), /job-9/);
  jobs.dispose();
});

test("/braid completes job handles, then node IDs for that job", async () => {
  const jobs = new BraidJobs();
  const command = captureCommand(jobs);
  assert.equal(command.getArgumentCompletions(""), null);
  const job = jobs.start(chain, {}, context(async () => response()));
  await jobs.wait(job.jobId);
  assert.deepEqual(
    (command.getArgumentCompletions("") as Array<{ value: string }>).map((item) => item.value),
    [job.handle],
  );
  assert.deepEqual(
    (command.getArgumentCompletions(`${job.handle} `) as Array<{ value: string; description: string }>)
      .map((item) => [item.value, item.description]),
    [[`${job.handle} a`, "completed"], [`${job.handle} b`, "completed"]],
  );
  assert.deepEqual(
    (command.getArgumentCompletions(`${job.handle} b`) as Array<{ label: string }>).map((item) => item.label),
    ["b"],
  );
  assert.equal(command.getArgumentCompletions("job-9 "), null);
  assert.equal(command.getArgumentCompletions(`${job.handle} a extra`), null);
  jobs.dispose();
});

test("/braid opens and completes node IDs that contain spaces", async () => {
  const jobs = new BraidJobs();
  const job = jobs.start({ ...input, nodes: [{ type: "execute", id: "code review", prompt: "work" }] }, {},
    context(async () => response("spaced output")));
  await jobs.wait(job.jobId);
  const command = captureCommand(jobs);
  assert.deepEqual(
    (command.getArgumentCompletions(`${job.handle} code r`) as Array<{ value: string }>).map((item) => item.value),
    [`${job.handle} code review`],
  );
  let rendered = "";
  await command.handler(`${job.handle} code review`, {
    mode: "tui",
    ui: {
      custom: async (factory: (...args: unknown[]) => BraidPanel) => {
        const panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, theme, {}, () => {});
        rendered = panel.render(100).join("\n");
        panel.handleInput("q");
      },
    },
  });
  assert.match(rendered, /Braid node code review · completed/);
  assert.match(rendered, /spaced output/);
  jobs.dispose();
});
