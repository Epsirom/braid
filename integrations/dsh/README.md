# Braid for DeepSeek Harness (`@chrok/dsh-braid`)

[![npm](https://img.shields.io/npm/v/%40chrok%2Fdsh-braid?label=%40chrok%2Fdsh-braid)](https://www.npmjs.com/package/@chrok/dsh-braid)

A native DeepSeek Harness plugin for background Braid graphs, bounded loops,
isolated Git worktrees, live updates, pause/resume, and completion reminders.
It uses DSH's provider routing and credentials through `ctx.llm`; it has no Pi
runtime dependency. Tested against **DSH 0.2.0-rc.2** and Node.js **22.19+**.
DSH is in developer preview, so host peer versions are pinned to this baseline.

For Braid 0.5, read the [0.4 → 0.5 migration guide](https://github.com/Epsirom/braid/blob/v0.5.0/docs/compatibility.md#migrating-from-04-to-05).
Running executions can pause and resume, results can be held after completion,
and a configured node timeout pauses by default. Set `options.onNodeTimeout`
to `"fail"` to preserve the previous timeout behavior.

## Install

DSH support starts with Braid 0.3.1; the npm badge shows availability.

```sh
dsh plugin --profile web add @chrok/dsh-braid
```

For development, install this repository checkout instead:

```sh
npm ci
npm run build:dsh
dsh plugin --profile web add ./integrations/dsh
```

Restart the DSH profile after installation or rebuilding. The package includes
`dsh.bundle` metadata and `cordis.patch.yml`, so installation activates the plugin.
It requires the `tools`, `llm`, `commands`, `systemPrompt`, and `jobs` services,
which the standard DSH composition provides. Custom profiles must provide them.

Use your own profile name in place of `web`. Core `@chrok/braid` is installed
automatically at the matching version. No API keys belong in plugin configuration;
configure models through DSH. A node's `model` is an exact `provider/model-id`,
including any additional slashes in the model ID; omitted overrides use the parent
agent's model captured at submission.

## Tools and live control

| Capability | DSH interface |
| --- | --- |
| Submit a graph | `braid({ goal, nodes, edges, promptTemplates?, loops?, options? })` |
| List this agent's jobs | `braid_status({})` |
| Read a job | `braid_status({ jobId })` |
| Read a specific invocation | `braid_status({ jobId, executionId })` |
| Read a node's latest invocation | `braid_status({ jobId, nodeId })` |
| Page earlier activity of an invocation | `braid_status({ jobId, executionId, activityBefore })` |
| Atomically edit/resume | `braid_update({ jobId, expectedRevision, ...patch })` |
| Resume without edits | `braid_resume({ jobId, expectedRevision, executionIds, nodeTimeoutMs? })` |
| Pause running executions or the whole job | `braid_pause({ jobId, executionIds? })`; resume a paused job with `braid_resume({ jobId })` |
| Hold a running execution's result once it finishes | `braid_pause({ jobId, executionIds, after: true })`; remove the hold with `braid_resume({ jobId, executionIds, after: true })` |
| Cancel | `braid_cancel({ jobId })` or `/braid cancel <jobId>`; `braid_cancel({ jobId, executionIds })` fails only those executions |
| Human progress snapshot | `/braid [jobId]`, `/braid list` |
| Graph, execution details and controls | **Braid** in the session header or right-sidebar guide |
| Generic job progress and cancellation | DSH's native **Jobs** panel |

Submission immediately returns a short `job-1` handle, a canonical UUID, and
`nativeJobId` (for DSH's generic job tools/panel). Braid tools accept the short
handle or UUID, exactly. Handles are scoped to the live agent; another agent or
session cannot retrieve them. Native job IDs belong to DSH's separate registry.
Submission receipts give the job IDs and how to wait for the job; they do not
repeat the submitted graph. Update receipts list the resulting graph without
prompts.

## Braid Web panel

Click **Braid** in a session's header, or choose **Braid** from the right-sidebar
guide. Braid's six tool calls also render as clickable transcript cards:

| Tool card | Recorded summary and navigation |
| --- | --- |
| `braid` | Submission receipt and node count; opens the submitted graph once the receipt arrives |
| `braid_status` | Recorded status, revision and execution progress; focuses a requested node/execution; list results provide a link for each job |
| `braid_update` | Before/after revision, upserted/removed nodes, edge counts and resumed executions; rejected updates are marked as not applied |
| `braid_resume` | Requested execution IDs (or the job) and remaining pauses; a single execution links directly to its history |
| `braid_pause` | Requested execution IDs (or the job) and suspended executions; a single execution links directly to its history |
| `braid_cancel` | Cancellation requested (for the job or the listed executions) or job already finished; a single execution links directly to its history |

The main card opens the right-sidebar Braid tab in the call's owning session.
Cards retain the result recorded at the time of the call; the sidebar shows the
**current** graph and status. Raw arguments, results and errors remain accessible
under **Show tool details**, along with DSH's inspector when available. Failed
submissions and calls still preparing a new graph do not link to an unrelated
latest job. Short handles in older receipts are fenced by the call timestamp;
a job missing after a Host restart is reported as unavailable.

The panel is a native DSH tab: the sidebar provides docking, splitting,
floating and fullscreen. It follows the session that owns the tab.

- Select a Braid job and inspect its live graph. Nodes show their type and state;
  edge labels show decisions, and dashed back-edges show bounded loops. Zoom and
  scrolling accommodate larger graphs.
- Click a node to select an exact execution, including earlier loop iterations.
  Inspect output, decisions, errors, context usage, tool counts, latency, workspace
  details and recovery refs. Output is paged in 32,768-character chunks.
- Watch a running execution's live activity: phase and time in phase, time since
  the last observed signal, total time, the in-flight model request (awaiting its
  first stream event or streaming text/reasoning/tool-call arguments), and running
  tools with arguments and latest shell output. The chronological history shows
  model requests/responses, assistant text, tool calls/results, workspace changes,
  and completion; expand an entry for its bounded detail preview, or load earlier
  entries 50 at a time. Missing host signals are listed as unavailable; quiet
  periods are shown as elapsed time, not as a stall.
- View the latest 80 lifecycle events and input/output/cache token totals.
- Cancel the job, resume one paused execution, or resume all paused executions.
  Resume submits the revision currently displayed; stale revisions are rejected
  and surfaced in the panel. Editing a graph remains a model-tool operation.

The Host sends structured snapshots through DSH's authenticated Remote transport,
coalesced to at most one update per 150 ms per observer. Prompts, provider messages
and node outputs are excluded from that stream; selected outputs and activity
history are read separately. Running executions carry a compact activity summary;
stream and tool-output activity refreshes it at most once per second. Switching sessions or closing the tab stops observation, while jobs
continue. Disconnected controls are disabled; the panel retries the stream, then
offers manual reconnect if retries fail.

The package declares `dsh.client` and exports `./client`, a DSH module-loader
factory sharing the shell's React instance. The Web profile must provide
`typert`, `remote`, the slot renderer, conversation header, tool views and right sidebar.
Custom headless profiles can omit these services and retain the tools/commands.
Unloading the plugin removes its tab type, slots, styles and Remote methods.

The generic Jobs panel also streams a text flow diagram, node states, elapsed times, context
token estimates/provider reports, context capacity when available, tool counts,
and recent events; its progress line names the first running node's activity
phase, and `/braid` adds an activity line for each running node. Its own stop
action cancels the Braid run. Closing the panel
leaves it running. `/braid` returns a snapshot in the command UI; it does not open
Pi's terminal overlay or bind Pi's keyboard shortcuts. Headless profiles can use
the tools and commands without a Web UI.

The five graph tools expose the same execution controls as the Pi integration.
DSH presentation uses a native Web graph panel, jobs and commands; it does not
include Pi's Mermaid terminal renderer. Tool results are plain-text documents
for the model, in native and PTC mode alike. Each result value is `{ text, ... }`:
besides `text` it carries only identifiers such as `jobId`, `canonicalJobId`,
`status`, revision, and paused IDs, which the Web client reads from the
result's presentation meta.

## Graphs and workspaces

```json
{
  "goal": "Implement a fix, review it, and apply it",
  "nodes": [
    { "type": "execute", "id": "implement", "prompt": "Implement and test the fix." },
    { "type": "execute", "id": "review", "prompt": "Review the implementation and report evidence.", "workspace": "read-only", "pauseAfter": true },
    { "type": "integrate", "id": "apply", "requireSuccess": true }
  ],
  "edges": [
    { "from": "implement", "to": "review" },
    { "from": "review", "to": "apply" }
  ]
}
```

`execute` and `decision` require `prompt`; only decisions declare nonempty,
distinct `choices` and call `decide`. `merge` and `integrate` allow an optional
prompt and forbid `workspace`/`choices`. All four types accept `model`,
`notifyOnCompletion`, `pauseAfter`, and `requireSuccess`. Core validates every
submission and update before it takes effect.

Inside Git, each execution gets a fresh snapshot of its predecessor checkpoints;
roots include tracked and non-ignored untracked caller changes. Execute/decision
nodes default to writable worktrees. `workspace: "read-only"` keeps snapshot
isolation while removing write/edit/shell tools. Outside Git all workers are
read-only. Independent changed snapshots need an explicit merge node before
another ordinary worker can consume their combined code.

`merge` combines snapshots in an isolated worktree. `integrate` applies selected
changes to the invoking checkout, preserving user edits. Nothing automatically
integrates at job completion. Both expose constrained Git operations and require
`finish_merge` dispositions for every source execution ID. Checkpoints and
integration backup refs remain recoverable after worktree cleanup. A failed
integration can leave partial changes or conflicts; core never resets the caller.

Workers receive a fresh DSH context containing the goal, rendered node prompt,
direct predecessor outputs, execution identity, and workspace/merge metadata.
They do not inherit the parent transcript, skills, extension/MCP tools, or Braid
itself. File and shell tools are DSH's own, so their schemas, guidance, and
results match what the parent agent sees:

- `read`, `glob`, and `grep` (`dsh-tool-fs`, `dsh-tool-fs-search`).
- `write`, `edit`, and `bash` (`dsh-tool-fs`, `dsh-tool-bash`) for writable Git
  workspaces; also `pwsh` (`dsh-tool-pwsh`) on Windows.
- `git` when core provides Git access; `finish_merge` for merge/integrate nodes.
- `decide` only for decision nodes, with exactly one declared choice.

Each execution runs these tools in its own Cordis context with local
providers rooted at its workspace (`dsh-fs-local`, `dsh-bash-local`,
`dsh-subprocess-local`), so they do not depend on the host's filesystem or shell
composition. DSH's read-before-write observation policy applies. Braid's
filesystem provider rejects writes outside the assigned workspace, to Git
metadata, submodules, symlinks, hard links, and special files. Shell commands use
host permissions and can bypass file guards; worktrees are not an OS sandbox.
Workers are instructed to keep writes local, preserve shared Git state, and avoid
global or externally visible actions unless requested. Commands run in the
foreground with no background jobs or sandbox escalation; timeout and
cancellation stop them, and processes a command leaves behind are stopped when
the execution ends, before its checkpoint. Ignored new dependencies, caches, and
build outputs are not checkpointed and disappear during cleanup. Shared services
and ports require execution-specific resources.

## Pauses, updates, loops, and reminders

`notifyOnCompletion: true` sends an intermediate success/failure reminder.
`pauseAfter: true` additionally holds outgoing scheduling; independent branches
continue. Reminders identify the exact invocation and loop iteration in the job
data. Fetch `braid_status`, then use its **current** graph revision and paused
execution IDs:

```json
{
  "jobId": "job-1",
  "expectedRevision": 0,
  "executionIds": ["<paused-execution-id>"]
}
```

Pass this to `braid_resume`. `braid_update` accepts complete `upsertNodes`,
`removeNodeIds`, `addEdges`, `removeEdges`, `promptTemplates`, `loops`, and
`resume`. Use historical `edge.executionId` pins only in updates. Include new
nodes and their dependencies in the same update: a disconnected root can start
immediately. Rejected revisions/patches change nothing. Upserts replace whole
node definitions; supplied templates/loops replace their whole map/list.
`removeEdges` matches every identity field exactly; omitted fields are not
wildcards. Existing invocations retain their captured inputs and policies.
Finalized jobs cannot be reopened.

Bounded loops use a `loops` entry `{ id, entry, maxIterations }` and one feedback
edge from a decision to that entry carrying `choice` and `feedback: "<loop-id>"`.
`maxIterations` includes the first round. Loops cannot overlap or nest. Prompt
templates use `{{name}}` placeholders and node prompts such as
`{ "template": "review", "variables": { "target": "src/runtime.ts" } }`.
Variable names must match exactly; values are inserted literally.
See the [execution-control guide](https://github.com/Epsirom/braid/blob/main/docs/execution-control.md)
for the shared graph semantics.

`braid_pause` stops running work without losing it: each execution finishes its
running tool, then stops before its next model request, keeping its conversation,
workspace, and tool budgets and releasing its concurrency slot. Resume it with
`braid_resume` or `braid_update` with `resume`; it continues the same
conversation. Without `executionIds`, the whole job pauses: no new executions
start and running ones pause, until `braid_resume({ jobId })`. The node timeout
stops while suspended; the graph timeout keeps running. The panel's **Pause job**
and **Pause this execution** buttons do the same for the user. The parent is not
woken for those: one notice per execution or job, with the latest state, is
injected as context once the agent next runs, and asks it not to resume work the
user paused unless the user asks.

`pauseAfter` is captured when an execution starts, so changing it with
`braid_update` affects only later executions. To review the result of an
execution that is already running, call `braid_pause({ jobId, executionIds,
after: true })`. The execution keeps running; once it finishes, completed or
failed, it is held exactly like `pauseAfter`, with a pause reminder.
`braid_resume({ jobId, executionIds, after: true })` removes the hold while it
is still running, including one that came from `pauseAfter`. Only those
executions change, not their node definitions. A result that is already held is
released with the usual `braid_resume` or `braid_update` `resume`. The panel's
**Hold result when finished** and **Remove hold** buttons do the same for the
user, with the same notices to the parent.

Execute and decision nodes have a `request_replan` tool. A node calls it when
its findings make the planned work wrong, unnecessary, or insufficient, with a
reason and optionally a suggested graph edit (`upsertNodes`, `removeNodeIds`,
`addEdges`, `removeEdges`) that core checks against the current graph. Nodes
cannot change the graph themselves. The parent gets a waking reminder at once;
the node keeps working, and its result is held when it finishes, like
`pauseAfter`. `braid_status` shows the reason and suggestion. The parent can stop
other branches with `braid_pause`, then change the graph and release the node
with `braid_update` and `resume`, keep the plan with `braid_resume`, or cancel.

When an execution exceeds `options.nodeTimeoutMs`, it is paused instead of
failed. Its current model request or shell command is stopped; the interrupted
call, with any output it produced, and any calls after it in the same batch are
recorded in its conversation. It keeps its conversation, workspace, and tool
budgets, and its successors wait. Unlike other pauses, this wakes the parent
with a reminder that says how long the execution ran, what it was doing, and how
to continue: `braid_resume` gives it the job's `nodeTimeoutMs` again (or pass
`nodeTimeoutMs`), `braid_update` can resume it with `resumeOptions`, and
`braid_cancel` with `executionIds` fails only that execution with
`NODE_TIMEOUT`. Resuming the whole job does not resume it. The panel shows who
paused it and has a **Cancel this execution** button, which asks for
confirmation; a cancellation from the panel is a notice for the parent, like a
user pause. Set `options.onNodeTimeout: "fail"` to fail on timeout instead.

Completion and pause messages use DSH `agent.steer`: a running agent consumes
them at the next step, and an idle agent wakes. Acknowledged messages are removed;
discarded messages retry when the agent returns to idle. DSH's generic job
controller may also show its native job completion notice. Tool descriptions, the
system prompt, and the submission receipt tell the agent to continue independent
work, or end its turn if it needs the result, and to retrieve results after the
reminder instead of sleeping or polling. Stopping a foreground response does not cancel
submitted jobs. Plugin or owning-agent disposal aborts workers, awaits cleanup,
and suppresses Braid reminders. Switching the UI to another still-live agent does
not dispose the original owner or redirect its reminders. Jobs are in memory;
they do not survive a DSH restart.

## Budgets and accounting

`options` accepts `maxConcurrency` (default 4), `maxExecutions` (default 1000),
`maxToolRounds`, `maxToolCalls`, `nodeTimeoutMs`, `graphTimeoutMs`, and
`onNodeTimeout` (`pause` by default, or `fail`). Tool/time
budgets are unlimited when omitted. Limits count rejected tool calls too. Workers
receive remaining budget/deadline reminders before model requests. Graph deadlines
continue during pauses and do not reset on resume or update.

`braid_status.usage` aggregates DSH usage, including completed provider rounds
from workers that later fail or time out. Input/cache fields are disjoint;
`totalTokens` includes input, output, cache reads, and cache writes. Core runner
usage combines input/cache into `inputTokens`. DSH does not offer Pi's external
tool-cost accounting contract: repeated status reads return the same totals
without adding charges to the foreground agent. No dollar cost is inferred.

Text over 50 KB is truncated: the control fields come first, and the complete
text is saved as a private file in the host's temporary directory whose path
ends the preview (and is the value's `fullOutputPath`), for running graphs and
focused execution reads alike. Saved files remain available after job cleanup.
Worker `git` results read like DSH's bash output (`[stderr]`, `[exit code: N]`),
and `decide` returns `Recorded choice: <choice>`.

## Development

```sh
npm run check:dsh
npm run test:dsh
npm run build:dsh
npm run test:package
```

Tests use scripted providers without network model calls. They exercise real
Cordis/DSH registration, native job ownership/control, canonical tool outputs,
reminder delivery and cleanup, graph controls, loops, budgets, filesystem guards,
and process cancellation. Web tests cover the native Gateway, the built browser
factory and Remote mounting, slot registration/unload, session switching, safe
text rendering, controls, revision checks, paging and disconnect cleanup. Package
smoke tests install the packed package outside the checkout, load its browser
factory and run a background worker. All dependencies share the root lockfile.
Use `npm install --workspace @chrok/dsh-braid <dependency>` for dependency updates.

Host contracts: [DSH plugin packaging](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/basic/publish.md),
[tool authoring](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/cookbook/adding-a-tool.md),
[client modules](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/subsystems/client-modules.md),
[right-sidebar extensions](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/ui-sidebar-right/README.md),
and [native jobs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/jobs/jobs/README.md).
