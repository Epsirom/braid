import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, InMemoryCredentialStore, Type, type AssistantMessage, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import braidExtension from "../index.js";
import { deferred, response } from "./helpers.js";

for (const phase of ["response", "tool batch"]) {
  test(`Pi delivers pause reminders after the current ${phase}, before the foreground task ends`, { timeout: 15_000 }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "braid-step-reminder-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const workerStarted = deferred<void>();
    const releaseWorker = deferred<void>();
    const pauseSent = deferred<void>();
    const jobSent = deferred<void>();
    let foregroundCalls = 0;
    let workerCalls = 0;
    let agentEnds = 0;
    const executed: string[] = [];
    const reminders: string[] = [];
    const failures: unknown[] = [];
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(cwd, "models-cache.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const submission = {
      goal: "Summarize an optional invalid-model failure, pause, then resume the successor.",
      nodes: [
        { id: "bad", type: "execute", model: "braid-boundary/missing", prompt: "hi", requireSuccess: false },
        { id: "summary", type: "execute", prompt: "Summarize the predecessor error.", workspace: "read-only", pauseAfter: true, notifyOnCompletion: true },
        { id: "next", type: "execute", prompt: "original successor" },
      ],
      edges: [{ from: "bad", to: "summary" }, { from: "summary", to: "next" }],
    };
    runtime.registerProvider("braid-boundary", {
      api: "openai-completions", apiKey: "offline", baseUrl: "https://offline.invalid",
      models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
      streamSimple(model, context) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          let message: AssistantMessage = { ...response(), api: model.api, provider: model.provider, model: model.id };
          const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({ type: "toolCall", id, name, arguments: args });
          try {
            if (getCurrentSystemPrompt(context.messages).includes("You are an isolated Braid worker")) {
              workerCalls++;
              if (workerCalls === 1) {
                assert.match(JSON.stringify(context.messages), /missing.*not registered/);
                workerStarted.resolve();
                await releaseWorker.promise;
                message.content = [{ type: "text", text: "The optional predecessor failed: unknown model." }];
              } else {
                assert.match(JSON.stringify(context.messages), /updated successor/);
                message.content = [{ type: "text", text: "Resumed successfully." }];
              }
            } else {
              foregroundCalls++;
              message.stopReason = "toolUse";
              if (foregroundCalls === 1) {
                message.content = [call("submit", "braid", submission)];
              } else if (foregroundCalls === 2) {
                await workerStarted.promise;
                if (phase === "response") {
                  releaseWorker.resolve();
                  await pauseSent.promise;
                }
                message.content = [call("first", "foreground_work", { id: "first" }), call("second", "foreground_work", { id: "second" })];
              } else if (foregroundCalls === 3) {
                assert.equal(agentEnds, 0, "notification must arrive before agent_end");
                assert.deepEqual([...executed].sort(), ["first", "second"], "steering must not skip the rest of the tool batch");
                assert.equal(workerCalls, 1, "pause must still hold the successor");
                const customIndex = context.messages.findIndex(m => m.role === "user" && JSON.stringify(m.content).includes("Outgoing scheduling was paused"));
                for (const id of ["first", "second"]) {
                  const resultIndex = context.messages.findIndex(m => m.role === "toolResult" && m.toolCallId === id);
                  assert.ok(customIndex > resultIndex && resultIndex !== -1, "reminder must follow every tool result");
                }
                message.content = [call("inspect", "braid_status", { jobId: "job-1", nodeId: "summary" })];
              } else if (foregroundCalls === 4) {
                const result = context.messages.find(m => m.role === "toolResult" && m.toolCallId === "inspect");
                assert.ok(result?.role === "toolResult" && result.content[0]?.type === "text");
                const status = JSON.parse(result.content[0].text);
                assert.equal(status.execution.revision, 0);
                assert.equal(status.execution.pausedExecutionIds.length, 1);
                assert.match(status.node.output, /unknown model/);
                message.content = [
                  call("update", "braid_update", { jobId: "job-1", expectedRevision: 0,
                    upsertNodes: [{ id: "next", type: "execute", prompt: "updated successor" }],
                    resume: status.execution.pausedExecutionIds }),
                  call("finish", "foreground_work", { id: "finish" }),
                ];
              } else if (foregroundCalls === 5) {
                assert.equal(agentEnds, 0);
                assert.match(JSON.stringify(context.messages), /Braid job job-1 finished with status completed/);
                message.content = [call("final-status", "braid_status", { jobId: "job-1" })];
              } else {
                assert.equal(foregroundCalls, 6, "no delayed reminder continuations");
                message.stopReason = "stop";
                message.content = [{ type: "text", text: "Done." }];
              }
            }
          } catch (error) {
            failures.push(error);
            message = { ...message, stopReason: "error", errorMessage: String(error) };
          }
          stream.push({ type: "start", partial: message });
          if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
          else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
          stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: join(cwd, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        braidExtension({ ...pi, sendMessage(message, options) {
          pi.sendMessage(message, options);
          reminders.push(message.customType);
          if (message.customType === "braid-node-completed") pauseSent.resolve();
          else if (message.customType === "braid-completed") jobSent.resolve();
        } });
        pi.registerTool({ name: "foreground_work", label: "Foreground fixture", description: "Offline foreground work",
          parameters: Type.Object({ id: Type.String() }),
          async execute(_id, params) {
            if (params.id === "first" && phase === "tool batch") {
              releaseWorker.resolve();
              await pauseSent.promise;
            }
            if (params.id === "finish") await jobSent.promise;
            executed.push(params.id);
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        });
        pi.on("agent_end", () => { agentEnds++; });
      }],
    });
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: runtime.getModel("braid-boundary", "fixture")!,
      settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
    });
    t.after(async () => { releaseWorker.resolve(); pauseSent.resolve(); jobSent.resolve(); await session.abort(); session.dispose(); });
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ onError: e => failures.push(e) });
    await session.prompt("Run the probe and keep working until its pause reminder arrives.");
    await session.waitForIdle();
    assert.deepEqual(failures, []);
    assert.equal(foregroundCalls, 6);
    assert.equal(workerCalls, 2);
    assert.equal(agentEnds, 1);
    assert.deepEqual(reminders, ["braid-node-completed", "braid-completed"]);
  });
}
