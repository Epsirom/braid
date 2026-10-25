import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { braid } from "../src/index.js";
import { decision, execute, graph } from "./helpers.js";
import { applySources, git, noWorktrees, repository } from "./merge-fixtures.js";

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
    [execute("left"), execute("right"), { type: "integrate", id: "integrate" }],
    [{ from: "left", to: "integrate" }, { from: "right", to: "integrate" }],
  ), { cwd, runner: async request => {
    if (request.node.type !== "integrate") {
      await assert.rejects(request.git!(["add", "."]), /unavailable/);
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, `${request.node.id}.txt`), request.node.id));
      if (request.node.id === "right") throw new Error("partial failure");
      return { output: "left done" };
    }
    assert.equal(request.workspace!.mode, "integrate");
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
  assert.equal(result.status, "completed"); // The optional failure remains visible on its execution.
  assert.equal(result.nodes.integrate!.status, "completed", JSON.stringify(result.nodes.integrate!.error));
  assert.equal(await readFile(join(cwd, "left.txt"), "utf8"), "left");
  assert.equal(await readFile(join(cwd, "right.txt"), "utf8"), "right");
  assert.equal(result.nodes.right!.workspace!.state, "archived");
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  await noWorktrees(cwd, result);
});

test("isolated merge feeds a fresh descendant worktree before explicit integration", async t => {
  const cwd = await repository(t);
  const seen = new Map<string, string>();
  const result = await braid(graph(
    [execute("a"), execute("b"), { type: "merge", id: "combined" }, execute("c"), { type: "integrate", id: "integrate" }],
    [{ from: "a", to: "combined" }, { from: "b", to: "combined" }, { from: "combined", to: "c" }, { from: "c", to: "integrate" }],
  ), { cwd, runner: async request => {
    if (request.node.id !== "integrate") {
      await assert.rejects(readFile(join(cwd, "a.txt")), { code: "ENOENT" });
      seen.set(request.node.id, request.workspace!.worktreeRoot!);
    }
    if (request.merge) {
      for (const source of request.merge.sources) {
        const patch = await request.git!(["diff", "--binary", "main", source.checkpointRef!]);
        const applied = await request.git!(["apply", "--binary", "-"], patch.stdout);
        assert.equal(applied.exitCode, 0, applied.stderr);
      }
      await request.merge.finish(request.merge.sources.map(source => ({ executionId: source.executionId!, disposition: "integrated", reason: "combined" })));
    } else {
      if (request.node.id === "c") for (const name of ["a", "b"]) assert.equal(await readFile(join(request.workspace!.workingDirectory, `${name}.txt`), "utf8"), name);
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, `${request.node.id}.txt`), request.node.id));
    }
    return { output: "done" };
  } });
  assert.equal(result.nodes.integrate!.status, "completed", JSON.stringify(result.nodes));
  assert.equal(new Set(seen.values()).size, 4);
  for (const id of ["a", "b", "c"]) assert.equal(await readFile(join(cwd, `${id}.txt`), "utf8"), id);
  await noWorktrees(cwd, result);
});

test("integration after a read-only review exposes the cumulative diff base and preserves caller edits", async t => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "file.txt"), "user staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "user unstaged\n");
  await writeFile(join(cwd, "user-untracked.txt"), "user untracked\n");
  const index = await readFile(join(cwd, ".git/index"));
  let integrated = false;
  const result = await braid(graph([
    execute("left"), execute("right"), { type: "merge", id: "combined" },
    { ...decision("review", ["pass"]), workspace: "read-only" },
    { type: "integrate", id: "integrate" },
  ], [
    { from: "left", to: "combined" }, { from: "right", to: "combined" },
    { from: "combined", to: "review" }, { from: "review", to: "integrate", choice: "pass" },
  ]), { cwd, runner: async request => {
    if (request.node.id === "left" || request.node.id === "right") {
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, `${request.node.id}.txt`), request.node.id));
    } else if (request.node.id === "review") {
      for (const name of ["left", "right"]) {
        assert.equal(await readFile(join(request.workspace!.workingDirectory, `${name}.txt`), "utf8"), name);
      }
      request.decide!("pass");
    } else {
      if (request.node.type === "integrate") {
        const source = request.merge!.sources[0]!;
        assert.equal(source.nodeId, "review");
        // A no-change review reuses its input checkpoint. Diffing against it
        // would silently lose the work inherited from both parallel branches.
        assert.equal(source.snapshotCommit, source.checkpointCommit);
        assert.ok(source.changes!.baseCommit);
        assert.notEqual(source.changes!.baseCommit, source.snapshotCommit);
        assert.notEqual(source.changes!.baseCommit, source.baseCommit);
        assert.deepEqual(source.changes!.files, ["left.txt", "right.txt"]);
        assert.doesNotMatch(source.changes!.diff.text, /user staged|user unstaged|user untracked/);
        const parents = await request.git!(["show", "--no-patch", "--format=%P", source.checkpointRef!]);
        assert.equal(parents.stdout.trim().split(" ").length, 3);
        assert.equal(request.merge!.sourceStatus!.dirty, true);
        integrated = true;
      }
      await applySources(request);
    }
    return { output: "done" };
  } });
  assert.equal(result.status, "completed", JSON.stringify(result.nodes));
  assert.equal(integrated, true);
  assert.equal(result.nodes.integrate!.status, "completed", JSON.stringify(result.nodes.integrate));
  for (const name of ["left", "right"]) assert.equal(await readFile(join(cwd, `${name}.txt`), "utf8"), name);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "user unstaged\n");
  assert.equal(await readFile(join(cwd, "user-untracked.txt"), "utf8"), "user untracked\n");
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  await noWorktrees(cwd, result);
});

test("a merge agent can resolve overlapping changes itself", async (t) => {
  const cwd = await repository(t);
  let sawConflict = false;
  const result = await braid(graph([execute("left"), execute("right"), { type: "integrate", id: "integrate", requireSuccess: true }], [{ from: "left", to: "integrate" }, { from: "right", to: "integrate" }]), { cwd, runner: async request => {
    if (request.node.type !== "integrate") {
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
    await request.merge!.finish(request.merge!.sources.map(source => ({ executionId: source.executionId!, disposition: "integrated", reason: "Resolved overlap by combining intent" })));
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
    const result = await braid(graph([execute("work"), { type: "integrate", id: "integrate", requireSuccess: true }], [{ from: "work", to: "integrate" }]), { cwd, runner: async request => {
      if (request.node.type !== "integrate") {
        await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "recovery.txt"), "recover this output"));
        return { output: "made changes" };
      }
      if (outcome === "throw") throw new Error("merge agent failed");
      if (outcome === "discard") await applySources(request, "discarded");
      return { output: "finished" };
    } });
    assert.equal(result.status, outcome === "discard" ? "completed" : "failed");
    const source = result.nodes.work!.workspace!;
    assert.equal(source.state, "archived");
    assert.equal(await git(cwd, "show", `${source.checkpointRef}:recovery.txt`), "recover this output");
    assert.ok(result.nodes.integrate!.workspace!.backupRef);
    await assert.rejects(readFile(join(cwd, "recovery.txt")), { code: "ENOENT" });
    await noWorktrees(cwd, result);
  });
}
