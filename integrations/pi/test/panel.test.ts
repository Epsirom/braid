import assert from "node:assert/strict";
import test from "node:test";
import { SelectList, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { BraidPanel, registerBraidCommand } from "../command.js";
import { renderNodePicker } from "../display.js";
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
  panel.handleInput("\x1b[B");
  assert.match(panel.render(100).at(-3)!, /Lines 2–/, "choosing a node scrolls its list row into view");
  assert.match(panel.render(100).join("\n"), /▸ · node1|▸ ✓ node1/);
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

test("panel opens finished nodes at the top and fits each help line to the panel width", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const long = Array.from({ length: 80 }, (_, i) => `output line ${i + 1}`).join("\n");
  const job = jobs.start(chain, {}, context(async () => response(long)));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  // The full graph hint is 70 columns and must appear as soon as it fits.
  assert.match(panel.render(74).join("\n"), /↑\/↓ node {3}⏎ open {3}←\/→ jobs {3}PgUp\/PgDn scroll {3}c cancel {3}Esc close/);
  assert.match(panel.render(73).join("\n"), /↑\/↓ node · ⏎ open · ←\/→ jobs · c cancel · Esc close/);
  panel.handleInput("\r");
  const opened = panel.render(100);
  assert.match(opened.join("\n"), /Braid node a · completed/, "a finished node shows its details first");
  assert.match(opened.at(-3)!, /Lines 1–/);
  panel.handleInput("\t");
  assert.match(panel.render(100).at(-3)!, /Lines 1–/, "Tab to another finished node also starts at the top");
});

test("panel windows very large node lists around the selection", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const nodes = Array.from({ length: 200 }, (_, i) => ({ type: "execute" as const, id: `n${i}`, prompt: "work" }));
  const job = jobs.start({ ...input, nodes }, { maxConcurrency: 50 }, context(async () => response()));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  for (let i = 0; i < 150; i++) panel.handleInput("\x1b[B");
  const rendered = panel.render(100).join("\n");
  assert.match(rendered, /▸ ✓ n150 /, "the selected row is scrolled into view");
  const picker = renderNodePicker(jobs.get(job.handle)!.result!.nodes, undefined, "n150", theme);
  assert.match(picker.lines.join("\n"), /… 110 more above[\s\S]*… 10 more below/);
  assert.equal(picker.lines.length, 1 + 1 + 80 + 1);
  assert.match(picker.lines[picker.selectedLine]!, /▸ ✓ n150/);
  assert.ok(panel.render(100).every((line) => visibleWidth(line) === 100));
  let total = 0;
  const lines = /Lines \d+–\d+\/(\d+)/.exec(rendered);
  if (lines) total = Number(lines[1]);
  assert.ok(total < 200, `the list is windowed, not 200+ rows (got ${total} lines)`);
});

/** A provider that streams `text` and then waits until the job is cancelled. */
function streaming(text: string, started: () => void) {
  const ctx = context(async () => response());
  (ctx.modelRegistry as unknown as { stream: unknown }).stream = (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
    const aborted = new Promise<never>((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    aborted.catch(() => {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", contentIndex: 0, delta: text };
        started();
        await aborted;
      },
      result: () => aborted,
    };
  };
  return ctx;
}

test("panel selects a node from the graph with arrow keys or Tab and opens it with Enter", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(chain, {}, context(async () => response("node output")));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  assert.match(panel.render(100).join("\n"), /nodes \(2\) · ↑\/↓ choose · Enter for live details/);
  assert.match(panel.render(100).join("\n"), /│ ▸ ✓ a +completed · [\d.]+s +│\n│   ✓ b +completed/);
  assert.match(panel.render(100).join("\n"), /↑\/↓ node {3}⏎ open/);
  panel.handleInput("\x1b[B");
  assert.match(panel.render(100).join("\n"), /▸ ✓ b +completed/, "Down selects the next node");
  panel.handleInput("\x1b[A");
  assert.match(panel.render(100).join("\n"), /▸ ✓ a +completed/, "Up selects the previous node");
  panel.handleInput("\t");
  assert.match(panel.render(100).join("\n"), /▸ ✓ b/);
  panel.handleInput("\t");
  assert.match(panel.render(100).join("\n"), /▸ ✓ a/, "Tab wraps around");
  panel.handleInput("\x1b[Z");
  assert.match(panel.render(100).join("\n"), /▸ ✓ b/, "Shift+Tab moves back");
  panel.handleInput("\r");
  const focused = panel.render(100).join("\n");
  assert.match(focused, /Braid node b · completed/);
  assert.doesNotMatch(focused, /nodes \(2\)/);
  assert.match(focused, /⌫ graph {3}Tab\/⇧Tab node {3}←\/→ jobs/);
  assert.match(panel.render(64).join("\n"), /⌫ graph · Tab\/⇧Tab node · ↑\/↓ scroll · c cancel · Esc close/);
  assert.match(panel.render(40).join("\n"), /⌫ graph · Esc close/);
  panel.handleInput("\t");
  assert.match(panel.render(100).join("\n"), /Braid node a · completed/, "Tab switches the focused node");
  panel.handleInput("\x1b[Z");
  assert.match(panel.render(100).join("\n"), /Braid node b · completed/, "Shift+Tab returns to the previous node");
  panel.handleInput("\t");
  panel.handleInput("\x7f");
  const graph = panel.render(100).join("\n");
  assert.match(graph, /Braid completed/);
  assert.match(graph, /▸ ✓ a/, "returning keeps the last focused node selected");
  assert.ok(panel.render(100).every((line) => visibleWidth(line) === 100));
});

test("panel streams a running node's output live and follows the newest text", { timeout: 2_000 }, async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const started = deferred<void>();
  const lines = Array.from({ length: 60 }, (_, i) => `streamed line ${i + 1}`).join("\n");
  const job = jobs.start(input, {}, streaming(lines, () => started.resolve()));
  await started.promise;
  const panel = new BraidPanel(jobs, focusTui, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  assert.match(panel.render(100).join("\n"), /▸ ▶ a +running · \d/, "the first running node is preselected");
  panel.handleInput("\r");
  const live = panel.render(100).join("\n");
  assert.match(live, /streamed line 60/, "the view follows the newest output");
  assert.doesNotMatch(live, /streamed line 1\n/);
  panel.handleInput("\x1b[5~");
  panel.handleInput("\x1b[5~");
  panel.handleInput("\x1b[5~");
  panel.handleInput("\x1b[5~");
  panel.handleInput("\x1b[5~");
  panel.handleInput("\x1b[5~");
  const scrolled = panel.render(100).join("\n");
  assert.match(scrolled, /Braid node a · running/);
  assert.match(scrolled, /live output \(streaming\)/);
  assert.doesNotMatch(scrolled, /streamed line 60/, "scrolling up stops following");
  assert.equal(JSON.stringify(jobs.get(job.handle)).includes("streamed line"), false, "status snapshots exclude the stream");
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

test("/braid safely completes and opens exact node IDs with whitespace, quotes, and terminal controls", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const command = captureCommand(jobs);
  const ids = [" review ", '"quoted"', "review\x1b[2J\nsecond line", "review\tstep", "review\u2028step\u2029end"];
  const identity = (value: string) => value;
  for (const [index, id] of ids.entries()) {
    const job = jobs.start({ ...input, nodes: [{ type: "execute", id, prompt: "work" }] }, {},
      context(async () => response(`exact output ${index}`)));
    await jobs.wait(job.handle);
    const [item] = command.getArgumentCompletions(`${job.handle} `) as Array<{ value: string; label: string; description: string }>;
    assert.ok(item);
    assert.equal(JSON.parse(item.value.slice(job.handle.length + 1)), id);
    assert.equal(item.label, item.value.slice(job.handle.length + 1));
    const menu = new SelectList([item], 5, { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity });
    assert.ok(menu.render(100).every(line => stripTerminalSequences(line) === line && !/[\p{Cc}\u2028\u2029]/u.test(line)));
    assert.ok(!/[\p{Cc}\u2028\u2029]/u.test(item.value));
    const prefix = item.value.slice(0, job.handle.length + 4);
    assert.deepEqual(command.getArgumentCompletions(prefix), [item]);
    let rendered = "";
    await command.handler(item.value, {
      mode: "tui",
      ui: {
        custom: async (factory: (...args: unknown[]) => BraidPanel) => {
          const panel = factory({ requestRender: () => {}, terminal: { rows: 30 } }, theme, {}, () => {});
          rendered = panel.render(100).join("\n");
          panel.handleInput("q");
        },
      },
    });
    assert.ok(rendered.includes(`exact output ${index}`), rendered);
  }
});

test("/braid reports malformed quoted node targets before opening a panel", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response()));
  await jobs.wait(job.handle);
  const command = captureCommand(jobs);
  await assert.rejects(command.handler(`${job.handle} "unterminated`, { mode: "tui" }), /quoted.*JSON string/i);
});
