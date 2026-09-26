import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { createFindTool } from "@earendil-works/pi-coding-agent";
import { createAvailableReadTools, detectSearchTools } from "../read-tools.js";

test("missing search dependencies are omitted and read/ls remain usable without installation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "braid-search-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "visible.txt"), "visible content");
  const { tools, guidance } = await createAvailableReadTools(cwd, { binDir: join(cwd, "absent-bin"), path: "" });
  assert.deepEqual(tools.map(tool => tool.name), ["read", "ls"]);
  assert.match(guidance, /find \(fd\).*grep \(rg\)/);
  assert.match(guidance, /use ls.*read/);
  const listing = await tools[1]!.execute("list", { path: "." });
  assert.match(JSON.stringify(listing.content), /visible.txt/);
  const content = await tools[0]!.execute("read", { path: "visible.txt" });
  assert.match(JSON.stringify(content.content), /visible content/);
});

test("dependency detection supports fdfind and omits broken cached binaries; disappearance blocks SDK execution", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "braid-search-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const binDir = join(cwd, "cache"), path = join(cwd, "path");
  await mkdir(binDir); await mkdir(path);
  for (const name of ["rg", "fdfind"]) {
    await writeFile(join(path, name), "#!/bin/sh\nprintf 'test binary\\n'\n");
    await chmod(join(path, name), 0o755);
  }
  assert.deepEqual(await detectSearchTools({ binDir, path }), { grep: true, find: true });
  const { tools } = await createAvailableReadTools(cwd, { binDir, path });
  await rm(join(path, "fdfind"));
  const find = tools.find(tool => tool.name === "find") as ReturnType<typeof createFindTool>;
  await assert.rejects(find.execute("find", { pattern: "*" }), /no longer available/);
  await writeFile(join(binDir, "rg"), "broken cached executable");
  assert.deepEqual(await detectSearchTools({ binDir, path }), { grep: false, find: false });
});
