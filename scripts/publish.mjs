import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { waitForPackage, registryLookup } from "./registry-ready.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Resolve the active npm executable without shell interpolation.
const npm = process.env.npm_execpath ?? execFileSync(process.platform === "win32" ? "where.exe" : "which", ["npm"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const workspaces = JSON.parse(readFileSync(join(root, "package.json"))).workspaces;
for (const cwd of [root, ...workspaces.map(workspace => join(root, workspace))]) {
  const { name, version } = JSON.parse(readFileSync(join(cwd, "package.json")));
  const args = [npm, "view", `${name}@${version}`, "version", "--json", "--registry=https://registry.npmjs.org"];
  const existing = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (existing.status === 0 && JSON.parse(existing.stdout) === version) {
    // Refuse silently replacing an unrelated package; a retry is allowed only
    // when the registry records this exact source commit as its published head.
    const publishedHead = JSON.parse(execFileSync(process.execPath, [npm, "view", `${name}@${version}`, "gitHead", "--json", "--registry=https://registry.npmjs.org"], { encoding: "utf8" }));
    if (publishedHead !== gitHead) throw new Error(`${name}@${version} already exists from another commit; bump the version`);
    console.log(`${name}@${version} already published from this commit; continuing.`);
    await waitForPackage({ name, version, gitHead }, { lookup: registryLookup(npm, name, version) });
    continue;
  }
  if (existing.status !== 0 && !existing.stderr.includes("E404")) throw new Error(existing.stderr);
  const published = spawnSync(process.execPath, [npm, "publish", "--access", "public", "--registry=https://registry.npmjs.org"], { cwd, stdio: "inherit" });
  if (published.error) throw published.error;
  if (published.status !== 0) process.exit(published.status ?? 1);
  await waitForPackage({ name, version, gitHead }, { lookup: registryLookup(npm, name, version) });
}
