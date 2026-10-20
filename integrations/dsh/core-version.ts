import * as core from "@chrok/braid";

/** The exact core release this plugin depends on; they release together. */
export const REQUIRED_CORE_VERSION = "0.5.0";

/**
 * A host process that loaded core before an upgrade can keep it while loading the new plugin,
 * which then fails on its first missing core helper as an opaque model error. Releases before
 * 0.5.1 do not export a version at all.
 */
export function assertCoreVersion(loaded: { BRAID_VERSION?: unknown } = core): void {
  const version = loaded.BRAID_VERSION;
  if (version === REQUIRED_CORE_VERSION) return;
  const found = typeof version === "string" ? `@chrok/braid ${version}` : "an older @chrok/braid";
  throw new Error(
    `@chrok/dsh-braid requires @chrok/braid ${REQUIRED_CORE_VERSION}, but ${found} is loaded. ` +
    "Install matching versions (check with `npm ls @chrok/dsh-braid @chrok/braid`), then restart the DeepSeek Harness host: " +
    "a running host keeps the core it loaded before an upgrade.",
  );
}
