import assert from "node:assert/strict";
import test from "node:test";
import { braidTool } from "../index.js";
import type { BraidResult, ExecutionEvent } from "../../../dist/index.js";

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
  assert.ok(braidTool.renderCall);
  const rendered = lines(
    braidTool.renderCall!(
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
      {} as never,
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
  assert.ok(braidTool.renderResult);
  const compact = lines(
    braidTool.renderResult!(
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
    braidTool.renderResult!(
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

test("running renderer highlights active nodes and shows live progress", () => {
  assert.ok(braidTool.renderResult);
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
    braidTool.renderResult!(
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
  assert.ok(braidTool.renderResult);
  const rendered = lines(
    braidTool.renderResult!(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
      theme,
      {} as never,
    ),
  );
  assert.match(rendered, /Braid is running…/);
});
