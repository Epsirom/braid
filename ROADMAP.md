# Roadmap

Braid is a small runtime for mutable agent graphs with bounded loops, isolated
executions, and explicit workspace integration. The goal is a predictable core
and thin host adapters. This is a direction for discussion, not a delivery schedule.

## Release status

The 0.3 workspace and Pi reliability changes are implemented on top of the 0.2
execution-control foundation. The 0.3.1 release adds DeepSeek Harness integration
and a native Web graph panel. Source availability and npm availability are
separate milestones. Check
[GitHub releases](https://github.com/Epsirom/braid/releases),
[@chrok/braid](https://www.npmjs.com/package/@chrok/braid),
[@chrok/pi-braid](https://www.npmjs.com/package/@chrok/pi-braid), and
[@chrok/dsh-braid](https://www.npmjs.com/package/@chrok/dsh-braid) for published versions.

## 0.3 implemented changes

- [x] Shell tools for writable Pi nodes, with cancellation and checkpoint write
  barriers; keep read-only nodes shell-free.
- [x] Git-aware checkpoints that preserve tracked changes and non-ignored files.
- [x] Pi completion/pause reminders between model steps, with actionable graph
  errors and complete focused status reads and exports.
- [x] Cumulative merge-source baselines and atomic update/retry guidance.
- [x] DeepSeek Harness integration with background graphs, isolated workers,
  live controls, native jobs, and completion/pause reminders.
- [x] Native DSH Web panel and tool cards for live graphs, execution history,
  outputs, usage, and controls, targeting DSH 0.2.0-rc.2.

Read the [0.2 → 0.3 migration guide](docs/compatibility.md#migrating-from-02-to-03)
for workspace capabilities and artifact preservation.

## 0.2 implemented foundation

- [x] Separate editable node definitions from captured execution instances,
  retaining exact predecessor identities, historical outputs, and checkpoints.
- [x] Bounded structured loops with explicit decision feedback, fresh workspaces
  per visit, finite iteration limits, and a total execution budget.
- [x] Revision-checked live updates, `pauseAfter` gates, and atomic update/resume.
- [x] Derive Git workspaces, including read-only workspaces, from predecessor
  checkpoints instead of reading the live caller checkout.
- [x] Separate isolated `merge` from source-checkout `integrate`; require explicit
  integration and preserve reusable source checkpoints until cleanup.
- [x] Optional invocation failures by default and captured `requireSuccess`
  fail-fast policy, with writes and cleanup drained before returning.
- [x] Submission-local prompt templates and execution-specific Pi reminders,
  result retrieval, live graph controls, and topology display.
- [x] Document the breaking changes and provide an offline loop/update example.

See [execution control](docs/execution-control.md) for the contract and
[0.1 → 0.2 migration](docs/compatibility.md#migrating-from-01-to-02) before upgrading.

Each release follows the [release checklist](docs/releasing.md): validate the
supported Node/platform matrix and isolated package installation, credit PR
authors and first-time contributors, then verify all registry versions,
provenance, and clean installation before marking publication complete.

## Next candidates

- Exercise real edit → review → refine → integrate tasks and use the results to
  improve migration examples, update-conflict diagnostics, and recovery guidance.
- Refresh scheduler measurements for the current execution model before
  optimizing data structures. Include execution history, updates, and loops;
  measure Git workspace costs separately. The [checked-in benchmark](docs/benchmark.md)
  is a 0.1 baseline.
- Explore explicit retention and cleanup policies for execution history, Git
  recovery refs, and Pi temporary result files without breaking result retrieval,
  reusable checkpoints, or usage accounting.
- Discuss definition, prompt/output, and event-log size limits and host-wide
  admission controls. `maxExecutions` already bounds materialized instances;
  it does not bound all memory, disk, or concurrent jobs.
- Define token/spend budget semantics that account for missing usage, failed
  requests, and in-flight calls before adding enforcement.
- Improve provider diagnostics and add adapters backed by real compatibility
  tests. Keep SDK dependencies outside the core.
- Migrate all packages from TypeScript 5 to 7 in one dedicated change. Explicitly
  load Node types, review compiler default changes, and validate public declaration
  consumption, package builds, and the complete Node/platform matrix. Keep Node
  declarations on 22.x while Node 22 remains the minimum supported runtime.

## Scope after 0.3

The original fixed-DAG-only boundary no longer applies. Bounded loops, live
graph changes, parent-controlled pause/resume, and execution history are part of
the core. The following boundaries still apply:

| Supported | Outside the current scope |
| --- | --- |
| Declared loops with finite limits; sequential and independent loops | Arbitrary cycles and nested/overlapping loops |
| In-memory updates and pause/resume before finalization | Durable workflow recovery, restart/resume, or reopening finalized jobs |
| Git checkpoints and backup refs for inspecting/recovering files | Persistence of scheduler state or host sessions |
| Per-execution workspace capabilities and isolated model context | A security sandbox, arbitrary code nodes, or recursive worker delegation |
| Submission-local templates and host tools/panels | A saved template registry or graphical workflow editor |

New proposals should explain why the behavior belongs in the core rather than
the caller or host adapter. Useful contributions include minimal reproductions,
platform testing, real-world examples, and documentation fixes. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## 0.1 release foundation

- [x] Deterministic validation, scheduling, decisions, cancellation, and events.
- [x] OpenAI-compatible runner and Pi background-job integration.
- [x] Core-managed worktrees, recovery refs, merge agents, and Pi tool budgets.
- [x] Clean builds and standalone package installation checks.
- [x] CI configuration, contribution policies, examples, and compatibility docs.
- [x] Reproducible scheduler benchmark and explicit resource limits.
- [x] Hosted CI on Linux, macOS, Windows, and the minimum Node version.

These are historical milestones; the 0.2 contracts above supersede the original
workspace, failure, and graph-lifecycle assumptions.
