import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { formatHumanInput } from "../human-input.js";
import { BraidJobs } from "../jobs.js";
import { context, deferred, input, response } from "./helpers.js";

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A Pi context whose model calls are scripted, recording the messages each call received. */
function scripted(steps: ((call: number) => Promise<AssistantMessage>)[]) {
  const received: Context["messages"][] = [];
  const ctx = context(async () => response("unused"));
  (ctx.modelRegistry as unknown as Record<string, unknown>).complete = (_model: unknown, request: Context) => {
    received.push(structuredClone(request.messages));
    const step = steps[received.length - 1];
    if (!step) throw new Error(`Unexpected model call ${received.length}`);
    return step(received.length);
  };
  return { ctx, received };
}

const toolUse = (): AssistantMessage => ({
  ...response(""),
  content: [{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } }],
  stopReason: "toolUse",
});

const executionOf = (jobs: BraidJobs, handle: string) =>
  Object.values(jobs.get(handle)!.execution?.executions ?? {})[0]?.executionId ?? "";

test("a message sent during a model request is delivered after the tool batch, before the next request", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const gate = deferred<void>();
  const { ctx, received } = scripted([
    async () => { await gate.promise; return toolUse(); },
    async () => response("Used the smaller fix."),
  ]);
  const job = jobs.start(input, {}, ctx);
  await until(() => received.length === 1);
  const executionId = executionOf(jobs, job.handle);
  jobs.sendInput(job.handle, executionId, "Prefer the smaller fix");
  assert.deepEqual(jobs.pendingInputs(job.handle, executionId).map(input => input.text), ["Prefer the smaller fix"]);
  gate.resolve();
  await jobs.wait(job.handle);

  assert.equal(received.length, 2);
  const [first, second] = received;
  assert.ok(!JSON.stringify(first).includes("Prefer the smaller fix"), "not injected into the request already in flight");
  const roles = second!.map(message => message.role);
  assert.deepEqual(roles.slice(-3), ["assistant", "toolResult", "user"], "delivered after the complete tool batch");
  assert.equal(second!.at(-1)!.content, formatHumanInput("Prefer the smaller fix"));
  assert.deepEqual(jobs.pendingInputs(job.handle, executionId), []);

  const execution = jobs.getNode(job.handle, undefined, executionId);
  assert.deepEqual(execution.humanInputs?.map(input => input.text), ["Prefer the smaller fix"]);
  assert.ok(jobs.get(job.handle)!.result!.events.some(event => event.type === "human_input"));
  assert.ok(jobs.getActivity(job.handle, executionId)!.entries.some(entry => entry.kind === "human_input"));
  const human = jobs.getTranscript(job.handle, executionId)!.messages.filter(message => message.role === "human");
  assert.deepEqual(human.map(message => message.role === "human" && [message.text, message.delivered]), [["Prefer the smaller fix", true]]);
  assert.throws(() => jobs.sendInput(job.handle, executionId, "late"), /running execution/);
});

test("a message that arrives during the final request gets one more round", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const gate = deferred<void>();
  const { ctx, received } = scripted([
    async () => { await gate.promise; return response("First answer."); },
    async () => response("Revised answer."),
  ]);
  const job = jobs.start(input, {}, ctx);
  await until(() => received.length === 1);
  jobs.sendInput(job.handle, executionOf(jobs, job.handle), "Also cover the edge case");
  gate.resolve();
  await jobs.wait(job.handle);
  assert.equal(received.length, 2);
  assert.deepEqual(received[1]!.slice(-2).map(message => message.role), ["assistant", "user"]);
  assert.match(jobs.getNode(job.handle, "a").output!, /Revised answer\./);
});

test("messages left when an execution ends are marked undelivered and never recorded as input", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const gate = deferred<void>();
  const { ctx, received } = scripted([async () => { await gate.promise; throw new Error("provider down"); }]);
  const job = jobs.start(input, {}, ctx);
  await until(() => received.length === 1);
  const executionId = executionOf(jobs, job.handle);
  jobs.sendInput(job.handle, executionId, "Try another approach");
  assert.throws(() => jobs.sendInput(job.handle, executionId, "   "), /must not be empty/);
  gate.resolve();
  await jobs.wait(job.handle);
  const execution = jobs.getNode(job.handle, undefined, executionId);
  assert.equal(execution.status, "failed");
  assert.equal(execution.humanInputs, undefined);
  const human = jobs.getTranscript(job.handle, executionId)!.messages.filter(message => message.role === "human");
  assert.deepEqual(human.map(message => message.role === "human" && message.delivered), [false]);
  assert.deepEqual(jobs.pendingInputs(job.handle, executionId), []);
});
