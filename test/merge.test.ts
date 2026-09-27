import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { braid, type BraidResult, type ModelRequest, type MergeDisposition } from "../src/index.js";
import { deferred, execute, graph } from "./helpers.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

async function repository(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "braid-merge-test-"));
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Braid test");
  await git(cwd, "config", "user.email", "test@localhost");
  await git(cwd, "config", "commit.gpgsign", "false");
  await git(cwd, "config", "core.autocrlf", "false");
  await writeFile(join(cwd, "file.txt"), "original\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "initial");
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); });
  return cwd;
}

async function applySources(request: ModelRequest, disposition: "integrated" | "discarded" = "integrated") {
  const decisions: MergeDisposition[] = [];
  for (const source of request.merge!.sources) {
    if (disposition === "integrated") {
      const patch = await request.git!(["diff", "--binary", source.snapshotCommit!, source.checkpointRef!]);
      assert.equal(patch.exitCode, 0);
      if (patch.stdout) {
        const applied = await request.git!(["apply", "--binary", "-"], patch.stdout);
        assert.equal(applied.exitCode, 0, applied.stderr);
      }
    }
    decisions.push({ nodeId: source.nodeId, disposition, reason: "Agent reviewed the checkpoint" });
  }
  await request.merge!.finish(decisions);
}

async function noWorktrees(cwd: string, result: BraidResult) {
  assert.equal((await git(cwd, "worktree", "list", "--porcelain")).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
  for (const workspace of Object.values(result.workspaces ?? {})) {
    if (workspace.worktreeRoot) await assert.rejects(readFile(join(workspace.worktreeRoot, ".git")), { code: "ENOENT" });
  }
}

test("concurrent graphs safely register and remove worktrees in one Git repository", { timeout: 30_000 }, async t => {
  const cwd = await repository(t);
  const results = await Promise.all([0, 1].map(run => braid(
    graph(Array.from({ length: 4 }, (_, i) => execute(`run-${run}-${i}`))),
    { cwd, maxConcurrency: 4, runner: async request => {
      if (request.merge) {
        await applySources(request, "discarded");
      } else {
        await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "result.txt"), request.node.id));
      }
      return { output: "done" };
    } },
  )));
  for (const result of results) {
    assert.equal(result.status, "completed", JSON.stringify(result.nodes));
    await noWorktrees(cwd, result);
  }
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "original\n");
});

test("explicit merge agents integrate failed predecessors; core never applies their changes first", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "user.txt"), "user uncommitted work");
  await git(cwd, "add", "user.txt");
  const index = await readFile(join(cwd, ".git/index"));
  const result = await braid(graph(
    [execute("left"), execute("right"), { type: "merge", id: "integrate" }],
    [{ from: "left", to: "integrate" }, { from: "right", to: "integrate" }],
  ), { cwd, runner: async request => {
    if (request.node.type !== "merge") {
      await assert.rejects(request.git!(["add", "."]), /unavailable/);
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`), request.node.id));
      if (request.node.id === "right") throw new Error("partial failure");
      return { output: "left done" };
    }
    assert.equal(request.workspace!.mode, "merge");
    assert.equal(request.predecessors.find(value => value.nodeId === "right")!.error!.message, "partial failure");
    await assert.rejects(readFile(join(cwd, "left.txt")), { code: "ENOENT" });
    await assert.rejects(request.git!(["push"]), /unavailable/);
    await assert.rejects(request.git!(["diff", "--output=/tmp/not-allowed"]), /boundaries/);
    await assert.rejects(request.git!(["diff", "--out=/tmp/not-allowed"]), /boundaries/);
    await assert.rejects(request.git!(["merge", "-scustom"]), /boundaries/);
    await assert.rejects(request.merge!.finish([]), /every merge source/);
    await applySources(request);
    return { output: "Agent integrated both checkpoints" };
  } });
  assert.equal(result.status, "failed"); // The original failure remains visible.
  assert.equal(result.nodes.integrate!.status, "completed", JSON.stringify(result.nodes.integrate!.error));
  assert.equal(await readFile(join(cwd, "left.txt"), "utf8"), "left");
  assert.equal(await readFile(join(cwd, "right.txt"), "utf8"), "right");
  assert.equal(result.workspaces!.right!.state, "integrated");
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  await noWorktrees(cwd, result);
});

test("core appends an agent merge for remaining worktrees and refreshes snapshots after explicit merges", async (t) => {
  const cwd = await repository(t);
  const merges: string[] = [];
  const result = await braid(graph(
    [execute("a"), execute("b"), { type: "merge", id: "first" }, execute("c")],
    [{ from: "a", to: "first" }, { from: "first", to: "c" }],
  ), { cwd, defaultModel: "merge-model", runner: async request => {
    if (request.node.type === "merge") {
      merges.push(request.node.id);
      await applySources(request);
      return { output: "Integrated" };
    }
    if (request.node.id === "c")
      assert.equal(await readFile(join(request.workspace!.worktreeRoot!, "a.txt"), "utf8"), "a");
    await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`), request.node.id));
    return { output: "done" };
  } });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.deepEqual(merges, ["first", "__braid_merge__"]);
  assert.equal(result.nodes.__braid_merge__!.model, "merge-model");
  assert.ok(result.events.some(event => event.type === "node_created" && event.nodeId === "__braid_merge__" && event.nodeType === "merge"));
  for (const id of ["a", "b", "c"]) assert.equal(await readFile(join(cwd, `${id}.txt`), "utf8"), id);
  await noWorktrees(cwd, result);
});

test("a merge agent can resolve overlapping changes itself", async (t) => {
  const cwd = await repository(t);
  let sawConflict = false;
  const result = await braid(graph([execute("left"), execute("right")]), { cwd, runner: async request => {
    if (request.node.type !== "merge") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), `${request.node.id}\n`));
      return { output: "edited" };
    }
    for (const source of request.merge!.sources) {
      const patch = await request.git!(["diff", source.snapshotCommit!, source.checkpointRef!]);
      const applied = await request.git!(["apply", "-"], patch.stdout);
      if (applied.exitCode !== 0) {
        sawConflict = true;
        await request.withWorkspaceWrite!(() => writeFile(join(cwd, "file.txt"), "agent resolution\n"));
      }
    }
    await request.merge!.finish(request.merge!.sources.map(source => ({ nodeId: source.nodeId, disposition: "integrated", reason: "Resolved overlap by combining intent" })));
    return { output: "Resolved" };
  } });
  assert.equal(result.status, "completed");
  assert.equal(sawConflict, true);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "agent resolution\n");
  await noWorktrees(cwd, result);
});

for (const outcome of ["discard", "throw", "unfinished"] as const) {
  test(`merge outcome ${outcome} preserves recovery checkpoints and removes worktrees`, async (t) => {
    const cwd = await repository(t);
    const result = await braid(graph([execute("work")]), { cwd, runner: async request => {
      if (request.node.type !== "merge") {
        await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "ignored.txt"), "recover this ignored output"));
        return { output: "made changes" };
      }
      if (outcome === "throw") throw new Error("merge agent failed");
      if (outcome === "discard") await applySources(request, "discarded");
      return { output: "finished" };
    } });
    assert.equal(result.status, outcome === "discard" ? "completed" : "failed");
    const source = result.workspaces!.work!;
    assert.equal(source.state, outcome === "discard" ? "discarded" : "archived");
    assert.equal(await git(cwd, "show", `${source.checkpointRef}:ignored.txt`), "recover this ignored output");
    assert.ok(result.workspaces!.__braid_merge__!.backupRef);
    await assert.rejects(readFile(join(cwd, "ignored.txt")), { code: "ENOENT" });
    await noWorktrees(cwd, result);
  });
}

test("cancellation waits for tracked writes, archives partial work, and never starts a merge agent", async (t) => {
  const cwd = await repository(t);
  const ready = deferred();
  const releaseWrite = deferred();
  const controller = new AbortController();
  let returned = false;
  const pending = braid(graph([execute("work")]), { cwd, signal: controller.signal, runner: async request => {
    assert.notEqual(request.node.type, "merge");
    await request.withWorkspaceWrite!(async () => {
      ready.resolve();
      await releaseWrite.promise;
      await writeFile(join(request.workspace!.worktreeRoot!, "partial.txt"), "last write");
    });
    return new Promise(() => {});
  } }).then(result => { returned = true; return result; });
  await ready.promise;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(returned, false);
  releaseWrite.resolve();
  const result = await pending;
  assert.equal(result.error!.code, "CANCELLED");
  assert.equal(await git(cwd, "show", `${result.workspaces!.work!.checkpointRef}:partial.txt`), "last write");
  await noWorktrees(cwd, result);
});

test("a merge agent chooses cherry-pick for one source and discards another", async (t) => {
  const cwd = await repository(t);
  const result = await braid(graph([execute("chosen"), execute("unused")]), { cwd, runner: async request => {
    if (request.node.type !== "merge") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`), request.node.id));
      return { output: "proposed change" };
    }
    const chosen = request.merge!.sources.find(source => source.nodeId === "chosen")!;
    const pick = await request.git!(["cherry-pick", chosen.checkpointRef!]);
    assert.equal(pick.exitCode, 0, pick.stderr);
    await request.merge!.finish(request.merge!.sources.map(source => ({
      nodeId: source.nodeId, disposition: source.nodeId === "chosen" ? "integrated" : "discarded",
      reason: source.nodeId === "chosen" ? "Selected this implementation" : "Unnecessary alternative",
    })));
    return { output: "Selected change committed" };
  } });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(await readFile(join(cwd, "chosen.txt"), "utf8"), "chosen");
  await assert.rejects(readFile(join(cwd, "unused.txt")), { code: "ENOENT" });
  assert.equal(await git(cwd, "status", "--porcelain"), "");
  await noWorktrees(cwd, result);
});

test("merge lock waits are cancellable without allowing a later agent to bypass the owner", { timeout: 10_000 }, async (t) => {
  const cwd = await repository(t);
  const ownerReady = deferred();
  const releaseOwner = deferred();
  const onlyMerge = graph([{ type: "merge", id: "merge" }]);
  const owner = braid(onlyMerge, { cwd, runner: async request => {
    ownerReady.resolve();
    await releaseOwner.promise;
    await request.merge!.finish([]);
    return { output: "owner done" };
  } });
  await ownerReady.promise;
  let nextEntered = false;
  try {
    const cancelled = await braid(onlyMerge, { cwd, nodeTimeoutMs: 120, runner: async () => {
      assert.fail("Timed-out waiter must never invoke the model");
    } });
    assert.equal(cancelled.nodes.merge!.error!.code, "NODE_TIMEOUT");
    const next = braid(onlyMerge, { cwd, runner: async request => {
      nextEntered = true;
      await request.merge!.finish([]);
      return { output: "next done" };
    } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(nextEntered, false);
    releaseOwner.resolve();
    assert.equal((await owner).status, "completed");
    assert.equal((await next).status, "completed");
  } finally { releaseOwner.resolve(); await owner; }
});

test("unresolved conflicts after finish_merge still fail and archive both sources", async (t) => {
  const cwd = await repository(t);
  const result = await braid(graph([execute("left"), execute("right")]), { cwd, runner: async request => {
    if (request.node.type !== "merge") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), request.node.id));
      return { output: "changed" };
    }
    const [left, right] = request.merge!.sources;
    assert.equal((await request.git!(["cherry-pick", left!.checkpointRef!])).exitCode, 0);
    await request.merge!.finish(request.merge!.sources.map(source => ({ nodeId: source.nodeId, disposition: "integrated", reason: "claimed integrated" })));
    assert.notEqual((await request.git!(["cherry-pick", right!.checkpointRef!])).exitCode, 0);
    return { output: "a conflict appeared after the finish call" };
  } });
  assert.equal(result.nodes.__braid_merge__!.error!.code, "MERGE_FAILED", JSON.stringify(result.nodes.__braid_merge__!.error));
  assert.equal(result.workspaces!.left!.state, "archived");
  assert.equal(result.workspaces!.right!.state, "archived");
  assert.equal(await git(cwd, "show", `${result.workspaces!.__braid_merge__!.backupRef}:file.txt`), "original");
  await noWorktrees(cwd, result);
});

test("cleanup failure reports the retained path instead of claiming worktree removal", async (t) => {
  const cwd = await repository(t);
  let root: string | undefined;
  try {
    const result = await braid(graph([execute("work")]), { cwd, runner: async request => {
      if (request.node.type !== "merge") {
        root = request.workspace!.worktreeRoot!;
        await git(cwd, "worktree", "lock", root);
        return { output: "locked by an external owner" };
      }
      await applySources(request, "discarded");
      return { output: "discarded" };
    } });
    assert.equal(result.error!.code, "CLEANUP_FAILED");
    assert.equal(result.workspaces!.work!.worktreeRoot, root);
    assert.equal(result.workspaces!.work!.state, "ready");
    assert.ok(result.workspaces!.work!.checkpointRef);
    assert.ok(await readFile(join(root!, ".git")));
  } finally {
    if (root) {
      await git(cwd, "worktree", "unlock", root);
      await git(cwd, "worktree", "remove", "--force", root);
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }
});

test("custom writes inside unsupported submodules cannot be silently lost during cleanup", async (t) => {
  const cwd = await repository(t);
  await git(cwd, "update-index", "--add", "--cacheinfo", "160000", await git(cwd, "rev-parse", "HEAD"), "submodule");
  await mkdir(join(cwd, "submodule"));
  let root: string | undefined;
  try {
    const result = await braid(graph([execute("work")]), { cwd, runner: async request => {
      assert.notEqual(request.node.type, "merge"); // Checkpoint validation fails before model invocation.
      root = request.workspace!.worktreeRoot!;
      await request.withWorkspaceWrite!(() => writeFile(join(root!, "submodule", "partial.txt"), "must survive"));
      return { output: "custom runner wrote outside supported capabilities" };
    } });
    assert.equal(result.error!.code, "CLEANUP_FAILED");
    assert.equal(await readFile(join(root!, "submodule", "partial.txt"), "utf8"), "must survive");
    assert.equal(result.workspaces!.work!.worktreeRoot, root);
  } finally {
    if (root) {
      await git(cwd, "worktree", "remove", "--force", root);
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }
});

test("merge context previews only node changes, bounds large diffs, and preserves the source index", async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "file.txt"), "user staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "user unstaged\n");
  await writeFile(join(cwd, "user-untracked.txt"), "user untracked\n");
  const index = await readFile(join(cwd, ".git/index"));
  const result = await braid(graph([execute("small"), execute("large")]), { cwd, runner: async request => {
    if (request.node.type !== "merge") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`),
        request.node.id === "large" ? "a long generated line\n".repeat(20_000) : "small addition\n"));
      return { output: "done" };
    }
    assert.equal(request.merge!.sourceStatus!.dirty, true);
    assert.match(request.merge!.sourceStatus!.text, /MM file.txt/);
    assert.match(request.merge!.sourceStatus!.text, /\?\? user-untracked.txt/);
    const small = request.merge!.sources.find(source => source.nodeId === "small")!.changes!;
    const large = request.merge!.sources.find(source => source.nodeId === "large")!.changes!;
    assert.deepEqual(small.files, ["small.txt"]);
    assert.match(small.diff.text, /\+small addition/);
    assert.equal(small.diff.truncated, false);
    assert.ok(small.diff.text.endsWith("\n"));
    assert.deepEqual(large.files, ["large.txt"]);
    assert.equal(large.diff.truncated, true);
    assert.ok(large.diff.text.length <= 6_000);
    assert.doesNotMatch(small.diff.text + large.diff.text, /user staged|user unstaged|user untracked/);
    await request.merge!.finish(request.merge!.sources.map(source => ({ nodeId: source.nodeId, disposition: "discarded", reason: "Preview test" })));
    return { output: "Reviewed" };
  } });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  await noWorktrees(cwd, result);
});
