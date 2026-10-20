import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertCoreVersion, REQUIRED_CORE_VERSION } from "../core-version.js";

const required = REQUIRED_CORE_VERSION.replaceAll(".", "\\.");

test("Pi requires the exact core version its manifest depends on", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(REQUIRED_CORE_VERSION, manifest.dependencies["@chrok/braid"]);
  assertCoreVersion();
});

test("Pi reports a mismatched core with versions and upgrade guidance", () => {
  assert.throws(() => assertCoreVersion({ BRAID_VERSION: "0.4.0" }), (error: Error) => {
    assert.match(error.message, new RegExp(`requires @chrok/braid ${required}, but @chrok/braid 0\\.4\\.0 is loaded`));
    assert.match(error.message, /npm ls @chrok\/pi-braid @chrok\/braid/);
    assert.match(error.message, /restart Pi/);
    return true;
  });
  assert.throws(() => assertCoreVersion({}), /but an older @chrok\/braid is loaded/);
});

// Regression for #102: load the extension the way Pi does (jiti, no module cache) against a core
// that predates the version export and isStepInterrupted, as a stale Pi process can.
test("Pi fails at load and runner creation on an older core instead of a model error", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "braid-pi-core-skew-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldCore = join(directory, "old-core.cjs");
  await writeFile(oldCore, `const { BRAID_VERSION, isStepInterrupted, ...core } = require(${JSON.stringify(fileURLToPath(import.meta.resolve("@chrok/braid")))});\nmodule.exports = core;\n`);
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  // jiti is Pi's own dependency, not ours, so only the part used here is typed.
  const { createJiti } = await import(piRequire.resolve("jiti")) as {
    createJiti(id: string, options: { moduleCache: boolean; alias: Record<string, string> }): { import<T>(id: string): Promise<T> };
  };
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@chrok/braid": oldCore } });

  const core = await jiti.import<Record<string, unknown>>("@chrok/braid");
  assert.equal(core.isStepInterrupted, undefined);
  const skew = new RegExp(`requires @chrok/braid ${required}, but an older @chrok/braid is loaded`);
  const { default: braidExtension } = await jiti.import<typeof import("../index.js")>(fileURLToPath(new URL("../index.ts", import.meta.url)));
  assert.throws(() => braidExtension({} as never), skew);
  const { createPiRunner } = await jiti.import<typeof import("../runner.js")>(fileURLToPath(new URL("../runner.ts", import.meta.url)));
  assert.throws(() => createPiRunner({ find: () => undefined, complete: async () => { throw new Error("unreachable"); } }), skew);
});
