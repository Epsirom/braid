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

test("explicit read-only workers inspect the live checkout without snapshots, worktrees, or merge", async t => {
  const cwd = await repository(t);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "file.txt"), "live edit\n");
  const index = await readFile(join(cwd, ".git/index"));
  const objects = await git(cwd, "count-objects", "-v");
  const result = await braid(graph([
    { ...execute("review"), workspace: "read-only" },
    { ...decision("route", ["done"]), workspace: "read-only" },
  ], [{ from: "review", to: "route" }]), { cwd: join(cwd, "nested"), runner: async request => {
    assert.equal(request.workspace!.mode, "read-only");
    assert.equal(request.workspace!.workingDirectory, join(cwd, "nested"));
    assert.equal(request.workspace!.worktreeRoot, undefined);
    assert.equal(request.workspace!.snapshotCommit, undefined);
    assert.equal((await git(cwd, "worktree", "list", "--porcelain")).match(/^worktree /gm)!.length, 1);
    const status = await request.git!(["status", "--porcelain"]);
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /file.txt/);
    const diff = await request.git!(["diff", "--", "../file.txt"]);
    assert.equal(diff.exitCode, 0);
    assert.match(diff.stdout, /live edit/);
    assert.match((await request.git!(["show", "HEAD:file.txt"])).stdout, /original/);
    await assert.rejects(request.git!(["add", "."]), /unavailable/);
    await assert.rejects(request.withWorkspaceWrite!(async () => assert.fail("write ran")), /read-only/);
    if (request.decide) {
      assert.equal(request.predecessors[0]!.workspace!.mode, "read-only");
      assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "live edit\nupdated\n");
      request.decide("done");
    } else await writeFile(join(cwd, "file.txt"), "live edit\nupdated\n"); // Simulate a parent edit.
    return { output: "reviewed" };
  } });
  assert.equal(result.status, "completed", result.error?.message);
  assert.deepEqual(Object.keys(result.nodes), ["review", "route"]);
  assert.equal(result.terminalOutputs.route!.decision, "done");
  assert.deepEqual(Object.keys(result.workspaces!), ["review", "route"]);
  assert.equal(result.events.filter(event => event.type === "workspace_updated").length, 2);
  assert.equal(await git(cwd, "count-objects", "-v"), objects);
  assert.equal(await git(cwd, "for-each-ref", "--format=%(refname)", "refs/braid/"), "");
  assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
});

for (const explicitMerge of [false, true]) {
  test(`mixed read-only and writable nodes pass only worktrees to ${explicitMerge ? "explicit" : "automatic"} merge`, async t => {
    const cwd = await repository(t);
    const result = await braid(graph([
      { ...execute("analysis"), workspace: "read-only" },
      { ...execute("implementation"), workspace: "worktree" },
      ...(explicitMerge ? [{ type: "merge" as const, id: "integrate" },
        { ...execute("after"), workspace: "read-only" as const }] : []),
    ], explicitMerge ? [
      { from: "analysis", to: "integrate" }, { from: "implementation", to: "integrate" },
      { from: "integrate", to: "after" },
    ] : []), { cwd, runner: async request => {
      if (request.merge) {
        assert.deepEqual(request.merge.sources.map(source => source.nodeId), ["implementation"]);
        await applySources(request);
      } else if (request.node.id === "implementation") {
        assert.equal(request.workspace!.mode, "worktree");
        await request.withWorkspaceWrite!(() => writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), "implemented\n"));
      } else {
        assert.equal(request.workspace!.mode, "read-only");
        if (request.node.id === "after")
          assert.match((await request.git!(["diff"])).stdout, /implemented/);
      }
      return { output: "done" };
    } });
    assert.equal(result.status, "completed", result.error?.message);
    assert.equal(result.workspaces!.analysis!.state, "ready");
    assert.equal(result.workspaces!.analysis!.checkpointRef, undefined);
    assert.equal(result.workspaces!.implementation!.state, "integrated");
    assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "implemented\n");
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
  assert.equal(result.nodes.writable!.workspace, undefined);
});

for (const baseline of ["clean", "dirty", "unborn"] as const) {
  test(`analysis-only graphs skip automatic merge with ${baseline} snapshots`, async t => {
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
      assert.equal(workspace.state, "discarded");
      assert.equal(workspace.reason, "No changes from snapshot");
      assert.equal(workspace.checkpointCommit, workspace.snapshotCommit);
      assert.equal(await git(cwd, "rev-parse", workspace.checkpointRef!), workspace.snapshotCommit);
      assert.equal(await git(cwd, "show", `${workspace.checkpointRef}:file.txt`), baseline === "dirty" ? "unstaged" : "original");
      assert.ok(result.events.some(event => event.type === "workspace_updated" &&
        event.workspace.nodeId === workspace.nodeId && event.workspace.state === "discarded"));
    }
    assert.deepEqual(await readFile(join(cwd, ".git/index")), index);
    assert.equal(await git(cwd, "status", "--porcelain"), status);
    assert.equal(await git(cwd, "for-each-ref", "--format=%(refname)", "refs/braid/merge-backups/"), "");
    await noWorktrees(cwd, result);
  });
}

test("failed nodes without changes skip automatic merge and preserve errors for consumers", async t => {
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
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.work!.error!.message, "analysis failed");
  assert.deepEqual(calls, ["work", "review"]);
  assert.equal(result.terminalOutputs.review!.output, "Failure explained");
  assert.equal(result.workspaces!.work!.state, "discarded");
  await noWorktrees(cwd, result);
});

test("automatic merge receives only changed sources, including ignored output from failed nodes", async t => {
  const cwd = await repository(t);
  let sources: string[] = [];
  const result = await braid(graph([execute("unchanged"), execute("changed")]), { cwd, runner: async request => {
    if (request.merge) {
      sources = request.merge.sources.map(source => source.nodeId);
      assert.deepEqual(request.merge.sources[0]!.changes!.files, ["ignored.txt"]);
      await applySources(request);
      return { output: "Recovered partial work" };
    }
    await request.withWorkspaceWrite!(async () => {
      if (request.node.id === "changed") await writeFile(join(request.workspace!.worktreeRoot!, "ignored.txt"), "partial work");
      else {
        await writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), "temporary edit\n");
        await writeFile(join(request.workspace!.worktreeRoot!, "file.txt"), "original\n");
      }
    });
    if (request.node.id === "changed") throw new Error("failed after writing");
    return { output: "Analysis complete" };
  } });
  assert.deepEqual(sources, ["changed"]);
  assert.equal(result.status, "failed");
  assert.equal(result.nodes.__braid_merge__!.status, "completed");
  assert.equal(result.workspaces!.unchanged!.state, "discarded");
  assert.equal(result.workspaces!.changed!.state, "integrated");
  assert.equal(await readFile(join(cwd, "ignored.txt"), "utf8"), "partial work");
  await noWorktrees(cwd, result);
});

test("explicit merge still runs for unchanged sources with recoverable snapshot refs", async t => {
  const cwd = await repository(t);
  const calls: string[] = [];
  const result = await braid(graph([execute("work"), { type: "merge", id: "explicit" }], [{ from: "work", to: "explicit" }]), {
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
  const workspace = result.workspaces!.work!;
  assert.equal(workspace.checkpointCommit, workspace.snapshotCommit);
  assert.equal(await git(cwd, "show", `${workspace.checkpointRef}:file.txt`), "original");
  assert.deepEqual(Object.keys(result.terminalOutputs), ["explicit"]);
  await noWorktrees(cwd, result);
});

test("cancellation during the unchanged check prevents automatic merge admission", async t => {
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
  assert.equal(result.workspaces!.work!.state, "archived");
  assert.equal(await git(cwd, "show", `${result.workspaces!.work!.checkpointRef}:partial.txt`), "recover me");
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
