import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BRAID_VERSION } from "../src/index.js";

test("BRAID_VERSION matches the core package version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(BRAID_VERSION, manifest.version);
});
