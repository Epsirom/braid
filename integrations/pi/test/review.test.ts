import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MergeSource, NodeWorkspace, PredecessorOutput } from "@chrok/braid";
import { BraidJobs } from "../jobs.js";
import { registerReviewCommand } from "../review.js";
import { context, response } from "./helpers.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function command(jobs: BraidJobs) {
  let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
  const messages: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  registerReviewCommand({
    registerCommand(name: string, options: { handler: typeof handler }) {
      assert.equal(name, "braid:review");
      handler = options.handler;
    },
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>) { messages.push(args); },
  } as never, jobs);
  return { handler, messages };
}

async function repository(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "braid-review-test-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Braid test");
  await git(root, "config", "user.email", "test@localhost");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(join(root, "code.txt"), "broken\n");
  await writeFile(join(root, "user.txt"), "original\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const jobs = new BraidJobs();
  t.after(async () => {
    jobs.dispose();
    for (const job of jobs.list()) {
      const saved = jobs.get(job.jobId)!;
      if (saved.fullOutputPath) await rm(dirname(saved.fullOutputPath), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  });
  const ctx = context(async () => response());
  ctx.cwd = root;
  return { root, jobs, ctx, ...command(jobs) };
}

interface Payload {
  nodeId: string;
  goal: string;
  execution: { executionId: string; iteration?: number };
  workspace: NodeWorkspace;
  predecessors: PredecessorOutput[];
  mergeSources?: MergeSource[];
}

function payload(worker: Context): Payload {
  return JSON.parse(worker.messages[0]!.content as string) as Payload;
}

function toolResponse(...calls: ToolCall[]) {
  return { ...response(), stopReason: "toolUse" as const, content: calls };
}

function decide(choice: string) {
  return toolResponse({ type: "toolCall", id: "decide", name: "decide", arguments: { choice } });
}

test("/braid:review registers a bounded background graph and trims its target", async t => {
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { handler, messages } = command(jobs);
  const start = t.mock.method(jobs, "start", () => ({ jobId: "review-id", handle: "job-1" }) as never);
  const ctx = context(async () => response()) as unknown as ExtensionCommandContext;
  await handler("  HEAD~2..HEAD  ", ctx);
  const [input, options, submittedContext] = start.mock.calls[0]!.arguments;
  assert.ok(input);
  assert.match(input.goal, /HEAD~2\.\.HEAD/);
  assert.doesNotMatch(input.goal, /  HEAD/);
  assert.deepEqual(input.loops, [{ id: "review-loop", entry: "scope", maxIterations: 3 }]);
  assert.ok(input.nodes.every(node => node.requireSuccess));
  assert.deepEqual(options, { maxConcurrency: 3, maxExecutions: 16 });
  assert.equal(submittedContext, ctx);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]![0].customType, "braid-review-started");
  assert.equal(messages[0]![0].display, true);
  assert.deepEqual(messages[0]![0].details, { jobId: "review-id", handle: "job-1" });
  assert.notEqual(messages[0]![1]?.triggerTurn, true);
  await handler(" \n ", ctx);
  assert.match(start.mock.calls[1]!.arguments[0]!.goal, /uncommitted/i);
});

// Repeated real Git worktrees need headroom under full-suite concurrency.
test("/braid:review fixes one checkpoint, re-reviews it, and preserves staged and unstaged user edits", { timeout: 30_000 }, async t => {
  const { root, jobs, ctx, handler } = await repository(t);
  await writeFile(join(root, "user.txt"), "staged caller\n");
  await git(root, "add", "user.txt");
  await writeFile(join(root, "user.txt"), "unstaged caller\n");
  await writeFile(join(root, "caller-new.txt"), "untracked caller\n");
  const turns = new Map<string, number>();
  const reviewed: number[] = [];
  let patch = "";
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const data = payload(worker);
    const turn = turns.get(data.execution.executionId) ?? 0;
    turns.set(data.execution.executionId, turn + 1);
    const round = data.execution.iteration ?? 0;
    for (const message of worker.messages) {
      if (message.role === "toolResult") assert.equal(message.isError, false, JSON.stringify(message.content));
    }
    if (data.nodeId === "scope" || data.nodeId.startsWith("review-")) {
      assert.equal(await readFile(join(data.workspace.workingDirectory, "user.txt"), "utf8"), "unstaged caller\n");
      assert.equal(await readFile(join(data.workspace.workingDirectory, "caller-new.txt"), "utf8"), "untracked caller\n");
      if (data.nodeId === "scope") {
        assert.equal(data.workspace.mode, "worktree");
        if (round === 2 && turn === 0) {
          assert.match(data.predecessors[0]!.output, /Fix code\.txt/);
          assert.equal(await readFile(join(data.workspace.workingDirectory, "code.txt"), "utf8"), "broken\n");
          return toolResponse({ type: "toolCall", id: "fix", name: "write", arguments: { path: "code.txt", content: "fixed\n" } });
        }
        return response(`Scope round ${round}; ${round === 1 ? "Prepared review" : "Fixed code.txt; validation passed"}; preserve caller changes`);
      }
      assert.equal(data.workspace.mode, "read-only");
      assert.ok(worker.tools!.some(tool => tool.name === "git"));
      assert.ok(!worker.tools!.some(tool => ["write", "edit", "bash", "powershell"].includes(tool.name)));
      assert.equal(await readFile(join(data.workspace.workingDirectory, "code.txt"), "utf8"), round === 1 ? "broken\n" : "fixed\n");
      reviewed.push(round);
      return response(round === 1 ? "P1 code.txt: confirmed bug" : "No actionable findings");
    }
    if (data.nodeId === "check") {
      assert.equal(data.workspace.mode, "read-only");
      assert.ok(!worker.tools!.some(tool => ["write", "edit", "bash", "powershell"].includes(tool.name)));
      assert.equal(data.predecessors.length, 4);
      assert.ok(data.predecessors.some(predecessor => predecessor.nodeId === "scope"));
      assert.equal(new Set(data.predecessors.map(predecessor => predecessor.workspace!.checkpointCommit)).size, 1);
      if (turn === 0) return decide(round === 1 ? "retry" : "done");
      return response(round === 1 ? "Fix code.txt; P1 confirmed; preserve pinned scope" : "Fixed code.txt; validation retained; no unresolved findings");
    }
    assert.equal(data.nodeId, "apply");
    const source = data.mergeSources![0]!;
    if (turn === 0) {
      assert.deepEqual(source.changes!.files, ["code.txt"]);
      assert.doesNotMatch(source.changes!.diff.text, /caller/);
      assert.equal(await readFile(join(root, "code.txt"), "utf8"), "broken\n");
      return toolResponse({ type: "toolCall", id: "diff", name: "git", arguments: { command: "diff", args: ["--binary", source.changes!.baseCommit!, source.checkpointRef!, "--"] } });
    }
    if (turn === 1) {
      const result = worker.messages.at(-1)!;
      assert.equal(result.role, "toolResult");
      if (result.role === "toolResult") patch = JSON.parse((result.content[0] as { text: string }).text).stdout as string;
      return toolResponse({ type: "toolCall", id: "apply", name: "git", arguments: { command: "apply", args: ["-"], input: patch } });
    }
    if (turn === 2) return toolResponse({ type: "toolCall", id: "finish", name: "finish_merge", arguments: {
      dispositions: [{ executionId: source.executionId!, disposition: "integrated", reason: "Applied reviewed fix" }],
    } });
    return response("Review completed after two rounds; integrated the fix");
  });
  await handler("", ctx as unknown as ExtensionCommandContext);
  const job = jobs.list()[0]!;
  await jobs.wait(job.handle);
  const result = jobs.get(job.handle)!.result!;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(reviewed.sort(), [1, 1, 1, 2, 2, 2]);
  assert.equal(Object.keys(result.executions).length, 11);
  assert.equal(await readFile(join(root, "code.txt"), "utf8"), "fixed\n");
  assert.equal(await git(root, "show", ":user.txt"), "staged caller");
  assert.equal(await readFile(join(root, "user.txt"), "utf8"), "unstaged caller\n");
  assert.equal(await readFile(join(root, "caller-new.txt"), "utf8"), "untracked caller\n");
  assert.equal(result.terminalOutputs.apply!.output, "Review completed after two rounds; integrated the fix");
  assert.equal((await git(root, "worktree", "list", "--porcelain")).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
});

for (const outcome of ["clean", "capped", "limit", "reviewer failure"] as const) {
  test(`/braid:review ${outcome === "clean" ? "stops after a clean first round" : outcome === "capped" ? "reports remaining issues on a normal third-round exit" : outcome === "limit" ? "bounds forced retries without editing the checkout" : "aborts before the decision when a required reviewer fails"}`, { timeout: 30_000 }, async t => {
    const { root, jobs, ctx, handler } = await repository(t);
    const calls = new Set<string>();
    t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
      const data = payload(worker);
      calls.add(data.nodeId);
      if (outcome === "reviewer failure" && data.nodeId === "review-2") throw new Error("Reviewer provider failed");
      if (data.nodeId === "check") {
        assert.equal(data.workspace.mode, "read-only");
        if (worker.messages.length === 1) return decide(outcome === "limit" || (outcome === "capped" && data.execution.iteration! < 3) ? "retry" : "done");
      }
      if (data.nodeId === "apply" && worker.messages.length === 1) {
        assert.ok(data.mergeSources!.every(source => source.changes!.diff.text === ""));
        return toolResponse({ type: "toolCall", id: "finish", name: "finish_merge", arguments: {
          dispositions: data.mergeSources!.map(source => ({ executionId: source.executionId!, disposition: "discarded", reason: "No fixes to integrate" })),
        } });
      }
      return response(outcome === "capped" ? "Round limit reached; unresolved P1 code.txt remains" : "No actionable findings");
    });
    await handler("", ctx as unknown as ExtensionCommandContext);
    const job = jobs.list()[0]!;
    await jobs.wait(job.handle);
    const result = jobs.get(job.handle)!.result!;
    assert.equal(await git(root, "status", "--porcelain"), "");
    assert.equal(await readFile(join(root, "code.txt"), "utf8"), "broken\n");
    if (outcome === "clean" || outcome === "capped") {
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(Object.keys(result.executions).length, outcome === "clean" ? 6 : 16);
      assert.ok(calls.has("apply"));
      if (outcome === "capped") assert.match(result.terminalOutputs.apply!.output, /Round limit reached; unresolved P1/);
    } else {
      assert.equal(result.status, "failed");
      assert.equal(result.error!.code, outcome === "limit" ? "LOOP_LIMIT" : "REQUIRED_NODE_FAILED");
      assert.ok(!calls.has("apply"));
      if (outcome === "limit") {
        assert.equal(Object.keys(result.executions).length, 15);
        assert.deepEqual(Object.values(result.executions).filter(node => node.id === "check").map(node => node.iteration), [1, 2, 3]);
      } else assert.ok(!calls.has("check"));
    }
  });
}
