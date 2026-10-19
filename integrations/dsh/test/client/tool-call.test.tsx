import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ToolCallOwnerProps, ToolCallPhaseProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { BraidToolCall } from "../../client/ToolCall.js";
import { toolNavigation, toolPresentation, readNavigation, type BraidNavigation } from "../../client/navigation.js";

function result(args: object, value: object, isError = false): ToolCallPhaseProps {
  return { phase: "result", block: { kind: "tool-result", callId: "call-1", seq: 1, time: 2000, callTime: 1000,
    call: { name: "braid", argsRaw: JSON.stringify(args) }, content: [{ type: "text", text: JSON.stringify(value) }], isError, subCalls: [] } };
}
/** Results now carry text content and their identifiers in presentation meta. */
function textResult(name: string, args: object, meta: object): ToolCallPhaseProps {
  return { phase: "result", block: { kind: "tool-result", callId: "call-1", seq: 1, time: 2000, callTime: 1000,
    call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: "text", text: "Braid job job-1 · running" }], isError: false, meta, subCalls: [] } };
}
const start: ToolCallPhaseProps = { phase: "start", block: { phase: "start", callId: "call-1", name: "braid", turn: 1, step: 1, time: 1000, argsRaw: "{}", subCalls: [] } };

test("tool links resolve canonical receipts, exact historical execution, single resume, and legacy handles", () => {
  assert.deepEqual(toolNavigation("braid", result({}, { jobId: "job-1", canonicalJobId: "uuid-1" })), { jobId: "uuid-1", createdBefore: 2000 });
  assert.equal(toolNavigation("braid", start), null);
  assert.equal(toolNavigation("braid", result({}, { message: "failed" }, true)), null);
  assert.deepEqual(toolNavigation("braid_status", result({ jobId: "job-1", nodeId: "review" }, { jobId: "uuid-1", node: { id: "review", executionId: "review@2" } })), { jobId: "uuid-1", nodeId: "review", executionId: "review@2", createdBefore: 2000 });
  assert.deepEqual(toolNavigation("braid_status", result({ jobId: "job-1", executionId: "review@1" }, { jobId: "uuid-1", truncated: true })), { jobId: "uuid-1", executionId: "review@1", createdBefore: 2000 });
  for (const name of ["braid_update", "braid_resume", "braid_cancel"]) {
    assert.deepEqual(toolNavigation(name, result({ jobId: "job-1" }, { canonicalJobId: "uuid-1" })), { jobId: "uuid-1", createdBefore: 2000 });
  }
  assert.deepEqual(toolNavigation("braid_resume", result({ jobId: "job-1", executionIds: ["review@2"] }, { jobId: "job-1" })), { jobId: "job-1", executionId: "review@2", createdBefore: 2000 });
  assert.deepEqual(toolNavigation("braid_cancel", result({ jobId: "job-1" }, { cancelled: true })), { jobId: "job-1", createdBefore: 2000 });
  assert.deepEqual(toolNavigation("braid_status", result({}, { jobs: [] })), {});
  assert.equal(toolNavigation("bash", result({}, { jobId: "uuid-1" })), null);
  assert.deepEqual(readNavigation({ jobId: [], executionId: "e", createdBefore: -1 }), { executionId: "e" });
});

test("text results link and summarize from presentation meta", () => {
  const control = { jobId: "job-1", canonicalJobId: "uuid-1", status: "running",
    execution: { status: "waiting", revision: 5, pausedExecutionIds: ["a"], total: 2, completed: 1 } };
  assert.deepEqual(toolNavigation("braid", textResult("braid", {}, { jobId: "job-1", canonicalJobId: "uuid-1", nodeCount: 3 })), { jobId: "uuid-1", createdBefore: 2000 });
  assert.equal(toolPresentation("braid", textResult("braid", {}, { canonicalJobId: "uuid-1", nodeCount: 3 })).summary, "Graph submitted · 3 nodes");
  assert.match(toolPresentation("braid_status", textResult("braid_status", { jobId: "job-1" }, control)).summary, /^waiting · r5 · 1\/2 executions complete · 1 paused$/);
  const focused = textResult("braid_status", { jobId: "job-1", nodeId: "a" }, { ...control, node: { id: "a", executionId: "a@1", status: "completed" } });
  assert.deepEqual(toolNavigation("braid_status", focused), { jobId: "uuid-1", nodeId: "a", executionId: "a@1", createdBefore: 2000 });
  assert.equal(toolPresentation("braid_status", focused).summary, "execution completed · graph waiting · r5 · 1 paused");
  assert.match(toolPresentation("braid_status", textResult("braid_status", { jobId: "job-1" }, { ...control, truncated: true })).changes.at(-1)!, /full text is saved/);
});

test("operation summaries distinguish snapshot progress, updates not applied, resume and cancellation outcomes", () => {
  const update = { jobId: "job-1", expectedRevision: 4, upsertNodes: [{ id: "review" }], removeNodeIds: ["old"], addEdges: [{ from: "review", to: "apply" }], resume: ["review@1"] };
  const card = toolPresentation("braid_update", result(update, { canonicalJobId: "uuid-1", revision: 5 }));
  assert.match(card.summary, /r4 → r5/);
  assert.deepEqual(card.changes, ["Upsert nodes: review", "Remove nodes: old", "Resume executions: review@1", "Add edges: 1"]);
  assert.match(toolPresentation("braid_update", result(update, {}, true)).summary, /not applied/);
  const status = toolPresentation("braid_status", result({ jobId: "job-1" }, { execution: { status: "waiting", revision: 5, executions: { a: { status: "completed" }, b: { status: "running" } }, pausedExecutionIds: ["a"] } }));
  assert.match(status.summary, /waiting · r5 · 1\/2 executions complete · 1 paused/);
  assert.equal(toolPresentation("braid_cancel", result({ jobId: "job-1" }, { cancelled: false })).summary, "Job already finished");
  assert.equal(toolPresentation("braid_resume", result({ executionIds: ["a", "b"] }, {})).summary, "Resumed 2 execution(s)");
  assert.equal(toolPresentation("braid_resume", result({ jobId: "job-1" }, {})).summary, "Resumed job");
  const pause = toolPresentation("braid_pause", result({ jobId: "job-1", executionIds: ["a"] }, { execution: { revision: 5, pausedExecutionIds: [], suspendedExecutionIds: ["b"] } }));
  assert.equal(pause.summary, "Pause requested for 1 execution(s)");
  assert.deepEqual(pause.changes, ["a", "0 still paused · r5", "1 suspended"]);
  assert.equal(toolPresentation("braid_pause", result({ jobId: "job-1" }, {})).summary, "Pause requested for job");
  assert.deepEqual(toolNavigation("braid_pause", result({ jobId: "job-1", executionIds: ["a@1"] }, { canonicalJobId: "uuid-1" })), { jobId: "uuid-1", executionId: "a@1", createdBefore: 2000 });
  const list = toolPresentation("braid_status", result({}, { jobs: [{ jobId: "uuid-2", handle: "job-2", status: "running" }] }));
  assert.deepEqual(list.jobs[0], { label: "job-2", status: "running", target: { jobId: "uuid-2", createdBefore: 2000 } });
});

test("clicking the tool card opens its target; raw evidence, errors and each listed job remain accessible", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root")!);
  const opened: BraidNavigation[] = [];
  function useDisclosure() { const [expanded, setExpanded] = useState(false); return { expanded, setExpanded, toggle: () => setExpanded(v => !v) }; }
  const common: Omit<ToolCallOwnerProps, "phase" | "block"> = { toolName: "braid_status", callId: "call-1", useDisclosure, openFile() {}, loadImage: async () => { throw new Error("unused"); } };
  const render = async (data: ToolCallPhaseProps) => { await act(async () => root.render(<BraidToolCall {...common} {...data} openBraid={target => opened.push(target)}/>)); };
  const click = async (query: string) => { await act(async () => document.querySelector<HTMLButtonElement>(query)!.click()); };
  try {
    await render(result({ jobId: "job-1", executionId: "review@1" }, { jobId: "uuid-1", status: "running", note: "<script>untrusted</script>" }));
    await click(".br-tool-open");
    assert.deepEqual(opened[0], { jobId: "uuid-1", executionId: "review@1", createdBefore: 2000 });
    await click(".br-tool-actions button");
    assert.equal(document.querySelector(".br-tool-details script"), null);
    assert.match(document.querySelector(".br-tool-details")!.textContent!, /<script>untrusted/);
    assert.match(document.body.textContent!, /Recorded result/);
    await render(result({}, { jobs: [{ jobId: "uuid-2", handle: "job-2", status: "completed" }] }));
    await click('[aria-label="View job-2"]'); assert.equal(opened.at(-1)!.jobId, "uuid-2");
    await render(result({ jobId: "job-1" }, { error: "query failed" }, true));
    assert.ok(document.querySelector('[role="alert"]')); assert.match(document.body.textContent!, /query failed/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
