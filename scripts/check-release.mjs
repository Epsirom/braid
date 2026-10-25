import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UPGRADE_NOTES_PATH, renderUpgradeNotes } from "./upgrade-notes.mjs";
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const core = JSON.parse(read("package.json"));
assert.match(core.version, /^\d+\.\d+\.\d+$/, "This workflow publishes stable versions only");
assert.equal(process.env.RELEASE_TAG, `v${core.version}`, "Release tag must match all package manifests");
assert.ok(read("src/version.ts").includes(`export const BRAID_VERSION = "${core.version}";`), "BRAID_VERSION must match the core version");
for (const integration of core.workspaces) {
  const manifest = JSON.parse(read(`${integration}/package.json`));
  assert.equal(manifest.version, core.version, `${manifest.name} must release with core`);
  assert.equal(manifest.dependencies[core.name], core.version, `${manifest.name} must depend on the exact core version`);
  assert.ok(read(`${integration}/core-version.ts`).includes(`export const REQUIRED_CORE_VERSION = "${core.version}";`), `${manifest.name} REQUIRED_CORE_VERSION must match core`);
}
// Throws unless the upgrade notes were written for this release.
renderUpgradeNotes(read(UPGRADE_NOTES_PATH), core.version);
