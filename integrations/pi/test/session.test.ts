import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { BraidPanel } from "../command.js";
import { BraidJobs } from "../jobs.js";
import { PiTranscripts } from "../transcript.js";
import { context, deferred, input, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;
const tui = { requestRender: () => {}, terminal: { rows: 60 } } as never;
const text = (panel: BraidPanel, width = 120) => stripTerminalSequences(panel.render(width).join("\n"));
const chain = {
  goal: "Chain",
  nodes: [
    { type: "execute" as const, id: "a", prompt: "first task" },
    { type: "execute" as const, id: "b", prompt: "second task" },
  ],
  edges: [{ from: "a", to: "b" }],
};

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("v selects nodes with arrow keys, Enter opens a session, and Esc steps back one level", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(chain, {}, context(async () => response("Chain step finished")));
  await jobs.wait(job.jobId);
  let closed = 0;
  const panel = new BraidPanel(jobs, tui, theme, () => { closed++; }, job.handle);
  t.after(() => panel.dispose());
  assert.match(text(panel), /v select node/);
  assert.doesNotMatch(text(panel), /◆/);

  panel.handleInput("v");
  let view = text(panel);
  assert.match(view, /◆ Selected 1\/2: a · completed/);
  assert.match(view, /◆ a/, "the chart marks the selected node in place of its status icon");
  assert.match(view, /Enter open session/);
  panel.handleInput("\x1b[B");
  assert.match(text(panel), /◆ Selected 2\/2: b/);
  panel.handleInput("\x1b[C");
  assert.match(text(panel), /◆ Selected 1\/2: a/, "selection wraps around");
  panel.handleInput("\x1b[D");

  panel.handleInput("\r");
  view = text(panel);
  assert.match(view, /Braid node b · completed/);
  assert.match(view, /second task/, "the worker's prompt opens the session");
  assert.match(view, /Chain step finished/, "the assistant reply is rendered by Pi's chat component");
  assert.match(view, /context: 1 predecessor output/);

  panel.handleInput("\x1b");
  assert.match(text(panel), /◆ Selected 2\/2: b/);
  panel.handleInput("\x1b");
  assert.doesNotMatch(text(panel), /Selected/);
  assert.equal(closed, 0);
  panel.handleInput("\x1b");
  assert.equal(closed, 1);
});

test("the session streams text, tool calls, and tool output live, following the newest lines", { timeout: 5_000 }, async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const toolGate = deferred<void>();
  const textGate = deferred<void>();
  const ctx = context(async () => response("unused"));
  let calls = 0;
  (ctx.modelRegistry as unknown as Record<string, unknown>).stream = () => {
    const stream = createAssistantMessageEventStream();
    const index = calls++;
    void (async () => {
      if (index === 0) {
        const call = { type: "toolCall" as const, id: "c1", name: "ls", arguments: { path: "." } };
        const partial: AssistantMessage = { ...response(), content: [{ type: "text", text: "" }], stopReason: "toolUse" };
        stream.push({ type: "start", partial });
        (partial.content[0] as { text: string }).text = "Let me look around first.";
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Let me look around first.", partial });
        await toolGate.promise;
        partial.content.push(call);
        stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial });
        stream.push({ type: "done", reason: "toolUse", message: partial });
      } else {
        const message = response("Everything checked out.");
        stream.push({ type: "start", partial: message });
        await textGate.promise;
        stream.push({ type: "done", reason: "stop", message });
      }
    })();
    return stream;
  };
  const job = jobs.start(input, {}, ctx);
  const executionId = () => Object.values(jobs.get(job.handle)!.execution?.executions ?? {})[0]?.executionId ?? "";
  await until(() => !!executionId() && jobs.getTranscript(job.handle, executionId())?.streaming !== undefined);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, { nodeId: "a" });
  t.after(() => panel.dispose());
  await until(() => text(panel).includes("Let me look around first."));
  assert.match(text(panel), /Braid node a · running/);

  toolGate.resolve();
  await until(() => calls === 2);
  await until(() => /Everything checked out\./.test(text(panel)));
  let view = text(panel);
  assert.ok(view.indexOf("Let me look around first.") < view.indexOf('ls path="."'), "the tool card follows the text that requested it");
  assert.match(view, /\(empty directory\)/, "tool results render inside the tool card");
  textGate.resolve();
  await jobs.wait(job.handle);
  view = text(panel);
  assert.match(view, /Braid node a · completed/);
  assert.match(view, /Everything checked out\./);

  // A short terminal shows the end of the transcript until the user scrolls up.
  const short = new BraidPanel(jobs, { requestRender: () => {}, terminal: { rows: 16 } } as never, theme, () => {}, job.handle, { nodeId: "a" });
  t.after(() => short.dispose());
  assert.match(text(short), /Everything checked out\./);
  assert.match(text(short), /Braid node a · completed/, "the node summary stays pinned while following");
  short.handleInput("\x1b[5~");
  assert.doesNotMatch(text(short), /Everything checked out\./);
  assert.match(text(short), /Braid node a · completed/, "scrolling moves only the transcript");
  short.handleInput("\x1b[F");
  assert.match(text(short), /Everything checked out\./);
  const lines = text(short).split("\n");
  const summary = lines.findIndex(line => line.includes("Braid node a · completed"));
  assert.ok(summary > 0 && summary < 8, "the summary sits directly below the job header");
  assert.ok(lines.length <= 16 && lines.every(line => line.length === lines[0]!.length), "the pinned block keeps the panel within its height");
});

test("transcripts close interrupted steps and retain only the newest finished sessions", () => {
  let changes = 0;
  const transcripts = new PiTranscripts(() => { changes++; }, 1);
  const intro = { prompt: "p", goal: "g", predecessors: 0, workspace: "read-only · /tmp" };
  transcripts.start("e1", "a", "/tmp", intro, new Map());
  const partial = { ...response("half"), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: "c1", name: "bash", arguments: {} }] };
  transcripts.assistant("e1", partial);
  transcripts.toolStart("e1", "c1");
  transcripts.streaming("e1", { ...response("still typing") });
  transcripts.finish("e1", "Execution was stopped before this step finished");
  const closed = transcripts.get("e1")!;
  assert.equal(closed.streaming, undefined);
  assert.equal(closed.running.size, 0);
  const [, aborted, result] = closed.messages;
  assert.equal(aborted?.role === "assistant" && aborted.stopReason, "aborted");
  assert.equal(result?.role === "toolResult" && result.isError, true);
  assert.equal(result?.role === "toolResult" && result.toolName, "bash");
  const before = changes;
  transcripts.toolResult("e1", { role: "toolResult", toolCallId: "late", toolName: "x", content: [], isError: false, timestamp: 0 });
  assert.equal(changes, before, "finished transcripts are immutable");

  transcripts.start("e2", "a", "/tmp", intro, new Map());
  transcripts.finish("e2");
  assert.equal(transcripts.get("e1"), undefined, "older finished transcripts are evicted");
  assert.ok(transcripts.get("e2"));
});

test("evicted or unrecorded executions fall back to the summary and activity history", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response("done")));
  await jobs.wait(job.jobId);
  const executionId = jobs.getNode(job.handle, "a").executionId!;
  // Simulate eviction by reading a job whose transcript store no longer has the execution.
  const original = jobs.getTranscript.bind(jobs);
  jobs.getTranscript = (jobId, id) => id === executionId ? undefined : original(jobId, id);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, { executionId });
  t.after(() => panel.dispose());
  const view = text(panel);
  assert.match(view, /live session for this execution is no longer retained/);
  assert.match(view, /history · \d+ events/);
});

test("a flowchart wider than the panel is cropped around the selected node", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const nodes = Array.from({ length: 8 }, (_, index) => ({ type: "execute" as const, id: `reviewer-number-${index}`, prompt: "x" }));
  const job = jobs.start({ goal: "Wide", nodes, edges: [] }, {}, context(async () => response("ok")));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, { requestRender: () => {}, terminal: { rows: 40 } } as never, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  const lines = () => text(panel, 80).split("\n");
  assert.ok(lines().some(line => /\[chart 1–76 of \d+ cols\]/.test(line)), "outside selection the left edge is shown");
  assert.ok(lines().some(line => line.includes("reviewer-number-0")));
  panel.handleInput("v");
  for (let index = 0; index < 6; index++) panel.handleInput("\x1b[C");
  let view = lines();
  assert.ok(view.some(line => /\[chart \d+–\d+ of \d+ cols · selected node\]/.test(line)), view.join("\n"));
  assert.ok(view.some(line => line.includes("◆ reviewer-number-6")), "the selected node's box is in the window");
  assert.ok(!view.some(line => line.includes("reviewer-number-0 done")), "distant nodes are cropped away");
  assert.ok(!view.some(line => line.startsWith("│ nodes")), "no fallback list while the selection is drawn");
  assert.ok(view.every(line => line.length === view[0]!.length), "cropping keeps every row within the panel");
  panel.handleInput("\x1b[D");
  view = lines();
  assert.ok(view.some(line => line.includes("◆ reviewer-number-5")));
  panel.handleInput("\r");
  assert.match(text(panel, 80), /Braid node reviewer-number-5 · completed/);
});

test("selecting a node scrolls a tall flowchart to keep it in view", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const nodes = Array.from({ length: 8 }, (_, index) => ({ type: "execute" as const, id: `step-${index}`, prompt: "x" }));
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }));
  const job = jobs.start({ goal: "Tall", nodes, edges }, {}, context(async () => response("ok")));
  await jobs.wait(job.jobId);
  const panel = new BraidPanel(jobs, { requestRender: () => {}, terminal: { rows: 24 } } as never, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  panel.handleInput("v");
  const body = () => text(panel, 100).split("\n").slice(7);
  assert.ok(body().some(line => line.includes("◆ step-0")));
  for (let index = 0; index < 7; index++) panel.handleInput("\x1b[B");
  assert.ok(body().some(line => line.includes("◆ step-7")), "the last node's box is scrolled into view");
  // Manual scrolling is not overridden until the selection changes.
  panel.handleInput("\x1b[5~");
  assert.ok(!body().some(line => line.includes("◆ step-7")));
});
