import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { braid } from "../src/index.js";
import { decision, execute, graph } from "./helpers.js";
import { applySources, git, noWorktrees, repository } from "./merge-fixtures.js";

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
