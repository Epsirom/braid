<!-- release: v0.6.0 -->
<!--
Upgrade notes for this release, published above the generated PR list.
List only what users must know or do when upgrading: required migrations
(link docs/compatibility.md at the release tag), new host or Node.js
requirements, behavior changes that need action, and steps such as
restarting Pi or DSH. Leave the list empty when nothing applies.
-->

## Upgrade notes


- This release has breaking changes; follow the [0.5 → 0.6 migration guide](https://github.com/Epsirom/braid/blob/v0.6.0/docs/compatibility.md#migrating-from-05-to-06).
- Limits default to unlimited: core's `maxExecutions`, `nodeTimeoutMs`, and `graphTimeoutMs` no longer default to 1000, 60 seconds, and 5 minutes. Set them explicitly if you relied on them. With `startBraid`, a reached limit pauses the run; pass `onLimit: "fail"` to keep failing.
- Graphs drop `loops` and edge `feedback`: move each loop's `maxIterations` onto a node in the cycle as `maxRuns`. Node IDs can no longer contain `@`.
- Pi: replace `--braid-ci-timeout` with `--braid-timeout`; the old flag is rejected. In RPC mode a run now stays busy until running Braid jobs finish, so send input as `steer`, `follow_up`, or a `prompt` with `streamingBehavior`.
- Restart Pi or DSH after upgrading so it loads the matching core.
- Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested host versions; integrations require Node.js 22.19+.
