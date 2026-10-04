# Changelog

## Unreleased

## 0.2.1 — 2026-10-04

### Maintenance

- Upgrade the Pi validation target to 1.0.1 and refresh the workspace lockfile
  so Pi's minimatch resolves the patched brace-expansion 5.0.12. Add a separate
  dependency-security check covering development dependencies and reporting
  scanner failures explicitly
  ([#38](https://github.com/Epsirom/braid/pull/38)) — @Epsirom.

No Braid API or runtime behavior changes. Pi 1.0.1 is the tested host version;
updating Braid does not upgrade a separately installed Pi host.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.2.0...v0.2.1).

## 0.2.0 — 2026-10-02

### Features and breaking changes

- Separate editable node definitions from unique execution instances, preserving
  captured prompts, policies, predecessor identities, and historical results
  ([#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.
- Support bounded structured loops with explicit decision feedback, finite round
  limits, fresh worktrees per visit, and no overlapping/nested rounds
  ([#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.
- Add `startBraid`, revision-checked live updates, `pauseAfter`, and atomic
  update/resume. Pi adds `braid_update`, `braid_resume`, exact execution retrieval,
  iteration-aware reminders, and live topology updates
  ([#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.
- Derive successor worktrees from predecessor checkpoints, including read-only
  executions. Split isolated `merge` from source-checkout `integrate`; remove
  automatic final integration. Workspace keys and merge dispositions use
  `executionId`; sources remain reusable until final cleanup
  ([#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.
- Make invocation failures optional by default. Captured `requireSuccess: true`
  failures abort siblings and fail the job after writes/checkpoint/cleanup drain.
  Add a finite `maxExecutions` budget shared across loops and live updates
  ([#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.
- Add submission-local `promptTemplates` and explicit template-reference prompts
  to core and Pi's `braid` tool. Core expands `{{name}}` placeholders using literal
  string variables, validates every rendered prompt before execution, and keeps
  existing plain-string/default merge prompts and runner contracts. Shared
  instructions no longer need repeating in each node's tool-call arguments
  ([#33](https://github.com/Epsirom/braid/pull/33)) — @Epsirom.
- Add opt-in `notifyOnCompletion` on execute, decision, and merge nodes. Pi sends
  parent reminders on node success/failure, including timeout/cancellation of
  running nodes, with delivery acknowledgement and dropped-message retries.
  Skipped nodes stay silent; whole-job reminders remain enabled. Add
  `braid_status({jobId, nodeId})` for full intermediate outputs/errors, with
  overflow results saved to a private temporary file. Live graph
  controls are now available through the execution-control API above
  ([#34](https://github.com/Epsirom/braid/pull/34),
  [#35](https://github.com/Epsirom/braid/pull/35)) — @Epsirom.

See the [0.1 → 0.2 migration guide](docs/compatibility.md#migrating-from-01-to-02)
before upgrading: use `integrate` for source-checkout writes, add explicit final
integration, use execution IDs for historical results and merge dispositions,
and set `requireSuccess: true` where failures must stop the whole run.

### Maintenance

- Refresh repository/package descriptions and discovery keywords for mutable
  agent graphs, bounded loops, and explicit workspace integration. Add npm links
  and version badges, distinguish 0.2 source from published 0.1.3, and align the
  roadmap and release checklist with the new execution contract
  ([#36](https://github.com/Epsirom/braid/pull/36)) — @Epsirom.
- Update `@types/node` from 22.20.2 to 22.20.4
  ([#17](https://github.com/Epsirom/braid/pull/17)) — @dependabot[bot].

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.1.3...v0.2.0).

## 0.1.3 — 2026-09-29

### Features and fixes

- Add per-node `workspace: "read-only" | "worktree"` for execute/decision nodes.
  Read-only nodes inspect the live source directory with Git inspection, without
  writable tools, snapshots, worktrees, or merge sources. Existing defaults are
  preserved. Pi's braid tool guides analysis/review/routing/synthesis to read-only
  nodes and implementation to worktrees; explicit read-only workspace metadata
  is included in results and events
  ([#28](https://github.com/Epsirom/braid/pull/28)) — @Epsirom.
- Skip the automatic merge agent when all remaining workspaces match their
  snapshots, preserving analysis-only terminal outputs and original node errors.
  Mixed runs pass only changed sources to the automatic merge. Unchanged sources
  retain recovery refs pointing to their snapshots without empty checkpoint
  commits; explicit merge nodes still run even for unchanged sources
  ([#27](https://github.com/Epsirom/braid/pull/27)) — @Epsirom.
- Prevent Pi TUI crashes in narrow terminals by truncating the flowchart fallback
  message to the terminal width
  ([#24](https://github.com/Epsirom/braid/pull/24)) — @powerfooI
  (**First-time contributor**).

### Maintenance

- Scan fork pull requests with CodeQL advanced setup so external contributions
  can satisfy the required security checks
  ([#25](https://github.com/Epsirom/braid/pull/25)) — @Epsirom.
- Make timeout coverage independent of workspace timing
  ([#26](https://github.com/Epsirom/braid/pull/26)) — @Epsirom.

### New Contributors

- Thanks to @powerfooI for their first contribution in
  [#24](https://github.com/Epsirom/braid/pull/24)!

[Full comparison](https://github.com/Epsirom/braid/compare/v0.1.2...v0.1.3).

## 0.1.2 — 2026-09-27

### Features and fixes

- Make Pi depend on the exact `@chrok/braid` version instead of bundling core.
  Export shared model-adapter helpers from the existing root entry point
  ([#19](https://github.com/Epsirom/braid/pull/19)) — @Epsirom.

### Build and release maintenance

- Use one npm workspace lockfile and a development-only local core link; test
  Pi-only installation against the unpublished core tarball outside the checkout
  ([#19](https://github.com/Epsirom/braid/pull/19)) — @Epsirom.
- Wait for core registry metadata and tarball availability before publishing Pi
  ([#19](https://github.com/Epsirom/braid/pull/19)) — @Epsirom.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.1.1...v0.1.2).

## 0.1.1 — 2026-09-27

### Features and fixes

- Clarify Pi tool and context guidance for parallel implementation and merge
  nodes; describe read-only filesystem access by the node's assigned workspace
  instead of assuming its directory is outside Git
  ([#15](https://github.com/Epsirom/braid/pull/15)) — @Epsirom.
- Trim OpenAI-compatible base URL trailing slashes in linear time, avoiding
  excessive regular-expression backtracking on long internal slash sequences
  ([#14](https://github.com/Epsirom/braid/pull/14)) — @Epsirom.

### Maintenance

- Validate the Pi integration against Pi 0.87.1; update GitHub Actions and tsx
  ([#16](https://github.com/Epsirom/braid/pull/16)) — @Epsirom.
- Group routine dependency updates and reserve Node/TypeScript major upgrades
  for deliberate compatibility changes across both packages
  ([#16](https://github.com/Epsirom/braid/pull/16)) — @Epsirom.
- Protect the main branch and version tags; document repository governance,
  CodeQL checks, Actions restrictions, and immutable releases
  ([#14](https://github.com/Epsirom/braid/pull/14)) — @Epsirom.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.1.0...v0.1.1).

## 0.1.0 — 2026-09-27

Initial public release. Publication is tracked in
[GitHub releases](https://github.com/Epsirom/braid/releases).

- Framework-independent DAG runtime with conditional decisions, bounded
  concurrency, explicit joins, failure propagation, and isolated node context
  ([initial commit](https://github.com/Epsirom/braid/commit/bdf4812f6844a415adcdaf53d83ac6f2ace63f2e))
  — @Epsirom (**First-time contributor**).
- Caller cancellation, node/graph deadlines, immutable events, partial results,
  model overrides, and provider-reported token accounting
  ([initial commit](https://github.com/Epsirom/braid/commit/bdf4812f6844a415adcdaf53d83ac6f2ace63f2e)) — @Epsirom.
- OpenAI-compatible Chat Completions runner with validated decision tool calls
  ([initial commit](https://github.com/Epsirom/braid/commit/bdf4812f6844a415adcdaf53d83ac6f2ace63f2e)) — @Epsirom.
- Pi background jobs, completion reminders, cancellation, guarded worker tools,
  and a live flow panel
  ([573a2a4](https://github.com/Epsirom/braid/commit/573a2a4c4b240ad29ce7ed7c2ef1d063187a49c8),
  [#4](https://github.com/Epsirom/braid/pull/4)). The Pi package includes the
  matching core runtime ([#5](https://github.com/Epsirom/braid/pull/5)) — @Epsirom.
- Core-managed Git worktrees, checkpoint/backup refs, agent-driven merge nodes,
  failure context on unconditional edges
  ([#4](https://github.com/Epsirom/braid/pull/4)), and optional Pi tool budgets
  with finite-budget reminders ([#3](https://github.com/Epsirom/braid/pull/3)) — @Epsirom.

### Packaging and maintenance

- Clean package builds, isolated tarball checks, CI for Node and supported
  operating systems, and an npm trusted-publishing workflow
  ([#5](https://github.com/Epsirom/braid/pull/5)) — @Epsirom.
- Install guides, runnable offline examples, compatibility and resource-limit
  documentation, scheduler benchmarks, and contribution/security policies
  ([#5](https://github.com/Epsirom/braid/pull/5)) — @Epsirom.

### New Contributors

- Thanks to @Epsirom for starting the project with the
  [initial commit](https://github.com/Epsirom/braid/commit/bdf4812f6844a415adcdaf53d83ac6f2ace63f2e)
  and contributing [#3](https://github.com/Epsirom/braid/pull/3),
  [#4](https://github.com/Epsirom/braid/pull/4), and
  [#5](https://github.com/Epsirom/braid/pull/5).

[Release history](https://github.com/Epsirom/braid/commits/v0.1.0).

Limitations: no persistent jobs, retries, token/spend budgets, streaming core
responses, graph mutation, nested runs, or sandboxing. See the roadmap and
resource-limit documentation before using it as a service.
