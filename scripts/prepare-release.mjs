import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { UPGRADE_NOTES_PATH, upgradeNotesTemplate } from "./upgrade-notes.mjs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Resolve `X.Y.Z` or `patch`/`minor`/`major` against the current stable version. */
export function nextVersion(current, input) {
  const [, major, minor, patch] = SEMVER.exec(current)?.map(Number) ?? [];
  if (major === undefined) throw new Error(`Current version ${current} is not X.Y.Z`);
  const next = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[input] ?? input;
  const parsed = SEMVER.exec(next)?.slice(1).map(Number);
  if (!parsed) throw new Error(`Expected X.Y.Z, patch, minor, or major; got ${input}`);
  const order = [parsed[0] - major, parsed[1] - minor, parsed[2] - patch].find(diff => diff !== 0) ?? 0;
  if (order <= 0) throw new Error(`${next} must be newer than ${current}`);
  return next;
}

/**
 * Integration READMEs are published to npm, so their links are pinned to a tag.
 * Links to the current release move to the next one; links to an older release
 * (the "previous release" pointers) move to the current one, label included.
 */
export function updatePinnedLinks(text, current, next) {
  return text.replace(/\[([^\]]*)\]\((https:\/\/github\.com\/Epsirom\/braid\/(?:blob|tree)\/)v(\d+\.\d+\.\d+)([^)]*)\)/g, (link, label, base, version, rest) => {
    if (version === current) return `[${label}](${base}v${next}${rest})`;
    return `[${label.split(version).join(current)}](${base}v${current}${rest})`;
  });
}

function update(path, change, { required = true } = {}) {
  const url = new URL(`../${path}`, import.meta.url);
  const before = readFileSync(url, "utf8");
  const after = change(before);
  if (required && after === before) throw new Error(`${path} did not change`);
  writeFileSync(url, after);
}

const setConstant = (name, current, next) => text => text.replace(`export const ${name} = "${current}";`, `export const ${name} = "${next}";`);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const core = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const current = core.version;
  const next = nextVersion(current, process.argv[2] ?? "");
  const json = edit => text => `${JSON.stringify(edit(JSON.parse(text)), null, 2)}\n`;

  update("package.json", json(manifest => ({ ...manifest, version: next })));
  for (const integration of core.workspaces) {
    update(`${integration}/package.json`, json(manifest => ({ ...manifest, version: next, dependencies: { ...manifest.dependencies, [core.name]: next } })));
    update(`${integration}/core-version.ts`, setConstant("REQUIRED_CORE_VERSION", current, next));
    update(`${integration}/README.md`, text => updatePinnedLinks(text, current, next), { required: false });
  }
  update("package-lock.json", json(lock => {
    lock.version = next;
    lock.packages[""].version = next;
    for (const integration of core.workspaces) {
      lock.packages[integration].version = next;
      lock.packages[integration].dependencies[core.name] = next;
    }
    return lock;
  }));
  update("src/version.ts", setConstant("BRAID_VERSION", current, next));
  update("README.md", text => updatePinnedLinks(text, current, next), { required: false });
  writeFileSync(new URL(`../${UPGRADE_NOTES_PATH}`, import.meta.url), upgradeNotesTemplate(next));

  console.log(`Prepared Braid ${next} (from ${current}). Next:
- Write ${UPGRADE_NOTES_PATH}, or leave its list empty when users need to do nothing.
- Update migration guides, tested host versions, and ROADMAP status if this release changes them.
- Run npm ci and npm run verify, then open a "Release ${next}" PR.
- After it merges, run the Publish Release workflow with version ${next}.`);
}
