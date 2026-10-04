# Braid for DeepSeek Harness (`@chrok/dsh-braid`)

A native DeepSeek Harness plugin for background Braid graphs, bounded loops,
isolated Git worktrees, live updates, pause/resume, and completion reminders.
It uses DSH's provider routing and credentials through `ctx.llm`; it has no Pi
runtime dependency. Tested against **DSH 0.2.0-rc.2** and Node.js **22.19+**.
DSH is in developer preview, so host peer versions are pinned to this baseline.

## Install

From this repository:

```sh
npm ci
npm run build:dsh
dsh plugin --profile web add ./integrations/dsh
```

Restart the DSH profile after installation or rebuilding. The package includes
`dsh.bundle` metadata and `cordis.patch.yml`, so installation activates the plugin.
It requires the `tools`, `llm`, `commands`, `systemPrompt`, and `jobs` services,
which the standard DSH composition provides. Custom profiles must provide them.

Once published, the planned npm installation command is:

```sh
dsh plugin --profile web add @chrok/dsh-braid
```

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
| Atomically edit/resume | `braid_update({ jobId, expectedRevision, ...patch })` |
| Resume without edits | `braid_resume({ jobId, expectedRevision, executionIds })` |
| Cancel | `braid_cancel({ jobId })` or `/braid cancel <jobId>` |
| Human progress snapshot | `/braid [jobId]`, `/braid list` |
| Graph, execution details and controls | **Braid** in the session header or right-sidebar guide |
| Generic job progress and cancellation | DSH's native **Jobs** panel |

Submission immediately returns a short `job-1` handle, a canonical UUID, and
`nativeJobId` (for DSH's generic job tools/panel). Braid tools accept the short
handle or UUID, exactly. Handles are scoped to the live agent; another agent or
session cannot retrieve them. Native job IDs belong to DSH's separate registry.
Receipts echo accepted node types, policies, overrides, and edges without prompts.

## Braid Web panel

Click **Braid** in a session's header, or choose **Braid** from the right-sidebar
guide. Braid's five tool calls also render as clickable transcript cards:

| Tool card | Recorded summary and navigation |
| --- | --- |
| `braid` | Submission receipt and node count; opens the submitted graph once the receipt arrives |
| `braid_status` | Recorded status, revision and execution progress; focuses a requested node/execution; list results provide a link for each job |
| `braid_update` | Before/after revision, upserted/removed nodes, edge counts and resumed executions; rejected updates are marked as not applied |
| `braid_resume` | Requested execution IDs and remaining pauses; a single execution links directly to its history |
| `braid_cancel` | Cancellation requested or job already finished; opens the original job |

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
- View the latest 80 lifecycle events and input/output/cache token totals.
- Cancel the job, resume one paused execution, or resume all paused executions.
  Resume submits the revision currently displayed; stale revisions are rejected
  and surfaced in the panel. Editing a graph remains a model-tool operation.

The Host sends structured snapshots through DSH's authenticated Remote transport,
coalesced to at most one update per 150 ms per observer. Prompts, provider messages
and node outputs are excluded from that stream; selected outputs are read
separately. Switching sessions or closing the tab stops observation, while jobs
continue. Disconnected controls are disabled; the panel retries the stream, then
offers manual reconnect if retries fail.

The package declares `dsh.client` and exports `./client`, a DSH module-loader
factory sharing the shell's React instance. The Web profile must provide
`typert`, `remote`, the slot renderer, conversation header, tool views and right sidebar.
Custom headless profiles can omit these services and retain the tools/commands.
Unloading the plugin removes its tab type, slots, styles and Remote methods.

The generic Jobs panel also streams a text flow diagram, node states, elapsed times, context
token estimates/provider reports, context capacity when available, tool counts,
and recent events. Its own stop action cancels the Braid run. Closing the panel
leaves it running. `/braid` returns a snapshot in the command UI; it does not open
Pi's terminal overlay or bind Pi's keyboard shortcuts. Headless profiles can use
the tools and commands without a Web UI.

The five graph tools expose the same execution controls as the Pi integration.
DSH presentation uses a native Web graph panel, jobs and commands; it does not
include Pi's Mermaid terminal renderer. Tool results are canonical JSON for both native and PTC mode.

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
itself. Fixed local tools are:

- `read` and `ls`; `grep` and `find` when `rg` is installed. Missing search
  dependencies are not downloaded; use `ls`/`read` instead.
- `write`, `edit`, and `bash` for writable Git workspaces; `powershell` on Windows.
- `git` when core provides Git access; `finish_merge` for merge/integrate nodes.
- `decide` only for decision nodes, with exactly one declared choice.

Guarded writes reject paths outside the assigned workspace, Git metadata,
submodules, symlinks, hard links, and special files. Shell commands use host
permissions and can bypass file guards; worktrees are not an OS sandbox. Workers
are instructed to keep writes local, preserve shared Git state, and avoid global
or externally visible actions unless requested. Commands run in the foreground;
completion, timeout, and cancellation terminate their process group. Ignored new
dependencies, caches, and build outputs are not checkpointed and disappear during
cleanup. Shared services and ports require execution-specific resources.

## Pauses, updates, loops, and reminders

`notifyOnCompletion: true` sends an intermediate success/failure reminder.
`pauseAfter: true` additionally holds outgoing scheduling; independent branches
continue. Reminders identify the exact invocation and loop iteration in the job
data. Fetch `braid_status`, then use its **current** `execution.revision` and
`execution.pausedExecutionIds`:

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

Completion and pause messages use DSH `agent.steer`: a running agent consumes
them at the next step, and an idle agent wakes. Acknowledged messages are removed;
discarded messages retry when the agent returns to idle. DSH's generic job
controller may also show its native job completion notice. Retrieve results after
the reminder instead of polling. Stopping a foreground response does not cancel
submitted jobs. Plugin or owning-agent disposal aborts workers, awaits cleanup,
and suppresses Braid reminders. Switching the UI to another still-live agent does
not dispose the original owner or redirect its reminders. Jobs are in memory;
they do not survive a DSH restart.

## Budgets and accounting

`options` accepts `maxConcurrency` (default 4), `maxExecutions` (default 1000),
`maxToolRounds`, `maxToolCalls`, `nodeTimeoutMs`, and `graphTimeoutMs`. Tool/time
budgets are unlimited when omitted. Limits count rejected tool calls too. Workers
receive remaining budget/deadline reminders before model requests. Graph deadlines
continue during pauses and do not reset on resume or update.

`braid_status.usage` aggregates DSH usage, including completed provider rounds
from workers that later fail or time out. Input/cache fields are disjoint;
`totalTokens` includes input, output, cache reads, and cache writes. Core runner
usage combines input/cache into `inputTokens`. DSH does not offer Pi's external
tool-cost accounting contract: repeated status reads return the same totals
without adding charges to the foreground agent. No dollar cost is inferred.

Results over 50 KB are saved as private JSON files in the host's temporary
directory. The bounded response preserves status/control fields and includes
`fullOutputPath`, including for running graphs and focused execution reads.
Running status retains the latest 80 events; finalized `result.events` contains
the complete core event log. Saved files remain available after job cleanup.

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
