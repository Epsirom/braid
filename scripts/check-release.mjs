import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const core = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const pi = JSON.parse(readFileSync(new URL("../integrations/pi/package.json", import.meta.url)));
assert.equal(pi.version, core.version, "Core and Pi must release the same version");
assert.match(core.version, /^\d+\.\d+\.\d+$/, "This workflow publishes stable versions only");
assert.equal(process.env.RELEASE_TAG, `v${core.version}`, "Release tag must match both package manifests");
assert.equal(pi.dependencies[core.name], core.version, "Pi must depend on the exact released core version");
