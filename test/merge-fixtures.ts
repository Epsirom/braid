import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { BraidResult, ModelRequest, MergeDisposition } from "../src/index.js";

// Shared by the merge test files, which are split so the runner can execute them in parallel.
const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

export async function repository(t: TestContext) {
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

export async function applySources(request: ModelRequest, disposition: "integrated" | "discarded" = "integrated") {
  const decisions: MergeDisposition[] = [];
  for (const source of request.merge!.sources) {
    if (disposition === "integrated") {
      const patch = await request.git!(["diff", "--binary", source.changes!.baseCommit!, source.checkpointRef!]);
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

export async function noWorktrees(cwd: string, result: BraidResult) {
  assert.equal((await git(cwd, "worktree", "list", "--porcelain")).split("\n").filter(line => line.startsWith("worktree ")).length, 1);
  for (const workspace of Object.values(result.workspaces ?? {})) {
    if (workspace.worktreeRoot) await assert.rejects(readFile(join(workspace.worktreeRoot, ".git")), { code: "ENOENT" });
  }
}
