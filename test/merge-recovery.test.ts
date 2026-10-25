import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { braid } from "../src/index.js";
import { decision, deferred, execute, graph } from "./helpers.js";
import { applySources, git, noWorktrees, repository } from "./merge-fixtures.js";

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
  assert.equal(await git(cwd, "show", `${result.nodes.work!.workspace!.checkpointRef}:partial.txt`), "last write");
  await noWorktrees(cwd, result);
});

test("a merge agent chooses cherry-pick for one source and discards another", async (t) => {
  const cwd = await repository(t);
  const result = await braid(graph([execute("chosen"), execute("unused"), { type: "integrate", id: "integrate" }], [{ from: "chosen", to: "integrate" }, { from: "unused", to: "integrate" }]), { cwd, runner: async request => {
    if (request.node.type !== "integrate") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`), request.node.id));
      return { output: "proposed change" };
    }
    const chosen = request.merge!.sources.find(source => source.nodeId === "chosen")!;
    const pick = await request.git!(["cherry-pick", chosen.checkpointRef!]);
    assert.equal(pick.exitCode, 0, pick.stderr);
    await request.merge!.finish(request.merge!.sources.map(source => ({
      executionId: source.executionId!, disposition: source.nodeId === "chosen" ? "integrated" : "discarded",
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
  const onlyMerge = graph([{ type: "integrate", id: "merge" }]);
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
  const result = await braid(graph([execute("left"), execute("right"), { type: "integrate", id: "integrate", requireSuccess: true }], [{ from: "left", to: "integrate" }, { from: "right", to: "integrate" }]), { cwd, runner: async request => {
    if (request.node.type !== "integrate") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), request.node.id));
      return { output: "changed" };
    }
    const [left, right] = request.merge!.sources;
    assert.equal((await request.git!(["cherry-pick", left!.checkpointRef!])).exitCode, 0);
    await request.merge!.finish(request.merge!.sources.map(source => ({ executionId: source.executionId!, disposition: "integrated", reason: "claimed integrated" })));
    assert.notEqual((await request.git!(["cherry-pick", right!.checkpointRef!])).exitCode, 0);
    return { output: "a conflict appeared after the finish call" };
  } });
  assert.equal(result.nodes.integrate!.error!.code, "MERGE_FAILED", JSON.stringify(result.nodes.integrate!.error));
  assert.equal(result.nodes.left!.workspace!.state, "archived");
  assert.equal(result.nodes.right!.workspace!.state, "archived");
  assert.equal(await git(cwd, "show", `${result.nodes.integrate!.workspace!.backupRef}:file.txt`), "original");
  await noWorktrees(cwd, result);
});

test("cleanup failure reports the retained path instead of claiming worktree removal", async (t) => {
  const cwd = await repository(t);
  let root: string | undefined;
  try {
    const result = await braid(graph([execute("work")]), { cwd, runner: async request => {
      if (request.node.type !== "integrate") {
        root = request.workspace!.worktreeRoot!;
        await git(cwd, "worktree", "lock", root);
        return { output: "locked by an external owner" };
      }
      await applySources(request, "discarded");
      return { output: "discarded" };
    } });
    assert.equal(result.error!.code, "CLEANUP_FAILED");
    assert.equal(result.nodes.work!.workspace!.worktreeRoot, root);
    assert.equal(result.nodes.work!.workspace!.state, "ready");
    assert.ok(result.nodes.work!.workspace!.checkpointRef);
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
    assert.equal(result.nodes.work!.workspace!.worktreeRoot, root);
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
  const result = await braid(graph([execute("small"), execute("large"), { type: "integrate", id: "integrate" }], [{ from: "small", to: "integrate" }, { from: "large", to: "integrate" }]), { cwd, runner: async request => {
    if (request.node.type !== "integrate") {
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
    await request.merge!.finish(request.merge!.sources.map(source => ({ executionId: source.executionId!, disposition: "discarded", reason: "Preview test" })));
    return { output: "Reviewed" };
  } });
  assert.equal(result.status, "completed", JSON.stringify(result.error));
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  await noWorktrees(cwd, result);
});

test("loop executions derive fresh worktrees from the preceding result and never mutate the caller", async t => {
  const cwd = await repository(t);
  const paths: string[] = [];
  const result = await braid({ goal: "iterate", nodes: [{ ...execute("edit"), maxRuns: 3 }, { ...decision("check", ["again", "done"]), workspace: "read-only" }],
    edges: [{ from: "edit", to: "check" }, { from: "check", to: "edit", choice: "again" }],
  }, { cwd, runner: async request => {
    paths.push(request.workspace!.worktreeRoot!);
    const contents = await readFile(join(request.workspace!.workingDirectory, "file.txt"), "utf8");
    const round = request.execution.generation!;
    if (request.node.id === "edit") {
      assert.equal(contents, round === 1 ? "original\n" : `round ${round - 1}\n`);
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, "file.txt"), `round ${round}\n`));
    } else {
      assert.equal(contents, `round ${round}\n`);
      request.decide!(round === 3 ? "done" : "again");
    }
    return { output: `round ${round}` };
  } });
  assert.equal(result.status, "completed");
  assert.ok(Object.values(result.executions).every(record => record.status === "completed"), JSON.stringify(result.nodes));
  assert.equal(new Set(paths).size, 6);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "original\n");
  for (const round of [1, 2, 3]) {
    const record = Object.values(result.executions).find(value => value.id === "edit" && value.generation === round)!;
    assert.equal(await git(cwd, "show", `${record.workspace!.checkpointRef}:file.txt`), `round ${round}`);
  }
  await noWorktrees(cwd, result);
});

test("independent changed snapshots require an explicit merge before a worker join", async t => {
  const cwd = await repository(t);
  const result = await braid(graph([execute("a"), execute("b"), execute("join")], [{ from: "a", to: "join" }, { from: "b", to: "join" }]), { cwd, runner: async request => {
    assert.notEqual(request.node.id, "join");
    await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, `${request.node.id}.txt`), request.node.id));
    return { output: "done" };
  } });
  assert.equal(result.nodes.join!.error!.code, "WORKSPACE_MERGE_REQUIRED");
  await noWorktrees(cwd, result);
});

test("two merge consumers can independently reuse the same execution checkpoint", async t => {
  const cwd = await repository(t);
  const result = await braid(graph([execute("source"), { type: "merge", id: "one" }, { type: "merge", id: "two" }], [{ from: "source", to: "one" }, { from: "source", to: "two" }]), { cwd, runner: async request => {
    if (request.merge) await applySources(request);
    else await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, "reuse.txt"), "reusable"));
    return { output: "done" };
  } });
  for (const id of ["one", "two"]) {
    assert.equal(result.nodes[id]!.status, "completed", JSON.stringify(result.nodes[id]));
    assert.equal(await git(cwd, "show", `${result.nodes[id]!.workspace!.checkpointRef}:reuse.txt`), "reusable");
    assert.equal(result.nodes[id]!.workspace!.dispositions![0]!.executionId, result.nodes.source!.executionId);
  }
  await assert.rejects(readFile(join(cwd, "reuse.txt")), { code: "ENOENT" });
  await noWorktrees(cwd, result);
});
