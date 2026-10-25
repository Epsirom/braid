import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const UPGRADE_NOTES_PATH = ".github/upgrade-notes.md";

/** A fresh upgrade-notes file for a release; release:prepare writes it. */
export function upgradeNotesTemplate(version) {
  return `<!-- release: v${version} -->
<!--
Upgrade notes for this release, published above the generated PR list.
List only what users must know or do when upgrading: required migrations
(link docs/compatibility.md at the release tag), new host or Node.js
requirements, behavior changes that need action, and steps such as
restarting Pi or DSH. Leave the list empty when nothing applies.
-->

## Upgrade notes

`;
}

/** The upgrade-notes section to publish for `version`, or "" when it lists nothing. */
export function renderUpgradeNotes(text, version) {
  const release = /^<!-- release: v(\S+) -->/.exec(text)?.[1];
  if (release !== version) throw new Error(`${UPGRADE_NOTES_PATH} is for ${release ? `v${release}` : "no release"}, not v${version}; run npm run release:prepare`);
  // Guidance comments sit above the heading; only the list below it is published.
  const heading = /^## Upgrade notes[ \t]*$/m.exec(text);
  if (!heading) throw new Error(`${UPGRADE_NOTES_PATH} must keep its "## Upgrade notes" heading`);
  const body = text.slice(heading.index + heading[0].length).trim();
  return body ? `## Upgrade notes\n\n${body}\n` : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]?.replace(/^v/, "");
  if (!version) throw new Error("Usage: node scripts/upgrade-notes.mjs vX.Y.Z");
  process.stdout.write(renderUpgradeNotes(readFileSync(new URL(`../${UPGRADE_NOTES_PATH}`, import.meta.url), "utf8"), version));
}
