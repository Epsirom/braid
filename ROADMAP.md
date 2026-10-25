# Roadmap

Braid is a small runtime for mutable agent graphs with cycles, isolated
executions, and explicit workspace integration. The goal is a predictable core
and thin host adapters, with runs that can keep going until their owner stops
them. This is a direction for discussion, not a delivery schedule.

## Release status

The 0.3 workspace and Pi reliability changes are implemented on top of the 0.2
execution-control foundation. The 0.3.1 release adds DeepSeek Harness integration
and a native Web graph panel. The 0.3.2 release adds Pi editor progress, focused
node details, and a bounded parallel review command. The 0.3.3 release adds live
per-execution activity and read-only Pi node sessions. The 0.3.4 release adds a Pi
panel assistant that can message running executions, and `/braid:clear`. The 0.3.5
release returns plain-text Braid tool results and runs DSH workers on DSH's own
file and shell tools. The 0.3.6 release adds experimental opt-in Pi blocking
execution for single-shot runs, with CLI and session controls. The 0.4.0 release
makes Pi print and JSON runs wait for background jobs, adds `braid_finish` for
run outcomes, and deprecates blocking mode. The 0.5.0 release adds running-execution
pause/resume, result holds, timeout recovery, Pi model retries, and clearer loop
handoffs, and removes deprecated Pi blocking mode. The 0.5.1 release lets running
nodes ask the parent agent to replan, and makes Pi and DSH fail fast on a
mismatched core version. The 0.5.2 release wakes the parent agent when a graph
has no active work left but paused work remains. Source availability
and npm availability are separate milestones. Check
[GitHub releases](https://github.com/Epsirom/braid/releases),
[@chrok/braid](https://www.npmjs.com/package/@chrok/braid),
[@chrok/pi-braid](https://www.npmjs.com/package/@chrok/pi-braid), and
[@chrok/dsh-braid](https://www.npmjs.com/package/@chrok/dsh-braid) for published versions.

## Milestones

Current work is grouped into [GitHub milestones](https://github.com/Epsirom/braid/milestones).
Each has a tracking issue or a short list of issues; releases are cut from
whatever has landed, so the milestones are not tied to version numbers.

### RSI Mode

Let a run keep refining, evaluating, and improving its own output until its
owner stops it. Safety comes from observability and owner control (holds,
pauses, reminders) instead of hard limits that fail the job. Tracking issue:
[#118](https://github.com/Epsirom/braid/issues/118).

- [x] Default every limit to unlimited, and hold or pause instead of failing
  when a limit that is set is reached ([#112](https://github.com/Epsirom/braid/issues/112)).
- [ ] Replace the schedule/execution split with an execution-only graph of
  lineages, where a started node is changed by replacing it ([#113](https://github.com/Epsirom/braid/issues/113)).
- [ ] Accept unconditional, nested, and overlapping cycles ([#114](https://github.com/Epsirom/braid/issues/114)).
- [ ] Show lineage heads and the full execution history in one Pi graph ([#94](https://github.com/Epsirom/braid/issues/94)).
- [ ] Persist run state and recover runs after a restart ([#115](https://github.com/Epsirom/braid/issues/115)).
- [ ] Keep memory and disk bounded in long-running runs ([#116](https://github.com/Epsirom/braid/issues/116)).
- [ ] Consume outputs from runs that never finish ([#117](https://github.com/Epsirom/braid/issues/117)).
- [ ] Let the owner detach from and reattach to a long run, with summarized
  reminders, and decide whether some nodes may change the graph themselves ([#66](https://github.com/Epsirom/braid/issues/66)).

### Zen Mode

Make the Braid graph the primary workspace: the main agent and the user both
edit and run the same live graph, and nodes open as sessions. Tracking issue:
[#57](https://github.com/Epsirom/braid/issues/57).

- [x] Send prompts to a running node from its session view ([#59](https://github.com/Epsirom/braid/issues/59)).
- [ ] Decide how Pi and DSH can show the graph as the primary, non-modal view
  while the main agent stays reachable.
- [ ] Keep jobs open for more work, or continue from a finished job.
- [ ] Record who changed the graph, and tell the main agent about changes it did
  not make.
- [ ] Create, connect, and run nodes from the Pi and DSH graph views.
- [ ] Persist node sessions as session files in Pi and DSH ([#63](https://github.com/Epsirom/braid/issues/63), [#64](https://github.com/Epsirom/braid/issues/64)),
  with storage and retention rules ([#65](https://github.com/Epsirom/braid/issues/65)).

Durable run state ([#115](https://github.com/Epsirom/braid/issues/115)) serves both RSI Mode and Zen Mode.

### CI Mode

Run Braid in single-shot and CI environments, such as `pi -p`, without giving
up its asynchronous execution model.

- [x] Pi print and JSON runs drain background jobs before exiting and report the
  outcome with `braid_finish` ([#80](https://github.com/Epsirom/braid/issues/80)).
- [ ] Find out whether DSH single-shot runs exit before Braid jobs finish, and
  match Pi's behavior if they do ([#85](https://github.com/Epsirom/braid/issues/85)).

## 0.5 implemented changes

- [x] Pause and resume running executions or whole jobs, preserving their work.
- [x] Hold a running execution's result after it finishes, with Pi/DSH controls.
- [x] Pause interruptible executions on node timeout, renew their budget on
  resume, or cancel individual executions; retain `onNodeTimeout: "fail"`.
- [x] Retry transient Pi model errors inside the same execution.
- [x] Distinguish forward loop handoffs from retry edges in Pi charts.
- [x] Remove Pi blocking mode, including its CLI flag and session command.
- [x] Let running nodes report findings and ask the parent agent to replan.
- [x] Fail fast in Pi and DSH when the loaded core version does not match.
- [x] Wake the parent agent when a graph waits on paused work with nothing active.

Read the [0.4 → 0.5 migration guide](docs/compatibility.md#migrating-from-04-to-05)
for timeout behavior and TypeScript interface changes.

## 0.4 implemented changes

- [x] Pi print and JSON runs drain background jobs before exiting, with a
  paused-execution warning, cancellation, and `--braid-ci-timeout`.
- [x] `braid_finish` for explicit single-shot run outcomes and exit status.
- [x] Deprecate Pi blocking mode for removal in 0.5.0.

Read the [0.3 → 0.4 migration guide](docs/compatibility.md#migrating-from-03-to-04)
if you embed Pi through its SDK or use blocking mode.

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
- [x] Automatic Pi editor progress and a live panel for individual nodes or executions.
- [x] Bounded Pi parallel review/fix command with review-only requests and isolated fixes.
- [x] Live per-execution activity in core, Pi, and DSH, plus read-only Pi node sessions.
- [x] Pi panel assistant that can message running executions, recorded as human input.
- [x] Plain-text Braid tool results in Pi and DSH, and DSH workers on DSH's native tools.
- [x] Experimental opt-in Pi blocking execution with CLI and session controls.

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
supported Node/platform matrix and isolated package installation, publish upgrade
notes with release notes generated from labeled PRs, then verify all registry
versions, provenance, and clean installation before marking publication complete.

## Next candidates

- Exercise real edit → review → refine → integrate tasks and use the results to
  improve migration examples, update-conflict diagnostics, and recovery guidance.
- Refresh scheduler measurements for the current execution model before
  optimizing data structures. Include execution history, updates, and loops;
  measure Git workspace costs separately. The [checked-in benchmark](docs/benchmark.md)
  is a 0.1 baseline.
- Extend the retention work for long runs ([#116](https://github.com/Epsirom/braid/issues/116)) to Pi temporary result
  files without breaking result retrieval, reusable checkpoints, or usage
  accounting.
- Discuss definition, prompt/output, and event-log size limits and host-wide
  admission controls. Limits are unlimited by default; when set, `maxExecutions`
  and `maxTokens` bound materialized instances and reported tokens, but nothing
  bounds all memory, disk, or concurrent jobs.
- Complete the `maxTokens` semantics for missing usage, failed requests, and
  in-flight calls, and consider spend-based budgets.
- Improve provider diagnostics and add adapters backed by real compatibility
  tests. Keep SDK dependencies outside the core.
- Migrate all packages from TypeScript 5 to 7 in one dedicated change. Explicitly
  load Node types, review compiler default changes, and validate public declaration
  consumption, package builds, and the complete Node/platform matrix. Keep Node
  declarations on 22.x while Node 22 remains the minimum supported runtime.

## Scope after 0.3

The original fixed-DAG-only boundary no longer applies. Loops, live graph
changes, parent-controlled pause/resume, and execution history are part of the
core. The following boundaries still apply. RSI Mode and Zen Mode deliberately
revisit some of them: arbitrary and nested cycles ([#114](https://github.com/Epsirom/braid/issues/114)), durable recovery
and scheduler persistence ([#115](https://github.com/Epsirom/braid/issues/115)), nodes that change the graph ([#66](https://github.com/Epsirom/braid/issues/66)), and a
graphical workflow editor ([#57](https://github.com/Epsirom/braid/issues/57)). Each row changes when that work lands.

| Supported | Outside the current scope |
| --- | --- |
| Cycles closed by a decision's choice edge, with optional edge limits; sequential and independent cycles | Other cycles, and nested/overlapping cycles |
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
