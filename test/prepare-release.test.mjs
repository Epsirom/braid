import assert from "node:assert/strict";
import test from "node:test";
import { nextVersion, updatePinnedLinks } from "../scripts/prepare-release.mjs";
import { renderUpgradeNotes, upgradeNotesTemplate } from "../scripts/upgrade-notes.mjs";

test("release versions resolve from a bump or an explicit newer version", () => {
  assert.equal(nextVersion("0.5.2", "patch"), "0.5.3");
  assert.equal(nextVersion("0.5.2", "minor"), "0.6.0");
  assert.equal(nextVersion("0.5.2", "major"), "1.0.0");
  assert.equal(nextVersion("0.5.2", "0.10.0"), "0.10.0");
  assert.throws(() => nextVersion("0.5.2", "0.5.2"), /newer/);
  assert.throws(() => nextVersion("0.5.2", "0.4.9"), /newer/);
  assert.throws(() => nextVersion("0.5.2", "0.6.0-rc.1"), /Expected X\.Y\.Z/);
});

test("pinned links move to the next release and previous-release links to the current one", () => {
  const text = [
    "Read the [0.4 → 0.5 migration guide](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#migrating-from-04-to-05).",
    "For the previous release, use the",
    "[0.5.1 guide](https://github.com/Epsirom/braid/blob/v0.5.1/integrations/pi/README.md).",
    "See the [0.5.1 documentation](https://github.com/Epsirom/braid/tree/v0.5.1).",
    "Unpinned [compatibility](docs/compatibility.md) and [releases](https://github.com/Epsirom/braid/releases) stay.",
  ].join("\n");
  assert.equal(updatePinnedLinks(text, "0.5.2", "0.5.3"), [
    "Read the [0.4 → 0.5 migration guide](https://github.com/Epsirom/braid/blob/v0.5.3/docs/compatibility.md#migrating-from-04-to-05).",
    "For the previous release, use the",
    "[0.5.2 guide](https://github.com/Epsirom/braid/blob/v0.5.2/integrations/pi/README.md).",
    "See the [0.5.2 documentation](https://github.com/Epsirom/braid/tree/v0.5.2).",
    "Unpinned [compatibility](docs/compatibility.md) and [releases](https://github.com/Epsirom/braid/releases) stay.",
  ].join("\n"));
});

test("upgrade notes are published only for their release and only when they list something", () => {
  const template = upgradeNotesTemplate("0.5.3");
  assert.equal(renderUpgradeNotes(template, "0.5.3"), "");
  assert.equal(renderUpgradeNotes(`${template}- Restart Pi.\n`, "0.5.3"), "## Upgrade notes\n\n- Restart Pi.\n");
  assert.throws(() => renderUpgradeNotes(template, "0.5.4"), /is for v0\.5\.3, not v0\.5\.4/);
  assert.throws(() => renderUpgradeNotes("## Upgrade notes\n", "0.5.3"), /is for no release/);
  assert.throws(() => renderUpgradeNotes("<!-- release: v0.5.3 -->\n- Restart Pi.\n", "0.5.3"), /heading/);
});
