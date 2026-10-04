import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { braid, type BraidResult, type ModelRequest, type MergeDisposition } from "../src/index.js";
import { decision, deferred, execute, graph } from "./helpers.js";

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
    decisions.push({ executionId: source.executionId!, disposition, reason: "Agent reviewed the checkpoint" });
  }
  await request.merge!.finish(decisions);
}

async function noWorktrees(cwd: string, result: BraidResult) {
  assert.equal((await git(cwd, "worktree", "list", "--porcelain")).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
  for (const workspace of Object.values(result.workspaces ?? {})) {
    if (workspace.worktreeRoot) await assert.rejects(readFile(join(workspace.worktreeRoot, ".git")), { code: "ENOENT" });
  }
}

test("read-only executions use fresh isolated predecessor snapshots", async t => {
  const cwd = await repository(t);
  await writeFile(join(cwd, "file.txt"), "initial edit\n");
  const index = await readFile(join(cwd, ".git/index"));
  const paths: string[] = [];
  const result = await braid(graph([
    { ...execute("review"), workspace: "read-only" },
    { ...decision("route", ["done"]), workspace: "read-only" },
  ], [{ from: "review", to: "route" }]), { cwd, runner: async request => {
    assert.equal(request.workspace!.mode, "read-only");
    paths.push(request.workspace!.worktreeRoot!);
    assert.equal(await readFile(join(request.workspace!.workingDirectory, "file.txt"), "utf8"), "initial edit\n");
    assert.equal((await request.git!(["status", "--porcelain"])).stdout, "");
    await assert.rejects(request.git!(["add", "."]), /unavailable/);
    await assert.rejects(request.withWorkspaceWrite!(async () => assert.fail("write ran")), /read-only/);
    if (request.decide) request.decide("done");
    else await writeFile(join(cwd, "file.txt"), "later parent edit\n");
    return { output: "reviewed" };
  } });
  assert.equal(result.nodes.route!.status, "completed", JSON.stringify(result.nodes));
  assert.equal(new Set(paths).size, 2);
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "later parent edit\n");
  await noWorktrees(cwd, result);
});

for (const integrate of [false, true]) {
  test(`mixed workspaces ${integrate ? "explicitly integrate" : "retain results without automatic integration"}`, async t => {
    const cwd = await repository(t);
    const result = await braid(graph([
      { ...execute("analysis"), workspace: "read-only" }, execute("implementation"),
      ...(integrate ? [{ type: "integrate" as const, id: "integrate" }] : []),
    ], integrate ? [{ from: "analysis", to: "integrate" }, { from: "implementation", to: "integrate" }] : []), {
      cwd, runner: async request => {
        if (request.merge) {
          assert.deepEqual(request.merge.sources.map(source => source.nodeId), ["analysis", "implementation"]);
          await applySources(request);
        } else if (request.node.id === "implementation") {
          await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.workingDirectory, "file.txt"), "implemented\n"));
        }
        return { output: "done" };
      },
    });
    assert.equal(result.nodes.implementation!.status, "completed");
    if (integrate) assert.equal(result.nodes.integrate!.status, "completed", JSON.stringify(result.nodes.integrate));
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), integrate ? "implemented\n" : "original\n");
    assert.ok(result.nodes.analysis!.workspace!.checkpointRef);
    assert.equal(result.nodes.implementation!.workspace!.state, "archived");
    await noWorktrees(cwd, result);
  });
}

test("explicit workspace modes preserve non-Git read-only behavior", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "braid-read-only-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await braid(graph([
    { ...execute("readonly"), workspace: "read-only" },
    { ...execute("writable"), workspace: "worktree" },
  ]), { cwd, runner: async request => {
    assert.equal(request.workspace!.mode, "read-only");
    assert.equal(request.git, undefined);
    return { output: "done" };
  } });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(result.nodes.readonly!.workspace!.mode, "read-only");
  assert.equal(result.nodes.writable!.workspace!.mode, "read-only");
});

for (const baseline of ["clean", "dirty", "unborn"] as const) {
  test(`analysis-only graphs retain checkpoint results with ${baseline} snapshots`, async t => {
    const cwd = await repository(t);
    if (baseline === "dirty") {
      await writeFile(join(cwd, "file.txt"), "staged\n");
      await git(cwd, "add", "file.txt");
      await writeFile(join(cwd, "file.txt"), "unstaged\n");
      await writeFile(join(cwd, "user.txt"), "untracked\n");
    } else if (baseline === "unborn") {
      await git(cwd, "update-ref", "-d", "refs/heads/main");
    }
    const index = await readFile(join(cwd, ".git/index"));
    const status = await git(cwd, "status", "--porcelain");
    const calls: string[] = [];
    const result = await braid(graph(
      [execute("correctness"), decision("tests", ["reviewed"]), execute("review")],
      [{ from: "correctness", to: "review" }, { from: "tests", to: "review" }],
    ), { cwd, runner: async request => {
      calls.push(request.node.id);
      if (request.node.type === "decision") request.decide!("reviewed");
      if (request.merge) await applySources(request, "discarded");
      if (request.node.id === "review") {
        for (const predecessor of request.predecessors)
          assert.ok(await readFile(join(predecessor.workspace!.worktreeRoot!, ".git")));
      }
      return { output: request.node.id, usage: { inputTokens: 1, outputTokens: 1 } };
    } });
    assert.equal(result.status, "completed", result.error?.message);
    assert.deepEqual(calls.sort(), ["correctness", "review", "tests"]);
    assert.deepEqual(Object.keys(result.terminalOutputs), ["review"]);
    assert.equal(result.terminalOutputs.review!.output, "review");
    assert.deepEqual(result.metadata.usage, { inputTokens: 3, outputTokens: 3 });
    assert.equal(result.metadata.usageReportedNodes, 3);
    assert.ok(!result.events.some(event => event.type === "node_created" && event.nodeType === "merge"));
    for (const workspace of Object.values(result.workspaces!)) {
      assert.equal(workspace.state, "archived");
      assert.equal(workspace.reason, "Execution checkpoint retained for inspection and future recovery");
      assert.equal(workspace.checkpointCommit, workspace.snapshotCommit);
      assert.equal(await git(cwd, "rev-parse", workspace.checkpointRef!), workspace.snapshotCommit);
      assert.equal(await git(cwd, "show", `${workspace.checkpointRef}:file.txt`), baseline === "dirty" ? "unstaged" : "original");
      assert.ok(result.events.some(event => event.type === "workspace_updated" &&
        event.workspace.nodeId === workspace.nodeId && event.workspace.state === "archived"));
    }
    assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
    assert.equal(await git(cwd, "status", "--porcelain"), status);
    assert.equal(await git(cwd, "for-each-ref", "--format=%(refname)", "refs/braid/merge-backups/"), "");
    await noWorktrees(cwd, result);
  });
}

test("failed nodes without changes retain checkpoints and preserve errors for consumers", async t => {
  const cwd = await repository(t);
  const calls: string[] = [];
  const result = await braid(graph([execute("work"), execute("review")], [{ from: "work", to: "review" }]), {
    cwd, runner: async request => {
      calls.push(request.node.id);
      if (request.node.id === "work") throw new Error("analysis failed");
      assert.equal(request.predecessors[0]!.error!.message, "analysis failed");
      return { output: "Failure explained" };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.work!.error!.message, "analysis failed");
  assert.deepEqual(calls, ["work", "review"]);
  assert.equal(result.terminalOutputs.review!.output, "Failure explained");
  assert.equal(result.nodes.work!.workspace!.state, "archived");
  await noWorktrees(cwd, result);
});

test("explicit integration preserves deliberately force-added files from failed nodes", async t => {
  const cwd = await repository(t);
  let sources: string[] = [];
  const result = await braid(graph([execute("unchanged"), execute("changed"), { type: "integrate", id: "integrate" }], [{ from: "changed", to: "integrate" }]), { cwd, runner: async request => {
    if (request.merge) {
      sources = request.merge.sources.map(source => source.nodeId);
      assert.deepEqual(request.merge.sources[0]!.changes!.files, ["ignored.txt"]);
      await applySources(request);
      return { output: "Recovered partial work" };
    }
    await request.withWorkspaceWrite!(async () => {
      if (request.node.id === "changed") {
        await writeFile(join(request.workspace!.worktreeRoot!, "ignored.txt"), "partial work");
        await git(request.workspace!.worktreeRoot!, "add", "--force", "ignored.txt");
      }
      else {
        await writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), "temporary edit\n");
        await writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), "original\n");
      }
    });
    if (request.node.id === "changed") throw new Error("failed after writing");
    return { output: "Analysis complete" };
  } });
  assert.deepEqual(sources, ["changed"]);
  assert.equal(result.status, "completed");
  assert.equal(result.nodes.integrate!.status, "completed");
  assert.equal(result.nodes.unchanged!.workspace!.state, "archived");
  assert.equal(result.nodes.changed!.workspace!.state, "archived");
  assert.equal(await readFile(join(cwd, "ignored.txt"), "utf8"), "partial work");
  await noWorktrees(cwd, result);
});

test("explicit merge still runs for unchanged sources with recoverable snapshot refs", async t => {
  const cwd = await repository(t);
  const calls: string[] = [];
  const result = await braid(graph([execute("work"), { type: "integrate", id: "explicit" }], [{ from: "work", to: "explicit" }]), {
    cwd, runner: async request => {
      calls.push(request.node.id);
      if (request.merge) {
        assert.deepEqual(request.merge.sources.map(source => source.nodeId), ["work"]);
        assert.equal(request.merge.sources[0]!.changes!.diff.text, "");
        await applySources(request, "discarded");
      }
      return { output: request.node.id };
    },
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.deepEqual(calls, ["work", "explicit"]);
  const workspace = result.nodes.work!.workspace!;
  assert.equal(workspace.checkpointCommit, workspace.snapshotCommit);
  assert.equal(await git(cwd, "show", `${workspace.checkpointRef}:file.txt`), "original");
  assert.deepEqual(Object.keys(result.terminalOutputs), ["explicit"]);
  await noWorktrees(cwd, result);
});

test("cancellation during checkpoint sealing prevents downstream admission", async t => {
  const cwd = await repository(t);
  const controller = new AbortController();
  const calls: string[] = [];
  const result = await braid(graph([execute("work")]), {
    cwd, signal: controller.signal,
    onEvent: event => {
      if (event.type === "workspace_updated" && event.workspace.checkpointRef) controller.abort();
    },
    runner: async request => {
      calls.push(request.node.id);
      await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "partial.txt"), "recover me"));
      return { output: "done" };
    },
  });
  assert.equal(result.error!.code, "CANCELLED");
  assert.deepEqual(calls, ["work"]);
  assert.ok(!result.events.some(event => event.type === "node_created" && event.nodeType === "merge"));
  assert.equal(result.nodes.work!.workspace!.state, "archived");
  assert.equal(await git(cwd, "show", `${result.nodes.work!.workspace!.checkpointRef}:partial.txt`), "recover me");
  await noWorktrees(cwd, result);
});

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
  const result = await braid({ goal: "iterate", nodes: [execute("edit"), { ...decision("check", ["again", "done"]), workspace: "read-only" }],
    edges: [{ from: "edit", to: "check" }, { from: "check", to: "edit", choice: "again", feedback: "iteration" }],
    loops: [{ id: "iteration", entry: "edit", maxIterations: 3 }],
  }, { cwd, runner: async request => {
    paths.push(request.workspace!.worktreeRoot!);
    const contents = await readFile(join(request.workspace!.workingDirectory, "file.txt"), "utf8");
    const round = request.execution.iteration!;
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
    const record = Object.values(result.executions).find(value => value.id === "edit" && value.iteration === round)!;
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
