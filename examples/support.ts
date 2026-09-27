import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Text-only examples run outside Git, without worktrees or source integration. */
export async function inTemporaryDirectory<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "braid-example-"));
  try { return await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
