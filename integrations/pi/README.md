# Braid for Pi (`@chrok/pi-braid`)

[![npm](https://img.shields.io/npm/v/%40chrok%2Fpi-braid?label=%40chrok%2Fpi-braid)](https://www.npmjs.com/package/@chrok/pi-braid)

This optional Pi extension runs Braid agent graphs as background jobs, with
cycles, live updates and reruns, pause/resume, and a live flow panel.

**0.5 API:** The npm badge shows the published version; see
[GitHub releases](https://github.com/Epsirom/braid/releases) for release notes.
Review the [0.4 → 0.5 migration guide](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#migrating-from-04-to-05)
before upgrading: running executions can pause and resume, configured node
timeouts pause by default, and blocking mode is removed. Users coming from
0.3 also need the [0.3 → 0.4 guide](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#migrating-from-03-to-04)
for print/JSON job draining and Pi SDK behavior. Users coming from 0.2 also need the
[0.2 → 0.3 guide](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#migrating-from-02-to-03),
and users coming from 0.1 the
[0.1 → 0.2 guide](https://github.com/Epsirom/braid/blob/v0.5.2/docs/compatibility.md#migrating-from-01-to-02).
For the previous release, use the
[0.5.1 guide](https://github.com/Epsirom/braid/blob/v0.5.1/integrations/pi/README.md).

It registers:

- `braid` — submit a graph, optionally with cycles; receive a `jobId`
  immediately (print/JSON runs wait for it before exiting, RPC runs before settling).
- `braid_status` — retrieve progress and results with `{ "jobId": "..." }`, or
  add `"executionId": "..."` for an exact invocation's full output/error.
  `"nodeId": "..."` selects that node's latest invocation. Omit all IDs
  to list jobs in the current session. A job read names each execution's inputs
  and shows how long each running execution has run, its phase, and its model
  requests and tool calls. Reading a
  running job again when nothing changed returns only that progress and a reminder
  to wait.
- `braid_update` / `braid_resume` — add, edit, rerun, or remove nodes, or release paused executions.
- `braid_pause` — pause running executions, or the whole job, without losing their
  work; with `after: true`, hold a running execution's result once it finishes.
- `braid_cancel` — cancel a job with `{ "jobId": "..." }`, or add
  `"executionIds"` to fail only those executions.
- `braid_finish` — print/JSON runs only: record the run outcome with
  `{ "status": "success" | "failure", "summary": "..." }`.
- `/braid [jobId]` — open a live flow panel in interactive Pi.
- `/braid:review [target or focus]` — run a bounded parallel review/fix loop.
- `/braid:clear` — clear the progress widget above the editor; run it again while
  the widget is empty to restore what was cleared.

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
When idle, it starts a new agent turn automatically. Tool descriptions, the
system prompt, and the submission receipt tell the agent to continue independent
work, or end its turn if it needs the result, and not to sleep, use a timer, or
poll in a loop to wait for the job.
Stopping the foreground response does not stop background jobs.

### Single-shot and CI runs

In print mode (`pi -p`) and `--mode json`, background execution works unchanged:
the run stays open until every Braid job reaches a terminal status and its
reminder has been delivered, then exits after the parent's final response.

```sh
pi -p "Use Braid to review the changes and summarize the results."
```

The parent submits, ends its turn, and is resumed by the reminder as in
interactive Pi, so `pauseAfter`, `notifyOnCompletion`, `braid_update`, and
`braid_resume` keep working. Paused executions are never resumed automatically.
If the parent ends its turn while only paused executions remain, it receives one
warning naming them; ending the next turn without resuming them cancels their
jobs, gives the parent a final turn on the cancellation reminder, and exits 1.

`--braid-ci-timeout <duration>` bounds the whole run, starting at its first
prompt. It accepts milliseconds or an `s`, `m`, or `h` suffix (for example
`--braid-ci-timeout 30m`). On expiry, outstanding jobs are cancelled, the parent
gets a final turn on the cancellation reminders, and the run exits 1. Either
forced cancellation prints a `Braid:` line on stderr.

A failed graph does not by itself fail the run. Instead, the parent is told to
call `braid_finish` with `status` `success` or `failure` and a short `summary`
once the task is done. The tool only records the outcome; the run still ends
when the parent ends its turn with no Braid job outstanding, and a later call
replaces the earlier outcome. A final `failure` exits 1 and prints
`Braid: run reported failure: <summary>` on stderr. `success` never overrides a
non-zero exit from a forced cancellation or from Pi itself. If the parent never
calls it, the exit status is Pi's own apart from forced cancellations.

In `--mode json`, the final outcome is also written as a session entry, after the
`tool_execution_end` event of the call itself:

```json
{"type":"entry_appended","entry":{"type":"custom","customType":"braid-finish","data":{"status":"failure","summary":"Review found 2 blocking issues.","forcedFailures":[]},...}}
```

`forcedFailures` lists any forced cancellations, which fail the run whatever the
reported status. The entry is not part of model context, and text mode still
prints only the parent's final response. `braid_finish` is not offered in
interactive or RPC sessions.

Pi SDK sessions default to print mode too, so `session.prompt()` returns only
after outstanding Braid jobs drain.

### RPC and SDK hosts

Jobs run inside the Pi process, so they end with it. RPC hosts usually treat
`agent_settled` as the end of a run and may close Pi's stdin then, so in
`--mode rpc` (and SDK sessions bound with `mode: "rpc"`) a run does not settle
while a Braid job is running. The parent still submits, ends its turn, and is
resumed by the reminder; `agent_settled` arrives once the jobs are done and the
parent has handled their reminders.

While the run waits, Pi is busy, so send user input as `steer`, `follow_up`, or
`prompt` with `streamingBehavior`. Braid lets a queued message through at once:
the parent answers it in a turn of its own, and the run then keeps waiting. A
plain `prompt` fails with "Agent is already processing", as it does during any
long tool call. `abort` ends the wait at once: the run settles with
`aborted: true`, and the jobs keep running, as stopping the foreground response
never cancels them. If Pi keeps running, their reminders start new runs; if the
host ends Pi, they are lost. To cancel jobs, steer the parent to cancel them.

Paused work does not keep the run open. When only paused executions, held
results, reruns at `maxRuns`, or paused jobs remain, the run settles and that
work waits for the next message. It is lost if the host ends Pi at that point.

Only interactive Pi settles while jobs run; there, each reminder starts a new
run.

### Migrating from blocking mode

Blocking mode, `--braid-blocking`, and `/braid:blocking` are removed in 0.5.0.
Drop the flag or command. Print and JSON runs wait for background jobs before
exiting, and `braid_finish` sets the run outcome. The parent submits the graph,
ends its turn, and retrieves results with `braid_status` after the completion
reminder. `pauseAfter`, reminders, and live updates remain available.

Jobs live in memory for the current Pi session. Quitting, reloading extensions,
or switching/forking sessions aborts outstanding work and suppresses its
reminders. Job IDs cannot be retrieved after that lifecycle ends. They are not
persistent processes outside Pi.

## Review command

Run `/braid:review` to review current uncommitted changes (including staged, unstaged,
and non-ignored new files). With no uncommitted changes, it reviews the latest
commit. Supply a file, commit range, or focus with `/braid:review src/runtime.ts` or
`/braid:review main..HEAD, focus on cancellation`. Workers inspect the supplied target
with local tools; they report unavailable remote targets instead of inventing
their contents. Use `/braid:review review-only, src/runtime.ts` to request findings
without fixes.

Each round assigns three independent, read-only reviewers distinct angles based
on the change. Findings need concrete evidence and file/line references, with
P0/P1/P2 priority and a merge verdict. One writer synthesizes the feedback and
fixes only evidenced, in-scope P0/P1 problems in an isolated worktree, then runs
focused validation. Optional P2 polish is reported. A product, scope, or
architecture decision stops the loop for user input.

The graph enforces a fixed maximum of **three review rounds**, including the
first, and **two fix passes**. The final round reports remaining issues without
making further edits; reaching the cap does not mean the review is clean.
Only fixes that passed re-review and validation are integrated into the invoking
checkout, preserving existing user changes. Conflicting concurrent edits or
failed validation leave the fix checkpoint archived for recovery. Outside Git,
workers can only inspect files and report findings.

The command returns immediately with a job handle. Use `/braid [jobId]` to see
progress, `braid_status` for results, and `braid_cancel` to stop. The existing
completion reminder resumes the parent to report rounds, applied fixes,
validation, remaining findings, and the stop reason. Session shutdown cancels
the job. Cancellation or failure during integration can leave partial checkout
changes; Braid retains backup and checkpoint refs for recovery.

The review policy is adapted from pi-subagents'
[review-loop](https://github.com/nicobailon/pi-subagents/blob/main/prompts/review-loop.md)
and [parallel-review](https://github.com/nicobailon/pi-subagents/blob/main/prompts/parallel-review.md)
prompts. Invoking `/braid:review` authorizes the narrow fix passes described above;
an explicit review-only request disables them.

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
update takes effect. The submission reply gives the job ID and how to wait for
it; it does not repeat the graph the agent just sent. Update replies list the
resulting graph without prompts. If a definition problem repeats,
inspect/report the mismatch instead of launching more probe jobs.

Edges use exact node IDs in `from` and `to`. `choice` is an exact label declared
by the source decision; omitting it makes the edge unconditional. Pass `edges: []`
for independent roots.

Any edge may close a cycle, and cycles may be unconditional, nested, or
overlapping. A retry cycle is usually closed by a decision's choice edge back to
the node where each round starts, such as
`{ "from": "check", "to": "work", "choice": "retry" }`; an unconditional cycle
repeats until the parent stops the job, and edges that leave it run in every
round. The `braid` and `braid_update` results list each new cycle and what can
stop it, so an accidental cycle is noticed. They also name a node that runs only
after a decision in the cycle chooses it: when each round should start there
instead, set `"closesCycle": true` on that choice edge. To bound the rounds, set `maxRuns` on
a node in the cycle, so `maxRuns: 3` on `work` allows three rounds; omit it unless
the user asks for a limit. `maxRuns` counts every run of that node, including
reruns after an upstream change and runs in earlier rounds of an enclosing
cycle, but never blocks your own replacement of it. A rerun past the limit
waits instead of starting, and once nothing else is active the parent gets the
waiting reminder: upsert the node with a higher `maxRuns` in `braid_update` to
let the waiting rerun start (it is edited in place), or release it with
`braid_resume` to end the rerun, which in a cycle ends the cycle. Each round runs new
executions, named `<nodeId>@<generation>`. See the
[cycle example](../../docs/execution-control.md#cycles).

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
Each reminder identifies the exact `executionId`, `<nodeId>@<generation>`.
`braid_status({jobId, executionId})` retrieves that instance's full output/error;
`nodeId` selects the latest instance. Skipped executions stay silent. Reminders
are acknowledged when they enter context and retried if foreground cancellation
drops the queued message. Session shutdown suppresses delivery.

Set `pauseAfter: true` to hold an execution's outgoing scheduling and receive a
pause reminder. Independent branches continue. Fetch `braid_status` to obtain
the current graph revision and paused execution IDs, then:

```json
{
  "jobId": "job-1",
  "expectedRevision": 0,
  "upsertNodes": [{ "type": "execute", "id": "fix", "prompt": "Implement the findings." }],
  "addEdges": [{ "from": "inspect", "to": "fix" }],
  "resume": ["inspect@1"]
}
```

Pass this to `braid_update`. It validates and commits the full change and resume
atomically.

A started execution never changes: upserting a running node with `pauseAfter`
would replace it. To review the result of an execution that is already running, call `braid_pause({jobId, executionIds,
after: true})`. The execution is not suspended: it keeps running, and once it
finishes, completed or failed, it is held exactly like `pauseAfter`, with a pause
reminder. `braid_resume({jobId, executionIds, after: true})` removes the hold
while it is still running, including one that came from `pauseAfter`. Either
way only those executions change, not their node definitions. A result that is
already held is released with the usual `braid_resume` or `braid_update`
`resume`. To continue without edits, call `braid_resume({jobId,
expectedRevision, executionIds})`.

`braid_update` acts on each node's latest execution. Upserting a node that has
not started edits it in place. Upserting a node that has started, running or
finished, replaces it: a new execution runs with the new definition, a running
one is cancelled, and once the replacement finishes, the nodes downstream of it
rerun. Upserting an unchanged definition reruns the node. To review a
replacement before its downstream nodes rerun, give it `pauseAfter: true`. An
edge added into a finished node reruns it once its new input finishes.
Rejected revisions/changes have no effects. Finalized jobs cannot be reopened.
Include new nodes and their dependencies in the same update. A new node
without incoming edges is a root that can start at once; another node's
`pauseAfter` does not hold it. After a rejected update, retry the complete
corrected patch, including edges and resume IDs, instead of staging disconnected
nodes separately.
Pause reminders describe the event when it occurred: check current status and
paused IDs before attempting an update/resume, since the job can time out or be
cancelled before the parent handles the reminder.

When the last running execution finishes while held or suspended work remains,
nothing more runs until the parent acts, so the parent gets a waking reminder
that lists what the job waits on and how to release, resume, or cancel it. It is
sent once each time the job reaches that state. There is none when that work is
only what the user paused or held from `/braid`, when the user paused the whole
job, or when the parent's own `braid_pause`, a held result's pause reminder, or
a timeout pause reminder already accounts for it.

Execute and decision nodes have a `request_replan` tool. A node calls it to
report a finding that contradicts its prompt's assumptions, makes its task
unnecessary, or affects more than its task, with a reason and optionally a
suggested graph edit (`upsertNodes`, `removeNodeIds`, `addEdges`, `removeEdges`)
that core checks against the current graph. Nodes cannot change the graph
themselves, and they see only the goal, their prompt, and direct predecessors:
the parent decides which planned work a finding affects. Saying in a node's
prompt what related work other nodes handle makes its requests more precise. The parent gets a waking reminder at once;
the node keeps working, and its result is held when it finishes, like
`pauseAfter`. `braid_status` shows the reason and suggestion. The parent can stop
other branches with `braid_pause`, then change the graph and release the node
with `braid_update` and `resume`, keep the plan with `braid_resume`, or cancel.

Focused `braid_status` reads also start with the current control fields: graph
status, revision, and paused execution IDs. Use that current revision for
updates even when inspecting an older invocation.
After cancellation or finalization there are no resumable paused executions;
the event log still records where pauses occurred.

`upsertNodes` takes whole node definitions, so include all required fields.
`promptTemplates` replaces the entire map when supplied; omitting it preserves
the current templates. `removeNodeIds` removes nodes with their edges and cancels
a running execution; finished executions stay in `braid_status`. `removeEdges`
identifies edges by `from`, `to`, and `choice`; an omitted `choice` is not a
wildcard, and removing a node or edge that does not exist is an error. `resume`
and `braid_resume.executionIds` take paused, suspended, or limited execution IDs,
not node IDs.

`requireSuccess` defaults to false. Optional failures retain artifacts and allow
unconditional recovery; required failures cancel siblings and fail the job after
cleanup. A node's `maxRuns`, total `maxExecutions`, `maxTokens`, and the
timeouts are unlimited unless set; `maxExecutions` spans updates. `maxRuns` is
the most runs the node's lineage can reach and never resets; upserting the node
with only `maxRuns` changed raises or lowers it at any time without rerunning the
node. Deadlines keep
running through pauses. The graph timeout includes time waiting for the parent
to inspect and update a paused graph, and resuming does not extend it.

Reaching `maxExecutions`, `graphTimeoutMs`, or `maxTokens` pauses the job instead
of failing it (`options.onLimit: "fail"` fails it). `maxExecutions` only stops new
executions; the other two also pause running ones. Once nothing is active, the
parent gets the waiting reminder, and `braid_resume({ jobId, limits })` raises the
limit and resumes the job. The job does not resume while the limit is still
reached. `/braid:review` bounds its rounds with `maxRuns` on its writer node and
keeps failing at that limit.

See [execution control](../../docs/execution-control.md) for cycle schemas, exact
update and rerun semantics, and workspace lineage. There is no
scheduler persistence across Pi reloads. Reminders alone do not pause execution.

### Pausing running executions

`pauseAfter` holds a result after the execution finishes. To stop work that is
still running, call `braid_pause({jobId, executionIds})`. Each execution finishes
its running tool, then stops before its next model request. It keeps its
conversation, workspace, and tool budgets, and releases its concurrency slot to
other nodes. Messages sent to it from the `/braid` assistant while it is paused
are delivered when it resumes. Resume with `braid_resume({jobId, expectedRevision,
executionIds})` or `braid_update` with `resume`; the worker continues the same
conversation. A transient-error retry also waits at the pause point before resending.

Omit `executionIds` to pause the whole job: no new executions start and running
ones pause. `braid_resume({jobId})` resumes the job and the executions that the
job pause paused; executions paused separately stay paused.

The node timeout stops while an execution is suspended; the graph timeout keeps
running. `braid_status` shows suspended executions, a job pause, and who paused
them.

### Node timeouts

When an execution exceeds `options.nodeTimeoutMs`, it is paused instead of
failed. Its current model request or shell command is stopped; the interrupted
call, with any output it produced, and any calls after it in the same batch are
recorded in its conversation. Its conversation, workspace, and tool budgets are
kept, and its successors wait. The parent is woken with a reminder that says how
long the execution ran, what it was doing, and what it can do next:

- `braid_resume({jobId, expectedRevision, executionIds})` gives it the job's
  `nodeTimeoutMs` again; add `nodeTimeoutMs` for a different budget.
- `braid_update` with `resume` and `resumeOptions: { nodeTimeoutMs }` resumes it
  together with graph changes.
- `braid_cancel({jobId, executionIds})` fails only that execution with
  `NODE_TIMEOUT`; its successors follow the usual failure rules.

Resuming the whole job does not resume a timeout pause. Set
`options.onNodeTimeout: "fail"` to fail on timeout instead.

Users can pause and hold from the panel too (`p` and `h`, below). The parent is not woken for
that: one notice with the latest state per execution or job is added to its next
turn, and it is told not to resume work the user paused unless the user asks.
In print and JSON runs, a job held only by pauses counts as stalled: the parent
gets one warning, and the job is cancelled if it ends the next turn without resuming.
In RPC runs, such a job lets the run settle and waits for the next message.

## Live flow panel

In interactive Pi, background progress appears automatically **above the input
editor** as soon as a job is submitted; no command or polling is needed:

```text
Braid job-1 · running · 2/5 done · review
```

The widget shows node progress, active node IDs, paused gates, and failures.
It shows up to three active jobs, with an overflow count for the rest. When no
jobs are active, the newest job's final completed/failed/cancelled status stays
visible until another job is submitted or the session ends. Run `/braid:clear`
to clear the widget: it clears every job submitted so far, including running
ones, and jobs submitted afterwards still appear. Running it again while the widget
is empty restores the most recently cleared jobs. Counts use the
latest execution of each current node; failed and skipped nodes count as
done, and reruns or live edits can change progress and totals. RPC, JSON, and
print modes do not create a terminal widget.

Run `/braid` to open the newest job, or `/braid <jobId>` to open a specific job.
The bordered panel keeps the job header and keyboard controls visible while
you scroll the flow and event log. It refreshes as nodes start, finish, fail,
and pass outputs downstream.
Use Left/Right to select jobs, Up/Down or Page Up/Page Down to scroll, `c` to
cancel the selected job, `p` to pause or resume it, and Escape or `q` to close the panel.
In selection or an open session, `p` pauses or resumes the selected or open
execution instead; a suspended node shows `‖ PAUSED`, and one paused by its node
timeout also shows `timed out`. `h` holds that execution's result once it
finishes, removes the hold if one is set (its status shows `· hold`), or
releases a result that is already held. Press `x` twice there to cancel only
that execution; the parent gets a notice with its next turn. Closing the panel
leaves jobs running. In RPC or noninteractive modes, use `braid_status`.

A flowchart wider than the terminal is cropped to the terminal width around the
first running execution, or from its left edge; a `[chart 1–76 of 245 cols]` line
shows the visible columns.

### Live and timeline views

The panel draws one box per execution, in one of two views. Press `g` to switch
between them; the panel title (`Braid · live view` or `Braid · timeline view`)
and the footer show the active one, and the panel keeps your choice while it is
open, across jobs and sessions.

- **Timeline view** (default): every execution, oldest first, in one flat
  graph: every round of a cycle appears below the round before it, labelled by
  its execution ID (`review@2`). Skipped executions show `⊘` and the reason, pending ones `○`.
  Replaced executions stay and show `superseded → <executionId>`, and executions
  of removed nodes show `removed`.
- **Live view**: only executions that have not released their result
  downstream yet: pending, running, and held. It shows what the job is doing
  now and what comes next, and stays small however long the job runs. A pending
  execution shows why it waits (`waits predecessors`, `stale`, `hold`,
  `choice`, `limit`, `run paused`, or `slot`); a running one shows whether its
  worker is in a `model` request or a `tool`, `· hold` if its result will be held, and paused
  or pausing. When nothing is live, for example once the job has finished, the
  view says so and points to the timeline.

In both views, solid edges are the inputs an execution ran with. Dotted edges
show the input a pending execution will use or the upstream result a skipped
one saw, and a dotted `replaces` edge links a replaced execution to its
replacement. Edges to executions that a view does not draw are left out.

So long runs stay readable, the timeline shows the last two generations of each
node and folds older finished executions into one `≡` box per node
(`≡ review@1–3`); pending, running, and held executions are never folded. Press
`e` to show every generation, and `e` again to fold them. Either way at most 80
boxes are drawn; the oldest finished executions fold first.

Press `v` to select an execution: the arrow keys move a `◆` marker through the
flowchart (starting at a running execution, or in the timeline at the newest
one), and the view pans horizontally and scrolls vertically to keep the
selection in sight. If the flowchart cannot be drawn, a list replaces it while
selecting. Pressing `g` while selecting keeps the same execution selected when
the other view draws it, or moves to the newest drawn execution of the same
node. Enter opens that exact execution as a live session, and `p`, `h`, and `x`
act on it. Left/Right in the session switch to the node's other executions,
including folded and settled ones. Escape returns to the execution you were
viewing, or, when the current view does not draw it, to the newest drawn
execution of the same node. The session is drawn with Pi's own chat
components, as in the main conversation: the worker's prompt, streamed
assistant text and thinking, and tool cards whose arguments and output update
while they run. The node summary—status, elapsed time, usage, context, and live
activity (see below)—stays pinned at the top while the session scrolls. The
session follows the newest lines; scroll up to pause, and press End to follow again. Left/Right switch between
invocations of the same node (for example rounds of a cycle), and ctrl+o expands
tool output. Escape steps back one level—session, then selection, then the
graph—and closes the panel from the graph; `q` closes it from anywhere. Running
invocations and the 20 most recently finished ones per job keep their session;
older ones show the summary and activity history.

### Assistant

Press Tab to open an assistant and Tab again to hide it. While it is open,
every key goes to it, including `q` and `c`; type a question and press Enter.
Escape stops an answer in progress, or hides the assistant. PgUp/PgDn or the
mouse wheel scroll the conversation. A panel at least 100 columns wide shows
the assistant beside the graph or session; a narrower one shows it in their
place.

Conversations are scoped. On the graph, the assistant talks about the whole
job. With a node selected (`v`) or its session open, it uses that node's own
conversation, shared by all of the node's executions; each question says which
execution is shown. Each scope keeps its history for the Pi session, including
while the assistant or the panel is hidden.

In fullscreen mode the mouse wheel also scrolls the left side: the graph, a
node session, or a node's details and history. Scrolling a session up stops it
following new output; scrolling back to the bottom resumes.

The assistant uses the main session's current model. It does not see the main
conversation; each question tells it what the panel shows (the graph, the
selected node, or the open session), and it reads the job through its own
tools: job status and graph, an execution's details and activity, and the
latest messages of a worker's conversation. It cannot edit the graph, cancel,
or resume; ask the main agent for that.

To steer a running execution, tell the assistant what it should do. The
assistant messages that execution for you, and only when you ask. The message
waits, shown as pending in the execution's session, and is delivered before the
worker's next model request. A tool batch that is running finishes first and is
never interrupted. If it arrives while the worker is writing its final answer,
the worker gets one more round to take it into account. The worker receives it
labelled as a message from the supervising human, separate from the node prompt
and predecessor outputs; it cannot lift tool, budget, workspace, or decision
constraints (a decision node that has already called `decide` keeps its
choice). Delivered messages appear in the session, in the activity history, in
the event log, and in the execution's `humanInputs` in `braid_status` results,
so it stays visible that the result did not come from the graph alone. Messages
still pending when the execution ends are marked as not delivered and are not
recorded as input. Finished executions, including those held by `pauseAfter`,
cannot be messaged.

Run `/braid <jobId> <nodeId>` to open that node's latest invocation directly in
the session view, or `/braid <jobId> <executionId>` for an exact invocation such
as an earlier round of a cycle. The header shows live activity for that exact invocation: the current phase
(workspace preparation, worker, model request, tool, or checkpoint/cleanup) and
how long it has been in it, time since the last observed signal, total time, the
in-flight model request (sent, awaiting the first stream event, or streaming
text/reasoning/tool-call arguments with a character count and latest tail), and
running tools with their arguments, elapsed time, and latest output. Focused
`braid_status` reads, and invocations whose session is no longer retained, add a
chronological history of model requests and responses, assistant text, tool calls
and results, workspace changes, and completion, with bounded detail previews.
A quiet period is shown as elapsed time, not declared a stall. If the host cannot
report a signal—for example a model registry without streaming—the view says so.
Tab completes job handles and then that job's node IDs.
IDs with leading/trailing whitespace, terminal controls, or a leading double
quote use JSON string syntax, such as `/braid job-1 " review "` or
`/braid job-1 "review\nstep"`. Tab inserts this form automatically and displays
control characters as escapes.

The panel renders a Mermaid flowchart of executions, their states, elapsed
times, context-token estimates or provider-reported usage, context-window sizes,
filesystem tool-call counts, and the execution log. Active executions are marked
`▶ ACTIVE`. The `braid` and status tools render a flowchart with one box per node,
its latest execution, showing its status, number of runs, and the tokens all its
executions used; expand the result to see more log events. In that chart, a
forward edge opposite the edge that closes a cycle is drawn dotted, while the
closing retry edge stays solid: `/braid:review` shows the direct `scope → check`
handoff dotted and `check → scope` (`retry`) solid.
When selecting `nodeId` or `executionId`, it instead shows that invocation's
output/error and activity, with the full text and history available on expansion.

The Braid tools return plain-text documents to the model, not JSON. A
whole-job read lists the control state, every execution, their outputs,
workspaces, and the current graph without prompts. A focused read shows one
execution's output and its activity with the latest 40 history entries; pass
`activityBefore` with an entry sequence to page earlier ones. While the invocation
runs, the activity comes before the output so it survives preview truncation.
Worker `git` results read like Pi's bash output, and `decide` returns
`Recorded choice: <choice>`.

`/braid` now opens this panel; it no longer arms the next prompt. To request
Braid explicitly, ask the agent to analyze the task using Braid.

Braid owns graph validation, scheduling, joins, routing, skip/failure propagation,
timeouts, Git worktree/checkpoint/merge lifecycle, and result metadata. Pi owns
model lookup, credentials/OAuth, provider transport, filesystem tool execution,
and token/cost accounting. The first
whole-job `braid_status` retrieval of a finished job reports its accumulated Pi usage;
subsequent retrievals do not count the same usage again.
The whole-job status text reports Pi's totals as `Usage`, including completed
provider rounds from nodes that later fail or time out; core `metadata.usage`
only includes usage returned by runners.

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

Requires Node.js 22.19+ and Pi 1.2.0 (the tested version):

```sh
pi install npm:@chrok/pi-braid
```

Add `-l` for a project-local installation. Run `/reload` after installation.
The package depends on the exact matching `@chrok/braid` release; npm installs
core automatically. It does not bundle core or depend on a source checkout.
Pi supplies its core peer packages at runtime.
Their wildcard ranges follow Pi's packaging convention, not universal version
compatibility. Development and CI pin Pi 1.2.0.

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
untracked caller edits. Later rounds of a cycle get new worktrees; they never reuse a
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
| `maxModelRetries` | Retries per model request for transient provider errors; default 3, `0` disables, at most 10 |
| `nodeTimeoutMs` | Active time allowed for each node after it starts, excluding pauses, in milliseconds |
| `onNodeTimeout` | `pause` (default) suspends a timed-out node and wakes the parent; `fail` fails it with `NODE_TIMEOUT` |
| `graphTimeoutMs` | Time allowed for the entire graph, including queueing and pauses, in milliseconds |
| `maxExecutions` | Total started and skipped executions; unlimited by default, positive safe integer |
| `maxTokens` | Total input and output tokens reported by all executions, checked as each finishes; unlimited by default |
| `onLimit` | `pause` (default) keeps a rerun past its node's `maxRuns` waiting, or pauses the job at the other limits, and wakes the parent; `fail` fails the job |

For example, `options: { maxToolRounds: 20, maxToolCalls: 60, nodeTimeoutMs: 120000 }`.
Omit tool, time, execution, and token fields for no limit; programmatic options also accept `Infinity`.
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
cancelling jobs. To set a node or graph timeout,
supply milliseconds in the submission tool input under `options`; each omitted
timeout remains unlimited:

```json
{
  "maxConcurrency": 2,
  "nodeTimeoutMs": 30000,
  "graphTimeoutMs": 120000
}
```

The adapter sets `cacheRetention: "none"` and gives each node a fresh provider
context. Tool budgets are unlimited unless `maxToolRounds` or
`maxToolCalls` is set. Missing paths, invalid arguments, disallowed writes, and
unavailable tools are returned as tool errors so the node can recover. Provider
authentication and calls may still incur normal provider costs. Braid cannot
forcibly stop synchronous JavaScript or a remote provider that ignores
cancellation. Cancellation prevents further tool calls but does not roll back
writes already made. Core waits for tracked writes, preserves checkpoints, and
removes worker worktrees before completing cancellation.

### Transient model errors

A transient provider error, such as a rate limit (HTTP 429), overload, a 5xx
response, or a dropped connection, is retried inside the running node execution.
The node keeps its conversation, tool results, workspace, decision, merge state,
and tool-budget counts; the failed request is sent again with the same context.
Tools run only after a complete model response, so a retry never repeats a
completed tool call. `options.maxModelRetries` sets the retries for each model
request (default 3; `0` disables them):

- If the provider rejects a request before its response starts, Pi's provider
  client retries it with exponential backoff and honors `Retry-After`. A requested
  wait longer than 60 seconds fails immediately.
- If a response stream fails after it started, Braid discards the partial
  response and restarts the request after 2, 4, then 8 seconds.

Quota, billing, and other non-transient errors are not retried. Retries stop on
cancellation, and Braid does not start a wait that would outlast the node or
graph deadline. When retries run out, the node fails with the provider error and
follows the usual failure rules, including `requireSuccess`. Failed attempts stay
visible in the session view, and their reported usage is counted. Braid does not
retry a whole node execution.

The tool output is capped at 50KB/2000 lines to protect Pi context. When exceeded,
the adapter writes the complete text to a temporary file (mode 600 on POSIX;
inherited ACLs on Windows) and ends the preview with its path, for running jobs
as well as finished ones.

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
