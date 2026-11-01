<!-- release: v0.7.0 -->
<!--
Upgrade notes for this release, published above the generated PR list.
List only what users must know or do when upgrading: required migrations
(link docs/compatibility.md at the release tag), new host or Node.js
requirements, behavior changes that need action, and steps such as
restarting Pi or DSH. Leave the list empty when nothing applies.
-->

## Upgrade notes

- This release has breaking changes; follow the [0.6 → 0.7 migration guide](https://github.com/Epsirom/braid/blob/v0.7.0/docs/compatibility.md#migrating-from-06-to-07).
- The `decision` node type is removed: change `type: "decision"` to `type: "execute"` and keep its `choices`. Graphs and updates that still use it are rejected with a migration hint. TypeScript users: `DecisionNode` is removed and `ExecuteNode` has an optional `choices`; custom runners should check `request.decide` instead of `request.node.type === "decision"`.
- Restart Pi or DSH after upgrading so it loads the matching core.
- Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested host versions; integrations require Node.js 22.19+.
