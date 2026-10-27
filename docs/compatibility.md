# Compatibility and stability

| Surface | Supported / tested contract |
| --- | --- |
| Core runtime | Node.js 22+, ESM imports, TypeScript declarations, no runtime dependencies |
| Pi package | Node.js 22.19+, Pi 1.2.0 is the pinned validation target |
| DSH package | Node.js 22.19+, DeepSeek Harness 0.2.0-rc.2 is the pinned developer-preview host target; native Web panel |
| CI | Core minimum Node 22.0; all three packages on Node 22.19 and 24 on Linux, macOS, Windows |
| OpenAI-compatible runner | Chat Completions text and function-tool calls; decisions and merge/integrate nodes require tool calling |
| Browsers / CommonJS | No standalone core browser build or CommonJS entry point in 0.5; the DSH `./client` export is loaded by DSH's Web host |

The CI matrix describes configured checks; see actual workflow results for each
commit. Offline HTTP fixtures validate the adapter contract. They do not prove
that every provider advertising OpenAI compatibility supports its tool schema.
Run a small opt-in live test with your chosen provider before relying on it.

Pi's upstream packaging guide requires `*` peer dependencies for packages the
host provides. Braid follows that convention and pins dev dependencies to 1.2.0.
The wildcard is a loader/distribution convention, **not a claim that every Pi
version works**. Test the whole Pi suite before updating the supported target.
The offline host compatibility test loads the extension into a real Pi session
with an in-memory model provider. It checks worker prompt/tool normalization and
reminder delivery between model steps after the current tool batch, idle
continuation, and acknowledgement, including retrieval of a node output while
its job still runs. These fixtures run without provider credentials or network
model calls. Version 0.1.0 was originally validated with
Pi 0.85.1; the current checkout's pinned validation target is 1.2.0.
The Pi npm package declares an exact dependency on the matching `@chrok/braid`
release. npm installs the core automatically; Pi does not bundle another copy of
its runtime and does not need a source checkout.

The DSH integration starts at 0.3.1 and pins host peers to DSH 0.2.0-rc.2 because
the host is in developer preview. It installs the exact matching core version
and uses DSH's model, tool, and job services. Its browser entry is a native DSH
Web plugin, not a standalone browser runtime. See the
[DSH guide](../integrations/dsh/README.md) for installation and host requirements.
Existing 0.3.0 core and Pi users need no migration for 0.3.1.

Git must be installed for workspace execution inside a Git checkout. Non-Git
text-only runs do not require Git workspace management.
## Migrating from 0.1 to 0.2

Version 0.2 deliberately changed the execution and workspace contracts:

- Replace old source-checkout `merge` nodes with `integrate`. The new `merge`
  combines inputs in a fresh isolated worktree.
- Add explicit integrate nodes where a graph previously relied on automatic
  final integration. Runs no longer append `__braid_merge__`.
- Treat node IDs as definition identities. Read exact historical instances from
  `executions[executionId]`; `nodes[nodeId]` returns the latest instance.
- Key workspace lookups and `finish_merge` dispositions by `executionId`.
  Source workspaces remain reusable; target `dispositions` records selections.
- Read-only nodes now use isolated predecessor snapshots in Git. They receive
  checkpoints and cleanup events. All non-Git allocations also report metadata.
- Set `requireSuccess: true` on nodes whose failures must fail the whole job.
  Optional failures now retain their error and artifacts while allowing recovery.
- Handle repeated instance events and the new revision/loop/gate events. Use
  `braid_status({jobId, executionId})` for precise Pi result retrieval.
- Set finite `maxExecutions` (default 1000) and per-loop `maxIterations`. Deadlines
  and execution limits span live graph updates and paused gates.

Use `startBraid` for live updates or pause/resume. Existing `braid` callers can
still await a static graph result. See [execution control](execution-control.md)
for the full scheduling and update contract; there is no old-behavior mode.

Graph submissions may include `promptTemplates` and template-reference prompts.
`BraidInput.nodes` uses `BraidInputNode`, whose `NodePrompt` accepts a string or
`PromptTemplateReference`. Code inspecting unrendered input prompts must narrow
that union; use `satisfies BraidInput` to preserve the inferred types of a literal
graph. Runner-facing `BraidNode` and `ModelRequest.node` retain string prompts,
so existing runners need no template support. Rendering happens in core before
execution, including for Pi submissions. Older versions reject template inputs.

All node types accept optional `notifyOnCompletion: boolean` (default `false`).
Core captures this preference per execution; Pi implements parent reminders for successful and failed executions.
Skipped nodes do not notify. Pi's optional `braid_status` `nodeId` parameter
requires `jobId` and retrieves full intermediate node results. Whole-job queries and reminders remain available. Paused executions send a
separate gate reminder; when both preferences are enabled it supplies the single
completion reminder for that instance. Cancellation still sends failure reminders
for opted-in running instances.

## Migrating from 0.2 to 0.3

Version 0.3 changes workspace capabilities and checkpoint contents:

- Writable Pi nodes now receive `bash` and, on Windows, `powershell`, allowing
  dependency installation, builds, and tests within a node. If a graph relies on
  workers having no shell, set execute/decision nodes to `workspace: "read-only"`
  (which also disables file writes), or use a custom runner with the required
  capability policy. Writable shell access uses host permissions and prompt-based
  cooperation rules; worktrees are not a security sandbox. Parent extension/MCP
  tools and their hooks are not inherited.
- Core checkpoints now follow `git add --all` semantics instead of force-adding
  every output. Move artifacts needed by successors or for recovery to non-ignored
  paths, or deliberately track them. Already tracked files, including files
  explicitly staged with `git add --force`, remain tracked even when they match
  ignore rules. Untracked ignored outputs are discarded when worktrees are removed,
  including after failed or cancelled executions. This applies to every adapter.
- Shell commands must run in the foreground. On POSIX, Braid stops remaining
  children in the command's process group even on normal completion; Windows uses
  best-effort process-tree cleanup. Run a temporary server and its checks within
  one foreground command and clean it up before returning. Detached daemons and
  external services are not contained by this lifecycle.

No graph field, result shape, or event schema migration is required. Pi now
delivers completion/pause reminders after the current assistant response and
tool batch, before the next model step, rather than waiting for the entire
foreground task to finish. Fetch current status before updating or resuming a
paused execution because the reminder describes the state when it was queued.

## Migrating from 0.3 to 0.4

Version 0.4 changes how the Pi extension behaves in print and JSON modes:

- Pi print mode (`pi -p`) and `--mode json` now stay open until every Braid job
  reaches a terminal status and its reminder is delivered. No change is needed for
  CLI use; runs that previously exited early now finish their graphs.
- Pi SDK sessions created with `createAgentSession` default to extension mode
  `"print"`, which the extension cannot tell apart from the CLI. In such sessions,
  `session.prompt()` now returns only after outstanding Braid jobs drain. Hosts
  that stay running and rely on reminders starting new runs after the agent
  settles should bind with another mode, for example
  `session.bindExtensions({ mode: "rpc" })`.
- In print and JSON modes, ending a turn while only paused executions remain
  produces one warning; ending the next turn without resuming them cancels those
  jobs and sets exit status 1. Resume or cancel paused executions before the
  parent finishes. `--braid-ci-timeout` and a final `braid_finish` failure also
  exit 1.
- In 0.4, blocking mode (`--braid-blocking`, `/braid:blocking`) is deprecated
  for removal in 0.5.0. Drop the flag or command: print and JSON runs wait for
  background jobs without blocking each tool call.

No graph field, result shape, or event schema migration is required, and DSH
behavior is unchanged.

## Migrating from 0.4 to 0.5

Version 0.5 adds execution pause/resume, result holds, and timeout recovery.
Before upgrading:

- Set `onNodeTimeout: "fail"` on `startBraid` to preserve the previous timeout
  behavior with interruptible runners, including the OpenAI-compatible adapter.
  Otherwise, resume or cancel timed-out executions. Pi and DSH still default to
  unlimited node timeouts, and `braid()` still fails on timeout.
- Drop `--braid-blocking` and `/braid:blocking`; blocking mode is removed.
  The Pi `braid` tool always returns a background job handle, and completion reminders lead
  the parent to its results through `braid_status`. Print and JSON runs drain
  background jobs before exiting; use `braid_finish` to report the outcome.
  Stopping the foreground response leaves jobs running; use `braid_cancel`
  or the panel to cancel them.
- Update code that implements `BraidRun`, constructs `BraidSnapshot`, or handles
  execution events exhaustively as described below.

### Pausing running executions (0.5.0)

Pausing running executions needs no graph or result migration. Runners that do
not opt in keep working; their executions cannot be paused, and `pauseRun` only
stops admission. TypeScript consumers may need small changes:

- `ModelRunner` is now an interface with a call signature and an optional
  `pausable` flag. Plain async functions remain assignable.
- `ExecutionEvent` adds `execution_suspending`, `execution_suspended`,
  `graph_paused`, and `graph_resumed`. An exhaustive `switch` over event types
  needs cases (or a default) for them.
- `BraidSnapshot` adds a required `suspendedExecutionIds` array and an optional
  `pause`; `NodeResult` adds an optional `suspension`; `BraidRun` adds `pause`,
  `pauseRun`, and `resumeRun`; `ExecutionActivityPhase` adds `"suspended"`.
  Code that constructs these types, such as test fakes, must supply the new
  required members.
- Runners that copied `request.deadlines.node` must read it again before each use:
  core moves it later after a suspension.

Holding running executions ([#95](https://github.com/Epsirom/braid/issues/95))
also needs no migration. `BraidRun` adds `holdAfter`, `NodeResult` adds an optional
`holdAfter`, and `ExecutionEvent` adds `execution_hold_added` and
`execution_hold_removed`. Executions admitted with `pauseAfter` now carry
`holdAfter: { source: "definition" }`; read that field, not `node.pauseAfter`, to
tell whether an execution will be held.

In Pi and DSH, `braid_resume` makes `executionIds` and `expectedRevision`
optional (omit both to resume a paused job) and still requires the revision with
IDs. In Pi print mode, a stalled run now also covers suspended executions and
paused jobs, and its cancellation message reads "paused work was never resumed".

### Pausing on node timeout (0.5.0)

`startBraid` now pauses a timed-out execution instead of failing it when its
runner is interruptible. This changes behavior in one case:

- **`startBraid` with the OpenAI-compatible adapter.** Core's default
  `nodeTimeoutMs` is 60 seconds, so a slow execution now pauses and waits to be
  resumed or cancelled. A run that never resumes it ends with `GRAPH_TIMEOUT`
  (5 minutes by default) instead of continuing past an optional `NODE_TIMEOUT`
  failure; with an unlimited `graphTimeoutMs` it waits until it is resumed or
  cancelled. To keep the old behavior, pass `onNodeTimeout: "fail"`.

Nothing else changes by default:

- `braid()` still fails on timeout, and rejects `onNodeTimeout: "pause"`.
- Custom runners still fail on timeout until they set `interruptible: true` and
  use `request.stepSignal()`. Runners that are only `pausable` are unaffected.
- Pi and DSH keep an unlimited `nodeTimeoutMs` by default, so their jobs only
  pause when `options.nodeTimeoutMs` is set. Pass `options.onNodeTimeout: "fail"`
  to fail instead.
- A runner that already returned its result keeps it under `"pause"`, even if
  the node budget ran out before the result was checked; under `"fail"` it still
  fails with `NODE_TIMEOUT`.

TypeScript consumers may need small changes:

- `BraidRun` adds `cancelExecutions`, and `resume` takes an optional third
  `ResumeOptions` argument. Code that implements `BraidRun`, such as test fakes,
  must supply the new method.
- New optional members: `BraidOptions.onNodeTimeout`, `ModelRunner.interruptible`,
  `ModelRequest.stepSignal`, `ExecutionSuspension.timeout`, and
  `GraphUpdate.resumeOptions`. `execution_suspending` and `execution_suspended`
  events can now carry `source: "node_timeout"`.

In Pi and DSH, `braid_cancel` accepts optional `executionIds`, `braid_resume`
accepts `nodeTimeoutMs`, `braid_update` accepts `resumeOptions`, and submissions
accept `options.onNodeTimeout`. The `BraidJobs` constructors take a fourth
callback for timeout pauses, and `ControlNotice.action` adds `"cancelled"`.

## Migrating from 0.5 to 0.6

Version 0.6 prepares Braid for runs that keep going until their owner stops
them. It removes default limits, pauses a `startBraid` run at a limit instead of
failing it, and replaces the definition graph with a graph of execution
instances.

### Limits

- **Defaults.** Core's `maxExecutions` (was 1000), `nodeTimeoutMs` (was 60
  seconds), and `graphTimeoutMs` (was 5 minutes) are now unlimited, and cycles
  need no round limit. Callers that relied on the old bounds, including
  `braid()` callers, must set them explicitly. Pi and DSH already defaulted both
  timeouts to unlimited; their jobs also lose the 1000-execution bound.
- **Limits pause by default.** With `startBraid`, a rerun past its node's
  `maxRuns` waits, `maxExecutions` stops admission, and `graphTimeoutMs` pauses
  the run, instead of failing with `RUN_LIMIT` (was `LOOP_LIMIT`),
  `EXECUTION_LIMIT`, or `GRAPH_TIMEOUT`. Pass `onLimit: "fail"` to keep failing.
  Otherwise, raise the limit and continue as described in
  [limits](execution-control.md#limits), or cancel the run. `braid()` still fails
  and rejects `onLimit: "pause"`.

TypeScript consumers may need small changes:

- `BraidSnapshot` adds a required `limits` object and `BraidRun` adds
  `setLimits`. Code that constructs or implements these types, such as test
  fakes, must supply them.
- `ExecutionEvent` adds `limit_reached` and `limits_updated`, and
  `ExecutionError.code` adds `"TOKEN_LIMIT"`. An exhaustive `switch` needs cases
  (or a default) for them.
- New optional members: `BraidOptions.onLimit` and `BraidOptions.maxTokens`.
  `BraidOptions` now extends the exported `BraidLimits`.

In Pi and DSH, submissions accept `options.maxTokens` and `options.onLimit`, and
`braid_resume` accepts `limits` without `executionIds`. `JobOptions` extends
`BraidLimits`, and `resumeJob` takes optional limits. `/braid:review` passes
`onLimit: "fail"`, so it still fails at its round limit.

### The execution-only graph

The graph now holds only execution instances. Each node ID names a lineage of
instances, `<nodeId>@<generation>`, and the latest one, the head, is also the
template for the next. There are no separate definitions that an edit could
change without effect. See [execution control](execution-control.md) for the
full model.

**Graphs and loops.** Remove `loops` and every edge's `feedback`. A cycle closed
by a decision's choice edge is a loop; move the loop's `maxIterations` onto a node
in the cycle, usually its entry, as `maxRuns` with the same number. `maxRuns`
counts every execution of that node that starts, including reruns caused by
upstream changes:

```ts
// 0.5
nodes: [{ type: "execute", id: "edit", prompt }, /* ... */],
loops: [{ id: "refine", entry: "edit", maxIterations: 3 }],
edges: [{ from: "review", to: "edit", choice: "again", feedback: "refine" }],
// 0.6
nodes: [{ type: "execute", id: "edit", prompt, maxRuns: 3 }, /* ... */],
edges: [{ from: "review", to: "edit", choice: "again" }],
```

At the limit, the decision is no longer held: the next round's execution of that
node is created but waits pending (`waitReason: "limit"`, listed in
`limitedExecutionIds`). Raise `maxRuns` by upserting the node to let it start, or
release it with `resume` to end the cycle, as described in
[limits](execution-control.md#limits).

Any edge may now close a cycle; see [below](#any-edge-may-close-a-cycle). Node
IDs can no longer contain `@`.

**Updates.** `upsertNodes` now acts on the node's head. A head that has not
started is edited in place. A head that has started, running or settled, is
replaced: the new instance has `supersedes`, the old one `supersededBy`, a
running one is cancelled, and lineages downstream of it rerun once the
replacement settles. Before, upserting a started node changed only later
admissions and silently did nothing for a settled node outside a loop; now it
reruns the node. Upsert only the nodes you mean to change or rerun, and set
`pauseAfter` on a replacement to review it before the cascade. Removing a running
node cancels it instead of letting it finish. An edge added into a settled node
reruns it once its new input settles. `removeNodeIds` and `removeEdges` reject
unknown nodes and edges instead of ignoring them; edges are identified by
`from`, `to`, and `choice`.

**Historical edges.** `edge.executionId` is gone. Edges resolve to the head of
their source, so depend on the node itself; a node you keep is not superseded
unless you replace it.

**Results and snapshots.**

- `executions` includes pending instances from the start, and instances that
  never ran are recorded as skipped when the run ends, so counts of
  `executions` include them. `maxExecutions` counts started and skipped
  instances only.
- `nodes` holds the head of each node that was not removed. A removed node's
  instances stay in `executions` only.
- `terminalExecutionIds` and `terminalOutputs` consider heads only.
- Execution IDs are `<nodeId>@<generation>` instead of UUIDs, and are unique
  within a run only. Key anything shared across runs by `runId` as well.
- `NodeStatus` drops `runnable`: an instance is `running` from the moment it is
  admitted. Pending instances in snapshots carry `waitReason`; settled held ones
  carry `held: true`.

**TypeScript and events.**

- Removed: `LoopDefinition`, `BraidInput.loops`, `GraphUpdate.loops`,
  `Edge.feedback`, `Edge.executionId`, `NodeExecution.loopId` and `iteration`,
  `ExecutionContext.loopId` and `iteration`, and the `loopId`/`iteration` event
  fields. Use `generation` on `NodeExecution` and `ExecutionContext` instead; a
  runner that read `request.execution.iteration` reads `generation`.
- Removed events: `node_created` (now `execution_created`, for every new
  instance, with `generation`, `cause`, and `supersedes` or `trigger`),
  `node_runnable`, `loop_started`, and `loop_completed`. New events:
  `execution_removed` and `execution_superseded`. `limit_reached.limit` is
  `"maxRuns"` instead of `"maxIterations"`, with the waiting execution's
  `executionId`.
- `ExecutionError.code` `LOOP_LIMIT` is now `RUN_LIMIT`, and the hold source
  `loop_limit` is gone: a limit no longer holds the decision.
- New: `maxRuns` on every node type, `WaitReason` (including `"limit"`),
  `NodeResult.waitReason`, `held`, `supersedes`, and `supersededBy`,
  `NodeExecution.generation`, `BraidSnapshot.limitedExecutionIds` and
  `graph_waiting.limitedExecutionIds`, and the `closingEdges` helper.
  `resume` also accepts a limited execution, which ends that rerun. An upsert
  that changes only `maxRuns` keeps a started head instead of replacing it.

**Pi and DSH.** The `braid` and `braid_update` tools drop `loops`, `feedback`, and
`executionId` on edges, and accept `maxRuns` on nodes. Status text lists
executions oldest first with their wait reasons, holds, and replacements, and
marks the edge that closes a cycle. Completion notices drop `iteration` and
`loopLimit`, and `formatLoopLimit` is removed: a rerun at its node's `maxRuns`
appears in the waiting reminder instead, as a `WaitingItem` of kind `"limited"`
with source `"maxRuns"`. Pi's `OutstandingJob` adds `limitedExecutionIds`. The Pi live state replaces
`iterations` with `generations`, and the DSH panel's `PanelJob` drops `loops`,
marks the closing edge with `closesCycle`, and gives each execution a
`generation`.

### Any edge may close a cycle

Validation no longer rejects cycles. Unconditional, nested, and overlapping
cycles, cycles with several entries or with edges that leave from any node, and
decisions without an exit choice are all accepted. See
[cycles](execution-control.md#cycles).

Graphs that earlier versions accepted run as before: their cycles keep the same
closing edge, and the exits of a cycle closed by a decision's choice edge still
wait for its final round. The one exception is a cycle with no entry (no edge
from outside enters it) where a decision inside the cycle also has a choice edge
back to a node listed before the old round start: its rounds may now start at
that node. List the node where rounds start first in `nodes`, and check
`closingEdges(graph)`. Bound any cycle with `maxRuns` on one of its nodes.

- `closingEdges` returns the closing edges of every cycle, including several per
  cycle, instead of skipping cycles that were rejected.
- New: the `cycles_created` event, the `GraphCycle` type, and the `newCycles`
  helper, which report new cycles and whether anything stops or bounds them. An
  exhaustive `switch` over `ExecutionEvent` needs a case for `cycles_created`.
- New: `Edge.closesCycle` makes an edge close its cycle, so each round starts at
  its target, and `GraphCycle.choiceGated` lists the choice edges that a node on
  the cycle waits for before its first run. Code that compares whole
  `GraphCycle` objects needs the new field.
- Pi and DSH: `braid` and `braid_update` results list new cycles, and
  `formatUpdate` takes the previous graph as an optional second argument. Their
  edge schemas accept `closesCycle`.
- Pi and DSH: `WaitingNotice` and `TimeoutPause` add `graphTimeoutMs` when the
  job has a graph timeout, and their reminders say that the graph timeout keeps
  running only then.

## Versioning

Core, Pi, and DSH release together with matching versions. During 0.x, patch releases
preserve documented behavior; breaking API or semantic changes require a minor
version bump, a changelog entry, and migration guidance. New optional fields or
fixes that restore the documented contract may ship in a patch.
Pi and DSH require the exact core version they depend on, which core exports as
`BRAID_VERSION`, and fail to load with any other. After upgrading, restart the host:
a running process keeps the core it loaded first.

Supported core entry points are `@chrok/braid` and `@chrok/braid/adapters/openai`.
The root `@chrok/braid` entry point also exports adapter helpers:
`formatBudgetReminder`, `gitToolDefinition`, `finishMergeToolDefinition`,
`mergeInstructions`, `parseGitToolArguments`, and `parseFinishMergeArguments`.
These helpers share the core's compatibility policy; Git workspace implementation
classes remain internal. Internal files and Pi helper classes are not stable
public APIs. Documented result/error
fields, routing behavior, `ModelRunner`, and existing event meanings are part of
the public contract. Consumers should ignore new diagnostic fields and provide a
fallback for new event types; event sequence numbers order events within a run,
but concurrent nodes need not finish in a fixed order.

There is no cross-version serialized job/checkpoint format. Pi jobs are scoped to
one host session and are lost on exit, reload, switch, or fork. The project is
experimental and maintained on a best-effort basis.
