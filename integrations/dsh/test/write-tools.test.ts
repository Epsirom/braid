import assert from "node:assert/strict";
import test from "node:test";
import { link, realpath, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWriteBoundary } from "../write-tools.js";
import { directory } from "./helpers.js";

test("write boundary rejects links, submodules, Git metadata and traversal", async t => {
  const cwd = directory(true);
  const boundary = await createWriteBoundary(cwd, new AbortController().signal, async () => ["submodule"]);
  const check = (path: string) => boundary(join(cwd, path));
  await assert.rejects(check("../outside.txt"), /only inside/);
  await assert.rejects(check(".git/config"), /Git metadata/);
  await assert.rejects(check("submodule/file.txt"), /submodules/);
  await link(join(cwd, "file.txt"), join(cwd, "hard.txt"));
  await assert.rejects(check("hard.txt"), /hard links/);
  assert.equal(await check("new/file.txt"), join(await realpath(cwd), "new", "file.txt"));
  // Windows symlink creation needs developer mode or elevated permissions.
  try { await symlink(join(cwd, "file.txt"), join(cwd, "link.txt")); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Symlink check unavailable without Windows developer mode"); return; }
    throw error;
  }
  await assert.rejects(check("link.txt"), /symlinks/);
  await mkdir(join(cwd, "target"));
  await symlink(join(cwd, "target"), join(cwd, "linked-directory"), "junction");
  await assert.rejects(check("linked-directory/file.txt"), /symlinks/);
});
