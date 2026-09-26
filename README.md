# Braid

Braid is a small execution runtime for dynamically constructed graphs of isolated
model invocations. A parent submits a complete DAG in one call; Braid resolves
routing and dependencies, runs independent nodes concurrently, and returns the
successful execution-terminal outputs. It is an agent primitive, not a workflow
builder.

**v0.1:** TypeScript, Node.js 22+, no runtime dependencies. The core has no Pi,
provider SDK, or framework dependency. The package is currently private/unpublished.

## Run locally

```sh
npm ci
npm run check
npm test
npm run build
npm run demo
```

The demo uses a deterministic fake model runner and makes no network calls. To
run the same graph with an OpenAI-compatible Chat Completions endpoint:

```sh
# Set OPENAI_API_KEY and BRAID_MODEL in your environment first.
npm run demo -- --live
```

`OPENAI_BASE_URL` optionally changes the API root (for example,
`https://your-provider.example/v1`). Live mode makes billable model requests.
The adapter requires a model with function/tool calling support. No live provider
is needed for the test suite; its HTTP requests are intercepted in tests.

## API

Local package imports work after `npm run build`. Submit the graph in one call;
configuration and the trusted provider adapter are separate from the graph data:

```ts
import { braid } from "braid";
import { createOpenAICompatibleRunner } from "braid/adapters/openai";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.BRAID_MODEL;
if (!apiKey || !model) throw new Error("Set OPENAI_API_KEY and BRAID_MODEL");

const result = await braid({
  goal: "Assess a proposed change and give a recommendation.",
  nodes: [
    {
      type: "decision", id: "route", prompt: "Choose a brief answer or a detailed assessment.",
      choices: ["brief", "detailed"], model: process.env.BRAID_ROUTER_MODEL ?? model,
    },
    { type: "execute", id: "benefits", prompt: "Assess the potential benefits." },
    { type: "execute", id: "risks", prompt: "Assess the risks and unknowns." },
    { type: "execute", id: "answer", prompt: "Use the available context to give a recommendation." },
  ],
  edges: [
    { from: "route", to: "answer", choice: "brief" },
    { from: "route", to: "benefits", choice: "detailed" },
    { from: "route", to: "risks", choice: "detailed" },
    { from: "benefits", to: "answer" },
    { from: "risks", to: "answer" },
  ],
}, {
  runner: createOpenAICompatibleRunner({ apiKey }),
  defaultModel: model,
  maxConcurrency: 4,
  nodeTimeoutMs: 60_000,
  graphTimeoutMs: 300_000,
  onEvent: event => console.log(`[${event.type}]`, event),
});

console.log(result.status, result.terminalOutputs);
```

The detailed route starts `benefits` and `risks` concurrently. The brief route
skips both, propagates their inactivity, and runs `answer` with only `route`'s
output. The graph has no special fork, branch, or join nodes.

### Graph schema

```ts
type BraidNode =
  | { type: "execute"; id: string; prompt: string; model?: string }
  | { type: "decision"; id: string; prompt: string;
      choices: readonly string[]; model?: string };

type Edge = { from: string; to: string; choice?: string };
type BraidInput = { goal: string; nodes: readonly BraidNode[]; edges: readonly Edge[] };
```

IDs are unique, non-empty strings. Prompts, goals, models, and choices must be
non-empty strings when present. Decision choices must be non-empty and unique.
Unknown fields, unsupported node types, missing references, duplicate exact
edges, and cycles are rejected. Cycles are rejected even if a decision might
make them inactive. Disconnected components are allowed; every root runs.
Distinct choices may connect the same node pair. Choices need not all have
outgoing edges, and decisions may themselves be terminal.

`validateGraph(input)` is also exported for validation without execution. It and
`braid` throw `GraphValidationError` for invalid graphs, before invoking a model.
Invalid runtime options throw `TypeError`. Execution failures return a result
with `status: "failed"` instead of discarding the run's successful outputs.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `runner` | Required | A fresh, isolated invocation for each call |
| `defaultModel` | Adapter default | Overridden by each node's `model` |
| `maxConcurrency` | `4` | Maximum simultaneous runtime-managed node invocations; positive integer |
| `nodeTimeoutMs` | `60_000` | Separate deadline for each node, starting when it runs (not while queued) |
| `graphTimeoutMs` | `300_000` | Whole execution deadline, including node queueing; starts after validation |
| `signal` | None | Caller cancellation signal; aborts running nodes and marks queued nodes cancelled |
| `onEvent` | None | Live observer for graph/node creation, readiness, starts, handoffs, completions, skips, failures, and graph completion |

Timeouts must be positive finite milliseconds, at most `2_147_483_647`, or
`Infinity` to disable that deadline. Set both timeouts to `Infinity` to run
without a time limit; caller cancellation still works.

## Scheduling and routing semantics

Node states are explicit:

```text
pending -> runnable -> running -> completed | failed
pending -> skipped
pending | runnable -> skipped (graph timeout)
```

Edges are resolved from their source node's state:

| Source result | Outgoing edge state |
| --- | --- |
| Not yet finished | Unresolved |
| Completed, unlabelled edge | Active |
| Completed decision, matching choice | Active |
| Completed decision, nonmatching choice | Inactive |
| Skipped because all inputs were inactive | Inactive |
| Failed, or skipped because of a failed dependency | Blocked |

Only decision nodes may have choice-labelled outgoing edges. Unlabelled edges
are unconditional, including edges from decisions. A single choice can activate
any number of edges. Routing occurs **only after successful node completion**.
A decision must call `decide` exactly once with exactly one declared choice;
missing, invalid, or repeated calls fail it. Catching a tool validation error
inside an adapter does not turn that invocation into a success.

A pending node waits until **all incoming edges are resolved**. Then:

1. Any blocked incoming edge makes it `skipped: upstream_failed`.
2. If it has incoming edges but none are active, it becomes `skipped: inactive`.
3. Otherwise it becomes `runnable` (including roots, which have no inputs).

This distinction between inactivity and failure prevents both deadlocked joins
and joins silently running with missing required inputs. Skip propagation uses
topological order, not recursive traversal. A failed decision has no successful
routing result, so all its possible successors are blocked. Independent branches
continue; there are no retries. The graph fails if any node fails or its deadline
expires, even when another branch finishes successfully.

## Execution events

The runtime keeps an immutable `events` log on every execution result and can
stream the same events through `options.onEvent`. Events are numbered and
timestamped. The log is diagnostic data and does not alter scheduling; observer
exceptions and rejected promises are ignored. Event payloads are frozen before
being retained and delivered.

The event sequence includes:

- `graph_created`, `node_created`, and `edge_created` when the submitted DAG is
  admitted.
- `node_runnable` and `node_started` when scheduling admits a node.
- `handoff` for every direct predecessor output passed to a downstream node,
  including the upstream decision when present.
- `node_completed`, `node_skipped`, and `node_failed`, including output,
  decision, model, usage, latency, skip reason, or error where applicable.
  A node start/completion/failure event is emitted only once the corresponding
  transition is admitted; a provider call that expires before admission has no
  `node_started` event.
- `graph_completed` with execution terminal IDs, or `graph_failed` with the
  representative error and any successful terminal IDs.

`node_completed` and `node_failed` include node latency; `node_completed` also
includes the selected decision and reported usage when available. Event output
is diagnostic context and may be previewed by an adapter; `BraidResult.events`
retains the complete event payloads.

The core event stream is intentionally a log, not a second control API. It does
not permit graph mutation or runtime intervention. A Pi adapter can use it to
render live topology, handoffs, failures, and active nodes without reconstructing
scheduler state from final results. Tool selection remains the responsibility of
the host agent; the optional Pi adapter supplies explicit proactive-use guidance
so Braid is considered for complex multi-branch reasoning without forcing it for
every prompt. In the Pi adapter, nodes can inspect the current checkout with
read-only filesystem tools; the parent remains responsible for writes, shell
commands, and test execution.

## Context isolation and model runners

The core accepts a `ModelRunner` function with this contract:

```ts
import type { ModelRequest } from "braid";

type ModelRunner = (request: ModelRequest) => Promise<{
  output: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
}>;
```

Each request contains the goal, node, resolved model, predecessor outputs,
execution IDs, and an abort signal. Decision nodes additionally receive
`request.decide(choice)`. Expose that callback as an actual model tool; do not
infer decisions by parsing the model's prose. The framework-agnostic core does
not define a filesystem or shell capability: an adapter may provide explicitly
selected tools. The included Pi adapter provides read-only `read`, `grep`, `find`, and `ls` by
default. It does not provide `edit`, `write`, `bash`, or `powershell`, so parallel
nodes cannot create shared-workspace write conflicts. This lets Braid handle
repository-aware analysis while the parent retains mutation and verification
control.

`request.predecessors` contains only direct, completed, active predecessors, in
incoming-edge order. Each source appears once:

```json
[{ "nodeId": "route", "output": "Use a detailed comparison.", "decision": "detailed", "model": "router" }]
```

There is no parent conversation, global transcript, or automatic transitive
history. Each invocation gets fresh node/context objects, so modifying them
cannot affect the graph, another node, or recorded results. Pi read-only tools
use the adapter's captured working directory and Pi's normal path resolution;
they are not a security sandbox or a filesystem snapshot. Both the submitted
graph and options are snapshotted before asynchronous execution.

**The adapter is a trust boundary, not a security sandbox.** It must avoid shared
conversation state, expose no other tools, and forward `signal` to its provider.
The core never gives the model arbitrary code execution or a recursive Braid
tool. An optional Pi adapter translates this same contract without changing the
runtime; the core v0.1 package does not depend on Pi. See
[`integrations/pi/README.md`](integrations/pi/README.md) for installation and testing.

The included OpenAI-compatible adapter uses a fresh Chat Completions conversation
per node, a strict `decide({ choice })` enum schema for decisions, and at most
one tool-free follow-up request to obtain the final text after `decide`. It keeps
both pre-tool and final textual content, sums reported usage across those
requests, and rejects unsupported tool calls and truncated completions. It has
no general tool loop, retries, or streaming. The optional Pi adapter instead
runs a loop for the standard read-only `read`, `grep`, `find`, and `ls`
tools, returning tool errors to the node model so it can recover. It never
provides `edit`, `write`, `bash`, or `powershell`.

Pi tool and time budgets are unlimited by default. Its `options.maxToolRounds`
and `options.maxToolCalls` can impose positive integer limits per node; counts
include `decide` and rejected requests. Exceeding either limit fails the node
before executing the over-budget batch. Returning final text at the limit is
allowed. See the [Pi budget options](integrations/pi/README.md#node-filesystem-capabilities)
for configuration, including `nodeTimeoutMs` and `graphTimeoutMs`.

For finite budgets, Pi inserts a system reminder with remaining tool and time
budgets before every model call. The OpenAI-compatible adapter also refreshes
finite time-budget reminders before each request. The core supplies optional
`request.deadlines` on the `performance.now()` clock for adapters to calculate
remaining node and shared graph time. Reminders do not extend hard limits or
interrupt a model response already in progress. The core API's default timeouts
remain 60 seconds per node and 5 minutes per graph.

## Results, timeouts, and accounting

`BraidResult` contains:

- `status`: `completed` or `failed`.
- `terminalOutputs`: `{ [nodeId]: { output, decision?, model? } }` for completed
  nodes with **no active outgoing edges in this execution**. This includes a
  decision selecting a choice with no successor. A completed node does not
  become terminal merely because its active successor failed or was skipped.
- `nodes`: all node states plus available output, decision, model, usage, error,
  skip reason, start/end timestamps (Unix milliseconds), and latency in ms.
  Skipped nodes have no start time or latency. Nodes without a valid
  response have no output. A failed decision may retain its text and selected
  choice for debugging, but neither is used to activate edges.
- `events`: the immutable execution log described above. `onEvent` observes live
  copies of the same state transitions while the run is in progress.
- `metadata`: run/root identity, timestamps, monotonic latency, summed reported
  token usage, and `usageReportedNodes`. Missing usage is unknown, not proof of
  zero consumption. Usage counts only what the runner actually returns; a
  timeout or provider error may leave billable usage unavailable.
- `error`: one representative error when failed; `nodes` retains all errors.

A node timeout marks the running node `failed: NODE_TIMEOUT` and propagates
failure skips. A graph timeout marks running nodes `failed: GRAPH_TIMEOUT`,
skips queued/pending nodes with `graph_timeout`, and retains already completed
terminal outputs. Timers are cleared when no longer needed.

Timeouts abort the invocation signal and stop waiting even if a runner ignores
cancellation. Late settlements cannot change the returned results, and late
rejections are observed. JavaScript cannot forcibly preempt synchronous work or
stop an uncooperative remote request: providers must honor cancellation to stop
resource consumption. Concurrency limits cover runtime-managed invocations;
uncancelled provider work after timeout can outlive a slot.

## Internal architecture and scope

- [`src/types.ts`](src/types.ts): public graph, provider, and result types.
- [`src/validate.ts`](src/validate.ts): strict validation, graph snapshot,
  dependency indexes, and iterative DAG validation.
- [`src/runtime.ts`](src/runtime.ts): edge resolution, explicit state transitions,
  bounded concurrent scheduling, invocation deadlines, execution events, and result accounting.
- [`src/adapters/openai.ts`](src/adapters/openai.ts): optional provider translation.
- [`integrations/pi/`](integrations/pi/): thin Pi model-registry/tool adapter, Mermaid graph renderer, and live execution renderer (`display.ts`).
- [`test/`](test/): deterministic scheduling, execution-event, and intercepted HTTP/tool tests.

There is one in-memory execution context per run and no shared mutable scheduler
state. `rootRunId` equals `runId` in v0.1. Centralized invocation admission and
usage aggregation leave places to thread a shared root budget in a future
nested-run implementation; **nested runs and shared budget enforcement are not
implemented**. The current scheduler deliberately rescans a small DAG after
completions; `onEvent` is an observer for diagnostics and visualization, not a
scheduler event bus.

Out of scope: loops, arbitrary code nodes, persistent workflows, saved templates,
resume/checkpointing, human approval, editing UI, graph mutation during execution,
and recursive Braid calls from model nodes.

## License

Braid is released under the [MIT License](LICENSE).
