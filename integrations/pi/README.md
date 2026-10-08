# Braid for Pi (`@chrok/pi-braid`)

[![npm](https://img.shields.io/npm/v/%40chrok%2Fpi-braid?label=%40chrok%2Fpi-braid)](https://www.npmjs.com/package/@chrok/pi-braid)

This optional Pi extension runs Braid agent graphs as background jobs with
bounded loops, live updates, pause/resume, and a live flow panel.

**0.3 API:** The npm badge shows the published version; see
[GitHub releases](https://github.com/Epsirom/braid/releases) for release notes.
Review the [0.2 → 0.3 migration guide](https://github.com/Epsirom/braid/blob/v0.3.0/docs/compatibility.md#migrating-from-02-to-03)
before upgrading: writable nodes now have shell tools, checkpoints exclude
untracked ignored outputs, and reminders can interrupt work between model steps.
Users coming from 0.1 also need the
[0.1 → 0.2 guide](https://github.com/Epsirom/braid/blob/v0.3.0/docs/compatibility.md#migrating-from-01-to-02).
For the previous release, use the
[0.2.1 guide](https://github.com/Epsirom/braid/blob/v0.2.1/integrations/pi/README.md).

It registers:

- `braid` — submit a graph with optional bounded loops and immediately receive a `jobId`.
- `braid_status` — retrieve progress and results with `{ "jobId": "..." }`, or
  add `"executionId": "..."` for an exact invocation's full output/error.
  `"nodeId": "..."` selects that definition's latest invocation. Omit all IDs
  to list jobs in the current session.
- `braid_update` / `braid_resume` — edit live definitions or release paused executions.
- `braid_cancel` — cancel a job with `{ "jobId": "..." }`.
- `/braid [jobId]` — open a live flow panel in interactive Pi.

Submission and completion reminders use short session handles such as `job-1`.
Status, cancellation and the panel accept either that exact handle or the original
UUID. Unknown IDs report available handles; IDs are never guessed or fuzzy-matched.

Invalid submissions show the validation error directly in the tool result,
including failures before a background job is created. Correct the indicated
field or graph relationship and resubmit. `braid_status` lookup failures also
display their error text.

The parent can continue independent work or finish its response while a job runs.
On completion, failure, or cancellation, the extension sends a custom
`system-reminder` containing the job ID and a request to retrieve its results.
Pi queues it as steering during streaming: it enters context after the current
assistant response and its entire tool batch, before the next model step. It
does not wait for the whole foreground task to finish or skip remaining tools.
When idle, it starts a new agent turn automatically. The agent should wait for
this reminder rather than poll.
Stopping the foreground response does not stop background jobs.

Jobs live in memory for the current Pi session. Quitting, reloading extensions,
or switching/forking sessions aborts outstanding work and suppresses its
reminders. Job IDs cannot be retrieved after that lifecycle ends. They are not
persistent processes outside Pi.

## Graph definitions

Each node has a unique `id` and one of these four shapes:

| `type` | `prompt` | `choices` | `workspace` |
| --- | --- | --- | --- |
| `execute` | Required | Omit | Optional: `read-only` or `worktree` |
| `decision` | Required | Required, non-empty, distinct strings | Optional: `read-only` or `worktree` |
| `merge` | Optional | Omit | Omit; combines changes in an isolated worktree |
| `integrate` | Optional | Omit | Omit; applies changes to the invoking checkout |

All four types accept `model`, `notifyOnCompletion`, `pauseAfter`, and
`requireSuccess`. Omit optional fields when unused. Execute/decision nodes
default to writable worktrees in Git; outside Git, all workers are read-only.
The model-facing schema exposes these fields in one object with a `type` enum;
core validation enforces the type-specific requirements before a submission or
update takes effect. Submission/update replies echo the accepted node types,
model overrides, policies, and edges without repeating prompts. If a definition
problem repeats, inspect/report the mismatch instead of launching more probe jobs.

Edges use exact node IDs in `from` and `to`. `choice` is an exact label declared
by the source decision; omitting it makes the edge unconditional. Pass `edges: []`
for independent roots. Historical `executionId` pins are available only in
`braid_update`, after the source execution exists.

A retry cycle needs a `loops` definition and exactly one feedback edge from a
decision back to the loop entry, carrying both `choice` and `feedback: "<loop-id>"`.
The decision needs another choice to exit. `maxIterations` counts the first round
as well as retries. The body must be acyclic after removing the feedback edge;
external edges enter only at the entry and leave only through that decision.
Loops cannot nest or overlap. See the [loop example](../../docs/execution-control.md#structured-loops).

## Shared prompts

The `braid` tool accepts a `promptTemplates` object alongside `goal`, `nodes`,
`edges`, and `options`. For example, define
`"promptTemplates": { "review": "Review {{target}}. Report evidence and file references." }`
and use `"prompt": { "template": "review", "variables": { "target": "src/runtime.ts" } }`
on a node. This keeps repeated instructions out of the parent model's tool-call
arguments; workers still receive the full rendered prompt.

Placeholders use `{{name}}`, with names matching `[A-Za-z_][A-Za-z0-9_]*` and
optional whitespace inside the braces. Variables must match the template exactly
and have string values; insertion is literal and never recursively rendered.
Core validates all templates and rendered prompts before the job starts.
Plain-string prompts and omitted merge prompts keep their existing behavior.
Templates are scoped to this submission, with no saved registry. See the
[core template guide](https://github.com/Epsirom/braid#reusable-prompt-templates)
for a complete graph and validation rules.

## Node completion reminders and live control

Set `notifyOnCompletion: true` on selected nodes for completion/failure reminders.
Each reminder identifies the exact `executionId` and optional loop iteration.
`braid_status({jobId, executionId})` retrieves that instance's full output/error;
`nodeId` selects the latest instance. Skipped executions stay silent. Reminders
are acknowledged when they enter context and retried if foreground cancellation
drops the queued message. Session shutdown suppresses delivery.

Set `pauseAfter: true` to hold an execution's outgoing scheduling and receive a
pause reminder. Independent branches continue. Fetch `braid_status` to obtain
`execution.revision` and `execution.pausedExecutionIds`, then:

```json
{
  "jobId": "job-1",
  "expectedRevision": 0,
  "upsertNodes": [{ "type": "execute", "id": "fix", "prompt": "Implement the findings." }],
  "addEdges": [{ "from": "inspect", "to": "fix", "executionId": "<paused-execution-id>" }],
  "resume": ["<paused-execution-id>"]
}
```

Pass this to `braid_update`. It validates and commits the full change and resume
atomically. To continue without edits, call `braid_resume({jobId,
expectedRevision, executionIds})`. Definitions can be changed while executions
are running or waiting, including inside a loop. Existing instances keep their
captured prompt, inputs, and policy; completion routes through the latest graph.
Rejected revisions/changes have no effects. Finalized jobs cannot be reopened.
Include new nodes and their dependencies/loops in the same update. A new node
without incoming edges is a runnable root; another node's `pauseAfter` does not
hold it. After a rejected update, retry the complete corrected patch, including
edges, loops, and resume IDs, instead of staging disconnected nodes separately.
Pause reminders describe the event when it occurred: check current status and
paused IDs before attempting an update/resume, since the job can time out or be
cancelled before the parent handles the reminder.

Focused `braid_status` reads also include the current control fields; the
returned `node.revision` is the revision captured when that invocation started.
Use `execution.revision` for updates even when inspecting an older invocation.
After cancellation or finalization there are no resumable paused executions;
the event log still records where pauses occurred.

`upsertNodes` replaces whole node definitions, so include all required fields.
`promptTemplates` and `loops` replace their entire map/list when supplied;
omitting them preserves the current definitions. `removeEdges` matches exact
identities, including any `choice`, `feedback`, or `executionId`: omitted fields
are not wildcards. `resume` and `braid_resume.executionIds` take paused execution
IDs, not node IDs.

`requireSuccess` defaults to false. Optional failures retain artifacts and allow
unconditional recovery; required failures cancel siblings and fail the job after
cleanup. All loops declare a finite `maxIterations`; total `maxExecutions`
defaults to 1000 and spans updates. Deadlines keep running through pauses.
The graph timeout includes time waiting for the parent to inspect and update a
paused graph, and resuming does not extend it. Reserve time for integration.

See [execution control](../../docs/execution-control.md) for loop schemas, exact
update semantics, historical dependencies, and workspace lineage. There is no
scheduler persistence across Pi reloads. Reminders alone do not pause execution.

## Live flow panel

In interactive Pi, background progress appears automatically **above the input
editor** as soon as a job is submitted; no command or polling is needed:

```text
Braid job-1 · running · 2/5 done · review
```

The widget shows node progress, active node IDs, paused gates, and failures.
It shows up to three active jobs, with an overflow count for the rest. When no
jobs are active, the newest job's final completed/failed/cancelled status stays
visible until another job is submitted or the session ends. Counts use the
latest state of each current node definition; failed and skipped nodes count as
done, and reruns or live edits can change progress and totals. RPC, JSON, and
print modes do not create a terminal widget.

Run `/braid` to open the newest job, or `/braid <jobId>` to open a specific job.
The bordered panel keeps the job header and keyboard controls visible while
you scroll the flow and event log. It refreshes as nodes start, finish, fail,
and pass outputs downstream.
Use Left/Right to select jobs, Up/Down or Page Up/Page Down to scroll, `c` to
cancel the selected job, and Escape or `q` to close the panel. Closing the panel
leaves jobs running. In RPC or noninteractive modes, use `braid_status`.

The panel renders a Mermaid flowchart, node states, elapsed times, context-token
estimates or provider-reported usage, context-window sizes, filesystem tool-call
counts, and the execution log. Active nodes are marked `▶ ACTIVE`. The status
tool also renders a flowchart; expand its result to see more log events.
When selecting `nodeId` or `executionId`, it instead shows that invocation's
output/error, with the full text available on expansion.

`/braid` now opens this panel; it no longer arms the next prompt. To request
Braid explicitly, ask the agent to analyze the task using Braid.

Braid owns graph validation, scheduling, joins, routing, skip/failure propagation,
timeouts, Git worktree/checkpoint/merge lifecycle, and result metadata. Pi owns
model lookup, credentials/OAuth, provider transport, filesystem tool execution,
and token/cost accounting. The first
whole-job `braid_status` retrieval of a finished job reports its accumulated Pi usage;
subsequent retrievals do not count the same usage again.
Use the status response's `usage` for Pi totals, including completed provider
rounds from nodes that later fail or time out. Saved final result files expose
the same accounting as `piUsage`; core `metadata.usage` only includes usage
returned by runners. Large running status reads save a complete snapshot too,
so truncation never requires waiting for job completion to inspect the graph.

## When Pi will use Braid

Tool selection is made by the parent Pi model. It is not possible for an
extension to force a model tool call safely for every prompt. This adapter adds
an explicit per-turn planning policy to Pi's system prompt and tool metadata:

- for code reviews, bug investigations, design comparisons, test planning, or
  changes spanning multiple files, call Braid first when two or more concerns
  can be handled independently; use `workspace: "read-only"` for analysis,
  review, routing, and synthesis, and worktrees for implementation;
- do not use Braid for simple one-step answers, trivial direct edits, or a single
  shell command; writable nodes can implement, test, and fix their own work;
- the user does not need to say “Braid” or design the graph;
- when Braid fits, the model should submit a graph and refine it with live updates when needed, continue independent work, and retrieve the terminal outputs after
  the completion reminder.

This is a recommendation to the model, not hard enforcement. If a model still
ignores the policy, use a short instruction such as “decompose this with Braid”
or strengthen the project/system prompt for that model. The adapter explicitly
asks the model to make the delegation choice before directly inspecting the
repository. Do not add a generic `always call braid` rule: that would waste
model calls and bypass direct tools.
Merge nodes combine and validate snapshots; integrate nodes apply selected changes to the caller; the parent reviews results and performs any remaining validation.
Each node gets a new Pi AI context containing only the Braid goal, its node prompt,
labelled direct predecessor outputs, and workspace metadata. It receives Pi's
`read` and `ls`, plus `grep` when local `rg` is available and `find` when
local `fd`/`fdfind` is available. Missing search dependencies are reported in the
node prompt, with `ls`/`read` as alternatives. Dependencies are checked before
exposing search tools and again before executing them; missing tools are not
installed automatically by Braid. Writable workspaces additionally receive `write`,
`edit`, and Pi's `bash` tool (`powershell` is also exposed on Windows), so nodes
can install local dependencies, build, and run tests. Read-only nodes have no shell.
Nodes receive no parent transcript, skills, or inherited extension/MCP tools.
Decision nodes additionally receive `decide`. Git nodes receive
local Git inspection; merge/integrate nodes also receive Git integration commands and
`finish_merge`. Merge agents receive bounded changed-file lists, diff statistics
and previews; integrate also receives the source checkout's dirty status. The model-facing `git`
tool has a role-specific `command` enum and separate `args`; `finish_merge` lists
only the current source IDs and diagnoses missing, duplicate or unexpected IDs.

## Install from npm

Requires Node.js 22.19+ and Pi 1.0.1 (the tested version):

```sh
pi install npm:@chrok/pi-braid
```

Add `-l` for a project-local installation. Run `/reload` after installation.
The package depends on the exact matching `@chrok/braid` release; npm installs
core automatically. It does not bundle core or depend on a source checkout.
Pi supplies its core peer packages at runtime.
Their wildcard ranges follow Pi's packaging convention, not universal version
compatibility. Development and CI pin Pi 1.0.1.

## Install this local checkout in Pi

From the repository root:

```sh
npm ci
npm run build:pi
pi install ./integrations/pi
```

Run these commands from the repository root. To install for only one project,
add `-l`:

```sh
pi install -l ./integrations/pi
```

For local installations, rebuild with `npm run build:pi` after source edits,
then reload Pi. In Pi, run `/reload`. Restart Pi if the package was installed into an
already running process and the tool does not appear. Inspect installation with:

```sh
pi list
pi config
```

The extension loads its own compiled `dist/` and the Pi host dependencies.
`npm ci` at the repository root installs the pinned workspace development
environment, including a local link to core. Use
`npm install --workspace @chrok/pi-braid <dependency>` when updating Pi dependencies;
all packages share the root lockfile. The adapter uses the `grok-mermaid` terminal renderer for Mermaid flowcharts.
The local install is trusted code: Pi extensions execute with the process's full
permissions.

## Test the adapter without spending money

After the root `npm ci` command above, verify the core and adapter:

```sh
npm run check
npm test
npm run build
npm run check:pi
npm run test:pi
npm run demo
```

The Pi adapter tests use a fake model registry and assert exact model lookup,
fresh contexts, tool isolation, decision handling, filesystem tool execution,
continuation behavior, usage aggregation, context-token progress, and tool counts.
Renderer tests cover Mermaid topology, live active-node highlighting,
handoff/failure logs, expanded per-node output, and bounded event previews.
Background-job tests cover immediate submission, foreground independence,
completion reminders, explicit cancellation, shutdown, usage accounting, and
large-result retrieval. Panel tests cover navigation, scrolling, and cleanup.
They make no provider requests.

## Node filesystem capabilities

Inside Git, every execution gets a new worktree based on predecessor checkpoints.
Root executions use the initial job snapshot, including tracked and non-ignored
untracked caller edits. Later loop rounds get new worktrees; they never reuse a
previous invocation's workspace. `workspace: "read-only"` disables write/edit
while retaining an isolated snapshot. Outside Git, all filesystem access is
read-only, including no shell tools. Search tools require installed `rg`/`fd`.
Writable nodes can run shell commands and tests in their assigned working directory.

`merge` combines predecessor results into a new isolated worktree. `integrate`
applies selected changes to the invoking checkout and preserves user edits. Both
expose Git integration commands and `finish_merge`, require per-source
`executionId` dispositions, and forbid the `workspace` property. Use ordinary
execute/decision nodes for analysis; a worker with independent changed code
inputs needs an explicit merge to produce its starting snapshot.

Nothing is automatically integrated at job completion. To apply implementation
results, explicitly connect them to an integrate node:

```json
{
  "goal": "Implement and review a fix",
  "nodes": [
    { "type": "execute", "id": "implement", "prompt": "Make the fix." },
    { "type": "execute", "id": "review", "prompt": "Review the fix.", "workspace": "read-only" },
    { "type": "integrate", "id": "apply", "requireSuccess": true }
  ],
  "edges": [{ "from": "implement", "to": "review" }, { "from": "review", "to": "apply" }]
}
```

Checkpoints save tracked changes and non-ignored new files, following normal
`git add --all` semantics. Existing tracked files remain tracked even when they
match ignore rules. Ignored dependencies, caches, and build outputs are discarded
with the worktree and are not carried to successors; keep required outputs in
non-ignored paths. Files deliberately staged with `git add --force` remain tracked.

`braid_status` retains execution-keyed workspace paths, checkpoint refs, and target
merge dispositions. Cleanup removes worktrees while keeping immutable checkpoints.
Inspect with `git show <checkpointRef>:path`. Integration additionally saves a
pre-write backup ref. A failed integration can leave partial source changes or
conflicts; core does not reset the caller's checkout. Integrations serialize
within the process, without locking parent edits or other processes.

Pi's guarded `write`/`edit` reject external paths, Git metadata, symlinks, hard links,
and special files. Shell tools run with host permissions and can bypass those
checks. Prompts require writes to stay in the assigned workspace, reserve source
checkout changes for integrate nodes, and protect shared Git refs/configuration,
other nodes, ports, databases, caches, and external services. These are cooperation
rules, not an OS sandbox. Shell tools are created for each invocation; parent
extension/MCP tools and their hooks are not inherited.

Shell calls join the core write barrier: cancellation/timeout stops the process
group (Windows uses `taskkill /T`), and checkpointing waits for the call to settle.
On POSIX, remaining children in the command's process group are also stopped on
normal command exit. Windows cleanup after the parent process exits is best effort.
Run commands in the foreground; do not daemonize or leave servers/watchers running.
Processes that detach from the group and external services are not contained by
this mechanism. A custom runner must honor the core write barrier as well.
Calling the Pi runner without an assigned workspace stays read-only.

Tool and time budgets are unlimited by default in Pi. To set finite hard limits,
pass any of these fields in the `braid` tool's `options`:

| Option | Meaning |
| --- | --- |
| `maxToolRounds` | Maximum assistant responses containing tool calls, per node |
| `maxToolCalls` | Maximum total requested tool calls, per node |
| `nodeTimeoutMs` | Time allowed for each node after it starts, in milliseconds |
| `graphTimeoutMs` | Time allowed for the entire graph, including queueing and pauses, in milliseconds |
| `maxExecutions` | Total materialized execution records, including skips; default 1000, positive safe integer |

For example, `options: { maxToolRounds: 20, maxToolCalls: 60, nodeTimeoutMs: 120000 }`.
Omit tool/time fields for no tool/time limit; programmatic time/tool options also accept `Infinity`. The total execution limit is always finite.
Tool limits must be positive safe integers. Counts include `decide`, `git`,
`finish_merge`, and rejected
tool requests. A batch exceeding either tool limit is rejected before execution
and fails the node; a final text response is still allowed at the exact limit.

When any budget is finite, the worker's system prompt contains a `system-reminder`
before its first model call and refreshes it before each continuation. It reports
finite tool limits and remaining rounds/calls, and remaining node/graph time.
Workers must reserve a call for `decide` or `finish_merge` when required and finish
within the remaining budgets. Graph time is shared across all nodes; a queued
node receives the remaining graph time, not a fresh graph timeout. Reminders do
not extend deadlines or interrupt an in-flight model response.

## Test real Pi models

Authenticate Pi normally first, for example with `/login`, an environment key,
or an existing `~/.pi/agent/auth.json`. Select a model with `/model`. Braid uses
that exact current model by default. Per-node overrides use an exact
`provider/modelId`, for example `anthropic/claude-sonnet-4-5` or
`openai/gpt-5-mini`.

Ask Pi to make one very small test call (this explicitly names Braid so it
also verifies the tool wiring):

```text
Use the braid tool with this graph:
- goal: "Return the word PASS."
- one execute node: id "check", prompt "Return exactly PASS."
- no edges
Use the currently selected Pi model. Do not use any other tool.
```

Pi should call `braid` and show a completed result whose terminal output is
keyed by `check`. This is a billable model request. A slightly richer routing
test is:

```text
Use braid with this complete graph. Goal: "Test routing."
Nodes:
1. decision id route, prompt "Select go and then explain briefly", choices ["go", "stop"]
2. execute id left, prompt "Return LEFT"
3. execute id right, prompt "Return RIGHT"
4. execute id join, prompt "List your predecessor IDs and outputs"
Edges:
- route -> left labelled choice go
- route -> right labelled choice stop
- left -> join
Ask the decision node to choose go. Use the current Pi model.
```

Expected behavior:

- `route` completes with decision `go`.
- `left` runs.
- `right` is `skipped` with reason `inactive`.
- `join` receives only `left` as a labelled predecessor.
- `join` appears in `terminalOutputs`.
- The Pi TUI shows a compact graph summary rather than the full input JSON.
- Submission returns a job ID immediately. Open `/braid` to see active nodes
  and the execution log update with starts and handoffs.
- Completion sends a reminder and resumes an idle agent; `braid_status` retrieves
  the finished result.
- The result shows completion/failure, node counts, terminal IDs, decisions, failures, skips, and the execution log. Expand the result row to see per-node output and more events.

To test per-node model selection, add `model: "provider/modelId"` to one node.
Use an exact ID shown by `/model` or `pi --list-models`; an unrecognized model
fails that node cleanly and does not invoke another provider.

## Cancellation and limits

The Pi extension has no node or graph time limit by default. Use `braid_cancel`
or press `c` in the flow panel to abort running nodes and mark queued nodes
`cancelled`. Escape stops the foreground response or closes the panel without
cancelling jobs. To set a node or graph timeout, supply milliseconds in the
submission tool input under `options`; each omitted timeout remains unlimited:

```json
{
  "maxConcurrency": 2,
  "nodeTimeoutMs": 30000,
  "graphTimeoutMs": 120000
}
```

The adapter sets `maxRetries: 0`, `cacheRetention: "none"`, and gives each node a
fresh provider context. Tool budgets are unlimited unless `maxToolRounds` or
`maxToolCalls` is set. Missing paths, invalid arguments, disallowed writes, and
unavailable tools are returned as tool errors so the node can recover. Provider
authentication and calls may still incur normal provider costs. Braid cannot
forcibly stop synchronous JavaScript or a remote provider that ignores
cancellation. Cancellation prevents further tool calls but does not roll back
writes already made. Core waits for tracked writes, preserves checkpoints, and
removes worker worktrees before completing cancellation.

The tool output is capped at 50KB/2000 lines to protect Pi context. When exceeded,
the adapter writes a full JSON result to a temporary file (mode 600 on POSIX;
inherited ACLs on Windows) and includes
its path in the tool output.

For a test of proactive selection, start a fresh Pi turn with a task such as:

```text
Compare these three proposed designs, identify independent risks for each,
and finish with a recommendation. You may use the available execution
primitives when they improve the result.
```

The adapter's policy tells Pi to consider Braid because this task has multiple
independent reasoning branches and a final synthesis. Whether it actually calls
the tool remains model-dependent; inspect the transcript for the `braid` tool
submission, completion reminder, and the live graph/handoff log in `/braid`.

## Live end-to-end tests

The reusable RPC suite is in [test/live/README.md](test/live/README.md). It uses
your local Pi installation and configured credentials with real provider calls.
Run it explicitly; it is separate from the deterministic tests and incurs model
usage. It saves prompts, actual Braid parameters, node/tool transcripts, Git/file
assertions and a Markdown report in a temporary output directory.
