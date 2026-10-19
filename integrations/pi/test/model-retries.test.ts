import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRequest } from "@chrok/braid";
import { createPiRunner } from "../runner.js";
import { PiTranscripts } from "../transcript.js";
import { readOnlyCwd } from "./helpers.js";

const model = { provider: "fake", id: "model", api: "fake" } as unknown as Model<"fake">;
const usage = (input: number, output: number): Usage => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const message = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant", content, api: "fake", provider: "fake", model: "model", usage: usage(1, 2), stopReason,
  ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now(),
});
const text = (value: string) => message([{ type: "text", text: value }]);
const readCall = () => message([{
  type: "toolCall", id: "read-1", name: "read",
  arguments: { path: new URL("../../../package.json", import.meta.url).pathname, limit: 1 },
}], "toolUse");

/** A failure after the stream started (`started`), or a request rejected before any response. */
type Attempt = AssistantMessage | { error: string; started: boolean; partialText?: string };

function streamingRegistry(attempts: Attempt[]) {
  const contexts: Context[] = [];
  const options: Record<string, unknown>[] = [];
  const registry = {
    find: () => model,
    complete: () => { throw new Error("stream expected"); },
    stream(_model: unknown, context: Context, requestOptions: Record<string, unknown>) {
      contexts.push(structuredClone(context));
      options.push({ ...requestOptions, signal: undefined });
      const attempt = attempts.shift();
      if (!attempt) throw new Error("unexpected model request");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        if ("role" in attempt) {
          stream.push({ type: "start", partial: attempt });
          stream.push({ type: "done", reason: attempt.stopReason as "stop" | "toolUse", message: attempt });
          return;
        }
        const failed = message(attempt.partialText ? [{ type: "text", text: attempt.partialText }] : [], "error", attempt.error);
        if (attempt.started) {
          stream.push({ type: "start", partial: failed });
          if (attempt.partialText) stream.push({ type: "text_delta", contentIndex: 0, delta: attempt.partialText, partial: failed });
        }
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    },
  } as unknown as Pick<ModelRegistry, "find" | "complete" | "stream">;
  return { registry, contexts, options };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    goal: "goal",
    node: { type: "execute", id: "work", prompt: "Work" },
    model: "fake/model",
    predecessors: [],
    execution: { runId: "run", rootRunId: "run", executionId: "exec-1" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("a stream failing mid-response is retried in place without repeating completed tools", async () => {
  const fake = streamingRegistry([
    readCall(),
    { error: "429 Too Many Requests: rate limit exceeded", started: true, partialText: "Half an ans" },
    { error: "overloaded_error: Overloaded", started: true },
    text("Done"),
  ]);
  const transcripts = new PiTranscripts();
  const reports: Usage[] = [];
  const output = await createPiRunner(fake.registry, {
    cwd: readOnlyCwd, transcripts, modelRetryDelayMs: 0, onUsage: report => reports.push(report),
  })(request());

  assert.equal(output.output, "Done");
  assert.equal(fake.contexts.length, 4);
  // Every retry resends the same conversation: one tool call, one tool result, no failed partial.
  for (const context of fake.contexts.slice(1)) assert.deepEqual(context.messages, fake.contexts[1]!.messages);
  assert.deepEqual(fake.contexts[3]!.messages.map(entry => entry.role), ["user", "assistant", "toolResult"]);
  assert.doesNotMatch(JSON.stringify(fake.contexts[3]!.messages), /Half an ans/);
  // Failed attempts are billed and stay visible in the session view.
  assert.equal(reports.length, 4);
  assert.deepEqual(output.usage, { inputTokens: 4, outputTokens: 8 });
  const assistants = transcripts.get("exec-1")!.messages.filter(entry => entry.role === "assistant") as AssistantMessage[];
  assert.deepEqual(assistants.map(entry => entry.stopReason), ["toolUse", "error", "error", "stop"]);
});

test("provider clients retry rejected requests; Braid does not retry them again", async () => {
  const fake = streamingRegistry([{ error: "429 rate limit exceeded", started: false }, text("unused")]);
  await assert.rejects(
    createPiRunner(fake.registry, { cwd: readOnlyCwd, modelRetryDelayMs: 0 })(request()),
    /429 rate limit exceeded/,
  );
  assert.equal(fake.contexts.length, 1);
  assert.equal(fake.options[0]!.maxRetries, 3);
  assert.equal(fake.options[0]!.maxRetryDelayMs, 60_000);
});

test("non-retryable model errors fail the execution immediately", async () => {
  const fake = streamingRegistry([{ error: "429 insufficient_quota: check your billing", started: true }, text("unused")]);
  await assert.rejects(
    createPiRunner(fake.registry, { cwd: readOnlyCwd, modelRetryDelayMs: 0 })(request()),
    /insufficient_quota/,
  );
  assert.equal(fake.contexts.length, 1);
});

test("the retry budget is bounded per model request and 0 disables retries", async () => {
  const failure = { error: "503 service unavailable", started: true };
  const limited = streamingRegistry([failure, failure, text("unused")]);
  await assert.rejects(
    createPiRunner(limited.registry, { cwd: readOnlyCwd, maxModelRetries: 1, modelRetryDelayMs: 0 })(request()),
    /503 service unavailable/,
  );
  assert.equal(limited.contexts.length, 2);
  assert.equal(limited.options[0]!.maxRetries, 1);

  const disabled = streamingRegistry([failure, text("unused")]);
  await assert.rejects(
    createPiRunner(disabled.registry, { cwd: readOnlyCwd, maxModelRetries: 0 })(request()),
    /503 service unavailable/,
  );
  assert.equal(disabled.contexts.length, 1);
  assert.equal(disabled.options[0]!.maxRetries, 0);

  // The budget restarts for each model request in the same execution.
  const perRequest = streamingRegistry([failure, readCall(), failure, text("Done")]);
  const output = await createPiRunner(perRequest.registry, { cwd: readOnlyCwd, maxModelRetries: 1, modelRetryDelayMs: 0 })(request());
  assert.equal(output.output, "Done");
});

test("a backoff that would outlast a deadline fails with the provider error", async t => {
  t.mock.method(performance, "now", () => 0);
  const fake = streamingRegistry([{ error: "502 bad gateway", started: true }, text("unused")]);
  await assert.rejects(
    createPiRunner(fake.registry, { cwd: readOnlyCwd, modelRetryDelayMs: 5_000 })(
      request({ deadlines: { node: 10_000, graph: 4_000 } }),
    ),
    /502 bad gateway/,
  );
  assert.equal(fake.contexts.length, 1);
});

test("cancellation interrupts the retry backoff", async () => {
  const controller = new AbortController();
  const fake = streamingRegistry([{ error: "502 bad gateway", started: true }, text("unused")]);
  const run = createPiRunner(fake.registry, { cwd: readOnlyCwd, modelRetryDelayMs: 60_000 })(
    request({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(new Error("cancelled by user")), 10);
  await assert.rejects(run, /cancelled by user/);
  assert.equal(fake.contexts.length, 1);
});

test("invalid model retry options are rejected", () => {
  const { registry } = streamingRegistry([]);
  for (const maxModelRetries of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => createPiRunner(registry, { maxModelRetries }), /maxModelRetries/);
  }
  assert.throws(() => createPiRunner(registry, { modelRetryDelayMs: -1 }), /modelRetryDelayMs/);
});
