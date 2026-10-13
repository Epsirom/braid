import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest, NodeWorkspace } from "@chrok/braid";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { createWorkerTools, type WorkerTools } from "../worker-tools.js";
import { directory, until } from "./helpers.js";

const request = (signal = new AbortController().signal) =>
  ({ signal, execution: { executionId: "execution-1" } }) as unknown as ModelRequest;
const workspace = (cwd: string, mode: NodeWorkspace["mode"]): NodeWorkspace =>
  ({ nodeId: "a", mode, workingDirectory: cwd, ...(mode === "worktree" ? { worktreeRoot: cwd } : {}), state: "ready" });
let count = 0;
async function call(tools: WorkerTools, name: string, args: object, signal = new AbortController().signal, onOutput?: (output: string) => void) {
  const result = await tools.execute({ id: ToolCallId(`call-${++count}`), name, arguments: args }, signal, onOutput);
  return { ...result, text: result.content.map(block => block.type === "text" ? block.text : "").join("") };
}

test("read-only workers get DSH's native read/glob/grep tools and results", async () => {
  const cwd = directory(); writeFileSync(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");
  const tools = await createWorkerTools(request(), workspace(cwd, "read-only"));
  try {
    assert.deepEqual(tools.definitions.map(tool => tool.name).sort(), ["glob", "grep", "read"]);
    assert.match(tools.guidance, /Use the read tool/);
    assert.doesNotMatch(tools.guidance, /edit|bash/);
    const read = await call(tools, "read", { file_path: "sample.txt", offset: 2, limit: 1 });
    assert.equal(read.isError, false);
    assert.match(read.text, /<content>\n2: beta\n/);
    assert.doesNotMatch(read.text, /alpha/);
    assert.match((await call(tools, "grep", { pattern: "gam" })).text, /sample\.txt\nLine 3: gamma/);
    assert.match((await call(tools, "glob", { pattern: "*.txt" })).text, /sample\.txt/);
    const invalid = await call(tools, "read", { path: "sample.txt" });
    assert.equal(invalid.isError, true);
    for (const name of ["write", "bash", "unknown"]) {
      const denied = await call(tools, name, { file_path: "x.txt", content: "x", command: "true", description: "x" });
      assert.equal(denied.isError, true); assert.match(denied.text, /Unavailable tool/);
    }
    assert.equal(existsSync(join(cwd, "x.txt")), false);
  } finally { await tools.dispose(); }
});

test("writable workers write through DSH's tools inside Braid's write boundary", async t => {
  const cwd = directory(true);
  const tools = await createWorkerTools(request(), workspace(cwd, "worktree"));
  try {
    assert.ok(["write", "edit", "bash"].every(name => tools.definitions.some(tool => tool.name === name)));
    assert.ok(tools.writes("edit") && tools.writes("bash") && !tools.writes("read"));
    // DSH's observation policy requires reading before editing.
    assert.equal((await call(tools, "edit", { file_path: "file.txt", old_string: "original", new_string: "changed" })).isError, true);
    await call(tools, "read", { file_path: "file.txt" });
    const edited = await call(tools, "edit", { file_path: "file.txt", old_string: "original", new_string: "changed" });
    assert.equal(edited.isError, false, edited.text);
    assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "changed\n");
    assert.equal((await call(tools, "write", { file_path: "nested/new.txt", content: "new" })).isError, false);
    for (const path of ["../escape.txt", ".git/config"]) {
      const denied = await call(tools, "write", { file_path: path, content: "bad" });
      assert.equal(denied.isError, true, path); assert.match(denied.text, /only inside|Git metadata/);
    }
    assert.equal(existsSync(join(cwd, "..", "escape.txt")), false);
    try { symlinkSync(join(cwd, "file.txt"), join(cwd, "link.txt")); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Symlink check unavailable without Windows developer mode"); return; }
      throw error;
    }
    const linked = await call(tools, "write", { file_path: "link.txt", content: "bad" });
    assert.equal(linked.isError, true); assert.match(linked.text, /symlinks/);
    assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "changed\n");
  } finally { await tools.dispose(); }
});

test("bash returns DSH's native result, streams output, and honors timeout and cancellation", { skip: process.platform === "win32" }, async () => {
  const cwd = directory(true);
  const tools = await createWorkerTools(request(), workspace(cwd, "worktree"));
  try {
    const chunks: string[] = [];
    const result = await call(tools, "bash", { command: "pwd; echo first; sleep 0.3; echo second; echo oops >&2; exit 3", description: "Print output" },
      undefined, output => { chunks.push(output); throw new Error("observer"); });
    assert.equal(result.isError, false);
    assert.match(result.text, /braid-dsh-test-[^\n]*\nfirst\nsecond\n\[stderr\]\noops\n\[exit code: 3\]/);
    assert.match(chunks.join(""), /first\n.*second/s);
    const timedOut = await call(tools, "bash", { command: "sleep 5", description: "Wait", timeoutMs: 50 });
    assert.match(timedOut.text, /\[timed out after 50ms\]/);
    const controller = new AbortController();
    const pending = call(tools, "bash", { command: "sleep 5", description: "Wait" }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await pending.catch(() => {});
    assert.ok(Date.now() - started < 4000);
  } finally { await tools.dispose(); }
});

test("disposal stops processes a command left behind", { skip: process.platform === "win32" }, async () => {
  const cwd = directory(true);
  const tools = await createWorkerTools(request(), workspace(cwd, "worktree"));
  const pidFile = join(cwd, "pid");
  try {
    const result = await call(tools, "bash", { command: `(sleep 30 & echo $! > ${pidFile})`, description: "Leave a child" });
    assert.equal(result.isError, false, result.text);
  } finally { await tools.dispose(); }
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});
