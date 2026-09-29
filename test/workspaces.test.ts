import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ModelRequest, NodeWorkspace } from "../src/index.js";
import { GitWorkspaces } from "../src/workspaces.js";

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
  // These fixtures assert exact LF bytes, independent of the host's Git defaults.
  await git(root, "config", "core.autocrlf", "false");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "file.txt"), "original\n");
  await writeFile(join(root, "deleted.txt"), "delete me\n");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  if (!unborn) {
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
  }
  const workspaces = new Map<string, NodeWorkspace>();
  const onWorkspace = (workspace: NodeWorkspace) => {
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

for (const source of ["unborn", "linked"] as const) {
  test(`read-only allocation supports a ${source} checkout without capturing a snapshot`, async t => {
    const fixture = await repository(t, source === "unborn");
    const cwd = source === "linked" ? join(fixture.directory, "linked") : fixture.root;
    if (source === "linked") {
      await git(fixture.root, "worktree", "add", "--detach", cwd, "HEAD");
      t.after(() => git(fixture.root, "worktree", "remove", "--force", cwd).catch(() => {}));
    }
    const before = await git(cwd, "count-objects", "-v");
    const manager = new GitWorkspaces(cwd);
    const invocation = request("review");
    invocation.node = { type: "execute", id: "review", prompt: "Review", workspace: "read-only" };
    invocation.workspace = await manager.prepare(invocation);
    assert.equal(invocation.workspace.mode, "read-only");
    assert.equal(invocation.workspace.snapshotCommit, undefined);
    assert.deepEqual(manager.pending(), []);
    assert.equal((await manager.git(invocation, ["status", "--porcelain"])).exitCode, 0);
    await manager.close();
    assert.equal(await git(cwd, "count-objects", "-v"), before);
    assert.equal(await readFile(join(cwd, "src/file.txt"), "utf8"), "original\n");
  });
}

test("worktree checkout does not run hooks and a reused runner snapshots each graph separately", async (t) => {
  const fixture = await repository(t);
  const hook = join(fixture.root, ".git", "hooks", "post-checkout");
  await writeFile(hook, "#!/bin/sh\nprintf ran > hook-ran\n", { mode: 0o755 });
  const workspaces = new GitWorkspaces(fixture.root, fixture.onWorkspace);
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
  const workspace = await new GitWorkspaces(fixture.root, fixture.onWorkspace).prepare(request("initial"));
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
  const workspace = await new GitWorkspaces(join(linked, "src"), fixture.onWorkspace).prepare(request("linked"));
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
  const workspace = await new GitWorkspaces(fixture.root, fixture.onWorkspace).prepare(request("split"));
  assert.equal(await readFile(join(workspace.worktreeRoot!, "src/file.txt"), "utf8"), "split index changes\n");
  assert.deepEqual(await readFile(join(fixture.root, ".git/index")), index);
});

test("a worktree creation error fails closed and reports the attempted workspace", async (t) => {
  const fixture = await repository(t);
  let attempted: NodeWorkspace | undefined;
  const manager = new GitWorkspaces(fixture.root, workspace => {
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
