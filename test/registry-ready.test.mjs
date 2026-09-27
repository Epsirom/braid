import assert from "node:assert/strict";
import test from "node:test";
import { waitForPackage } from "../scripts/registry-ready.mjs";

const expected = { name: "@chrok/braid", version: "0.1.2", gitHead: "release-commit" };
const metadata = { ...expected, dist: { tarball: "https://registry.example/core.tgz" } };
function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; }, intervalMs: 10, timeoutMs: 30, log() {} };
}

test("publication waits for both registry metadata and a downloadable core tarball", async () => {
  let lookups = 0;
  let downloads = 0;
  await waitForPackage(expected, {
    ...clock(),
    lookup: async () => { if (++lookups === 1) throw new Error("E404: pending scan"); return metadata; },
    download: async url => {
      assert.equal(url, metadata.dist.tarball);
      if (++downloads === 1) throw new Error("Tarball not available yet");
    },
  });
  assert.equal(lookups, 3);
  assert.equal(downloads, 2);
});

test("a version published from another commit stops the release", async () => {
  let downloaded = false;
  await assert.rejects(waitForPackage(expected, {
    ...clock(), lookup: async () => ({ ...metadata, gitHead: "other-commit" }),
    download: async () => { downloaded = true; },
  }), /does not match this release/);
  assert.equal(downloaded, false);
});

test("registry processing has a bounded wait with instructions for a safe retry", async () => {
  let attempts = 0;
  await assert.rejects(waitForPackage(expected, {
    ...clock(), lookup: async () => { attempts++; throw new Error("Registry unavailable"); },
  }), /Timed out.*rerun this release/);
  assert.equal(attempts, 4);
});
