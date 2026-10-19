# Execution control

Braid 0.2 separates mutable node definitions from execution instances. This is a
breaking change from 0.1, covering bounded loops (#30) and live graph updates (#31).

## Definitions and instances

A node is a reusable definition identified by `id`. An execution has a unique
`executionId`, a captured node definition, graph `revision`, predecessor execution
IDs, and, within a loop, `loopId` and a one-based `iteration`. Editing or deleting
a definition never changes or cancels an already admitted execution. Failure,
notification, pause, model, prompt, and workspace policies are captured at admission.

`result.executions` retains every instance, including earlier rounds and deleted
nodes. `result.nodes` is a convenience projection of the latest instance per node.
Workspace records are keyed by execution ID. `terminalExecutionIds` identifies
successful instances whose outputs were not consumed by another admitted instance;
`terminalOutputs` provides their latest outputs keyed by node ID. Failed instances
remain available separately, even when the overall job completes.

## Structured loops

```ts
const graph = {
  goal: "Refine until the review passes",
  nodes: [
    { type: "execute", id: "edit", prompt: "Implement the feedback." },
    { type: "decision", id: "review", prompt: "Review the result.",
      choices: ["again", "done"], workspace: "read-only" },
    { type: "integrate", id: "apply" },
  ],
  loops: [{ id: "refinement", entry: "edit", maxIterations: 3 }],
  edges: [
    { from: "edit", to: "review" },
    { from: "review", to: "edit", choice: "again", feedback: "refinement" },
    { from: "review", to: "apply", choice: "done" },
  ],
};
```

Each loop declares one entry, one decision feedback edge, and a finite positive
iteration limit. Ignoring feedback and historical references, the graph must be
acyclic. Loop bodies may fork and join; external edges enter only through the
entry and leave only through the feedback decision. Nested/overlapping loops and
arbitrary cycles are rejected. Sequential and independent loops are supported.

The first round uses external predecessors or the job's root snapshot. A feedback
choice creates another round only after all admitted instances in the current
round have settled and their pause gates have been released. The next entry also
receives the previous feedback execution. External inputs remain available in
subsequent rounds. Exits wait for the loop to finish and use the final round.
Choosing feedback at `maxIterations` fails the job with `LOOP_LIMIT`.

Loops do not overlap their own rounds. Live updates can change definitions,
edges, and loop topology during an iteration; no boundary pause is required.
Already admitted instances drain normally. Updates do not replay a completed
activation just because its definition or incoming edges changed. Use a new node
ID for new work outside a subsequent loop round.

## Live updates and gates

```ts
import { startBraid } from "@chrok/braid";

const run = startBraid({
  goal: "Inspect, then decide the next steps",
  nodes: [{ type: "execute", id: "inspect", prompt: "Find the problem.", pauseAfter: true }],
  edges: [],
}, { runner });

// After execution_paused (or after obtaining a snapshot from your host):
const state = run.snapshot();
const executionId = state.pausedExecutionIds[0];
run.update({
  expectedRevision: state.revision,
  upsertNodes: [{ type: "execute", id: "fix", prompt: "Implement the fix." }],
  addEdges: [{ from: "inspect", to: "fix", executionId }],
  resume: [executionId],
});
const result = await run.result;
```

`startBraid` returns synchronously with `runId`, `result`, `snapshot()`,
`update(patch)`, `resume(executionIds, expectedRevision)`, and `cancel()`.
`braid(input, options)` is the convenience API for awaiting the result.

Updates require the current `expectedRevision` and commit atomically. A successful
update increments the graph revision once. A stale revision or invalid candidate
changes nothing, including pause gates. `upsertNodes` replaces whole definitions;
`removeNodeIds` also removes incident edges. `addEdges` and `removeEdges` use full
edge identities, including choice, feedback, and execution ID. `promptTemplates`
and `loops` replace their respective collections when supplied. Template edits
are rendered for future admissions; running prompts remain unchanged.

Completion routes through the latest graph. If A is running and A→B is replaced
with A→C, A's completion can admit C. A previously admitted B continues with its
captured inputs. A historical dependency pins `edge.executionId` and matching
`from` to a settled execution, even if its definition was removed. Initial
submissions cannot reference history from another job.

`pauseAfter` holds an execution's outgoing scheduling and keeps the job alive,
even at a leaf. Independent branches continue. Pi sends a pause reminder;
`notifyOnCompletion` alone only sends a reminder. Resume specific execution IDs,
either on its own or in the same transaction as a graph update. Removing a paused
node definition does not discard its gate: explicitly resume or cancel it.

### Holding a running execution

`pauseAfter` is captured when an execution is admitted, so a `braid_update` that
sets it affects only later executions. To hold the result of an execution that is
already running, add a hold to that execution:

```ts
run.holdAfter([executionId], true, { source: "agent" });  // hold once it settles
run.holdAfter([executionId], false, { source: "agent" }); // or let it flow downstream
```

A hold set this way behaves exactly like `pauseAfter`: when the execution settles,
completed or failed, it is listed in `pausedExecutionIds`, `execution_paused` is
emitted, and `resume` releases it. It applies to this execution only and changes
neither its captured `node` nor the graph definition. Removing a hold that came
from the definition's `pauseAfter` releases only this execution; later ones still
pause. Each execution's `holdAfter` field (`{ source, requestedAt }`, with source
`"definition"` for `pauseAfter`) is authoritative over `node.pauseAfter`.

`holdAfter` accepts running executions only, including suspended ones, and works
with any runner. It rejects pending, settled, and held executions: once an
execution reports completion its hold no longer changes, even while it finishes
checkpointing. It neither takes nor increments the graph revision. Repeating the
current state changes nothing; otherwise `execution_hold_added` or
`execution_hold_removed` records the change and its source. A hold and a
suspension are independent: resuming a suspended execution keeps its hold, so a
held result still needs a second resume once it settles.

## Pausing running executions

`pauseAfter` holds an execution after it finishes. To stop an execution while it
is still running, without losing its work, suspend it:

```ts
const run = startBraid(graph, { runner }); // runner.pausable must be true
const state = run.pause([executionId], { source: "user" });
// state.executions[executionId].suspension.state === "pausing"
// ...later, once it is suspended:
run.resume([executionId], run.snapshot().revision);
```

| State (`execution.suspension.state`) | Meaning |
| --- | --- |
| `pausing` | Requested; the execution keeps running until its runner's next checkpoint and still holds its concurrency slot |
| `suspended` | Stopped at a checkpoint; its slot is released for other work |
| `resuming` | Resumed and waiting for a free slot; it gets one before any new admission |

A pausable runner sets `pausable: true` on the runner function and awaits
`request.checkpoint()` before each model request. The Pi, DSH, and
OpenAI-compatible adapters do this. The checkpoint resolves at once unless a pause
was requested; then the execution suspends there and the call resolves after
resume, so the worker continues the same conversation with its tool budgets,
workspace, and decision or merge state. A running tool is never interrupted, and
an execution whose final model request is already in flight completes normally.
`pause` rejects unknown, settled, or not-yet-admitted executions, and throws for a
runner without checkpoints. Pausing a `pausing` or `suspended` execution changes
nothing; resuming a `pausing` execution withdraws the request.

`resume` and `update({ resume })` accept both held and suspended execution IDs.
`suspendedExecutionIds` lists suspended and resuming executions; each execution's
`suspension` records the caller-supplied `source` label (default `"caller"`).
Events: `execution_suspending` when requested, `execution_suspended` at the
checkpoint, and `execution_resumed` when the execution continues (immediately for
a withdrawn request, otherwise once it has a slot).

`pauseRun({ source })` pauses the whole run: no new executions are admitted, not
even skipped records, and every running execution is paused. Suspension releases
slots, so stopping admission is what keeps freed slots from starting other nodes.
`resumeRun()` admits again and resumes only the executions `pauseRun` paused;
an execution paused separately stays suspended. With a runner that cannot pause,
`pauseRun` still stops admission. Events: `graph_paused` and `graph_resumed`; the
snapshot carries `pause: { source, pausedAt }`.

The node timeout stops while an execution is suspended or waiting for a slot.
Core moves `request.deadlines.node` later in place, so runners must read it each
time. The graph timeout keeps running, so a pause that is never resumed ends the
run with `GRAPH_TIMEOUT`; with an unlimited graph timeout it waits until resumed
or cancelled. Cancellation and run failure end suspended executions as failed.
A paused run with nothing running reports `status: "waiting"` and does not finish.

A job accepts updates while running or waiting. Once no work, gates, suspended
executions, or run pause remain, it enters finalization and rejects further
updates. Completed jobs cannot be reopened. These are in-memory controls,
including suspensions; there is no restart or crash recovery of the scheduler itself.

## Workspaces and merge operations

Every execution gets a new Git worktree, including read-only executions and
later loop visits. Root worktrees derive from one initial snapshot; successors
derive from predecessor checkpoints. Read-only is a capability restriction,
not a live view of the caller. Outside Git, filesystem tools remain read-only.

If inputs have identical trees, or one checkpoint contains all the others in its
ancestry, an ordinary worker can use that snapshot. Independent changed inputs
require an explicit `merge`; the worker fails with `WORKSPACE_MERGE_REQUIRED`
instead of silently selecting or combining them. All active predecessors still
provide text/error context.

| Type | Target | Result |
| --- | --- | --- |
| `merge` | New isolated worktree based on the initial job snapshot | Selected predecessor changes combined into a reusable checkpoint |
| `integrate` | Invoking source checkout / working branch | Selected changes applied to the caller and captured as a checkpoint |

Neither operation applies changes automatically. The runner chooses Git/file
operations, resolves conflicts, and calls `finish_merge` once with one
`{ executionId, disposition, reason }` per source. Sources are immutable and
reusable by multiple consumers. Dispositions are recorded on the target
workspace; source worktrees remain available until job cleanup. Integration
captures a `backupRef` first and serializes source-checkout access within the
process. It must preserve unrelated staged, unstaged, and untracked caller edits.

Each merge source's `changes.baseCommit` identifies the frozen job snapshot used
for its cumulative diff preview, including the caller's initial uncommitted
edits. Retrieve the full patch with
`git diff --binary <changes.baseCommit> <checkpointRef> --` when choosing patch
integration. `source.snapshotCommit` is that invocation's input: after a read-only
review it may equal the checkpoint, yielding an empty diff despite earlier
changes. `source.baseCommit` is the original HEAD and excludes uncommitted edits.
Checkpoints can have multiple parents recording merged sources. A bare
`cherry-pick` then fails; inspect the parents before choosing a mainline, or use
the cumulative diff. The runtime does not choose or apply a merge strategy.

There is no implicit final integration. Each instance is checkpointed before
successors are released, including partial work on optional failure. Finalization
archives/removes owned worktrees while retaining checkpoint refs. Cancelled or
failed integration may leave partial source edits or conflicts for inspection;
it does not reset the caller's checkout.

## Failure and budgets

`requireSuccess` defaults to false. Optional failures keep their errors and partial
artifacts; unconditional successors can recover. A failed decision never activates
a choice edge. A job can complete with failed optional executions.

A captured `requireSuccess: true` failure immediately stops admission, aborts
running siblings, waits for tracked writes and cleanup, and fails the job with
`REQUIRED_NODE_FAILED`. Editing the definition's policy later has no effect on
that instance. Infrastructure, checkpoint/cleanup, cancellation, graph deadline,
loop limit, and total execution limit failures always fail the job.

`maxExecutions` defaults to 1000 and must be a positive safe integer. It bounds
all materialized execution records, including skipped branches, across all rounds
and graph updates. `maxIterations` bounds each loop. The graph deadline includes
waiting at gates and is never reset by an update or resume. Usage sums all
instances once; Pi only claims job usage on the first terminal job retrieval.
