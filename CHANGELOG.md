# Changelog

## Unreleased

### Features

- Core exports `BRAID_VERSION`.

### Fixes

- Pi and DSH check the loaded core version when they load and when they create
  a runner. With a mismatched core, such as one kept by a Pi process started
  before an upgrade, they fail with both versions and upgrade and restart
  guidance instead of failing every node with `MODEL_ERROR: (0 ,
  _braid.isStepInterrupted) is not a function` after its first model response
  (closes [#102](https://github.com/Epsirom/braid/issues/102)) — @Epsirom.

## 0.5.0 — 2026-10-20

### Breaking changes

- `startBraid` pauses an execution that exceeds `nodeTimeoutMs` instead of
  failing it, when its runner is interruptible. This includes the
  OpenAI-compatible adapter, so with core's default 60-second node timeout a
  slow execution now waits to be resumed or cancelled, and a run that never does
  ends with `GRAPH_TIMEOUT`. Pass `onNodeTimeout: "fail"` to keep the old
  behavior. `braid()`, custom runners that are not interruptible, and Pi and DSH
  jobs without a `nodeTimeoutMs` are unchanged. See
  [compatibility](docs/compatibility.md#pausing-on-node-timeout-050)
  ([#99](https://github.com/Epsirom/braid/pull/99), closes
  [#68](https://github.com/Epsirom/braid/issues/68)) — @Epsirom.
- Remove Pi blocking mode, including `--braid-blocking`, the `/braid:blocking`
  session command, foreground waiting/cancellation, and reminder suppression.
  Drop the flag or command: print and JSON runs already wait for background
  jobs, and `braid_finish` reports the run outcome. Session-command removal was
  implemented in [#92](https://github.com/Epsirom/braid/pull/92); the remaining
  mode is removed in [#100](https://github.com/Epsirom/braid/pull/100) — @Epsirom.

### Features

- Pi nodes retry transient model errors, such as HTTP 429 rate limits, overload,
  5xx responses, and dropped streams, inside the running execution instead of
  failing the node. The conversation, completed tool calls, workspace, and tool
  budgets are kept, and completed tools are not run again. Requests rejected
  before a response starts are retried by Pi's provider client, which honors
  `Retry-After`; streams that fail after starting are restarted by Braid with
  exponential backoff. Retries stop at cancellation and node/graph deadlines.
  Set `options.maxModelRetries` (default 3, `0` disables) to change the limit
  ([#93](https://github.com/Epsirom/braid/pull/93)) — @Epsirom.
- Running executions can be paused and resumed without losing their work
  ([#67](https://github.com/Epsirom/braid/issues/67)). A paused execution stops
  before its next model request, keeps its conversation, workspace, and tool
  budgets, and releases its concurrency slot; resuming continues the same
  conversation. A whole run can be paused too: no new executions start and
  running ones pause. The node timeout stops while suspended; the graph timeout
  keeps running. Core adds `BraidRun.pause`, `pauseRun`, and `resumeRun`,
  `resume` for suspended executions, the `request.checkpoint()` runner hook with
  the `pausable` runner flag, and new events. The Pi, DSH, and OpenAI-compatible
  runners support it. Pi and DSH add `braid_pause`, panel controls (Pi `/braid`
  key `p`; DSH **Pause job** and **Pause this execution**), and `braid_resume({ jobId })`
  for a paused job. A pause by the user does not wake the parent; it gets a
  notice with its next turn, which asks it not to resume unless the user asks.
  In Pi print mode, a job held only by pauses is stalled: one warning, then
  cancellation. See [compatibility](docs/compatibility.md#pausing-running-executions-050)
  for type-level changes such as new event types
  ([#96](https://github.com/Epsirom/braid/pull/96)) — @Epsirom.
- The result of an execution that is already running can be held once it
  finishes, like `pauseAfter`, without cancelling it or editing edges
  ([#95](https://github.com/Epsirom/braid/issues/95)). `pauseAfter` is captured
  at admission, so this covers a decision made while a node runs, including one
  whose final model request is already in flight. Core adds
  `BraidRun.holdAfter(executionIds, hold, { source })`, which also removes a hold,
  including one from `pauseAfter`, for that execution only. Executions carry
  `holdAfter`, and the `execution_hold_added`/`execution_hold_removed` events
  record changes. Pi and DSH add `after: true` to `braid_pause` (hold) and
  `braid_resume` (remove the hold), plus panel controls (Pi `/braid` key `h`;
  DSH **Hold result when finished** and **Remove hold**). Holds made by the user
  reach the parent as notices, like pauses
  ([#98](https://github.com/Epsirom/braid/pull/98)) — @Epsirom.
- A node timeout pauses the execution instead of failing it
  ([#68](https://github.com/Epsirom/braid/issues/68)). Core interrupts the
  current model request or tool call and suspends the execution with its
  conversation, workspace, and tool budgets; the interrupted step is recorded in
  the conversation. Resume it with a new time budget
  (`resume(ids, revision, { nodeTimeoutMs })` or `update({ resume, resumeOptions })`;
  by default it gets `nodeTimeoutMs` again), or fail only that execution with the
  new `BraidRun.cancelExecutions`. Set `onNodeTimeout: "fail"` to fail instead.
  Runners opt in with `interruptible: true` and `request.stepSignal()`; the Pi,
  DSH, and OpenAI-compatible runners do. In Pi and DSH, a timeout pause wakes the
  parent with a reminder that says how long the execution ran, what it was
  doing, and how to resume or cancel it; `braid_cancel` takes `executionIds`,
  `braid_resume` takes `nodeTimeoutMs`, and the panels can cancel a single
  execution (Pi `/braid` key `x`; DSH **Cancel this execution**)
  ([#99](https://github.com/Epsirom/braid/pull/99)) — @Epsirom.

### Fixes

- Pi loop charts draw forward handoffs opposite a retry edge dotted and keep
  the feedback edge solid, distinguishing the two directions in `/braid:review`
  and user-defined graphs with the same shape. All dependencies remain visible,
  and runtime handoffs are unchanged
  ([#91](https://github.com/Epsirom/braid/pull/91)) — @powerfooI.

### Maintenance

- Bound suspension-test waits by elapsed time and widen Pi CLI test timeouts
  for slower CI workers
  ([#97](https://github.com/Epsirom/braid/pull/97),
  [#88](https://github.com/Epsirom/braid/pull/88)) — @Epsirom.
- Allow timer granularity in timeout-pause duration assertions across core, Pi,
  and DSH ([#100](https://github.com/Epsirom/braid/pull/100)) — @Epsirom.

See the [0.4 → 0.5 migration guide](docs/compatibility.md#migrating-from-04-to-05)
for the timeout policy, removed blocking mode, and TypeScript interface changes.
Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested host versions; integrations require
Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.4.0...v0.5.0).

## 0.4.0 — 2026-10-16

### Features and breaking changes

- Pi print and JSON modes (`pi -p`, `--mode json`) keep background execution
  and stay open until every Braid job finishes and its reminder is delivered, so
  single-shot runs no longer exit before their graphs complete. The parent
  submits, ends its turn, and continues from the reminder; `pauseAfter`,
  reminders, `braid_update`, and `braid_resume` keep working. If only paused
  executions remain when the parent ends its turn, it gets one warning; ending
  the next turn without resuming them cancels their jobs and exits 1.
  `--braid-ci-timeout <duration>` bounds the whole run the same way
  ([#82](https://github.com/Epsirom/braid/pull/82)) — @Epsirom.
- **Breaking for Pi SDK hosts:** Pi SDK sessions default to print mode, so
  `session.prompt()` now returns only after outstanding Braid jobs drain. Hosts
  that stay running and want reminders to start new runs after settling should
  bind with another mode, such as `session.bindExtensions({ mode: "rpc" })`
  ([#82](https://github.com/Epsirom/braid/pull/82)) — @Epsirom.
- In Pi print and JSON modes, the parent can call `braid_finish` with
  `status` (`success` or `failure`) and a `summary` to report the run outcome.
  A final `failure` exits 1; `success` never masks a forced cancellation. JSON
  mode records the outcome as a `braid-finish` custom entry
  ([#83](https://github.com/Epsirom/braid/pull/83)) — @Epsirom.

See the [0.3 → 0.4 migration guide](docs/compatibility.md#migrating-from-03-to-04)
before upgrading if you embed Pi through its SDK or use blocking mode. CLI users
of `pi -p` need no changes. Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested host
versions; integrations require Node.js 22.19+. DSH behavior is unchanged; whether
DSH has the same single-shot problem is tracked in
[#85](https://github.com/Epsirom/braid/issues/85).

### Deprecations

- Pi blocking mode (`--braid-blocking`, `/braid:blocking`) is deprecated and
  will be removed in 0.5.0. Print and JSON runs now wait for background jobs
  and keep `pauseAfter`, reminders, and live updates, and `braid_finish` sets
  the exit status; drop the flag or command to migrate. Using either prints a
  one-time warning, on stderr in print/JSON mode or as a UI notice
  ([#84](https://github.com/Epsirom/braid/pull/84)) — @Epsirom.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.6...v0.4.0).

## 0.3.6 — 2026-10-15

### Features

- Pi supports experimental opt-in blocking execution with `--braid-blocking` and the session
  command `/braid:blocking [on|off]`. Blocking tool calls wait for the graph and
  workspace cleanup before returning final results, emit an initial progress
  update, and suppress completion reminders except for cancellation. Stopping the
  foreground response cancels its work and leaves a reminder for partial results.
  Wait/result retrieval failures preserve the existing job handle and usage so
  the graph does not need to be resubmitted. Background execution remains the
  default; session switches affect only new tool calls. Blocking mode may change
  or be replaced by an async-preserving CI mode ([#80](https://github.com/Epsirom/braid/issues/80))
  ([#79](https://github.com/Epsirom/braid/pull/79)) — @powerfooI.

No breaking API changes or migration from 0.3.5 are required. Blocking mode
rejects `pauseAfter: true`, which requires a later resume call, and a failed
graph does not by itself set Pi's process exit code; inspect the returned job
status for CI pass/fail decisions. Pi 1.2.0 and DSH 0.2.0-rc.2 remain the tested
host versions; integrations require Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.5...v0.3.6).

## 0.3.5 — 2026-10-14

### Changes

- DSH workers now use DSH's own `read`, `write`, `edit`, `glob`, `grep`, and
  `bash` tools (`pwsh` on Windows) instead of Braid's reimplementations, so
  their schemas, guidance, and results match the parent agent's: line-numbered
  `read` with `offset`/`limit`, `[stderr]` and `[exit code: N]` markers from
  `bash`, and no JSON-encoded results. `ls` and `find` are replaced by `glob`,
  and DSH's read-before-write policy applies. Each execution runs the tools in a
  private context with local providers rooted at its workspace; Braid keeps its
  write boundary, live shell output, and cleanup of leftover processes before
  the checkpoint. `@chrok/dsh-braid` gains peer dependencies on these DSH
  packages ([#75](https://github.com/Epsirom/braid/pull/75)) — @Epsirom.

- Braid tools no longer return JSON strings to the model. In Pi and DSH,
  `braid`, `braid_status`, `braid_update`, and `braid_resume` return plain-text
  documents: update results list the resulting graph without prompts; a
  whole-job status lists control state, executions, outputs, workspaces, and
  the current graph; a focused read shows one execution's output and activity.
  Control fields (graph status, revision, paused execution IDs) always come
  first. Text over 50 KB is truncated and the complete text is saved to a
  private file; the JSON result and snapshot files are gone. Worker `git`
  results read like the host's bash output, and `decide` returns
  `Recorded choice: <choice>`, also in the OpenAI-compatible adapter. DSH tool
  values become `{ text, ... }` with only identifiers beside the text, which the
  Web client reads from presentation meta; recorded sessions with JSON results
  still link correctly ([#77](https://github.com/Epsirom/braid/pull/77)) — @Epsirom.

- Pi and DSH tell the parent agent more directly how waiting for a Braid job
  works. The `braid` and `braid_status` descriptions, the system prompt, and
  the submission receipt say that the job keeps running after the turn ends and
  that a reminder resumes the agent when it finishes. They tell the agent to
  continue independent work, or end its turn if it needs the result, and not to
  sleep, use a timer, or poll in a loop to wait for the job. The `braid`
  receipt is now just the job ID and this guidance: it no longer repeats the
  graph the agent submitted, and the system prompt no longer asks the agent to
  check it ([#74](https://github.com/Epsirom/braid/pull/74), closes
  [#73](https://github.com/Epsirom/braid/issues/73)) — @Epsirom.

### Maintenance

- Pi 1.2.0 is now the pinned Pi validation target, replacing 1.0.1. The Pi
  integration needed no code changes, and its peer dependencies stay `*`. On
  Pi 1.2.0, runs started by Braid's completion reminders also receive the Braid
  execution policy in their system prompt, because Pi now fires
  `before_agent_start` for them
  ([#76](https://github.com/Epsirom/braid/pull/76)) — @Epsirom.
- The package smoke test (`npm run test:package`) failed after
  `@earendil-works/pi-codemode` 1.2.0 removed `MCP_TYPESCRIPT_PREAMBLE`, which
  `@earendil-works/pi-coding-agent` 1.0.1 still imports through its `^1.0.1`
  range. The smoke consumer now holds Pi's transitive packages at the versions
  in `package-lock.json`, so a later Pi sibling release can no longer change
  what it tests. Published packages are unchanged
  ([#76](https://github.com/Epsirom/braid/pull/76)) — @Epsirom.

No breaking core API changes or migration from 0.3.4 are required. Code that
parsed the JSON text of Braid tool results, or read the JSON result and
snapshot files they saved, must read the plain-text documents instead.
`@chrok/dsh-braid` adds peer dependencies on DSH's file and shell tool packages
at 0.2.0-rc.2. Pi 1.2.0 and DSH 0.2.0-rc.2 are the tested host versions;
integrations require Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.4...v0.3.5).

## 0.3.4 — 2026-10-11

### Features

- Add the Pi `/braid:clear` command, which clears the progress widget above the
  editor. Jobs submitted afterwards still appear; running the command again
  while the widget is empty restores the most recently cleared jobs
  ([#70](https://github.com/Epsirom/braid/pull/70)) — @Epsirom.
- Add an assistant to the Pi `/braid` panel, toggled with Tab. On the graph it
  talks about the whole job; with a node selected or its session open, it uses
  that node's own conversation, shared by the node's executions. It reads job
  status, execution details and activity, and worker conversations, and does
  not see the main conversation. Asked to
  steer a running execution, it messages that execution; the message waits as
  pending and is delivered before the worker's next model request, never
  interrupting a running tool, and a message that arrives during the final
  answer gets one more round. Delivered messages are marked as human input in
  the session, the activity history, the event log (`human_input`), and the
  execution result (`humanInputs`); messages still pending when the execution
  ends are shown as not delivered. The assistant cannot edit the graph, cancel,
  or resume. In fullscreen Pi, the mouse wheel scrolls the conversation and the
  graph or node session ([#69](https://github.com/Epsirom/braid/pull/69),
  closes [#59](https://github.com/Epsirom/braid/issues/59)) — @Epsirom.
- Core adds `ModelRequest.recordHumanInput`, `NodeResult.humanInputs`, the
  `human_input` event, and the `human_input` activity entry kind, so any adapter
  can record human messages delivered to a running worker. These are additive;
  exhaustive switches over event types or activity kinds need a new case
  ([#69](https://github.com/Epsirom/braid/pull/69)) — @Epsirom.

### Fixes

- On Windows, a shell command that timed out or was cancelled could report a
  `taskkill` error instead, when one of its child processes exited while the
  process tree was being stopped. Pi and DSH shell tools now report the timeout
  or cancellation, and fail only if the shell itself survives
  ([#69](https://github.com/Epsirom/braid/pull/69)) — @Epsirom.

No breaking API changes or migration from 0.3.3 are required; consumers with
exhaustive switches over `ExecutionEvent["type"]` or activity entry kinds need a
`human_input` case. Pi 1.0.1 and DSH 0.2.0-rc.2 remain the tested host versions;
integrations require Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.3...v0.3.4).

## 0.3.3 — 2026-10-09

### Features

- Show live per-execution activity so long-running nodes can be diagnosed while
  they run: current phase and time in it, time since the last observed signal,
  total time, the in-flight model request and its stream state, running tools
  with arguments and latest output, and a bounded chronological history of model
  requests/responses, assistant text, tool calls/results, workspace changes, and
  completion. Histories are keyed by execution ID, so repeated loop visits do not
  mix. Pi shows it in `/braid <jobId> <nodeId|executionId>` and focused
  `braid_status` reads; DSH shows it in the Braid Web panel, `/braid`, the Jobs
  progress line, and focused `braid_status` reads. Both status tools accept
  `activityBefore` to page earlier history. Hosts list signals they cannot
  observe, and quiet periods are never reported as stalls. The core exports the
  host-neutral `ExecutionActivityTracker` and `formatActivityStatus` helpers.
  Pi worker model calls now stream through the registry when available (the same
  request as `complete()`); execution semantics are unchanged
  ([#60](https://github.com/Epsirom/braid/pull/60)) — @Epsirom.
- Press `v` in the Pi `/braid` panel to select a node with the arrow keys, and
  Enter to open its live session, drawn with Pi's own chat components: prompt,
  streamed text and thinking, and tool cards with live output, below a pinned
  node summary. Left/Right switch
  invocations of the node, ctrl+o expands tool output, and Escape steps back one
  level. `/braid <jobId> <node|execution>` opens the session directly. Sessions
  are read-only ([#60](https://github.com/Epsirom/braid/pull/60)) — @Epsirom.
- Crop Pi flowcharts wider than the terminal to a window around the selected or
  running node instead of hiding them; selection also scrolls tall charts to the
  selected node. Flowchart renderer failures no longer break the panel
  ([#60](https://github.com/Epsirom/braid/pull/60)) — @Epsirom.

### Changes

- In the Pi `/braid` panel, Escape and Backspace now step back one level instead
  of jumping from a node straight to the graph, and Left/Right in a node view
  switch invocations of that node instead of jobs. Narrow terminals show a
  cropped flowchart instead of a "Flowchart needs N columns" message
  ([#60](https://github.com/Epsirom/braid/pull/60)) — @Epsirom.

No API changes or migration from 0.3.2 are required. Pi 1.0.1 and DSH 0.2.0-rc.2
remain the tested host versions; integrations require Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.2...v0.3.3).

## 0.3.2 — 2026-10-09

### Features

- Show Pi background-job progress automatically above the input editor, including
  active nodes, paused gates, failures, and retained final status. Keep running
  executions visible after live edits remove their node definitions; use `/braid`
  for the full flow panel
  ([#52](https://github.com/Epsirom/braid/pull/52)) — @powerfooI.
- Add Pi `/braid:review [target or focus]`: three parallel reviewers, narrow fixes in
  isolated worktrees, and at most three review rounds before summarizing and
  integrating reviewed fixes
  ([#53](https://github.com/Epsirom/braid/pull/53)) — @powerfooI.
- Add `/braid <jobId> <nodeId|executionId>` to open the Pi panel on one node's
  latest or exact invocation, with live status, elapsed time, token and context
  usage, tool calls, workspace, and full output or error. Backspace returns to
  the graph; Tab completes job handles and node IDs. Focused `braid_status`
  results show the same details at the time of the read
  ([#54](https://github.com/Epsirom/braid/pull/54)) — @powerfooI.

### Fixes

- Escape terminal controls in Pi node completions and preserve exact node IDs
  containing leading/trailing whitespace or quotes with JSON string syntax
  ([#54](https://github.com/Epsirom/braid/pull/54)) — @powerfooI.

### Maintenance

- Update esbuild and keep the DSH integration on its React 18 baseline
  ([#47](https://github.com/Epsirom/braid/pull/47)) — @dependabot[bot].

No migration from 0.3.1 is required. Pi 1.0.1 and DSH 0.2.0-rc.2 remain the
tested host versions; integrations require Node.js 22.19+.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.1...v0.3.2).

## 0.3.1 — 2026-10-04

### Features

- Add the `@chrok/dsh-braid` DeepSeek Harness plugin with background graphs,
  isolated workers, revision-checked updates, pause/resume, cancellation, and
  completion reminders through DSH's native model, tool, and job services
  ([#45](https://github.com/Epsirom/braid/pull/45)) — @Epsirom.
- Add a native DSH Web panel with live graphs, execution history, paged outputs,
  usage, and controls. Braid tool cards preserve recorded operation summaries
  and open the corresponding job, node, or execution in the live panel
  ([#45](https://github.com/Epsirom/braid/pull/45)) — @Epsirom.

DSH 0.2.0-rc.2 and Node.js 22.19+ are the tested integration baseline. DSH is
in developer preview, so its host peer dependencies are pinned. This release
preserves the existing core and Pi contracts; no migration from 0.3.0 is required.
Pi 1.0.1 remains the pinned Pi validation target.

### Documentation

- Introduce Braid with a parallel code-review example and clear installation
  paths, moving release history, migration links, and source setup later in the README
  ([#44](https://github.com/Epsirom/braid/pull/44)) — @Epsirom.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.3.0...v0.3.1).

## 0.3.0 — 2026-10-04

### Features and breaking changes

- Give writable Pi nodes built-in shell tools for dependency installation, builds,
  tests, and repair. Shell calls participate in cancellation and the workspace
  write barrier before checkpointing; prompts describe workspace boundaries and
  shared resources. Read-only nodes still have no shell, and parent extension/MCP
  tools are not inherited
  ([#41](https://github.com/Epsirom/braid/pull/41)) — @Epsirom.
- Checkpoint tracked changes and non-ignored new files using normal Git staging
  semantics. Ignored dependencies, caches, and build outputs are no longer
  automatically archived or passed to successors; already tracked and deliberately
  force-added files remain tracked
  ([#41](https://github.com/Epsirom/braid/pull/41)) — @Epsirom.

See the [0.2 → 0.3 migration guide](docs/compatibility.md#migrating-from-02-to-03)
before upgrading if you rely on shell-free workers or preservation of ignored
outputs. Use read-only nodes or a custom runner to restrict worker capabilities,
and keep successor artifacts in non-ignored or deliberately tracked paths.

### Fixes

- Include `changes.baseCommit` in merge-source previews and explain cumulative
  diffs versus invocation snapshots. Read-only review checkpoints can otherwise
  suggest an empty patch; multi-parent checkpoints also need an explicit
  strategy instead of a bare cherry-pick
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Display Pi submission and status errors even when the host supplies empty
  result details; failed graph definitions no longer appear as background jobs
  with an undefined ID/status. Validation errors identify offending nodes/edges
  and explain how to declare feedback cycles
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Clarify Pi node requirements, loop/template parameters, and revision controls
  while retaining a flat provider-facing node schema with type-specific core
  validation. Restrict historical execution pins to updates. Submission/update
  replies echo accepted graph types and policies
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Deliver Pi completion/pause reminders at the next model step using steering,
  after the current tool batch, instead of queuing follow-ups behind the entire
  foreground task. Clarify that pause reminders need a current-state check
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Explain atomic update failures and retrying complete patches: new nodes and
  their edges/loops must be submitted together to avoid starting disconnected
  roots while another execution is paused. Discourage repeated replacement jobs
  when a definition problem recurs
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Show the requested execution's output/error in focused Pi status reads and
  include the current revision and paused IDs, separately from its captured
  revision. Preserve this rendering for older saved Pi sessions
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Keep errors, control fields, and Pi usage ahead of large status payloads;
  save complete running snapshots and include failed-worker provider usage as
  `piUsage` in exported final results
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.
- Update live status on graph completion/failure and clear resumable pause IDs
  when finalizing, while retaining pause history in the event log. Loop
  validation now names feedback targets and edges that bypass the loop entry
  ([#42](https://github.com/Epsirom/braid/pull/42)) — @Epsirom.

### New Contributors

No first-time human contributors in this release.

[Full comparison](https://github.com/Epsirom/braid/compare/v0.2.1...v0.3.0).

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
