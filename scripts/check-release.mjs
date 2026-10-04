import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const core = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
assert.match(core.version, /^\d+\.\d+\.\d+$/, "This workflow publishes stable versions only");
assert.equal(process.env.RELEASE_TAG, `v${core.version}`, "Release tag must match all package manifests");
for (const integration of core.workspaces) {
  const manifest = JSON.parse(readFileSync(new URL(`../${integration}/package.json`, import.meta.url)));
  assert.equal(manifest.version, core.version, `${manifest.name} must release with core`);
  assert.equal(manifest.dependencies[core.name], core.version, `${manifest.name} must depend on the exact core version`);
}
