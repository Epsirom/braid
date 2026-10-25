import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Recreates the workspace links npm ci makes. CI restores node_modules from a cache
// that leaves them out, because the core link points back at the checkout root.
const root = fileURLToPath(new URL("../", import.meta.url));
const scope = resolve(root, "node_modules/@chrok");
mkdirSync(scope, { recursive: true });
for (const [name, target] of [["braid", "."], ["pi-braid", "integrations/pi"], ["dsh-braid", "integrations/dsh"]]) {
  rmSync(resolve(scope, name), { recursive: true, force: true });
  symlinkSync(resolve(root, target), resolve(scope, name), "junction");
}
