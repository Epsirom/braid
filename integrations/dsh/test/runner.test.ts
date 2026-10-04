import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { braid, type BraidInput } from "@chrok/braid";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { createDshRunner } from "../runner.js";
import { runCommand } from "../shell-tools.js";
import { directory, input, llm, answer, calls, payload } from "./helpers.js";

test("uses exact routes, fresh contexts, native tools, cache usage and direct predecessor output", async () => {
  const cwd = directory();
  const seen: GenerateOptions[] = [];
  const result = await braid({ goal: "goal", nodes: [
    { type: "execute", id: "a", prompt: "first" },
    { type: "execute", id: "b", prompt: "second", model: "other/id/with/slash" },
  ], edges: [{ from: "a", to: "b" }] }, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
    seen.push(options);
    assert.equal(options.messages.length, 1);
    assert.ok(!options.tools?.some(tool => ["braid", "write", "edit", "bash"].includes(tool.name)));
    return answer(payload(options).nodeId);
  }), { cwd }) });
  assert.equal(result.status, "completed");
  assert.equal(seen[1]!.provider, "other"); assert.equal(seen[1]!.model, "id/with/slash");
  assert.equal(payload(seen[1]!).predecessors[0].output, "a");
  assert.equal(result.metadata.usage?.inputTokens, 14);
  assert.notEqual(seen[0]!.messages, seen[1]!.messages);
});

test("decision routes through decide, preserves tool messages and provider replay metadata", async () => {
  const cwd = directory(); let routeCalls = 0;
  const result = await braid({ goal: "route", nodes: [
    { type: "decision", id: "route", prompt: "choose", choices: ["yes", "no"] },
    { type: "execute", id: "yes", prompt: "yes" }, { type: "execute", id: "no", prompt: "no" },
  ], edges: [{ from: "route", to: "yes", choice: "yes" }, { from: "route", to: "no", choice: "no" }] }, {
    cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
      if (payload(options).nodeId !== "route") return answer();
      if (!routeCalls++) return [...calls({ name: "decide", args: { choice: "yes" } }).slice(0, -1),
        { type: "finish", reason: { kind: "tool-calls" }, replayState: { response: { requestId: "replay" } } }];
      assert.equal(options.messages.at(-1)!.role, "tool");
      const previous = options.messages[1]!;
      assert.equal(previous.role, "assistant");
      if (previous.role === "assistant") assert.deepEqual(previous.source.replayState, { response: { requestId: "replay" } });
      assert.ok(!options.tools!.some(tool => tool.name === "decide"));
      return answer("yes selected");
    }), { cwd }),
  });
  assert.equal(result.nodes.yes!.status, "completed"); assert.equal(result.nodes.no!.status, "skipped");
});

test("bounded loops use fresh invocations and prompt templates", async () => {
  const cwd = directory();
  const rounds = new Map<string, number>();
  const graph: BraidInput = { goal: "loop", promptTemplates: { task: "Work on {{target}}" }, nodes: [
    { type: "execute", id: "work", prompt: { template: "task", variables: { target: "loop" } } },
    { type: "decision", id: "check", prompt: "check", choices: ["retry", "done"] },
  ], edges: [{ from: "work", to: "check" }, { from: "check", to: "work", choice: "retry", feedback: "retry" }], loops: [{ id: "retry", entry: "work", maxIterations: 2 }] };
  const result = await braid(graph, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
    const p = payload(options);
    if (p.nodeId === "work") { assert.equal(p.prompt, "Work on loop"); return answer(); }
    const id = p.execution.executionId;
    if (!rounds.has(id)) { rounds.set(id, 1); return calls({ name: "decide", args: { choice: p.execution.iteration === 1 ? "retry" : "done" } }); }
    return answer();
  }), { cwd }) });
  assert.equal(result.status, "completed"); assert.equal(Object.keys(result.executions).length, 4);
});

test("tool limits fail before an over-budget batch can write", async () => {
  const cwd = directory(true);
  const result = await braid(input, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(() => calls(
    { name: "write", args: { path: "no.txt", content: "no" } }, { name: "write", args: { path: "also-no.txt", content: "no" } },
  )), { cwd, maxToolCalls: 1 }) });
  assert.equal(result.nodes.a!.status, "failed"); assert.match(result.nodes.a!.error!.message, /budget/);
  assert.equal(existsSync(join(cwd, "no.txt")), false);
});

test("writable workers edit isolated snapshots and checkpoints exclude ignored outputs", async () => {
  const cwd = directory(true); writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  let round = 0;
  const result = await braid(input, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
    assert.notEqual(payload(options).workspace.workingDirectory, cwd);
    if (!round++) return calls({ name: "edit", args: { path: "file.txt", oldText: "original", newText: "changed" } },
      { name: "write", args: { path: "ignored.txt", content: "cache" } },
      { name: "write", args: { path: "../escape.txt", content: "bad" } },
      { name: "write", args: { path: ".git", content: "bad" } });
    const results = options.messages.filter(message => message.role === "tool");
    assert.equal(results[0]!.isError, false); assert.equal(results[2]!.isError, true); assert.equal(results[3]!.isError, true);
    return answer();
  }), { cwd }) });
  assert.equal(result.nodes.a!.status, "completed");
  assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "original\n");
  const checkpoint = result.nodes.a!.workspace!.checkpointRef!;
  assert.equal(execFileSync("git", ["show", `${checkpoint}:file.txt`], { cwd, encoding: "utf8" }), "changed\n");
  assert.throws(() => execFileSync("git", ["show", `${checkpoint}:ignored.txt`], { cwd, stdio: "ignore" }));
});

test("integration applies selected snapshots, preserves caller edits, and retains recovery refs", async () => {
  const cwd = directory(true);
  writeFileSync(join(cwd, "file.txt"), "caller changes\n");
  const rounds = new Map<string, number>();
  const result = await braid({ goal: "apply", nodes: [
    { type: "execute", id: "implement", prompt: "write" },
    { type: "execute", id: "review", prompt: "review", workspace: "read-only" },
    { type: "integrate", id: "apply", requireSuccess: true },
  ], edges: [{ from: "implement", to: "review" }, { from: "review", to: "apply" }] }, {
    cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
      const p = payload(options), round = rounds.get(p.nodeId) ?? 0;
      rounds.set(p.nodeId, round + 1);
      if (p.nodeId === "implement") return round ? answer() : calls({ name: "write", args: { path: "selected.txt", content: "selected" } });
      if (p.nodeId === "review") {
        assert.equal(readFileSync(join(p.workspace.workingDirectory, "selected.txt"), "utf8"), "selected");
        assert.ok(!options.tools!.some(tool => tool.name === "write")); return answer("reviewed");
      }
      const source = p.mergeSources[0];
      if (round === 0) {
        assert.equal(p.sourceCheckoutStatus.dirty, true);
        return calls({ name: "git", args: { command: "diff", args: ["--binary", source.changes.baseCommit, source.checkpointRef] } });
      }
      const latest = options.messages.at(-1)!;
      assert.equal(latest.role, "tool");
      if (latest.role === "tool") assert.equal(latest.isError, false, JSON.stringify(latest));
      if (round === 1) return calls({ name: "git", args: { command: "apply", args: ["-"], input: JSON.parse((latest.content[0] as { text: string }).text).stdout } });
      if (round === 2) return calls({ name: "finish_merge", args: { dispositions: [{ executionId: source.executionId, disposition: "integrated", reason: "Applied selected diff" }] } });
      return answer("applied");
    }), { cwd }),
  });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(readFileSync(join(cwd, "selected.txt"), "utf8"), "selected");
  assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "caller changes\n");
  assert.ok(result.nodes.apply!.workspace!.backupRef);
});

test("read-only tools execute locally and malformed/unknown calls return errors to the model", async () => {
  const cwd = directory(); writeFileSync(join(cwd, "sample.txt"), "hello");
  let round = 0;
  const result = await braid(input, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
    if (!round++) return calls({ name: "read", args: { path: "sample.txt" } }, { name: "read", args: {} }, { name: "bash", args: { command: "false" } });
    const results = options.messages.filter(message => message.role === "tool");
    assert.match(JSON.stringify(results[0]), /hello/); assert.equal(results[1]!.isError, true); assert.equal(results[2]!.isError, true);
    return answer();
  }), { cwd }) });
  assert.equal(result.status, "completed");
});

test("bounded file reads preserve UTF-8 characters across windows", async () => {
  const cwd = directory(), original = "你好".repeat(10_000);
  writeFileSync(join(cwd, "unicode.txt"), original);
  let text = "", round = 0;
  const result = await braid(input, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(options => {
    if (!round++) return calls({ name: "read", args: { path: "unicode.txt" } });
    const latest = options.messages.at(-1)!;
    const read = JSON.parse((latest.content[0] as { text: string }).text);
    text += read.text;
    return read.eof ? answer() : calls({ name: "read", args: { path: "unicode.txt", offset: read.nextOffset } });
  }), { cwd }) });
  assert.equal(result.status, "completed"); assert.equal(text, original);
});

test("rejects incomplete streams, empty output, max tokens and duplicate decisions", async () => {
  const cwd = directory();
  for (const chunks of [answer().slice(0, -1), answer(""), [{ type: "finish" as const, reason: { kind: "max-tokens" as const } }]]) {
    const result = await braid(input, { cwd, defaultModel: "fake/model", runner: createDshRunner(llm(() => chunks), { cwd }) });
    assert.equal(result.nodes.a!.status, "failed");
  }
  const result = await braid({ goal: "duplicate", nodes: [{ type: "decision", id: "a", prompt: "choose", choices: ["yes"] }], edges: [] }, {
    cwd, defaultModel: "fake/model", runner: createDshRunner(llm(() => calls({ name: "decide", args: { choice: "yes" } }, { name: "decide", args: { choice: "yes" } })), { cwd }),
  });
  assert.equal(result.nodes.a!.status, "failed");
});

test("shell commands obey timeout and cancellation and use the assigned cwd", async () => {
  const cwd = directory();
  const result = JSON.parse(await runCommand(process.execPath, ["-e", "console.log(process.cwd())"], cwd, new AbortController().signal));
  assert.equal(result.exitCode, 0); assert.match(result.output, /braid-dsh-test-/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], cwd, new AbortController().signal, 0.03), /timeout/);
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], cwd, controller.signal);
  controller.abort(); await assert.rejects(pending, /aborted/);
});
