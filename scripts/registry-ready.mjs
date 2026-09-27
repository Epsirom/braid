import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Wait for metadata and the tarball before publishing a package that depends on it. */
export async function waitForPackage(expected, {
  lookup,
  download = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Tarball returned HTTP ${response.status}`);
    await response.arrayBuffer();
  },
  sleep = delay,
  now = Date.now,
  timeoutMs = 10 * 60_000,
  intervalMs = 15_000,
  log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (true) {
    let metadata;
    try { metadata = await lookup(); }
    catch (error) { lastError = error; }
    if (metadata) {
      if (metadata.version !== expected.version || metadata.gitHead !== expected.gitHead) {
        throw new Error(`${expected.name}@${expected.version} registry version/commit does not match this release`);
      }
      try {
        await download(metadata.dist.tarball);
        log(`${expected.name}@${expected.version} is available from npm.`);
        return;
      } catch (error) { lastError = error; }
    }
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for ${expected.name}@${expected.version} on npm; rerun this release after registry processing completes`, { cause: lastError });
    }
    log(`Waiting for npm to make ${expected.name}@${expected.version} available...`);
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

export function registryLookup(npm, name, version) {
  return () => JSON.parse(execFileSync(process.execPath, [npm, "view", `${name}@${version}`,
    "version", "gitHead", "dist", "--json", "--registry=https://registry.npmjs.org",
    "--fetch-retries=0", "--fetch-timeout=20000"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25_000,
  }));
}
