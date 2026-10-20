import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertCoreVersion, REQUIRED_CORE_VERSION } from "../core-version.js";

test("DSH requires the exact core version its manifest depends on", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(REQUIRED_CORE_VERSION, manifest.dependencies["@chrok/braid"]);
  assertCoreVersion();
});

test("DSH reports a mismatched core with versions and upgrade guidance", () => {
  assert.throws(() => assertCoreVersion({ BRAID_VERSION: "0.4.0" }), (error: Error) => {
    assert.match(error.message, new RegExp(`requires @chrok/braid ${REQUIRED_CORE_VERSION.replaceAll(".", "\\.")}, but @chrok/braid 0\\.4\\.0 is loaded`));
    assert.match(error.message, /npm ls @chrok\/dsh-braid @chrok\/braid/);
    assert.match(error.message, /restart the DeepSeek Harness host/);
    return true;
  });
  assert.throws(() => assertCoreVersion({}), /but an older @chrok\/braid is loaded/);
});
