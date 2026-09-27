import { rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const pi = process.argv[2] === "pi";
const directory = pi ? resolve(root, "integrations/pi") : root;
rmSync(resolve(directory, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [
  resolve(directory, "node_modules/typescript/bin/tsc"),
  "-p", resolve(directory, "tsconfig.build.json"),
], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (pi) copyFileSync(resolve(root, "LICENSE"), resolve(directory, "LICENSE"));
