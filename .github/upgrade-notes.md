<!-- release: v0.5.2 -->
<!--
Upgrade notes for this release, published above the generated PR list.
List only what users must know or do when upgrading: required migrations
(link docs/compatibility.md at the release tag), new host or Node.js
requirements, behavior changes that need action, and steps such as
restarting Pi or DSH. Leave the list empty when nothing applies.
-->

## Upgrade notes

- No migration from 0.5.1 is required. `graph_waiting` is a new event type, so an exhaustive `switch` over `ExecutionEvent` needs a case for it; see the [versioning policy](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#versioning).
- Restart Pi or DSH after upgrading so it loads the matching core.
- Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested host versions; integrations require Node.js 22.19+.
