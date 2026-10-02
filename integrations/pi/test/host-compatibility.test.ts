import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import braidExtension from "../index.js";
import { deferred, input, response } from "./helpers.js";

for (const templated of [false, true]) for (const notifyNode of [false, true]) {
test(`Pi host preserves ${templated ? "templated" : "plain"} worker context and continues once per ${notifyNode ? "node and job" : "job"} completion during settling`, { timeout: 15_000 }, async (t) => {
  const submittedInput = templated ? {
    ...input,
    promptTemplates: { inspect: "Inspect {{target}}." },
    nodes: [{ type: "execute", id: "a", prompt: { template: "inspect", variables: { target: "runtime" } } }],
  } : input;
  const cwd = await mkdtemp(join(tmpdir(), "braid-pi-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const workerStarted = deferred<void>();
  const releaseWorker = deferred<void>();
  const reminderSent = deferred<void>();
  const releaseOther = deferred<void>();
  const jobReminderSent = deferred<void>();
  const finished = deferred<void>();
  let foregroundCalls = 0;
  let workerCalls = 0;
  let reminders = 0;
  let settling = false;
  let settleCount = 0;
  const submission = notifyNode ? {
    ...submittedInput,
    nodes: [
      { ...submittedInput.nodes[0]!, notifyOnCompletion: true },
      { type: "execute", id: "other", prompt: "Keep working" },
    ],
    edges: [{ from: "a", to: "other" }],
  } : submittedInput;
  const failures: unknown[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(cwd, "models-cache.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("braid-offline", {
    api: "openai-completions",
    apiKey: "offline-test-key",
    baseUrl: "https://offline.invalid",
    models: [{
      id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 1_000,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let message: AssistantMessage = {
          ...response(), api: model.api, provider: model.provider, model: model.id,
        };
        try {
          const prompt = getCurrentSystemPrompt(context.messages);
          const tools = getCurrentTools(context.messages).map((tool) => tool.name);
          if (prompt.includes("You are an isolated Braid worker")) {
            workerCalls++;
            assert.ok(tools.includes("read"));
            assert.ok(!tools.includes("braid"));
            assert.match(JSON.stringify(context.messages), /Investigate in background/);
            if (templated && workerCalls === 1) {
              assert.match(JSON.stringify(context.messages), /Inspect runtime\./);
              assert.doesNotMatch(JSON.stringify(context.messages), /\{\{target\}\}/);
            }
            workerStarted.resolve();
            await (workerCalls === 1 ? releaseWorker.promise : releaseOther.promise);
            message.content = [{ type: "text", text: "worker result" }];
          } else {
            assert.equal(settling, false, "Pi must defer continuation until all settled handlers finish");
            foregroundCalls++;
            if (foregroundCalls === 1) {
              assert.match(prompt, /Braid execution policy/);
              assert.ok(tools.includes("braid"));
              message.content = [{ type: "toolCall", id: "launch", name: "braid", arguments: submission }];
              message.stopReason = "toolUse";
            } else if (foregroundCalls === 2) {
              message.content = [{ type: "text", text: "Waiting for the background result." }];
            } else if (foregroundCalls === 3) {
              assert.match(JSON.stringify(context.messages), /Braid job .* finished with status completed/);
              if (notifyNode) {
                assert.ok(JSON.stringify(context.messages).includes("This is a node reminder"));
                assert.ok(!JSON.stringify(context.messages).includes("Braid job job-1 finished with status"));
                message.content = [{ type: "toolCall", id: "read-node", name: "braid_status", arguments: { jobId: "job-1", nodeId: "a" } }];
                message.stopReason = "toolUse";
              } else {
                message.content = [{ type: "text", text: "Completion reminder received." }];
              }
            } else if (notifyNode && foregroundCalls === 4) {
              const result = context.messages.find((item) => item.role === "toolResult" && item.toolCallId === "read-node");
              assert.ok(result && result.role === "toolResult");
              const block = result.content[0]!;
              assert.equal(block.type, "text");
              const nodeStatus = JSON.parse(block.type === "text" ? block.text : "");
              assert.equal(nodeStatus.status, "running");
              assert.equal(nodeStatus.node.output, "worker result");
              message.content = [{ type: "text", text: "Intermediate result received; waiting for the job." }];
            } else if (notifyNode && foregroundCalls === 5) {
              assert.ok(JSON.stringify(context.messages).includes("Braid job job-1 finished with status completed"));
              message.content = [{ type: "text", text: "Job completion received." }];
            } else {
              assert.fail("Unexpected extra foreground continuation");
            }
          }
        } catch (error) {
          failures.push(error);
          message = { ...message, stopReason: "error", errorMessage: String(error) };
        }
        stream.push({ type: "start", partial: message });
        if (message.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          assert.ok(message.stopReason === "stop" || message.stopReason === "toolUse");
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: join(cwd, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      // Observe reminders while forwarding through Pi's real sendMessage path.
      braidExtension({ ...pi, sendMessage(message, options) {
        pi.sendMessage(message, options);
        reminders++;
        reminderSent.resolve();
        if (message.customType === "braid-completed") jobReminderSent.resolve();
      } });
      pi.on("agent_settled", async (_event, ctx) => {
        settleCount++;
        if (settleCount === 1) {
          settling = true;
          await workerStarted.promise;
          releaseWorker.resolve();
          await reminderSent.promise;
          assert.equal(ctx.isIdle(), true);
          assert.equal(foregroundCalls, 2);
          settling = false;
        } else if (notifyNode && settleCount === 2) {
          settling = true;
          releaseOther.resolve();
          await jobReminderSent.promise;
          assert.equal(foregroundCalls, 4);
          settling = false;
        } else {
          finished.resolve();
        }
      });
    }],
  });
  await resourceLoader.reload();
  const model = modelRuntime.getModel("braid-offline", "fixture");
  assert.ok(model);
  const { session, extensionsResult } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), modelRuntime, model,
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
  });
  t.after(async () => { releaseWorker.resolve(); releaseOther.resolve(); await session.abort(); session.dispose(); });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({ onError: (error) => failures.push(error) });
  await session.prompt("Run one Braid background job.");
  await finished.promise;
  await session.waitForIdle();
  assert.deepEqual(failures, []);
  assert.equal(workerCalls, notifyNode ? 2 : 1);
  assert.equal(foregroundCalls, notifyNode ? 5 : 3);
  assert.equal(reminders, notifyNode ? 2 : 1);
  const delivered = session.messages.filter((message) =>
    message.role === "custom" && message.customType === "braid-completed");
  assert.equal(delivered.length, 1);
  assert.equal(session.messages.filter((message) =>
    message.role === "custom" && message.customType === "braid-node-completed").length, notifyNode ? 1 : 0);
});
}
