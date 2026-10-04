import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BraidPanelView } from "../../client/Panel.js";
import { layoutGraph } from "../../client/layout.js";
import type { ControlRequest, PanelApi, PanelFrame } from "../../panel-types.js";

const fixture: PanelFrame = {
  rows: [{ jobId: "uuid-a", handle: "job-1", goal: "Review and implement", status: "running", createdAt: 0 }],
  job: { jobId: "uuid-a", handle: "job-1", goal: "Review and implement", status: "running", createdAt: 0,
    revision: 4, phase: "waiting", nodes: [{ id: "review", type: "execute", status: "completed" }, { id: "apply", type: "integrate", status: "pending" }],
    edges: [{ from: "review", to: "apply" }], loops: [], pausedExecutionIds: ["review@1"],
    usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 },
    executions: [{ id: "review", executionId: "review@1", revision: 3, status: "completed", type: "execute", iteration: 1, latencyMs: 1800 }],
    events: [{ sequence: 1, timestamp: 0, type: "execution_paused", executionId: "review@1", message: "execution paused" }],
  },
};
async function setup() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root")!);
  const controls: ControlRequest[] = [];
  const signals: AbortSignal[] = [];
  const sessions: string[] = [];
  let fail = false;
  const api: PanelApi = {
    async *watch(request, signal) {
      signals.push(signal); sessions.push(request.sessionId);
      if (fail) throw new Error("Connection lost");
      yield request.sessionId === "empty" ? { rows: [], job: null } : fixture;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    control: async request => { controls.push(request); return fixture; },
    detail: async request => ({ executionId: request.executionId, status: "completed", output: "<script>untrusted</script>\nReview passed", offset: 0, next: 42, total: 42 }),
  };
  const render = async (sessionId = "owner") => { await act(async () => { root.render(<BraidPanelView sessionId={sessionId} api={api}/>); }); };
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent === label || b.getAttribute("aria-label") === label);
    assert.ok(button, `Missing ${label}`); await act(async () => button.click());
  };
  return { dom, root, api, controls, signals, sessions, render, click, disconnect: () => { fail = true; },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); } };
}

test("panel renders DAG, output as text, exact-revision resume and cancel; switching session aborts observation", async () => {
  const h = await setup();
  try {
    await h.render();
    assert.match(document.body.textContent!, /Review and implement/);
    assert.equal(document.querySelectorAll(".br-node").length, 2);
    assert.equal(document.querySelector(".br-output script"), null);
    assert.match(document.querySelector(".br-output")!.textContent!, /<script>untrusted/);
    await h.click("Resume this execution");
    assert.deepEqual(h.controls[0], { sessionId: "owner", jobId: "uuid-a", action: "resume", executionIds: ["review@1"], revision: 4 });
    await h.click("Event log (1)"); assert.match(document.querySelector(".br-events")!.textContent!, /execution paused/);
    await h.click("Cancel job"); assert.equal(h.controls[1]!.action, "cancel");
    await h.render("empty"); assert.equal(h.signals[0]!.aborted, true);
    assert.match(document.body.textContent!, /No Braid jobs/); assert.ok(!document.body.textContent!.includes("Review and implement"));
  } finally { await h.close(); }
});

test("connection failures are visible, controls cannot act on stale frames and unmount cancels retry", async () => {
  const h = await setup();
  try {
    h.disconnect(); await h.render();
    assert.match(document.body.textContent!, /Connection lost/);
    assert.equal(document.querySelector(".br-node"), null);
    assert.ok(document.querySelector('[role="alert"]'));
    await h.click("Reconnect"); assert.equal(h.signals[0]!.aborted, true);
  } finally { await h.close(); }
  assert.ok(h.signals.every(signal => signal.aborted));
});

test("forward DAG ranks remain stable with loop feedback, branching and disconnected nodes", () => {
  const nodes = ["a", "b", "c", "d", "isolated"].map(id => ({ id, type: "execute", status: "pending" }));
  const { positions, width, height } = layoutGraph(nodes, [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }, { from: "d", to: "a", feedback: "review" }]);
  assert.ok(positions.get("a")!.y < positions.get("b")!.y);
  assert.equal(positions.get("b")!.y, positions.get("c")!.y);
  assert.ok(positions.get("b")!.y < positions.get("d")!.y);
  assert.equal(new Set([...positions.values()].map(p => `${p.x},${p.y}`)).size, nodes.length);
  assert.ok(width > 300 && height > 300);
});

test("tool navigation selects an older loop execution and reopening the tab resets manual selection", async () => {
  const h = await setup();
  const requests: object[] = [];
  const data = structuredClone(fixture);
  data.job!.executions.unshift({ ...data.job!.executions[0]!, executionId: "review@0", iteration: 0 });
  const api: PanelApi = { ...h.api, async *watch(request, signal) {
    requests.push(request); yield data;
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  } };
  const target = { jobId: "uuid-a", executionId: "review@0", createdBefore: 2000 };
  try {
    await act(async () => h.root.render(<BraidPanelView key={1} sessionId="owner" api={api} target={target}/>));
    assert.deepEqual(requests[0], { sessionId: "owner", jobId: "uuid-a", createdBefore: 2000 });
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Execution history"]')!.value, "review@0");
    assert.ok(!document.body.textContent!.includes("Resume this execution"));
    await act(async () => document.querySelector<HTMLButtonElement>('.br-node[title^="apply"]')!.click());
    assert.match(document.body.textContent!, /This node has not run yet/);
    await act(async () => h.root.render(<BraidPanelView key={2} sessionId="owner" api={api} target={target}/>));
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Execution history"]')!.value, "review@0");
    assert.equal(requests.length, 2);
    await act(async () => h.root.render(<BraidPanelView key={3} sessionId="owner" api={api} target={{ jobId: "uuid-a", executionId: "missing" }}/>));
    assert.match(document.body.textContent!, /requested execution \(missing\) is no longer available/);
    assert.equal(document.querySelector('[aria-label="Execution output"]'), null);
  } finally { await h.close(); }
});
