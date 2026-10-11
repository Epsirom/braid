import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AssistantModel } from "../assistant.js";
import { BraidPanel } from "../command.js";
import { NodeSessionView } from "../session-view.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;
const tui = { requestRender: () => {}, terminal: { rows: 60 } } as never;
const text = (panel: BraidPanel, width = 140) => stripTerminalSequences(panel.render(width).join("\n"));
const model = { provider: "fake", id: "assistant", contextWindow: 100_000 } as never;

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const call = (name: string, args: Record<string, string>, id = `call-${name}`): AssistantMessage => ({
  ...response(""), content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse",
});

/** An assistant model that answers from a script and records each request. */
function assistantModel(steps: ((context: Context) => AssistantMessage | Promise<AssistantMessage>)[]) {
  const requests: Context[] = [];
  const source: AssistantModel = {
    model,
    registry: {
      complete: async (_model, request) => {
        requests.push(structuredClone(request));
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`Unexpected assistant request ${requests.length}`);
        return step(request);
      },
    },
  };
  return { source, requests };
}

/** A job whose single worker waits in its first model request until released. */
function runningJob(jobs: BraidJobs) {
  const gate = deferred<void>();
  const worker: Context["messages"][] = [];
  const ctx = context(async () => response("unused"));
  (ctx.modelRegistry as unknown as Record<string, unknown>).complete = async (_model: unknown, request: Context) => {
    worker.push(structuredClone(request.messages));
    if (worker.length === 1) await gate.promise;
    return response(worker.length === 1 ? "First pass." : "Followed the guidance.");
  };
  const job = jobs.start(input, {}, ctx);
  const executionId = () => Object.values(jobs.get(job.handle)!.execution?.executions ?? {})[0]?.executionId ?? "";
  return { job, gate, worker, executionId };
}

test("the assistant inspects the job and messages a running execution on the user's behalf", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { job, gate, worker, executionId } = runningJob(jobs);
  await until(() => worker.length === 1);
  const id = executionId();
  const { source, requests } = assistantModel([
    () => call("job_status", {}),
    () => call("execution_transcript", { executionId: id }),
    () => call("message_execution", { executionId: id, message: "Use tabs for indentation." }),
    () => response("I asked node a to use tabs."),
  ]);
  const assistant = jobs.assistant(job.handle);
  assistant.send("Tell it to use tabs", `session of node "a", execution ${id} (running)`, source);
  await until(() => !assistant.busy && requests.length === 4);

  const first = requests[0]!;
  assert.match(first.systemPrompt!, /Never message an execution on your own initiative/);
  assert.deepEqual(first.tools!.map(tool => tool.name), ["job_status", "execution_details", "execution_transcript", "message_execution"]);
  assert.match(String(first.messages[0]!.content), /\[Panel view: session of node "a".*\]\n\nTell it to use tabs/s);
  const results = requests[3]!.messages.flatMap(message =>
    message.role === "toolResult" ? [message.content.map(block => block.type === "text" ? block.text : "").join("")] : []);
  assert.equal(results.length, 3);
  assert.match(results[0]!, /"executionId": "[^"]+",\s+"nodeId": "a",\s+"status": "running"/, "job_status reports executions");
  assert.match(results[1]!, /\[node prompt\] work/, "the transcript tool reads the worker conversation");
  assert.match(results[2]!, /Queued/);
  assert.deepEqual(jobs.pendingInputs(job.handle, id).map(input => input.text), ["Use tabs for indentation."]);

  gate.resolve();
  await jobs.wait(job.handle);
  assert.match(JSON.stringify(worker[1]), /Use tabs for indentation\./, "the worker receives the relayed message");
  assert.deepEqual(jobs.getNode(job.handle, "a").humanInputs?.map(input => input.text), ["Use tabs for indentation."]);
  assert.equal(assistant.conversation.messages.at(-1)!.role, "assistant");
});

test("tool failures reach the model as errors, and a finished execution cannot be messaged", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response("done")));
  await jobs.wait(job.handle);
  const id = jobs.getNode(job.handle, "a").executionId!;
  const { source, requests } = assistantModel([
    () => ({ ...response(""), stopReason: "toolUse", content: [
      { type: "toolCall", id: "c1", name: "message_execution", arguments: { executionId: id, message: "too late" } },
      { type: "toolCall", id: "c2", name: "execution_details", arguments: {} },
    ] }),
    () => response("It already finished."),
  ]);
  const assistant = jobs.assistant(job.handle);
  assistant.send("Tell a to stop", "job graph overview (completed)", source);
  await until(() => !assistant.busy && requests.length === 2);
  const results = requests[1]!.messages.filter(message => message.role === "toolResult");
  assert.deepEqual(results.map(result => result.role === "toolResult" && result.isError), [true, true]);
  assert.match(JSON.stringify(results[0]), /running execution/);
  assert.match(JSON.stringify(results[1]), /executionId or nodeId/);
  assert.equal(jobs.getNode(job.handle, "a").humanInputs, undefined);
});

test("Esc stops a streaming answer and the conversation stays usable", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response("done")));
  await jobs.wait(job.handle);
  let requests = 0;
  const source: AssistantModel = {
    model,
    registry: {
      complete: async () => response("Second answer."),
      stream: (_model, _context, options) => {
        requests++;
        const stream = createAssistantMessageEventStream();
        const partial: AssistantMessage = { ...response("Thinking about"), stopReason: "stop" };
        stream.push({ type: "start", partial });
        options?.signal?.addEventListener("abort", () => {
          stream.push({ type: "error", reason: "aborted", error: { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" } });
        });
        return stream;
      },
    },
  };
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, undefined, () => source);
  t.after(() => panel.dispose());
  panel.handleInput("\t");
  for (const key of "why?") panel.handleInput(key);
  panel.handleInput("\r");
  const assistant = jobs.assistant(job.handle);
  await until(() => requests === 1 && assistant.conversation.streaming !== undefined);
  assert.match(text(panel), /working… Esc to stop/);
  panel.handleInput("\x1b");
  await until(() => !assistant.busy);
  const last = assistant.conversation.messages.at(-1)!;
  assert.equal(last.role === "assistant" && last.stopReason, "aborted");
  assert.match(text(panel), /Assistant · job · Tab to hide/, "Esc while working stops the answer but keeps focus");
  panel.handleInput("\x1b");
  assert.doesNotMatch(text(panel), /Assistant ·/, "a second Esc hides the assistant");
  assert.match(text(panel), /Tab assistant/);
});

test("Tab toggles the assistant: beside the graph in a wide panel, in place of it in a narrow one", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response("Graph finished")));
  await jobs.wait(job.handle);
  const { source, requests } = assistantModel([() => response("Node a printed its result.")]);
  let closed = 0;
  const panel = new BraidPanel(jobs, tui, theme, () => { closed++; }, job.handle, undefined, () => source);
  t.after(() => panel.dispose());

  let view = text(panel);
  assert.doesNotMatch(view, /Assistant ·/, "hidden until Tab");
  assert.match(view, /Tab assistant/);

  panel.handleInput("\t");
  view = text(panel);
  assert.match(view, /Assistant · job/, "the graph view talks about the whole job");
  assert.match(view, /a done/, "a wide panel keeps the graph beside it");
  assert.ok(view.split("\n").every(line => line.length === view.split("\n")[0]!.length), "both panes fit the panel width");
  assert.doesNotMatch(text(panel, 90), /a done/, "a narrow panel shows only the assistant");

  for (const key of "qc what happened?") panel.handleInput(key);
  assert.equal(closed, 0, "q is typed, not a close");
  assert.match(text(panel, 90), /› qc what happened\?/);
  panel.handleInput("\r");
  await until(() => requests.length === 1 && !jobs.assistant(job.handle).busy);
  view = text(panel);
  assert.match(view, /qc what happened\?/);
  assert.match(view, /Node a printed its result\./);
  assert.match(String(requests[0]!.messages[0]!.content), /\[Panel view: job graph overview \(completed\)\]/);

  panel.handleInput("\t");
  assert.doesNotMatch(text(panel), /Assistant ·/, "Tab hides it again");
  panel.handleInput("v");
  panel.handleInput("\r");
  assert.match(text(panel), /Braid node a · completed/, "keys reach the graph once it is hidden");
  panel.handleInput("\t");
  view = text(panel);
  assert.match(view, /Assistant · node a/, "a node session has its own conversation");
  assert.doesNotMatch(view, /Node a printed its result\./);
  assert.match(view, /Ask what a is doing/, "the hint names the node");

  panel.handleInput("\t");
  panel.handleInput("\x1b");
  panel.handleInput("\x1b");
  panel.handleInput("\t");
  assert.match(text(panel), /Assistant · job/);
  assert.match(text(panel), /Node a printed its result\./, "the job conversation is kept");
});

test("node conversations are separate from the job's, bound to the node across its executions", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start({ goal: "Two", nodes: [{ type: "execute", id: "a", prompt: "x" }, { type: "execute", id: "b", prompt: "y" }], edges: [] },
    {}, context(async () => response("ok")));
  await jobs.wait(job.handle);
  const { source, requests } = assistantModel([() => response("About a."), () => response("About b."), () => response("About a again.")]);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, undefined, () => source);
  t.after(() => panel.dispose());
  const ask = async (question: string) => {
    panel.handleInput("\t");
    for (const key of question) panel.handleInput(key);
    panel.handleInput("\r");
    await until(() => requests.length > 0 && [...["a", "b"].map(id => jobs.assistant(job.handle, id)), jobs.assistant(job.handle)].every(value => !value.busy));
    panel.handleInput("\t");
  };

  panel.handleInput("v");
  await ask("what did a do");
  panel.handleInput("\x1b[B");
  await ask("what did b do");
  panel.handleInput("\x1b[A");
  panel.handleInput("\r");
  await ask("and now");

  assert.equal(requests.length, 3);
  assert.match(requests[0]!.systemPrompt!, /about node "a"/);
  assert.match(requests[1]!.systemPrompt!, /about node "b"/);
  assert.equal(requests[1]!.messages.length, 1, "b's conversation does not include a's");
  assert.equal(requests[2]!.messages.length, 3, "a's session continues a's conversation");
  assert.match(String(requests[2]!.messages[2]!.content), /\[Panel view: session of node "a"/);
  assert.equal(jobs.assistant(job.handle).conversation.messages.length, 0, "the job conversation is untouched");
});

test("the mouse wheel scrolls the assistant conversation or the graph, whichever it is over", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response(Array.from({ length: 40 }, (_, i) => `session line ${i}`).join("\n\n"))));
  await jobs.wait(job.handle);
  const answer = Array.from({ length: 60 }, (_, i) => `answer line ${i}`).join("\n\n");
  const { source } = assistantModel([() => response(answer)]);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, { nodeId: "a" }, () => source);
  t.after(() => panel.dispose());
  panel.handleInput("\t");
  for (const key of "show me") panel.handleInput(key);
  panel.handleInput("\r");
  await until(() => !jobs.assistant(job.handle, "a").busy && jobs.assistant(job.handle, "a").conversation.messages.length === 2);
  assert.match(text(panel), /answer line 59/, "the newest lines are shown");
  assert.doesNotMatch(text(panel), /answer line 0\b/);

  const lines = panel.render(140);
  const row = lines.findIndex(line => stripTerminalSequences(line).includes("answer line 59"));
  const column = stripTerminalSequences(lines[row]!).indexOf("answer line 59");
  const wheel = (x: number, delta: number) => panel.handleMouse({
    type: "wheel", button: "none", x, y: row, screenX: x, screenY: row, width: 140, height: lines.length,
    shift: false, alt: false, ctrl: false, wheelDelta: delta,
  });
  assert.deepEqual(wheel(column, -100), { handled: true });
  let view = text(panel);
  assert.match(view, /answer line 0\b/, "wheel up over the assistant reaches its oldest lines");
  assert.match(view, /session line 39/, "the session beside it does not move");
  wheel(column, 100);
  assert.match(text(panel), /answer line 59/);

  wheel(5, -100);
  view = text(panel);
  assert.match(view, /session line 0\b/, "wheel over the left pane scrolls the session");
  assert.match(view, /answer line 59/);
  assert.equal(panel.handleMouse({ type: "click", button: "left", x: 5, y: row, screenX: 5, screenY: row, width: 140, height: lines.length, shift: false, alt: false, ctrl: false }), undefined, "clicks are left to Pi");
});

test("with the assistant hidden, the wheel scrolls the node session and pauses following", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response(Array.from({ length: 40 }, (_, i) => `session line ${i}`).join("\n\n"))));
  await jobs.wait(job.handle);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle, { nodeId: "a" });
  t.after(() => panel.dispose());
  assert.match(text(panel), /session line 39/);
  const wheel = (delta: number) => panel.handleMouse({
    type: "wheel", button: "none", x: 60, y: 20, screenX: 60, screenY: 20, width: 140, height: 54,
    shift: false, alt: false, ctrl: false, wheelDelta: delta,
  });
  wheel(-100);
  assert.match(text(panel), /session line 0\b/);
  assert.doesNotMatch(text(panel), /session line 39/, "scrolling up stops following new output");
  wheel(100);
  assert.match(text(panel), /session line 39/);
  assert.equal(panel.handleMouse({ type: "wheel", button: "none", x: 60, y: 0, screenX: 60, screenY: 0, width: 140, height: 54,
    shift: false, alt: false, ctrl: false, wheelDelta: -3 }), undefined, "the header is not scrollable");
});

test("a blank line follows each finished reply, separating it from the next question", () => {
  const view = new NodeSessionView({ requestRender() {} } as never, theme);
  const conversation = {
    cwd: "/", running: new Map(), renderers: new Map(), version: 1,
    messages: [
      { role: "user" as const, content: "first question", timestamp: 0 }, response("First answer."),
      { role: "user" as const, content: "second question", timestamp: 0 }, response("Second answer."),
    ],
  };
  const lines = view.render(conversation, 60).map(line => stripTerminalSequences(line));
  const answer = lines.findIndex(line => line.includes("First answer."));
  // The user message's own padding row is drawn with its background color; the gap is a plain empty line.
  assert.equal(lines[answer + 1], "", lines.slice(answer, answer + 4).map(line => JSON.stringify(line)).join("\n"));
  assert.match(lines[answer + 2]!, /^ +$/, "followed by the user message's padding row");
  assert.equal(lines[0]!.trim(), "", "no blank line is added before the first message");
  assert.notEqual(lines[0], "");
  assert.notEqual(lines[answer + 2], "", "exactly one blank line between turns");
  assert.equal(lines.at(-1), "", "a finished reply is followed by a blank line before anything else arrives");

  const waiting = { ...conversation, messages: conversation.messages.slice(0, 2), version: 2 };
  const lone = new NodeSessionView({ requestRender() {} } as never, theme).render(waiting, 60).map(line => stripTerminalSequences(line));
  assert.ok(lone.at(-2)!.includes("First answer.") && lone.at(-1) === "", "the gap appears as soon as the reply ends");
  const toolTurn = { ...conversation, version: 3, messages: [conversation.messages[0]!,
    { ...response("Checking."), stopReason: "toolUse" as const }] };
  const midTurn = new NodeSessionView({ requestRender() {} } as never, theme).render(toolTurn, 60).map(line => stripTerminalSequences(line));
  assert.notEqual(midTurn.at(-1), "", "no gap while the turn continues with tools");
});

test("the empty assistant wraps its hints in full and leaves a blank line above the input", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, context(async () => response("done")));
  await jobs.wait(job.handle);
  const panel = new BraidPanel(jobs, tui, theme, () => {}, job.handle);
  t.after(() => panel.dispose());
  panel.handleInput("\t");
  const lines = text(panel, 60).split("\n").map(line => line.replace(/^│ ?|│$/g, "").trimEnd());
  const words = lines.join(" ").replace(/\s+/g, " ");
  assert.match(words, /say what it should do; the assistant messages that execution for you\./, "nothing is cut off");
  assert.ok(!lines.some(line => line.includes("…") && line.includes("execution's")), "no truncation marker");
  const prompt = lines.findIndex(line => line.startsWith("›"));
  assert.equal(lines[prompt - 1]!.trim(), "", "a blank line separates the hints from the input");
  assert.match(lines[prompt - 2]!, /you\.$/);
  assert.match(lines[prompt]!, /^› Ask, or say how to steer…$/, "the placeholder fits too");
});
