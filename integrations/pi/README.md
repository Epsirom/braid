# Braid for Pi (`@chrok/pi-braid`)

This optional Pi integration runs Braid graphs as background jobs. It registers:

- `braid` — submit a complete DAG and immediately receive a `jobId`.
- `braid_status` — retrieve progress and results with `{ "jobId": "..." }`, or
  omit the ID to list jobs in the current session.
- `braid_cancel` — cancel a job with `{ "jobId": "..." }`.
- `/braid [jobId]` — open a live flow panel in interactive Pi.

Submission and completion reminders use short session handles such as `job-1`.
Status, cancellation and the panel accept either that exact handle or the original
UUID. Unknown IDs report available handles; IDs are never guessed or fuzzy-matched.

The parent can continue independent work or finish its response while a job runs.
On completion, failure, or cancellation, the extension sends a custom
`system-reminder` containing the job ID and a request to retrieve its results.
Pi queues it as a follow-up during streaming; when idle, it starts a new agent
turn automatically. The agent should wait for this reminder rather than poll.
Stopping the foreground response does not stop background jobs.

Jobs live in memory for the current Pi session. Quitting, reloading extensions,
or switching/forking sessions aborts outstanding work and suppresses its
reminders. Job IDs cannot be retrieved after that lifecycle ends. They are not
persistent processes outside Pi.

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

## Live flow panel

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

`/braid` now opens this panel; it no longer arms the next prompt. To request
Braid explicitly, ask the agent to analyze the task using Braid.

Braid owns graph validation, scheduling, joins, routing, skip/failure propagation,
timeouts, Git worktree/checkpoint/merge lifecycle, and result metadata. Pi owns
model lookup, credentials/OAuth, provider transport, filesystem tool execution,
and token/cost accounting. The first
`braid_status` retrieval of a finished job reports its accumulated Pi usage;
subsequent retrievals do not count the same usage again.

## When Pi will use Braid

Tool selection is made by the parent Pi model. It is not possible for an
extension to force a model tool call safely for every prompt. This adapter adds
an explicit per-turn planning policy to Pi's system prompt and tool metadata:

- for code reviews, bug investigations, design comparisons, test planning, or
  changes spanning multiple files, call Braid first when two or more concerns
  can be handled independently; use `workspace: "read-only"` for analysis,
  review, routing, and synthesis, and worktrees for implementation;
- do not use Braid for simple one-step answers, trivial direct edits, or shell
  work; keep tests and shell commands in the parent agent;
- the user does not need to say “Braid” or design the graph;
- when Braid fits, the model should construct and submit the complete graph
  immediately, continue independent work, and retrieve the terminal outputs after
  the completion reminder.

This is a recommendation to the model, not hard enforcement. If a model still
ignores the policy, use a short instruction such as “decompose this with Braid”
or strengthen the project/system prompt for that model. The adapter explicitly
asks the model to make the delegation choice before directly inspecting the
repository. Do not add a generic `always call braid` rule: that would waste
model calls and bypass direct tools.
Merge agents review and integrate node changes; the parent reviews results and runs tests.
Each node gets a new Pi AI context containing only the Braid goal, its node prompt,
labelled direct predecessor outputs, and workspace metadata. It receives Pi's
`read` and `ls`, plus `grep` when local `rg` is available and `find` when
local `fd`/`fdfind` is available. Missing search dependencies are reported in the
node prompt, with `ls`/`read` as alternatives. Dependencies are checked before
exposing search tools and again before executing them; missing tools are not
installed by Braid. Git worktrees additionally receive `write` and `edit`.
It receives no parent transcript, shell tools, test runner, skills, or arbitrary
code execution. Decision nodes additionally receive `decide`. Git nodes receive
local Git inspection; merge nodes also receive Git integration commands and
`finish_merge`. Merge agents receive bounded changed-file lists, diff statistics
and previews, plus the source checkout's dirty status. The model-facing `git`
tool has a role-specific `command` enum and separate `args`; `finish_merge` lists
only the current source IDs and diagnoses missing, duplicate or unexpected IDs.

## Install from npm

Requires Node.js 22.19+ and Pi 0.87.1 (the tested version):

```sh
pi install npm:@chrok/pi-braid
```

Add `-l` for a project-local installation. Run `/reload` after installation.
The package depends on the exact matching `@chrok/braid` release; npm installs
core automatically. It does not bundle core or depend on a source checkout.
Pi supplies its core peer packages at runtime.
Their wildcard ranges follow Pi's packaging convention, not universal version
compatibility. Development and CI pin Pi 0.87.1.

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
both packages share the root lockfile. The adapter uses the `grok-mermaid` terminal renderer for Mermaid flowcharts.
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

Core owns workspace preparation, checkpointing, serialization, and cleanup for
all integrations. Pi exposes `read` and `ls` in all directories, plus search tools whose local dependencies are available.
In Git, execute and decision nodes default to `write`/`edit` restricted to their
own detached worktree, plus local Git inspection. Set `workspace: "read-only"`
to keep read tools and Git inspection without write/edit tools or a worktree.
Omit `workspace` or use `"worktree"` for implementation or a fixed snapshot.
Outside Git, both modes remain read-only. Nodes never receive shell commands or
a test runner. The `workspace` field is forbidden on merge nodes.

Read-only nodes inspect the live source directory at the original `cwd`, including
accessible ignored files. They create no snapshot, checkpoint, or merge source.
Parent edits and concurrent merges may change what they read during execution.
Implementation changes reach the source only through integration; a downstream
review can inspect a predecessor worktree/checkpoint explicitly, or run after a
merge to review the integrated source. Use a read-only execute node to summarize
findings, and a merge node to integrate file changes.

For example, this graph reviews two concerns before implementing a fix. Core
invokes an automatic merge only if the implementation leaves file changes:

```json
{
  "goal": "Review the cache and fix confirmed problems.",
  "nodes": [
    { "type": "execute", "id": "correctness", "workspace": "read-only", "prompt": "Review cache correctness." },
    { "type": "execute", "id": "tests", "workspace": "read-only", "prompt": "Inspect test coverage and identify missing cases; do not run tests." },
    { "type": "execute", "id": "fix", "prompt": "Implement confirmed fixes and regression tests from both reviews." }
  ],
  "edges": [{ "from": "correctness", "to": "fix" }, { "from": "tests", "to": "fix" }]
}
```

The initial snapshot includes tracked staged/unstaged changes, deletions, and
non-ignored untracked files. It preserves the source index and files. Ignored
files are not copied; submodules are not initialized or recursively snapshotted,
and Pi rejects writes inside them to keep checkpoint recovery complete.
Workers using worktrees share that baseline until a merge ends, after which new workers
snapshot the current source checkout. Uncommitted predecessor changes are not
implicitly applied to downstream workers. Their paths and checkpoint refs are
available as context for inspection.

A `merge` node accepts multiple predecessors and an optional prompt/model. It
operates in the source checkout, with guarded `write`/`edit` and local `git`
commands (`add`, `commit`, `merge`, `cherry-pick`, `apply`, `restore`, plus
inspection). The agent decides which changes to use and how to integrate them.
Core never automatically merges or cherry-picks. The agent must call
`finish_merge` with `integrated`, `discarded`, or `archived` and a reason for every
source. Tool errors and conflicts go back to the agent for recovery. Failed
predecessors pass errors and partial work along unconditional edges.

Core removes processed source worktrees after the merge agent finishes. After
declared nodes settle, unchanged worktrees are released as `discarded` with reason
`No changes from snapshot`, retaining recovery refs. Only remaining worktrees
with changes trigger a final merge agent, so analysis-only graphs keep their
declared terminal outputs without an extra model call. Explicit merge nodes run
even for unchanged sources.
Its model, tool calls, budgets, events, and usage behave like any other node.
Missing finish calls, unresolved conflicts, or archived sources fail the merge.
Cancellation, timeout, and failure archive remaining changes and clean worktrees;
they do not start new merge agents after graph cancellation.

`braid_status` includes core's `workspaces` map with workspace paths, states,
reasons, `checkpointRef`, and pre-merge `backupRef`. The panel distinguishes active
worktrees from cleaned workspaces. Worktrees use
`os.tmpdir()/braid-workspaces-*/<unique-id>`; after removal their contents remain
recoverable from `refs/braid/checkpoints/*`. Use `git show <checkpointRef>:<path>`
or `git diff <snapshotCommit> <checkpointRef>` to inspect archived changes.
Remove individual recovery refs with `git update-ref -d <ref>` once reviewed.
Explicit read-only nodes appear with mode `read-only` and state `ready`, without
checkpoint or backup refs; their files stay in the source directory.

A failed merge does not reset partial changes or conflict state in the source
checkout. Its `backupRef` preserves the pre-agent snapshot. Cleanup errors report
retained paths instead of silently claiming success. A process crash cannot run
cleanup. The merge mutex coordinates runs in the same process only; avoid parent
edits to the source checkout while a merge agent is running.

File writes reject external paths, Git metadata, symlinks, hard links, and special
files. Read access follows Pi's normal permissions. This does not replace an OS
sandbox against concurrent filesystem attacks. For programmatic use, pass
`createPiRunner(...)` to core `braid(..., { cwd, runner })`; calling the runner
directly without a core workspace gives read-only capabilities.

Tool and time budgets are unlimited by default in Pi. To set finite hard limits,
pass any of these fields in the `braid` tool's `options`:

| Option | Meaning |
| --- | --- |
| `maxToolRounds` | Maximum assistant responses containing tool calls, per node |
| `maxToolCalls` | Maximum total requested tool calls, per node |
| `nodeTimeoutMs` | Time allowed for each node after it starts, in milliseconds |
| `graphTimeoutMs` | Time allowed for the entire graph, including queueing, in milliseconds |

For example, `options: { maxToolRounds: 20, maxToolCalls: 60, nodeTimeoutMs: 120000 }`.
Omit a field for no limit; programmatic runner/job options also accept `Infinity`.
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
