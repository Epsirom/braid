import { rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const pi = process.argv[2] === "pi";
const directory = pi ? resolve(root, "integrations/pi") : root;
// Pi resolves the current core through the development-only workspace link.
if (pi) {
  const core = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: "inherit" });
  if (core.error) throw core.error;
  if (core.status !== 0) process.exit(core.status ?? 1);
}
rmSync(resolve(directory, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  resolve(root, "node_modules/typescript/bin/tsc"),
  "-p", resolve(directory, "tsconfig.build.json"),
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (pi) copyFileSync(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
