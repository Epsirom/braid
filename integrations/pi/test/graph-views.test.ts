import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NodeExecution } from "@chrok/braid";
import { BraidPanel } from "../command.js";
import { createLiveState, executionLayout, MAX_VISIBLE_NODES, renderGraphResult, TIMELINE_ROUNDS, type GraphView } from "../display.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;

function execution(id: string, generation: number, fields: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id, executionId: `${id}@${generation}`, generation, revision: 0, status: "completed", predecessorExecutionIds: [],
    node: { type: "execute", id, prompt: id }, ...fields,
  };
}

/** draft was replaced while check waits for it; the old lineage was removed after it ran. */
function replacedState() {
  const executions: Record<string, NodeExecution> = {
    "draft@1": execution("draft", 1, { supersededBy: "draft@2", usage: { inputTokens: 2_000, outputTokens: 1_000 }, latencyMs: 2_000 }),
    "old@1": execution("old", 1, { latencyMs: 1_000 }),
    "draft@2": execution("draft", 2, { status: "running", supersedes: "draft@1", startedAt: 0 }),
    "check@1": execution("check", 1, { status: "pending", waitReason: "predecessors" }),
  };
  const live = createLiveState();
  live.observedAt = 3_000;
  live.nodeTypes = { draft: "execute", check: "execute" };
  live.edges = [{ from: "draft", to: "check" }];
  live.nodes = {
    draft: { id: "draft", executionId: "draft@2", status: "running", startedAt: 0 },
    check: { id: "check", executionId: "check@1", status: "pending" },
  };
  live.progress = { draft: { nodeId: "draft", executionId: "draft@2", contextTokens: 2_000, contextSource: "reported", toolCalls: 3, toolRounds: 2, phase: "tool" } };
  return { ...live, executions };
}

const chart = (details: ReturnType<typeof replacedState>, view?: GraphView, selected?: string) =>
  renderGraphResult(details, false, false, theme, "", false, selected, view ? { view } : {}).render(400).join("\n");

test("tool-result charts show each node's wait reason, running sub-state, runs, and lineage usage", () => {
  const view = chart(replacedState());
  // Labels wrap at 24 columns, so match words rather than whole lines.
  assert.match(view, /draft@2 running/);
  assert.match(view, /· tool ·/, "the running sub-state is the worker's phase");
  assert.match(view, /2 runs/, "runs count started instances");
  assert.match(view, /\b3K\b/, "usage sums the lineage");
  assert.match(view, /pending · waits/);
  assert.match(view, /predecessors/);
  assert.doesNotMatch(view, /old/, "a removed lineage has no box");
  assert.doesNotMatch(view, /draft@1/);
});

test("the live view draws only pending, running, and held executions", () => {
  const details = replacedState();
  let view = chart(details, "live");
  assert.match(view, /▶ ACTIVE draft@2/);
  assert.match(view, /○ check@1/);
  assert.match(view, /waits/);
  assert.match(view, /╎/, "a pending execution's expected input is dotted");
  assert.doesNotMatch(view, /draft@1|old@1/, "settled executions are left out");
  details.executions["old@1"] = { ...details.executions["old@1"]!, held: true };
  view = chart(details, "live");
  assert.match(view, /old@1/, "a held result has not gone downstream yet");
  assert.match(view, /held/);
  for (const id of Object.keys(details.executions)) details.executions[id] = { ...details.executions[id]!, status: "completed", held: false };
  view = chart(details, "live");
  assert.match(view, /Nothing is pending, running, or held · press g for the timeline/);
  assert.doesNotMatch(view, /┌|╭/, "no empty chart is drawn");
});

test("the timeline keeps superseded and removed executions and links replacements", () => {
  const view = chart(replacedState(), "timeline");
  for (const id of ["draft@1", "draft@2", "check@1", "old@1"]) assert.match(view, new RegExp(id));
  assert.match(view, /superseded → draft@2/);
  assert.match(view, /replaces/, "the replaced execution links to its replacement");
  assert.match(view, /removed/, "an execution of a removed node is kept and marked");
  assert.match(view, /╎/, "a pending execution's expected input is dotted");
  assert.doesNotMatch(view, /folded/);
  const selected = chart(replacedState(), "timeline", "draft@1");
  assert.match(selected, /◆ draft@1/, "selection marks the exact execution");
  const cropped = renderGraphResult(replacedState(), false, false, theme, "", false, "missing@1", { view: "timeline" }).render(30).join("\n");
  assert.match(cropped, /executions \(selected execution/, "a cropped chart without the selection lists executions");
  assert.match(cropped, /draft@1 · completed/);
});

test("skipped executions are drawn differently from pending ones", () => {
  const details = replacedState();
  details.executions["check@1"] = execution("check", 1, { status: "skipped", skipReason: "inactive", finishedAt: 5 });
  details.executions["draft@2"] = execution("draft", 2, { supersedes: "draft@1", finishedAt: 4 });
  const view = chart(details, "timeline");
  assert.match(view, /⊘ check@1/);
  assert.match(view, /skipped ·/);
  assert.match(view, /inactive/);
  assert.doesNotMatch(view, /○ check@1/);
  assert.match(view, /╎/, "the skipped execution shows the upstream result it saw");
});

test("the timeline folds older settled generations per node, never active or held ones", () => {
  const executions: Record<string, NodeExecution> = {};
  for (let generation = 1; generation <= 5; generation++) {
    executions[`edit@${generation}`] = execution("edit", generation, generation === 2 ? { held: true } : {});
    executions[`review@${generation}`] = execution("review", generation, generation === 5 ? { status: "running" } : {});
  }
  const ids = (records: readonly NodeExecution[]) => records.map(record => record.executionId);
  const recent = executionLayout(executions, "timeline");
  assert.deepEqual(ids(recent.shown), ["edit@2", "edit@4", "review@4", "edit@5", "review@5"]);
  assert.equal(TIMELINE_ROUNDS, 2);
  assert.deepEqual(ids(recent.folded.get("edit")!), ["edit@1", "edit@3"]);
  assert.deepEqual(ids(recent.folded.get("review")!), ["review@1", "review@2", "review@3"]);
  assert.equal(executionLayout(executions, "timeline", true).shown.length, 10);
  assert.equal(executionLayout(executions, "timeline", true).folded.size, 0);
  const live = executionLayout(executions, "live");
  assert.deepEqual(ids(live.shown), ["edit@2", "review@5"]);
  assert.equal(live.folded.size, 0);

  const many: Record<string, NodeExecution> = {};
  for (let generation = 1; generation <= MAX_VISIBLE_NODES + 20; generation++) many[`step@${generation}`] = execution("step", generation);
  const capped = executionLayout(many, "timeline", true);
  assert.equal(capped.shown.length, MAX_VISIBLE_NODES, "even all history stays within the box limit");
  assert.equal(capped.shown.at(-1)!.generation, MAX_VISIBLE_NODES + 20, "the oldest generations fold first");

  const view = renderGraphResult({ ...createLiveState(), nodes: { edit: { id: "edit", status: "completed" }, review: { id: "review", status: "running" } }, executions },
    false, false, theme, "", false, undefined, { view: "timeline" }).render(400).join("\n");
  assert.match(view, /5 older settled executions folded into 2 ≡ boxes/);
  assert.match(view, /≡ edit@1–3/);
  assert.match(view, /≡ review@1–3/);
});

test("g switches the panel between live and timeline; selection and Enter follow exact executions", { timeout: 5_000 }, async t => {
  const started = deferred<void>();
  const gate = deferred<void>();
  const ctx = context(async () => response());
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string; execution: { generation: number } };
    if (payload.nodeId === "review" && worker.messages.length === 1) return {
      ...response(), stopReason: "toolUse" as const,
      content: [{ type: "toolCall" as const, id: "choice", name: "decide", arguments: { choice: payload.execution.generation === 4 ? "done" : "again" } }],
    };
    if (payload.nodeId === "work" && payload.execution.generation === 3) {
      started.resolve();
      await gate.promise;
    }
    return response(`round ${payload.execution.generation}`);
  });
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start({ goal: "Loop", nodes: [
    { type: "execute", id: "work", prompt: "work" },
    { type: "decision", id: "review", prompt: "review", choices: ["again", "done", "escalate"] },
    { type: "execute", id: "ship", prompt: "ship" },
    { type: "execute", id: "human", prompt: "ask" },
  ], edges: [
    { from: "work", to: "review" }, { from: "review", to: "work", choice: "again" },
    { from: "review", to: "ship", choice: "done" }, { from: "review", to: "human", choice: "escalate" },
  ] }, {}, ctx);
  await started.promise;
  const panel = new BraidPanel(jobs, { requestRender: () => {}, terminal: { rows: 80 } } as never, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  const text = () => stripTerminalSequences(panel.render(120).join("\n"));

  let view = text();
  assert.match(view, /^╭ Braid · timeline view /, "the timeline is the default");
  assert.match(view, /g live view/);
  panel.handleInput("g");
  view = text();
  assert.match(view, /^╭ Braid · live view /);
  assert.match(view, /g timeline view/);
  assert.match(view, /▶ ACTIVE work@3/);
  assert.match(view, /○ ship@1/, "pending executions are live");
  assert.doesNotMatch(view, /✓ (work|review)@/, "settled executions are not");

  panel.handleInput("v");
  assert.match(text(), /◆ Selected 3\/3: work@3 · running · Enter to open this execution's session/);
  panel.handleInput("g");
  view = text();
  assert.match(view, /^╭ Braid · timeline view /);
  assert.match(view, /g live view/);
  assert.match(view, /e all history/);
  assert.match(view, /◆ Selected 6\/6: work@3/, "a selection both views draw stays");
  assert.match(view, /≡ work@1/);
  assert.match(view, /✓ review@2/);

  gate.resolve();
  await jobs.wait(job.jobId);
  panel.handleInput("\x1b");
  view = text();
  assert.match(view, /⊘ human@1/, "the branch that was never taken is skipped, not pending");
  assert.match(view, /≡ work@1–2/);
  assert.doesNotMatch(view, /✓ work@1/);
  panel.handleInput("v");
  panel.handleInput("\r");
  for (let index = 0; index < 3; index++) panel.handleInput("\x1b[D");
  assert.match(text(), /execution 1 of 4 for this node/, "←/→ in a session reach folded executions too");
  panel.handleInput("\x1b");
  assert.match(text(), /◆ Selected \d+\/\d+: review@4/, "leaving a folded execution selects its node's newest drawn one");
  panel.handleInput("\x1b");
  panel.handleInput("e");
  view = text();
  assert.match(view, /✓ work@1/);
  assert.doesNotMatch(view, /≡/);
  assert.match(view, /e recent history/);

  panel.handleInput("v");
  assert.match(text(), /◆ Selected 10\/10: review@4 · completed/, "the timeline starts at the newest execution");
  for (let index = 0; index < 5; index++) panel.handleInput("\x1b[D");
  assert.match(text(), /◆ Selected 5\/10: work@2/);
  panel.handleInput("\r");
  view = text();
  assert.match(view, /Braid node work · completed/);
  assert.match(view, /execution 2 of 4 for this node/, "Enter opens that exact execution, not the latest");
  panel.handleInput("\x1b");
  assert.match(text(), /◆ Selected 5\/10: work@2/, "Esc returns to the same execution");

  panel.handleInput("g");
  view = text();
  assert.match(view, /^╭ Braid · live view /);
  assert.match(view, /Nothing is pending, running, or held · press g for the timeline/);
  assert.doesNotMatch(view, /Selected/, "a selection the live view does not draw ends");
  panel.handleInput("v");
  assert.match(text(), /Nothing to select/);
  panel.handleInput("g");
  assert.match(text(), /^╭ Braid · timeline view /, "the view is remembered after leaving selection");
});
