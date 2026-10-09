import assert from "node:assert/strict";
import test from "node:test";
import {
  renderGraphCall,
  renderGraphResult,
  renderNodeResult,
  applyEvent,
  createLiveState,
  type BraidToolDetails,
} from "../display.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createBraidTools } from "../index.js";
import { BraidJobs, type JobSnapshot } from "../jobs.js";
import { context, input, response } from "./helpers.js";

function renderResult(
  result: { content: unknown[]; details: BraidToolDetails },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _ctx: unknown,
) {
  return renderGraphResult(
    result.details,
    options.expanded,
    options.isPartial,
    theme,
  );
}
import type { BraidResult, ExecutionEvent } from "@chrok/braid";

const theme = {
  fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  bg: (color: string, value: string) => `<bg:${color}>${value}</bg:${color}>`,
  bold: (value: string) => `<bold>${value}</bold>`,
} as never;

function lines(
  component: { render(width: number): string[] },
  width = 160,
): string {
  return component.render(width).join("\n");
}

const result: BraidResult = {
  executions: {}, revision: 0, terminalExecutionIds: [],
  status: "failed",
  terminalOutputs: { answer: { output: "final answer" } },
  events: [
    {
      type: "graph_created",
      sequence: 1,
      timestamp: 1,
      nodeCount: 4,
      edgeCount: 1,
    },
    {
      type: "node_started",
      sequence: 2,
      timestamp: 2,
      nodeId: "route",
      model: "fake/router",
    },
    {
      type: "handoff",
      sequence: 3,
      timestamp: 3,
      from: "route",
      to: "left",
      output: "route text",
      decision: "go",
    },
    {
      type: "node_failed",
      sequence: 4,
      timestamp: 4,
      nodeId: "answer",
      latencyMs: 41,
      error: { code: "MODEL_ERROR", message: "provider unavailable" },
    },
    {
      type: "graph_failed",
      sequence: 5,
      timestamp: 5,
      terminalNodeIds: ["answer"],
      error: { code: "MODEL_ERROR", message: "provider unavailable" },
    },
  ] satisfies readonly ExecutionEvent[],
  nodes: {
    route: {
      id: "route",
      status: "completed",
      output: "route text",
      decision: "go",
      model: "fake/router",
      latencyMs: 0,
    },
    left: {
      id: "left",
      status: "completed",
      output: "left output",
      model: "fake/worker",
      latencyMs: 0,
    },
    right: { id: "right", status: "skipped", skipReason: "inactive" },
    answer: {
      id: "answer",
      status: "failed",
      latencyMs: 41,
      error: { code: "MODEL_ERROR", message: "provider unavailable" },
    },
  },
  error: { code: "MODEL_ERROR", message: "provider unavailable" },
  metadata: {
    runId: "run",
    rootRunId: "run",
    startedAt: 1,
    finishedAt: 42,
    latencyMs: 41,
    usage: { inputTokens: 10, outputTokens: 5 },
    usageReportedNodes: 2,
  },
};

test("Braid call renderer summarizes topology instead of dumping JSON", () => {
  const rendered = lines(
    renderGraphCall(
      {
        goal: "A goal that should be visible",
        nodes: [
          {
            type: "decision",
            id: "route",
            prompt: "route",
            choices: ["go", "stop"],
          },
          { type: "execute", id: "left", prompt: "left" },
        ],
        edges: [{ from: "route", to: "left", choice: "go" }],
        options: { maxConcurrency: 2 },
      },
      theme,
    ),
  );
  assert.match(rendered, /◆ Braid/);
  assert.match(rendered, /2 nodes \(1 decision\)/);
  assert.match(rendered, /◇ route {2}○ left/);
  assert.match(rendered, /route -go-> left/);
  assert.match(rendered, /A goal that should be visible/);
  assert.doesNotMatch(rendered, /┌/);
  assert.doesNotMatch(rendered, /"prompt"/);
});

test("Braid result renderer summarizes flow and expands to per-node detail", () => {
  const compact = lines(
    renderResult(
      { content: [], details: result },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    ),
    500,
  );
  assert.match(compact, /✗ Braid failed/);
  assert.match(compact, /2\/4 completed · 1 skipped · 1 failed · 0.04s/);
  assert.match(compact, /terminals: answer/);
  assert.match(compact, /done · 0.00s/);
  assert.match(compact, /┌/);
  assert.doesNotMatch(compact, /execution log/);

  const expanded = lines(
    renderResult(
      { content: [], details: result },
      { expanded: true, isPartial: false },
      theme,
      {} as never,
    ),
    500,
  );
  assert.match(expanded, /done · 0.00s/);
  assert.match(expanded, /┌/);
  assert.doesNotMatch(expanded, /nodes:/);
  assert.match(expanded, /execution log · 5 events/);
  assert.match(expanded, /handoff · route → left: route text/);
  assert.match(expanded, /failed · answer \(MODEL_ERROR\)/);
});

test("failed graphs show retained workspace paths when expanded", () => {
  const details: BraidToolDetails = {
    ...result,
    workspaces: {
      left: { nodeId: "left", mode: "worktree", state: "ready", workingDirectory: "/tmp/node-worktree", worktreeRoot: "/tmp/node-worktree" },
    },
  };
  const compact = lines(renderGraphResult(details, false, false, theme));
  assert.match(compact, /workspaces: 1 active · 0 cleaned/);
  assert.doesNotMatch(compact, /\/tmp\/node-worktree/);
  const expanded = lines(renderGraphResult(details, true, false, theme));
  assert.match(expanded, /left · ready: \/tmp\/node-worktree/);
  details.workspaces!.left!.state = "archived";
  details.workspaces!.left!.checkpointRef = "refs/braid/checkpoints/recovery";
  const archived = lines(renderGraphResult(details, true, false, theme));
  assert.match(archived, /0 active · 1 cleaned/);
  assert.match(archived, /left · archived: refs\/braid\/checkpoints\/recovery/);
  assert.doesNotMatch(archived, /\/tmp\/node-worktree/);
});

test("running renderer highlights active nodes and shows live progress", () => {
  const live = {
    status: "running",
    terminalOutputs: {},
    nodes: {
      active: { id: "active", status: "running", model: "fake/worker" },
      waiting: { id: "waiting", status: "pending" },
    },
    nodeTypes: { active: "execute", waiting: "execute" },
    edges: [{ from: "active", to: "waiting" }],
    progress: {
      active: {
        nodeId: "active",
        contextTokens: 20_000,
        contextWindow: 1_000_000,
        contextSource: "reported",
        toolCalls: 23,
        toolRounds: 1,
        phase: "tool",
      },
    },
    events: [
      {
        type: "graph_created",
        sequence: 1,
        timestamp: 1,
        nodeCount: 2,
        edgeCount: 0,
      },
      {
        type: "node_started",
        sequence: 2,
        timestamp: 2,
        nodeId: "active",
        model: "fake/worker",
      },
    ],
    latencyMs: 12,
  } as never;
  const rendered = lines(
    renderResult(
      { content: [], details: live },
      { expanded: true, isPartial: true },
      theme,
      {} as never,
    ),
  );
  assert.match(rendered, /⟳ Braid executing/);
  assert.match(
    rendered,
    /0\/2 completed · 1 active · 1 pending · 0 skipped · 0 failed · 0.01s/,
  );
  assert.match(rendered, /▶ ACTIVE active running/);
  assert.match(rendered, /started · active/);
  assert.match(rendered, /~?20K\/1M/);
  assert.match(rendered, /T23/);
  assert.match(rendered, /20K\/1M · T23/);
  assert.match(rendered, /┌/);
  assert.match(rendered, /▶ ACTIVE active/);
});

test("partial renderer remains compact before Braid has result details", () => {
  const rendered = lines(
    renderResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
      theme,
      {} as never,
    ),
  );
  assert.match(rendered, /Braid is running…/);
});

test("a too-wide flowchart is cropped to the terminal width around a running node", () => {
  const longId = "a-very-long-node-identifier-that-widens-the-chart";
  const { error: _error, ...base } = result;
  const wide: BraidResult = {
    ...base,
    terminalOutputs: {},
    events: [],
    nodes: {
      [longId]: {
        id: longId,
        status: "completed",
        output: "x",
        model: "fake/model",
        latencyMs: 0,
      },
      [`${longId}-two`]: {
        id: `${longId}-two`,
        status: "completed",
        output: "x",
        model: "fake/model",
        latencyMs: 0,
      },
    },
  };
  const width = 40;
  const component = renderGraphResult(wide, false, false, theme);
  const rendered = component.render(width);
  assert.ok(
    rendered.some((line) => /^\[chart 1–40 of \d+ cols\]$/.test(line)),
    "a too-wide chart is cropped from its left edge when nothing is running",
  );
  assert.ok(rendered.some((line) => line.includes("┌")), "the cropped chart itself is drawn");
  // A running node is kept in view. Plain styling keeps tag markup out of column counts.
  const plainTheme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
  const running = renderGraphResult({ ...wide, nodes: { ...wide.nodes, [`${longId}-two`]: { id: `${longId}-two`, status: "running", startedAt: 0 } } },
    false, false, plainTheme).render(width);
  assert.ok(running.some((line) => /^\[chart \d+–\d+ of \d+ cols · running node\]$/.test(line)), running.join("\n"));
  assert.ok(running.some((line) => line.includes("▶ ACTIVE")), "the running node's box is inside the window");
  for (const line of [...rendered, ...running]) {
    assert.ok(
      visibleWidth(line) <= width,
      `rendered line exceeds ${width} columns: ${line}`,
    );
  }
});

test("registered submission renderer shows graph validation errors with Pi's empty details", async (t) => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool } = createBraidTools(jobs);
  let calls = 0;
  const ctx = context(async () => { calls++; return response(); });
  let failure = "";
  await assert.rejects(braidTool.execute("invalid", {
    ...input, nodes: [...input.nodes, ...input.nodes],
  }, undefined, undefined, ctx), error => {
    assert.ok(error instanceof Error);
    failure = error.message;
    return true;
  });
  const rendered = lines(braidTool.renderResult!(
    { content: [{ type: "text", text: failure }], details: {} as JobSnapshot },
    { expanded: false, isPartial: false }, theme, { isError: true } as never,
  ));
  assert.match(rendered, /<error>✗ Braid submission failed: Duplicate node id 'a'/);
  assert.doesNotMatch(rendered, /background job|undefined|\/braid to view/);
  assert.deepEqual(jobs.list(), []);
  assert.equal(calls, 0);
});

test("registered renderers preserve host errors, including schema failures before execute", () => {
  const { braidTool, statusTool } = createBraidTools(new BraidJobs());
  let failure = "";
  assert.throws(() => validateToolArguments(braidTool, {
    type: "toolCall", id: "invalid", name: "braid", arguments: { ...input, nodes: [{ type: "unknown", id: "a" }] },
  }), error => {
    assert.ok(error instanceof Error);
    failure = error.message;
    return true;
  });
  for (const tool of [braidTool, statusTool]) {
    for (const details of [undefined, {}, { jobId: "incomplete" }]) {
      for (const expanded of [false, true]) {
        const rendered = lines(tool.renderResult!(
          { content: [{ type: "text", text: failure }], details: details as JobSnapshot | undefined },
          { expanded, isPartial: false }, theme, { isError: true } as never,
        ), 10_000);
        for (const line of failure.split("\n")) assert.ok(rendered.includes(line), `Missing error line: ${line}`);
        assert.match(rendered, /<error>✗ Validation failed for tool "braid"/);
        assert.doesNotMatch(rendered, /background job|undefined|\/braid to view/);
      }
    }
  }
});

test("registered renderers guard empty details even without the host error flag", () => {
  const { braidTool, statusTool } = createBraidTools(new BraidJobs());
  for (const tool of [braidTool, statusTool]) {
    const rendered = lines(tool.renderResult!(
      { content: [{ type: "text", text: "Unknown Braid job: job-99" }], details: {} as JobSnapshot },
      { expanded: false, isPartial: false }, theme, { isError: false } as never,
    ));
    assert.match(rendered, /Unknown Braid job: job-99/);
    assert.doesNotMatch(rendered, /background job|undefined/);
  }
});

test("registered submission renderer distinguishes pending, started, and startup failure", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool, statusTool } = createBraidTools(jobs);
  const pending = lines(braidTool.renderResult!(
    { content: [], details: undefined }, { expanded: false, isPartial: true }, theme, { isError: false } as never,
  ));
  assert.match(pending, /Braid submission pending/);
  assert.doesNotMatch(pending, /failed|undefined/);
  const submitted = await braidTool.execute("ok", input, undefined, undefined, context(async () => response()));
  const rendered = lines(braidTool.renderResult!(
    submitted, { expanded: false, isPartial: false }, theme, { isError: false } as never,
  ));
  assert.match(rendered, /Braid background job job-1 · running · \/braid to view/);

  for (const tool of [braidTool, statusTool]) {
    const failed = lines(tool.renderResult!({
      content: [], details: { ...submitted.details!, status: "failed", error: "Invalid maxConcurrency" },
    }, { expanded: false, isPartial: false }, theme, { isError: false } as never));
    assert.match(failed, /<error>.*failed/);
    assert.match(failed, /Invalid maxConcurrency/);

    // A host/extension error flag takes precedence over even valid job details.
    const overridden = lines(tool.renderResult!({
      ...submitted, content: [{ type: "text", text: "Host rejected the result" }],
    }, { expanded: false, isPartial: false }, theme, { isError: true } as never));
    assert.match(overridden, /<error>✗ Host rejected the result/);
    assert.doesNotMatch(overridden, /background job|undefined/);
  }
  await jobs.wait(submitted.details!.jobId);
});

test("terminal graph events update live state and clear pause indicators", () => {
  const completed = createLiveState();
  completed.pausedExecutionIds = ["held"];
  applyEvent(completed, { type: "graph_completed", terminalNodeIds: [], sequence: 1, timestamp: 1 });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.pausedExecutionIds, []);
  assert.match(lines(renderGraphResult(completed, false, false, theme)), /✓ Braid completed/);

  const cancelled = createLiveState();
  cancelled.pausedExecutionIds = ["held"];
  applyEvent(cancelled, { type: "graph_failed", terminalNodeIds: [], sequence: 1, timestamp: 1,
    error: { code: "CANCELLED", message: "Graph cancelled by caller" } });
  assert.equal(cancelled.status, "failed");
  assert.deepEqual(cancelled.pausedExecutionIds, []);
  const rendered = lines(renderGraphResult(cancelled, false, false, theme));
  assert.match(rendered, /Braid cancelled/);
  assert.match(rendered, /Graph cancelled by caller/);
  assert.doesNotMatch(rendered, /Braid executing|paused executions/);
});

test("node details render at the observation time and show recoverable workspace refs", () => {
  const plainTheme = { fg: (_c: string, v: string) => v, bg: (_c: string, v: string) => v, bold: (v: string) => v };
  const render = (node: Parameters<typeof renderNodeResult>[0], now: number) =>
    renderNodeResult(node, true, plainTheme, undefined, undefined, now).render(200).join("\n");
  const running = { id: "a", status: "running" as const, startedAt: 1_000, iteration: 2 };
  assert.match(render(running, 3_500), /iteration #2 · elapsed 2s/);
  assert.match(render(running, 3_500), /elapsed 2s/, "the same observation renders the same elapsed time");
  const workspace = {
    nodeId: "a", mode: "worktree" as const, workingDirectory: "/tmp/wt", worktreeRoot: "/tmp/wt",
    checkpointRef: "refs/braid/checkpoint", state: "ready" as const,
  };
  assert.match(render({ id: "a", status: "running", workspace }, 0), /workspace: worktree · ready · \/tmp\/wt/);
  const archived = render({ id: "a", status: "completed", workspace: { ...workspace, state: "archived" } }, 0);
  assert.match(archived, /workspace: worktree · archived · refs\/braid\/checkpoint/);
  assert.doesNotMatch(archived, /\/tmp\/wt/);
});
