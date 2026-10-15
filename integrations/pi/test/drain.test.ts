import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
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
import { input, response } from "./helpers.js";
import { parseDuration } from "../drain.js";

const paused = {
  goal: "Hold a draft for review",
  nodes: [
    { type: "execute" as const, id: "a", prompt: "draft", pauseAfter: true },
    { type: "execute" as const, id: "b", prompt: "finish" },
  ],
  edges: [{ from: "a", to: "b" }],
};

/**
 * Each parent step reads the latest context message and returns the assistant
 * content. Failed steps and unused or extra steps are recorded in failures.log,
 * because Pi would otherwise only see them as model errors.
 */
type Scenario = {
  graph: object;
  workerDelayMs: number;
  parent: string[];
};

const scenarios: Record<string, Scenario> = {
  // The parent ends its turn after submitting; the reminder resumes it.
  async: {
    graph: input,
    workerDelayMs: 200,
    parent: [
      `return launch();`,
      `assert.match(last(), /Braid runs asynchronously/); return say("Waiting for the Braid reminder.");`,
      `assert.match(last(), /Braid job job-1 finished with status completed/); return say("DRAIN DONE");`,
    ],
  },
  // Ending turns with only a paused execution left warns once, then cancels.
  stall: {
    graph: paused,
    workerDelayMs: 50,
    parent: [
      `return launch();`,
      `return say("Waiting.");`,
      `assert.match(last(), /node "a" execution .* finished with status completed.*paused/s); return say("Not resuming yet.");`,
      `assert.match(last(), /cannot end while Braid jobs are outstanding.*job-1 is waiting on paused executions/s); return say("Still not resuming.");`,
      `assert.match(last(), /Braid job job-1 finished with status cancelled/); return say("GAVE UP");`,
    ],
  },
  // The stall warning carries what the parent needs to resume.
  resume: {
    graph: paused,
    workerDelayMs: 50,
    parent: [
      `return launch();`,
      `return say("Waiting.");`,
      `return say("Not resuming yet.");`,
      `const [, ids, revision] = /paused executions (\\[[^\\]]*\\]) at revision (\\d+)/.exec(last());
       return call("braid_resume", { jobId: "job-1", executionIds: JSON.parse(ids), expectedRevision: Number(revision) });`,
      `assert.doesNotMatch(last(), /"isError":true/, last()); return say("Resumed.");`,
      `assert.match(last(), /Braid job job-1 finished with status completed/); return say("RESUMED DONE");`,
    ],
  },
  // The run budget cancels a job that would otherwise keep the run open.
  timeout: {
    graph: input,
    workerDelayMs: 60_000,
    parent: [
      `return launch();`,
      `return say("Waiting.");`,
      `assert.match(last(), /Braid job job-1 finished with status cancelled/); return say("TIMED OUT");`,
    ],
  },
  // braid_finish records a failure, which the run reports once it drains.
  finishFailure: {
    graph: input,
    workerDelayMs: 200,
    parent: [
      `assert.ok(tools().includes("braid_finish")); return launch();`,
      `return say("Waiting.");`,
      `assert.match(last(), /Braid job job-1 finished with status completed/);
       return call("braid_finish", { status: "failure", summary: "Review found 2 blocking issues." });`,
      `assert.match(last(), /Recorded failure\\. End your turn/); return say("REPORTED FAILURE");`,
    ],
  },
  // A success reported while a job is outstanding keeps the run open for its reminder.
  finishSuccess: {
    graph: input,
    workerDelayMs: 200,
    parent: [
      `return launch();`,
      `return call("braid_finish", { status: "success", summary: "Submitted the review." });`,
      `assert.match(last(), /Recorded success\\. 1 Braid job\\(s\\) are still outstanding/); return say("Waiting.");`,
      `assert.match(last(), /Braid job job-1 finished with status completed/); return say("REPORTED SUCCESS");`,
    ],
  },
  // A reported success cannot mask the failure of a forced cancellation.
  finishAfterTimeout: {
    graph: input,
    workerDelayMs: 60_000,
    parent: [
      `return launch();`,
      `return say("Waiting.");`,
      `assert.match(last(), /Braid job job-1 finished with status cancelled/);
       return call("braid_finish", { status: "success", summary: "Nothing to report." });`,
      `return say("CLAIMED SUCCESS");`,
    ],
  },
};

async function runPi(name: string, mode: "text" | "json", flags: string[] = []) {
  const scenario = scenarios[name]!;
  const cwd = await mkdtemp(join(tmpdir(), "braid-drain-cli-"));
  const provider = join(cwd, "provider.mjs");
  await writeFile(provider, `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
const steps = [${scenario.parent.map(body => `(last, say, call, launch, tools) => { ${body} }`).join(",\n")}];
const failures = ${JSON.stringify(join(cwd, "failures.log"))};
export default function (pi) {
  let parentCalls = 0;
  process.on("exit", () => {
    if (parentCalls !== steps.length) appendFileSync(failures, "parent called " + parentCalls + " of " + steps.length + " times\\n");
  });
  pi.registerProvider("braid-offline", {
    api: "openai-completions", apiKey: "offline-test", baseUrl: "https://offline.invalid",
    models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message = { ...${JSON.stringify(response())}, api: model.api, provider: model.provider, model: model.id };
      void (async () => {
        try {
          const prompt = getCurrentSystemPrompt(context.messages);
          if (prompt.includes("You are an isolated Braid worker")) {
            await setTimeout(${scenario.workerDelayMs}, undefined, { signal: options?.signal });
            message.content = [{ type: "text", text: "CI worker result" }];
          } else {
            assert.match(prompt, /This is a single-shot run/);
            const step = steps[parentCalls++];
            assert.ok(step, "unexpected parent call " + parentCalls);
            const latest = context.messages.at(-1);
            const last = () => typeof latest.content === "string" ? latest.content
              : latest.content.map(part => part.text ?? JSON.stringify(part)).join("\\n");
            const say = text => [{ type: "text", text }];
            const call = (name, args) => {
              message.stopReason = "toolUse";
              return [{ type: "toolCall", id: "call-" + parentCalls, name, arguments: args }];
            };
            const tools = () => getCurrentTools(context.messages).map(tool => tool.name);
            message.content = step(last, say, call, () => call("braid", ${JSON.stringify(scenario.graph)}), tools);
          }
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          if (!options?.signal?.aborted) appendFileSync(failures, "parent step " + parentCalls + ": " + String(error) + "\\n");
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
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
    ...flags, "--mode", mode, "-p", "Run Braid and summarize its result.",
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") }, timeout: 12_000, maxBuffer: 1_000_000 });
  invocation.child.stdin?.end();
  try {
    const result = await invocation.then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error: { code: unknown; stdout: string; stderr: string }) => {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    });
    const failures = await readFile(join(cwd, "failures.log"), "utf8").catch(() => "");
    assert.equal(failures, "", `${failures}\n${result.stderr}`);
    return result;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const mode of ["text", "json"] as const) {
  test(`Pi CLI ${mode} print mode stays open for background Braid jobs and their reminders`, { timeout: 15_000 }, async () => {
    const { code, stdout, stderr } = await runPi("async", mode);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /DRAIN DONE/);
    if (mode === "json") {
      const events = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.ok(events.some(event => event.type === "message_start" && event.message.customType === "braid-completed"));
    }
  });
}

test("Pi CLI print mode warns once about paused executions, then cancels them and exits 1", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("stall", "text");
  assert.equal(code, 1, stderr);
  assert.match(stdout, /GAVE UP/);
  assert.match(stderr, /Braid: paused executions were never resumed; cancelled job-1/);
});

test("Pi CLI print mode continues normally when the parent resumes after the stall warning", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("resume", "text");
  assert.equal(code, 0, stderr);
  assert.match(stdout, /RESUMED DONE/);
});

test("--braid-ci-timeout cancels outstanding jobs, lets the parent report, and exits 1", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("timeout", "text", ["--braid-ci-timeout", "300ms"]);
  assert.equal(code, 1, stderr);
  assert.match(stdout, /TIMED OUT/);
  assert.match(stderr, /Braid: --braid-ci-timeout expired; cancelled outstanding Braid jobs/);
});

test("braid_finish with failure exits 1 and reports the summary in JSON output", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("finishFailure", "json");
  assert.equal(code, 1, stderr);
  assert.match(stderr, /Braid: run reported failure: Review found 2 blocking issues\./);
  const events = stdout.trim().split("\n").map(line => JSON.parse(line));
  const finish = events.filter(event => event.type === "entry_appended" && event.entry.customType === "braid-finish");
  assert.deepEqual(finish.map(event => event.entry.data), [
    { status: "failure", summary: "Review found 2 blocking issues.", forcedFailures: [] },
  ]);
  assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolName === "braid_finish" &&
    event.result.details.status === "failure"));
});

test("braid_finish with success keeps the run open for outstanding jobs and exits 0", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("finishSuccess", "text");
  assert.equal(code, 0, stderr);
  assert.equal(stdout, "REPORTED SUCCESS\n");
  assert.doesNotMatch(stderr, /Braid:/);
});

test("braid_finish success does not mask a --braid-ci-timeout cancellation", { timeout: 15_000 }, async () => {
  const { code, stdout, stderr } = await runPi("finishAfterTimeout", "json", ["--braid-ci-timeout", "300ms"]);
  assert.equal(code, 1, stderr);
  assert.match(stdout, /CLAIMED SUCCESS/);
  assert.match(stderr, /Braid: --braid-ci-timeout expired; cancelled outstanding Braid jobs/);
  const finish = stdout.trim().split("\n").map(line => JSON.parse(line))
    .find(event => event.type === "entry_appended" && event.entry.customType === "braid-finish");
  assert.deepEqual(finish?.entry.data, {
    status: "success", summary: "Nothing to report.",
    forcedFailures: ["--braid-ci-timeout expired; cancelled outstanding Braid jobs"],
  });
});

test("--braid-ci-timeout accepts milliseconds and s/m/h suffixes", () => {
  assert.equal(parseDuration("250"), 250);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1.5m"), 90_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  for (const value of ["", "0", "-5s", "5d", "soon", "1e3"]) assert.throws(() => parseDuration(value), /Invalid --braid-ci-timeout/);
});

test("SDK sessions in Pi's default print mode return from prompt only after jobs and reminders drain", { timeout: 15_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "braid-drain-sdk-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(cwd, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  let parentCalls = 0;
  modelRuntime.registerProvider("braid-offline", {
    api: "openai-completions", apiKey: "offline-test-key", baseUrl: "https://offline.invalid",
    models: [{ id: "fixture", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { ...response(), api: model.api, provider: model.provider, model: model.id };
      void (async () => {
        if (getCurrentSystemPrompt(context.messages).includes("You are an isolated Braid worker")) {
          await new Promise(resolve => setTimeout(resolve, 100));
        } else if (++parentCalls === 1) {
          message.content = [{ type: "toolCall", id: "launch", name: "braid", arguments: input }];
          message.stopReason = "toolUse";
        } else {
          message.content = [{ type: "text", text: parentCalls === 2 ? "Waiting." : "Reported." }];
        }
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      })();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let settled = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: join(cwd, "agent"), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [braidExtension, pi => { pi.on("agent_settled", () => { settled++; }); }],
  });
  await resourceLoader.reload();
  const model = modelRuntime.getModel("braid-offline", "fixture");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), modelRuntime, model, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  await session.prompt("Run one Braid background job.");
  assert.equal(parentCalls, 3);
  assert.equal(settled, 1);
  assert.equal(session.messages.filter(message => message.role === "custom" && message.customType === "braid-completed").length, 1);
});
