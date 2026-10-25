# Execution control

Since 0.6 the graph holds only execution instances. There is no separate,
mutable definition graph: each node is a lineage of instances, and its latest
instance doubles as the template for the next one. This is a breaking change
from 0.5; see the [0.5 → 0.6 migration guide](compatibility.md#the-execution-only-graph).

## Lineages and instances

A node ID such as `review` names a **lineage**. Each instance in it has the
execution ID `<nodeId>@<generation>`: `review@1`, `review@2`, and so on, counted
from 1 and never reused, even after the node is removed and added again. Node
IDs therefore cannot contain `@`. Execution IDs are unique within a run, not
across runs. The latest instance is the lineage's **head**.

Submitting a graph creates one pending instance per node at once, so every node
has an execution ID before it runs. An instance records its `node` definition,
the graph `revision` that created or last edited it, and, once it starts, the
exact `predecessorExecutionIds` it ran with. A pending instance can still change;
a started one never does.

`result.executions` (and `snapshot().executions`) holds every instance, oldest
first, including superseded ones and those of removed nodes. `result.nodes` holds
the head of each node that was not removed. Workspace records are keyed by
execution ID. `terminalExecutionIds` lists completed heads that no other
instance consumed; `terminalOutputs` holds their outputs keyed by node ID. Failed
instances remain available separately, even when the job completes.

| Status | Meaning |
| --- | --- |
| `pending` | Not started. Snapshots add `waitReason` (see below) |
| `running` | Started. A pause adds `suspension` with state `pausing`, `suspended`, or `resuming` |
| `completed` | Finished with a valid result; may be `held` |
| `failed` | Finished with an error, including cancelled instances and running ones that were replaced; may be `held` |
| `skipped` | Never ran; `skipReason` says why |

Markers: `held: true` while a settled instance's result is held (it is also in
`pausedExecutionIds`), `supersededBy` on a started instance that was replaced,
and `supersedes` on its replacement. Staleness is derived, not stored.

`waitReason` on a pending instance is one of:

| Reason | The instance waits because |
| --- | --- |
| `predecessors` | An input has not run yet |
| `stale` | An input has a newer instance that has not settled, or will get one because something upstream of it is rerunning |
| `hold` | An input, or something upstream of it, is held |
| `limit` | It is a rerun beyond its node's `maxRuns` (see [limits](#limits)) |
| `run_paused` | The run is paused, by `pauseRun` or at a run limit |
| `slot` | No concurrency slot is free, or the instance it replaces is still stopping |

## Scheduling

Edges connect lineages. When an instance starts, each incoming edge resolves to
its source's head. An instance starts when all of its inputs have settled, no
input is stale, no input is held, the run is not paused, a slot is free, and no
other instance of its lineage is running: each lineage runs at most one instance
at a time. If an input is blocked (a failed decision, or a skipped instance that
is not merely inactive), the instance is skipped with `upstream_failed`; if no
edge into it is active, it is skipped with `inactive`.

An edge **reaches** a head when its source settles with a new result: a new
instance of the source, or an edge that is new. What happens depends on the head:

| Head | Action |
| --- | --- |
| Not started | It uses the new result when it starts |
| Started | Once the head has settled and any hold on it is released, it is **cloned** into a new pending instance, which runs with the current heads of its inputs |

A clone copies the head's definition, with any prompt template rendered from the
current `promptTemplates`. When several edges reach a settled head, the first
clones it and the others feed that clone. A clone of a failed head is a retry. A
clone whose inputs are now all inactive is recorded as a skipped instance, which
also ends any wait on it: if a decision reruns and no longer chooses a branch,
the branch gets a skipped instance instead of keeping its old result.

Inputs wait for stale upstream work, so fan-in stays consistent when paths have
different lengths. In `edit → testA → review` alongside `edit → slow → testB →
review`, rerunning `edit` reruns both paths, and `review@2` waits for `testB@2`
instead of starting with `testB@1`. Replacing an instance therefore cascades
downstream: each lineage below it reruns once its inputs are current.

Edges do not steer running executions. Changing a running instance is always an
explicit operation: human input, a hold, a replacement, or cancellation.

## Cycles

```ts
const graph = {
  goal: "Refine until the review passes",
  nodes: [
    { type: "execute", id: "edit", prompt: "Implement the feedback.", maxRuns: 3 },
    { type: "decision", id: "review", prompt: "Review the result.",
      choices: ["again", "done"], workspace: "read-only" },
    { type: "integrate", id: "apply" },
  ],
  edges: [
    { from: "edit", to: "review" },
    { from: "review", to: "edit", choice: "again" },
    { from: "review", to: "apply", choice: "done" },
  ],
};
```

A cycle is a loop. It must be closed by a decision's choice edge back to the node
where each round starts, its **entry**: the cycle node that edges from outside
enter, or, when none does, the target of the closing edge listed first in
`nodes`. The decision also needs an exit choice. Edges enter a cycle only at its
entry and leave only from its decision. Nested and overlapping cycles are
rejected; sequential and independent cycles are supported. `closingEdges(graph)`
returns the closing edge of each cycle, for displays and tools.

Nothing about a loop is declared, and no loop body is copied. When the decision
chooses the closing edge, the edge reaches the entry's head and clones it, with
the decision as an extra input; each instance after it is cloned in turn once
its inputs are current, which unrolls one round. A new round starts only after
everything in the previous round that feeds the decision has settled and been
released. Exits wait while the cycle is rerunning and use the final round.
Inputs from outside the cycle stay available to every round.

Without a limit the decision alone ends the cycle. To bound the rounds, set
`maxRuns` on a node in the cycle: `maxRuns: 3` on `edit` allows three rounds.
The round that would exceed it waits for the graph owner, or fails the job with
`RUN_LIMIT` under `onLimit: "fail"` (see [limits](#limits)).

An edge from a new node into a settled lineage that does not close a cycle
reruns that lineage once, for example `fix → test` added after `test` finished.

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
run.update({
  expectedRevision: state.revision,
  upsertNodes: [{ type: "execute", id: "fix", prompt: "Implement the fix." }],
  addEdges: [{ from: "inspect", to: "fix" }],
  resume: ["inspect@1"],
});
const result = await run.result;
```

`startBraid` returns synchronously with `runId`, `result`, `snapshot()`,
`update(patch)`, `resume(executionIds, expectedRevision)`, and `cancel()`.
`braid(input, options)` is the convenience API for awaiting the result.

Updates require the current `expectedRevision` and commit atomically. A successful
update increments the graph revision once. A stale revision or invalid candidate
changes nothing, including pause gates. What an update does to a node depends on
its head:

| Field | Not started | Started (running or settled) |
| --- | --- | --- |
| `upsertNodes` (complete definitions) | Edits the instance in place; no history is kept | **Replaces** it: a new pending instance with `supersedes`, and the old one gets `supersededBy`. A running instance is cancelled (`CANCELLED`, "replaced by a graph update"); a held one is released without routing. Once the replacement settles, downstream lineages rerun |
| `removeNodeIds` | Deletes the instance (`execution_removed`) | Cancels it if running, releases any hold, and keeps it in history |

A new ID in `upsertNodes` adds a node. Upserting an unchanged definition of a
started node reruns it from there; upsert only the nodes you mean to change or
rerun. The exception is `maxRuns`, which bounds the lineage rather than one
execution: an upsert that changes only `maxRuns` keeps a started head, running or
settled, with its hold, and later reruns use the new limit. The head's own `node`
keeps the definition it ran with. To review a replacement before its downstream lineages rerun, give it
`pauseAfter: true`: they then wait on the hold. `removeNodeIds` closes the
lineage together with its edges; the ID may be added again later and continues
with the next generation. A cancelled instance of a replaced or removed node never
fails the run, even with `requireSuccess`.

Edges are identified by `from`, `to`, and `choice`. `addEdges` rejects an edge that
already exists, and `removeEdges` rejects one that does not. Removing a node, or
an edge, that does not exist is an error. `promptTemplates` replaces the template map when supplied; pending
instances are rendered again, started ones keep the prompt they ran with.

`pauseAfter` holds an execution's outgoing scheduling and keeps the job alive,
even at a leaf. Independent branches continue. Pi sends a pause reminder;
`notifyOnCompletion` alone only sends a reminder. Resume specific execution IDs,
either on its own or in the same transaction as a graph update.

### Holding a running execution

A started instance never changes, so setting `pauseAfter` with an update on a
running node would replace it. To hold the result of an execution that is
already running, add a hold to that execution instead:

```ts
run.holdAfter([executionId], true, { source: "agent" });  // hold once it settles
run.holdAfter([executionId], false, { source: "agent" }); // or let it flow downstream
```

A hold set this way behaves exactly like `pauseAfter`: when the execution settles,
completed or failed, it is listed in `pausedExecutionIds`, `execution_paused` is
emitted, and `resume` releases it. It applies to this execution only and changes
neither its `node` nor later instances of the node. Removing a hold that came
from the node's `pauseAfter` releases only this execution; later ones still
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

### Replan requests from a node

A running node may find that its task rests on a wrong premise: the timeout it
was asked to fix in the parser comes from a cache setting, the bug is already
fixed, or the cause it found also explains other problems. Execute and decision
nodes can report such a finding and ask the graph owner to replan. A node sees
only the goal, its own prompt, and its direct predecessors, not the rest of the
graph, so it reports what it found rather than a new plan. The owner, which sees
the whole graph and the user's intent, decides which planned work the finding
affects, for example that a sibling fix is now unnecessary. A node cannot change
the graph itself.

```ts
request.requestReplan!({
  reason: "The timeouts come from the cache TTL, not the parser; the TTL also explains the stale reads.",
  suggestion: { // optional; a node knows only its own ID, so it can only add work after itself
    upsertNodes: [{ type: "execute", id: "fix-cache-ttl", prompt: "Fix the cache TTL." }],
    addEdges: [{ from: "investigate", to: "fix-cache-ttl" }],
  },
});
```

Owners get more precise requests by saying in a node's prompt what related work
other nodes handle, so the node can tell which of them its finding affects.

The call returns at once and the execution keeps running. Core records the
request on the execution as `replan: { reason, suggestion?, revision, requestedAt }`
and holds its result like `pauseAfter`: if the execution has no hold yet, it gets
one with source `"replan"` (and an `execution_hold_added` event); an existing
hold keeps its source. `replan_requested` carries the reason and suggestion.
Calling again replaces the request without adding a second hold, and adds the
hold again if the owner removed it.

`suggestion` takes the graph-edit fields of a `GraphUpdate`: `upsertNodes`,
`removeNodeIds`, `addEdges`, and `removeEdges`. Core validates it against the
current graph, as `update` would, and throws the reason if it is invalid, so the
node can fix or drop it. Nothing is applied: the owner applies a suggestion, as
is or adapted, with an ordinary revision-checked `update`. A suggestion goes
stale if the graph changes first; `update` then rejects the old revision as
usual.

The owner then decides with the usual controls. It can stop other branches with
`pause` or `holdAfter`, change the graph and release the execution in one
`update` with `resume`, keep the plan with `resume`, remove the hold early with
`holdAfter(..., false)`, or cancel. Until then the run waits, as with any other
hold. `requestReplan` is not offered to merge and integrate nodes, and it throws
once the invocation has ended. The Pi and DSH workers expose it as the
`request_replan` tool, and their parent agent gets a waking reminder as soon as
a node calls it.

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
time. The graph timeout keeps running, so a pause that is never resumed reaches
it, if one is set: the run then pauses at the graph timeout, or fails with
`GRAPH_TIMEOUT` under `onLimit: "fail"`. Cancellation and run failure end suspended executions as failed.
A paused run with nothing running reports `status: "waiting"` and does not finish.

The run emits `graph_waiting` when it enters that state because the last active
execution settled, was held, or suspended: nothing more runs until the graph
owner resumes, updates, or cancels it. The event has `settledExecutionId`, the
execution that left nothing active, `pausedExecutionIds`, `suspendedExecutionIds`,
`limitedExecutionIds` (reruns waiting at their node's `maxRuns`), the run's `pause` if any, and the current `revision`. It is emitted once per
transition. An update or resume that starts nothing does not repeat it, and
neither does cancelling an execution that was already suspended; the next one
follows after some execution runs again. A run that waits before anything ran,
such as one paused at once, emits none.

### Pausing on node timeout

By default, `startBraid` pauses an execution that exceeds `nodeTimeoutMs`
instead of failing it (`onNodeTimeout: "pause"`). Set `onNodeTimeout: "fail"` to
fail it with `NODE_TIMEOUT` as before. `braid()` always fails, because it has no
handle to resume with; passing `"pause"` to it throws a `TypeError`.

When the timeout fires, core interrupts the current step and the execution
suspends with `source: "node_timeout"`, keeping its conversation, workspace,
tool budgets, and decision or merge state:

1. The execution enters `pausing`, emits `execution_suspending`, and its current
   model request or tool call is interrupted.
2. The runner records the interruption and reaches its next checkpoint, where the
   execution suspends (`execution_suspended`) and releases its slot.
3. `suspension.timeout` records `{ nodeTimeoutMs, activeMs }`: the budget that
   ran out and how long the execution ran, excluding earlier suspensions.

Successors wait until the execution is resumed or cancelled:

```ts
// A full new window (the run's nodeTimeoutMs), or choose one:
run.resume([executionId], revision);
run.resume([executionId], revision, { nodeTimeoutMs: 120_000 });
run.update({ expectedRevision: revision, upsertNodes, resume: [executionId], resumeOptions: { nodeTimeoutMs: 120_000 } });
// Or fail only this execution, with the same result as onNodeTimeout: "fail":
run.cancelExecutions([executionId], { source: "agent" });
```

`ResumeOptions.nodeTimeoutMs` sets the remaining node budget, in active time
from when the execution gets a slot again; `Infinity` removes it. Without it, a
timeout pause gets the run's `nodeTimeoutMs` again, and any other pause keeps
its remaining budget. It applies to `pausing` and `suspended` executions;
resuming a timeout pause that is still `pausing` withdraws it and renews the
budget the same way. `resumeRun()` does not resume a timeout pause, and a timeout
that fires while a pause is pending takes over that pause's `source`.

This needs an interruptible runner. Such a runner sets `interruptible: true`
(which implies `pausable`) and calls `request.stepSignal()` at the start of each
model request, retry backoff, and tool call, passing the result to that step
instead of `request.signal`. A step whose signal aborted while `request.signal`
did not was interrupted (`isStepInterrupted(request, step)`): the runner
discards a partial model response, gives an interrupted tool call an error
result such as `interruptedToolResult(partialOutput)`, gives calls later in the
batch `notRunToolResult()`, and continues to its next checkpoint. Every tool call
in an assistant message therefore has a result. If the runner does not reach a
checkpoint within 10 seconds of the interruption, the execution fails with
`NODE_TIMEOUT`, so a timeout is always enforced. Runners that are not
interruptible, including runners that are only `pausable`, fail on timeout as
before. The Pi, DSH, and OpenAI-compatible runners are interruptible.

A timeout pause never fails the run, even for `requireSuccess` nodes; only
cancelling the execution does. The graph timeout keeps running, so a timeout
pause that is never resumed reaches it, if one is set, as described above; without
one the run waits until the execution is resumed or cancelled.

### Cancelling one execution

`run.cancelExecutions(executionIds, { source })` fails running executions,
including `pausing`, `suspended`, and `resuming` ones, without cancelling the
run. Their successors follow the usual failure rules: unconditional edges
receive the error, and a `requireSuccess` node fails the run with
`REQUIRED_NODE_FAILED`. A timeout pause fails with `NODE_TIMEOUT`; anything else
fails with `CANCELLED` ("Execution cancelled by <source>"). Settled and held
executions are rejected; drop a held execution's successors with a graph update
instead. `run.cancel()` still cancels the whole run.

A job accepts updates while running or waiting. Once no work, gates, suspended
executions, or run pause remain, it enters finalization and rejects further
updates. Completed jobs cannot be reopened. These are in-memory controls,
including suspensions; there is no restart or crash recovery of the scheduler itself.

## Workspaces and merge operations

Every execution gets a new Git worktree, including read-only executions and
later rounds of a cycle. Root worktrees derive from one initial snapshot; successors
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

## Limits

Every limit is unlimited by default, so a run can keep going until its graph
finishes or its owner stops it. Set a limit only to bound a run:

| Limit | Scope | Under `onLimit: "pause"` | Under `onLimit: "fail"` |
| --- | --- | --- | --- |
| `node.maxRuns` | Started executions of one node (lineage), counting cycle rounds and downstream reruns; skipped ones do not count, and an owner's replacement always starts | Keeps the rerun pending with wait reason `"limit"` | `RUN_LIMIT` |
| `maxExecutions` | Started and skipped instances, across rounds and updates; pending instances do not count | Stops admission (pause source `"execution_limit"`); started executions finish | `EXECUTION_LIMIT` |
| `graphTimeoutMs` | Wall time from the start of the run, including gates and pauses; never reset by an update or resume | Pauses the run and its running executions (`"graph_timeout"`) | `GRAPH_TIMEOUT` |
| `maxTokens` | Reported input and output tokens of all executions, checked as each settles, so running executions can exceed it | Pauses the run and its running executions (`"token_limit"`) | `TOKEN_LIMIT` |

`onLimit` defaults to `"pause"` in `startBraid`. `braid()` has no handle to
resume with, so it always fails at a limit and rejects `onLimit: "pause"`.

`maxRuns` limits automatic reruns: the rounds of a cycle and the reruns an
upstream change cascades downstream. When an edge reaches a settled head that has
already run `maxRuns` times, the clone is still created, but it stays pending with
`waitReason: "limit"` instead of starting. Once its inputs are current, core emits
`limit_reached` (with `limit: "maxRuns"`, the value, the `nodeId`, and the
waiting `executionId`) and lists it in `limitedExecutionIds` in the snapshot and in
`graph_waiting`; a run with nothing else active then waits for its owner. A rerun
that would be skipped is not held, and an owner's replacement of a started node
always starts, even past the limit.

To let the rerun start, raise `maxRuns` with an update that upserts the node: the
pending rerun is edited in place, not replaced, and starts. The limit can also be
raised or lowered ahead of time: changing only `maxRuns` never replaces a started
head (see [live updates](#live-updates-and-gates)). To end it instead,
release it with `resume` (or `resume` in an update) without raising the limit: the
rerun is removed (`execution_removed`), the node keeps its last result, and nothing
downstream reruns for it. In a cycle this ends the cycle there; the decision chose
the closing edge, so its other edges stay inactive.

```ts
const state = run.snapshot();
const [rerun] = state.limitedExecutionIds;
// Allow one more round:
run.update({
  expectedRevision: state.revision,
  upsertNodes: [{ type: "execute", id: "edit", prompt: "Implement the feedback.", maxRuns: 4 }],
});
// Or end the cycle here:
run.resume([rerun], state.revision);
```

At a run limit, core emits `limit_reached` and `graph_paused` with the limit's
pause source, and the snapshot carries that `pause`. Raise the limit with
`run.setLimits({ maxExecutions, graphTimeoutMs, maxTokens })`, then call
`run.resumeRun()`; `resumeRun` throws while the limit is still reached. Each given
limit replaces the current one and `Infinity` removes it; `graphTimeoutMs` still
counts from the start of the run. `setLimits` works at any time while the run is
active, emits `limits_updated`, and never resumes the run by itself. A run already
paused for another reason keeps that pause; reaching a limit then takes effect
when it is resumed. `snapshot().limits` lists the finite limits.

## Failure and budgets

`requireSuccess` defaults to false. Optional failures keep their errors and partial
artifacts; unconditional successors can recover. A failed decision never activates
a choice edge. A job can complete with failed optional executions.

A `requireSuccess: true` failure immediately stops admission, aborts running
siblings, waits for tracked writes and cleanup, and fails the job with
`REQUIRED_NODE_FAILED`. The policy is the instance's own: replacing a running
instance to change it cancels that instance, and a cancelled instance of a
replaced or removed node does not fail the job. Infrastructure, checkpoint/cleanup, and cancellation failures
always fail the job, as do limits under `onLimit: "fail"`.

Usage sums all instances once; Pi only claims job usage on the first terminal job retrieval.
