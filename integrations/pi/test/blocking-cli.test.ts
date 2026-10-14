import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { input, response } from "./helpers.js";

for (const mode of ["text", "json"]) for (const viaCommand of [false, true]) test(`Pi CLI ${viaCommand ? "/braid:blocking on" : "--braid-blocking"} waits and returns results in ${mode} print mode`, { timeout: 15_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "braid-blocking-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const provider = join(cwd, "provider.mjs");
  await writeFile(provider, `
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export default function (pi) {
  let parentCalls = 0;
  pi.registerProvider("braid-offline", {
    api: "openai-completions", apiKey: "offline-test", baseUrl: "https://offline.invalid",
    models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const message = { ...${JSON.stringify(response())}, api: model.api, provider: model.provider, model: model.id };
      void (async () => {
        try {
          const prompt = getCurrentSystemPrompt(context.messages);
          if (prompt.includes("You are an isolated Braid worker")) {
            await setTimeout(100);
            message.content = [{ type: "text", text: "CI worker result" }];
          } else if (++parentCalls === 1) {
            assert.match(prompt, /Blocking mode is enabled/);
            message.content = [{ type: "toolCall", id: "launch", name: "braid", arguments: ${JSON.stringify(input)} }];
            message.stopReason = "toolUse";
          } else {
            assert.equal(parentCalls, 2);
            const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "launch");
            assert.ok(result && !result.isError);
            assert.match(JSON.stringify(result.content), /Braid job job-1 · completed/);
            assert.match(JSON.stringify(result.content), /CI worker result/);
            assert.ok(!context.messages.some(message => message.role === "custom" && message.customType === "braid-completed"));
            message.content = [{ type: "text", text: "CLI observed completed Braid result" }];
          }
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
        }
        stream.end();
      })();
      return stream;
    },
  });
}
`);
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
  const invocation = promisify(execFile)(process.execPath, [cli,
    "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", extension, "-e", provider, "--provider", "braid-offline", "--model", "fixture",
    ...(viaCommand ? [] : ["--braid-blocking"]), "--mode", mode, "-p",
    ...(viaCommand ? ["/braid:blocking on"] : []), "Run Braid and summarize its result.",
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") }, timeout: 12_000, maxBuffer: 1_000_000 });
  invocation.child.stdin?.end();
  const { stdout } = await invocation;
  assert.match(stdout, /CLI observed completed Braid result/);
  if (mode === "json") {
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    const progress = events.findIndex(event => event.type === "tool_execution_update" && event.toolName === "braid");
    assert.ok(progress >= 0);
    assert.equal(events[progress].partialResult.details.handle, "job-1");
    assert.match(JSON.stringify(events[progress].partialResult.content), /Waiting for the graph/);
    assert.ok(progress < events.findIndex(event => event.type === "tool_execution_end" && event.toolName === "braid"));
    const completed = events.find(event => event.type === "tool_execution_end" && event.toolName === "braid");
    assert.equal(completed?.result.details.status, "completed");
    assert.equal(completed?.result.usage.totalTokens, 2);
  }
});
