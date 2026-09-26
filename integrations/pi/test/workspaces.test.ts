import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import type { MergeSource, ModelRequest, SourceCheckoutStatus } from "../../../dist/index.js";
import { createPiRunner } from "../runner.js";
import { PiWorkspaces, type PiNodeWorkspace } from "../workspaces.js";
import { createWorktreeWriteTools } from "../write-tools.js";
import { BraidJobs } from "../jobs.js";
import { createBraidTools } from "../index.js";
import { createAvailableReadTools } from "../read-tools.js";
import { context, deferred, input, response } from "./helpers.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function repository(t: TestContext, unborn = false) {
  const directory = await mkdtemp(join(tmpdir(), "braid-git-test-"));
  const root = join(directory, "repo");
  await mkdir(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Braid test");
  await git(root, "config", "user.email", "test@localhost");
  await git(root, "config", "commit.gpgsign", "false");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "file.txt"), "original\n");
  await writeFile(join(root, "deleted.txt"), "delete me\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  if (!unborn) {
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
  }
  const workspaces = new Map<string, PiNodeWorkspace>();
  const onWorkspace = (workspace: PiNodeWorkspace) => {
    if (workspace.worktreeRoot) workspaces.set(workspace.worktreeRoot, workspace);
  };
  t.after(async () => {
    for (const workspace of workspaces.values()) {
      await git(root, "worktree", "remove", "--force", workspace.worktreeRoot!).catch(() => {});
    }
    for (const parent of new Set([...workspaces.keys()].map(dirname)))
      await rm(parent, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, root, workspaces, onWorkspace };
}

function request(id: string, signal = new AbortController().signal, runId = "run"): ModelRequest {
  return {
    goal: "Edit independently", node: { type: "execute", id, prompt: "Edit the file" },
    model: "fake/model", predecessors: [], execution: { runId, rootRunId: runId }, signal,
  };
}

function toolResponse(...calls: ToolCall[]) {
  return { ...response(), stopReason: "toolUse" as const, content: calls };
}

test("parallel Git nodes write and edit separate worktrees from the same dirty snapshot", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, "src", "file.txt"), "staged\n");
  await git(fixture.root, "add", "src/file.txt");
  await writeFile(join(fixture.root, "src", "file.txt"), "unstaged\n");
  await writeFile(join(fixture.root, "new.txt"), "untracked\n");
  await writeFile(join(fixture.root, "ignored.txt"), "ignore me\n");
  await writeFile(join(fixture.root, ".gitignore"), "ignored.txt\nforced.txt\n");
  await writeFile(join(fixture.root, "forced.txt"), "tracked despite ignore rules\n");
  await git(fixture.root, "add", "--force", "forced.txt");
  await rm(join(fixture.root, "deleted.txt"));
  const index = await readFile(join(fixture.root, ".git", "index"));
  const head = await git(fixture.root, "rev-parse", "HEAD");
  const turns = new Map<string, number>();
  const ctx = context(async () => response());
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as {
      nodeId: string; workingDirectory: string; workspace: PiNodeWorkspace;
    };
    const turn = turns.get(payload.nodeId) ?? 0;
    turns.set(payload.nodeId, turn + 1);
    assert.deepEqual(worker.tools!.map(tool => tool.name), [...(await createAvailableReadTools(fixture.root)).tools.map(tool => tool.name), "write", "edit"]);
    assert.match(worker.systemPrompt!, /own isolated Git worktree/);
    assert.match(worker.systemPrompt!, /cannot run shell commands/);
    if (turn === 0) {
      assert.equal(await readFile(join(payload.workingDirectory, "file.txt"), "utf8"), "unstaged\n");
      assert.equal(await readFile(join(payload.workspace.worktreeRoot!, "new.txt"), "utf8"), "untracked\n");
      assert.equal(await readFile(join(payload.workspace.worktreeRoot!, "forced.txt"), "utf8"), "tracked despite ignore rules\n");
      await assert.rejects(readFile(join(payload.workspace.worktreeRoot!, "ignored.txt")), { code: "ENOENT" });
      await assert.rejects(readFile(join(payload.workspace.worktreeRoot!, "deleted.txt")), { code: "ENOENT" });
      return toolResponse({ type: "toolCall", id: "write", name: "write", arguments: {
        path: "created.txt", content: payload.nodeId,
      } });
    }
    const result = worker.messages.at(-1)!;
    assert.equal(result.role, "toolResult");
    if (result.role === "toolResult") assert.equal(result.isError, false);
    if (turn === 1) return toolResponse({ type: "toolCall", id: "edit", name: "edit", arguments: {
      path: "file.txt", edits: [{ oldText: "unstaged", newText: payload.nodeId }],
    } });
    return response(`Completed ${payload.nodeId}`);
  });
  const runner = createPiRunner(ctx.modelRegistry, {
    cwd: join(fixture.root, "src"), onWorkspace: fixture.onWorkspace,
  });
  const manager = new PiWorkspaces(join(fixture.root, "src"), fixture.onWorkspace);
  const outputs = await Promise.all(["left", "right"].map(async id => {
    const invocation = request(id);
    invocation.workspace = await manager.prepare(invocation);
    return runner(invocation);
  }));
  assert.equal(fixture.workspaces.size, 2);
  const snapshots = [...fixture.workspaces.values()];
  assert.equal(snapshots[0]!.snapshotCommit, snapshots[1]!.snapshotCommit);
  for (const workspace of snapshots) {
    assert.equal(workspace.baseCommit, head);
    assert.equal(await readFile(join(workspace.workingDirectory, "file.txt"), "utf8"), `${workspace.nodeId}\n`);
    assert.equal(await readFile(join(workspace.workingDirectory, "created.txt"), "utf8"), workspace.nodeId);
    assert.ok(outputs.some(output => output.output === `Completed ${workspace.nodeId}`));
  }
  assert.equal(await readFile(join(fixture.root, "src", "file.txt"), "utf8"), "unstaged\n");
  await assert.rejects(readFile(join(fixture.root, "src", "created.txt")), { code: "ENOENT" });
  assert.deepEqual(await readFile(join(fixture.root, ".git", "index")), index);
  assert.equal(await git(fixture.root, "rev-parse", "HEAD"), head);
});

test("write tools reject escapes, Git metadata, symlinks, hard links, and writes after cancellation", async (t) => {
  const fixture = await repository(t);
  const signal = new AbortController();
  const workspaces = new PiWorkspaces(fixture.root, fixture.onWorkspace);
  const workspace = await workspaces.prepare(request("safe", signal.signal));
  const sibling = await workspaces.prepare(request("sibling"));
  const outside = join(fixture.directory, "outside.txt");
  await writeFile(outside, "untouched");
  await symlink(fixture.directory, join(workspace.worktreeRoot!, "linked-dir"));
  await symlink(outside, join(workspace.worktreeRoot!, "linked-file"));
  await symlink(join(fixture.directory, "missing"), join(workspace.worktreeRoot!, "dangling"));
  await link(outside, join(workspace.worktreeRoot!, "hard-link"));
  const [write, edit] = await createWorktreeWriteTools(workspace.workingDirectory, workspace.worktreeRoot!, signal.signal);
  const metadata = await lstat(join(workspace.worktreeRoot!, ".git"));
  // Some filesystems treat these spellings as aliases of the .git file.
  for (const path of [".git.", ".git ", ".gi\u200ct", ".git::$DATA"]) {
    const alias = await lstat(join(workspace.worktreeRoot!, path)).catch(() => undefined);
    if (alias?.dev === metadata.dev && alias?.ino === metadata.ino)
      await assert.rejects(write.execute("metadata-alias", { path, content: "bad" }, signal.signal));
  }
  for (const path of [
    outside, "../outside.txt", join(fixture.root, "src/file.txt"),
    join(sibling.worktreeRoot!, "file.txt"), ".git", ".git/config", "nested/.git/config",
    "linked-dir/new-file", "linked-file", "dangling", "hard-link",
  ]) {
    await assert.rejects(write.execute("write", { path, content: "bad" }, signal.signal));
    await assert.rejects(edit.execute("edit", { path, edits: [{ oldText: "untouched", newText: "bad" }] }, signal.signal));
  }
  assert.equal(await readFile(outside, "utf8"), "untouched");
  await assert.rejects(readFile(join(fixture.directory, "new-file")), { code: "ENOENT" });
  await write.execute("valid", { path: "new/valid.txt", content: "allowed" }, signal.signal);
  assert.equal(await readFile(join(workspace.worktreeRoot!, "new/valid.txt"), "utf8"), "allowed");
  signal.abort();
  await assert.rejects(write.execute("late", { path: "late.txt", content: "late" }, signal.signal));
  await assert.rejects(readFile(join(workspace.worktreeRoot!, "late.txt")), { code: "ENOENT" });
});

test("worktree checkout does not run hooks and a reused runner snapshots each graph separately", async (t) => {
  const fixture = await repository(t);
  const hook = join(fixture.root, ".git", "hooks", "post-checkout");
  await writeFile(hook, "#!/bin/sh\nprintf ran > hook-ran\n", { mode: 0o755 });
  const workspaces = new PiWorkspaces(fixture.root, fixture.onWorkspace);
  const first = await workspaces.prepare(request("first"));
  await assert.rejects(readFile(join(first.worktreeRoot!, "hook-ran")), { code: "ENOENT" });
  await writeFile(join(fixture.root, "new-run.txt"), "later");
  const sameRun = await workspaces.prepare(request("same"));
  await assert.rejects(readFile(join(sameRun.worktreeRoot!, "new-run.txt")), { code: "ENOENT" });
  const nextRun = await workspaces.prepare(request("next", undefined, "next-run"));
  assert.equal(await readFile(join(nextRun.worktreeRoot!, "new-run.txt"), "utf8"), "later");
});

test("an initialized Git repository without commits still gets an isolated writable worktree", async (t) => {
  const fixture = await repository(t, true);
  const workspace = await new PiWorkspaces(fixture.root, fixture.onWorkspace).prepare(request("initial"));
  assert.equal(workspace.mode, "worktree");
  assert.equal(workspace.baseCommit, undefined);
  assert.equal(await readFile(join(workspace.worktreeRoot!, "src/file.txt"), "utf8"), "original\n");
  await assert.rejects(git(fixture.root, "rev-parse", "--verify", "HEAD"));
});

test("a linked worktree can be the source without modifying its index or working files", async (t) => {
  const fixture = await repository(t);
  const linked = join(fixture.directory, "linked");
  await git(fixture.root, "worktree", "add", "--detach", linked, "HEAD");
  await writeFile(join(linked, "src/file.txt"), "linked changes\n");
  const workspace = await new PiWorkspaces(join(linked, "src"), fixture.onWorkspace).prepare(request("linked"));
  assert.equal(await readFile(join(workspace.workingDirectory, "file.txt"), "utf8"), "linked changes\n");
  assert.equal(await readFile(join(fixture.root, "src/file.txt"), "utf8"), "original\n");
  assert.equal(await readFile(join(linked, "src/file.txt"), "utf8"), "linked changes\n");
  await git(fixture.root, "worktree", "remove", "--force", linked);
});

test("a source split index is preserved while snapshotting its working changes", async (t) => {
  const fixture = await repository(t);
  await git(fixture.root, "update-index", "--split-index");
  await writeFile(join(fixture.root, "src/file.txt"), "split index changes\n");
  const index = await readFile(join(fixture.root, ".git/index"));
  const workspace = await new PiWorkspaces(fixture.root, fixture.onWorkspace).prepare(request("split"));
  assert.equal(await readFile(join(workspace.worktreeRoot!, "src/file.txt"), "utf8"), "split index changes\n");
  assert.deepEqual(await readFile(join(fixture.root, ".git/index")), index);
});

test("a worktree creation error fails closed and reports the attempted workspace", async (t) => {
  const fixture = await repository(t);
  let attempted: PiNodeWorkspace | undefined;
  const manager = new PiWorkspaces(fixture.root, workspace => {
    fixture.onWorkspace(workspace);
    attempted = workspace;
  });
  // Break repository configuration after snapshot capture to exercise a real
  // worktree creation failure without mocking Git or touching the source files.
  const first = await manager.prepare(request("first"));
  const config = join(fixture.root, ".git", "config");
  const original = await readFile(config, "utf8");
  await writeFile(config, "this is not valid Git config\n");
  try {
    await assert.rejects(manager.prepare(request("blocked")), /Cannot prepare isolated node worktree/);
    assert.equal(attempted!.state, "failed");
    assert.notEqual(attempted!.worktreeRoot, first.worktreeRoot);
  } finally {
    await writeFile(config, original);
  }
});

for (const failure of ["error", "cancel"] as const) {
  test(`job results archive changes and remove worktrees after ${failure}`, async (t) => {
    const fixture = await repository(t);
    const ready = deferred<void>();
    let turns = 0;
    const ctx = context(async () => {
      if (turns++ === 0) return toolResponse({ type: "toolCall", id: "save", name: "write", arguments: {
        path: "partial.txt", content: "keep this work",
      } });
      ready.resolve();
      if (failure === "error") throw new Error("provider failed");
      return new Promise(() => {});
    });
    ctx.cwd = fixture.root;
    const jobs = new BraidJobs();
    t.after(() => jobs.dispose());
    const { braidTool, statusTool } = createBraidTools(jobs);
    const submitted = await braidTool.execute("work", input, undefined, undefined, ctx);
    const id = submitted.details!.jobId;
    await ready.promise;
    if (failure === "cancel") jobs.cancel(id);
    await jobs.wait(id);
    const status = await statusTool.execute("status", { jobId: id }, undefined, undefined, ctx);
    const workspace = status.details!.workspaces!.a!;
    fixture.onWorkspace(workspace);
    assert.equal(status.details!.status, failure === "error" ? "failed" : "cancelled");
    assert.equal(workspace.state, "archived");
    assert.equal(await git(fixture.root, "show", `${workspace.checkpointRef}:partial.txt`), "keep this work");
    await assert.rejects(readFile(join(workspace.worktreeRoot!, "partial.txt")), { code: "ENOENT" });
    assert.ok(JSON.stringify(status.content).includes(workspace.worktreeRoot!));
    await assert.rejects(readFile(join(fixture.root, "partial.txt")), { code: "ENOENT" });
  });
}

test("Pi merge agent inspects, applies, and finishes through core tools before automatic cleanup", async (t) => {
  const fixture = await repository(t);
  const ctx = context(async () => response());
  ctx.cwd = fixture.root;
  const turns = new Map<string, number>();
  let patch = "";
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as {
      nodeId: string; mergeSources?: MergeSource[]; sourceCheckoutStatus?: SourceCheckoutStatus;
    };
    const turn = turns.get(payload.nodeId) ?? 0;
    turns.set(payload.nodeId, turn + 1);
    if (payload.nodeId === "a") {
      if (turn === 0) return toolResponse({ type: "toolCall", id: "save", name: "write", arguments: { path: "chosen.txt", content: "chosen change" } });
      return response("Created chosen.txt");
    }
    assert.equal(payload.nodeId, "__braid_merge__");
    assert.match(worker.systemPrompt!, /core has not merged anything/);
    assert.match(worker.systemPrompt!, /Reserve budget.*finish_merge/);
    assert.ok(worker.tools!.some(tool => tool.name === "finish_merge"));
    const source = payload.mergeSources![0]!;
    if (turn === 0) {
      assert.deepEqual(source.changes!.files, ["chosen.txt"]);
      assert.match(source.changes!.diff.text, /chosen change/);
      assert.equal(payload.sourceCheckoutStatus!.dirty, false);
      const finishSchema = worker.tools!.find(tool => tool.name === "finish_merge")!.parameters as unknown as {
        properties: { dispositions: { maxItems: number; items: { properties: { nodeId: { enum: string[] } } } } };
      };
      assert.deepEqual(finishSchema.properties.dispositions.items.properties.nodeId.enum, ["a"]);
      assert.equal(finishSchema.properties.dispositions.maxItems, 1);
      await assert.rejects(readFile(join(fixture.root, "chosen.txt")), { code: "ENOENT" });
      return toolResponse({ type: "toolCall", id: "inspect", name: "git", arguments: { command: "diff", args: ["--binary", source.snapshotCommit!, source.checkpointRef!] } });
    }
    const toolResult = worker.messages.at(-1)!;
    assert.equal(toolResult.role, "toolResult");
    if (toolResult.role === "toolResult") {
      assert.equal(toolResult.isError, false, JSON.stringify(toolResult.content));
      if (turn === 1) patch = JSON.parse((toolResult.content[0] as { text: string }).text).stdout as string;
    }
    if (turn === 1) return toolResponse({ type: "toolCall", id: "apply", name: "git", arguments: { command: "apply", args: ["-"], input: patch } });
    if (turn === 2) return toolResponse({ type: "toolCall", id: "finish", name: "finish_merge", arguments: {
      dispositions: [{ nodeId: source.nodeId, disposition: "integrated", reason: "Inspected and applied the selected change" }],
    } });
    return response("Integrated the source");
  });
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool, statusTool } = createBraidTools(jobs);
  const submitted = await braidTool.execute("work", { ...input, options: { maxToolCalls: 3 } }, undefined, undefined, ctx);
  await jobs.wait(submitted.details!.jobId);
  const status = await statusTool.execute("result", { jobId: submitted.details!.jobId }, undefined, undefined, ctx);
  assert.equal(status.details!.status, "completed", JSON.stringify(status.details));
  assert.equal(status.details!.workspaces!.a!.state, "integrated");
  assert.equal(await readFile(join(fixture.root, "chosen.txt"), "utf8"), "chosen change");
  assert.equal((await git(fixture.root, "worktree", "list", "--porcelain")).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
});

test("Pi rejects submodule writes before they can escape Git checkpoint coverage", async (t) => {
  const fixture = await repository(t);
  await git(fixture.root, "update-index", "--add", "--cacheinfo", "160000", await git(fixture.root, "rev-parse", "HEAD"), "submodule");
  await mkdir(join(fixture.root, "submodule"));
  const ctx = context(async () => response());
  ctx.cwd = fixture.root;
  let workerTurns = 0;
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string; mergeSources?: PiNodeWorkspace[] };
    if (payload.mergeSources) {
      if (worker.messages.length === 1) return toolResponse({ type: "toolCall", id: "finish", name: "finish_merge", arguments: {
        dispositions: payload.mergeSources.map(source => ({ nodeId: source.nodeId, disposition: "discarded", reason: "No supported changes" })),
      } });
      return response("Discarded unchanged source");
    }
    if (workerTurns++ === 0) return toolResponse({ type: "toolCall", id: "write", name: "write", arguments: { path: "submodule/unsafe.txt", content: "unsafe" } });
    const last = worker.messages.at(-1)!;
    assert.equal(last.role, "toolResult");
    if (last.role === "toolResult") {
      assert.equal(last.isError, true);
      assert.match(JSON.stringify(last.content), /Writing inside submodules is not supported/);
    }
    return response("Submodule write rejected");
  });
  const jobs = new BraidJobs();
  t.after(() => jobs.dispose());
  const { braidTool, statusTool } = createBraidTools(jobs);
  const submitted = await braidTool.execute("work", input, undefined, undefined, ctx);
  await jobs.wait(submitted.details!.jobId);
  const status = await statusTool.execute("result", { jobId: submitted.details!.jobId }, undefined, undefined, ctx);
  assert.equal(status.details!.status, "completed", JSON.stringify(status.details));
  assert.equal(status.details!.workspaces!.a!.state, "discarded");
});

test("duplicate status cannot silently hide actual node changes behind a path filter", async (t) => {
  const fixture = await repository(t);
  const ctx = context(async () => response());
  ctx.cwd = fixture.root;
  let turn = 0;
  t.mock.method(ctx.modelRegistry, "complete", async (_model: unknown, worker: Context) => {
    const payload = JSON.parse(worker.messages[0]!.content as string) as { nodeId: string; mergeSources?: PiNodeWorkspace[] };
    if (payload.mergeSources) return toolResponse({ type: "toolCall", id: "finish", name: "finish_merge", arguments: {
      dispositions: payload.mergeSources.map(source => ({ nodeId: source.nodeId, disposition: "discarded", reason: "Inspection test only" })),
    } });
    if (turn++ === 0) return toolResponse(
      { type: "toolCall", id: "write", name: "write", arguments: { path: "node-change.txt", content: "real change" } },
      { type: "toolCall", id: "bad-status", name: "git", arguments: { command: "status", args: ["status"] } },
    );
    const last = worker.messages.at(-1)!;
    assert.equal(last.role, "toolResult");
    if (last.role !== "toolResult") throw new Error("Missing tool result");
    if (turn === 2) {
      assert.equal(last.isError, true);
      assert.match(JSON.stringify(last.content), /DUPLICATE_GIT_COMMAND/);
      return toolResponse({ type: "toolCall", id: "full-status", name: "git", arguments: { command: "status", args: ["--short"] } });
    }
    assert.equal(last.isError, false);
    assert.match(JSON.stringify(last.content), /node-change.txt/);
    return response("Actual dirty worktree observed");
  });
  // The merge agent must give a final answer after its disposition.
  const complete = ctx.modelRegistry.complete;
  t.mock.method(ctx.modelRegistry, "complete", async (...args: Parameters<typeof complete>) => {
    if (args[1].messages.some(message => message.role === "toolResult" && message.toolName === "finish_merge")) return response("Discarded test output");
    return complete(...args);
  });
  const jobs = new BraidJobs(); t.after(() => jobs.dispose());
  const job = jobs.start(input, {}, ctx);
  await jobs.wait(job.jobId);
  assert.equal(jobs.get(job.jobId)!.status, "completed");
});
