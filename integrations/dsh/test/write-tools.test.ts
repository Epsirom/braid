import assert from "node:assert/strict";
import test from "node:test";
import { link, readFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createWriteOperations } from "../write-tools.js";
import { directory } from "./helpers.js";

test("write operations reject links, submodules, Git metadata and traversal", async t => {
  const cwd = directory(true);
  const operations = await createWriteOperations(cwd, cwd, new AbortController().signal, async () => ["submodule"]);
  await assert.rejects(operations.write("../outside.txt", "bad"), /only inside/);
  await assert.rejects(operations.write(".git/config", "bad"), /Git metadata/);
  await assert.rejects(operations.write("submodule/file.txt", "bad"), /submodules/);
  await link(join(cwd, "file.txt"), join(cwd, "hard.txt"));
  await assert.rejects(operations.write("hard.txt", "bad"), /hard links/);
  await assert.rejects(operations.read("hard.txt"), /hard links/);
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "original\n");
  // Windows symlink creation needs developer mode or elevated permissions.
  try { await symlink(join(cwd, "file.txt"), join(cwd, "link.txt")); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("Symlink check unavailable without Windows developer mode"); return; }
    throw error;
  }
  await assert.rejects(operations.write("link.txt", "bad"), /symlinks/);
  await mkdir(join(cwd, "target"));
  await symlink(join(cwd, "target"), join(cwd, "linked-directory"), "junction");
  await assert.rejects(operations.write("linked-directory/file.txt", "bad"), /symlinks/);
});
