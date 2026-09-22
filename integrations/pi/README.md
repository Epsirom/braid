# Braid Pi adapter

This is the optional Pi integration for the local Braid checkout. It registers one tool:

- `braid` — an LLM-callable tool that submits one complete graph to Braid.

The tool's Pi TUI rendering shows a Mermaid flowchart for the submitted DAG and
a live execution view for the result. The DAG is rendered as a Mermaid flowchart
using Pi's terminal Mermaid renderer. Active nodes are marked `▶ ACTIVE`, shown
with a highlighted background, and annotated with current context-token estimates
or provider-reported input/cache tokens plus the model context window and
read-only tool-call counts. Labels use compact forms such as `20K/1M · T23`
(context used/window and tool calls), plus node elapsed time such as `12s`. The log also displays graph/node/edge creation,
runnable and started nodes, predecessor handoffs, completions, skips, failures,
and graph completion. The chart header shows overall Braid elapsed time.
Expand the result row for more log events; the
final details retain the complete execution log.

The adapter is intentionally thin. Braid owns graph validation, scheduling,
joins, routing, skip/failure propagation, timeouts, and result metadata. Pi owns
model lookup, credentials/OAuth, provider transport, read-only tool execution,
and token/cost accounting.

## Force Braid for the next prompt

Run `/braid` in Pi, then enter your ordinary development prompt. The command arms
only the next non-extension input, adds a mandatory Braid-first instruction to
that turn, and disarms automatically. It does not immediately start model work.

```text
/braid
Review the current diff for correctness, missing tests, and unnecessary complexity.
```

The model still constructs the complete DAG; you do not need to specify nodes or
edges. Braid nodes use read-only filesystem tools, so the parent remains the only
writer and test runner.

## When Pi will use Braid

Tool selection is made by the parent Pi model. It is not possible for an
extension to force a model tool call safely for every prompt. This adapter adds
an explicit per-turn planning policy to Pi's system prompt and tool metadata:

- for code reviews, bug investigations, design comparisons, test planning, or
  changes spanning multiple files, call Braid first when two or more concerns
  can be analyzed independently; nodes can inspect the current checkout
  read-only;
- do not use Braid for simple one-step answers, trivial direct edits, or shell
  work; keep writes, tests, and commands in the parent agent;
- the user does not need to say “Braid” or design the graph;
- when Braid fits, the model should construct and submit the complete graph
  immediately, then use the terminal outputs in its response.

This is a recommendation to the model, not hard enforcement. If a model still
ignores the policy, use a short instruction such as “decompose this with Braid”
or strengthen the project/system prompt for that model. The adapter explicitly
asks the model to make the delegation choice before directly inspecting the
repository. Do not add a generic `always call braid` rule: that would waste
model calls and bypass direct tools.
The key distinction is that Braid nodes may read the repository themselves, but
the parent remains the only writer/test runner.
Each node gets a new Pi AI context containing only the Braid goal, its node prompt,
and labelled direct predecessor outputs. By default it also receives Pi's
read-only `read`, `grep`, `find`, and `ls` tools. It receives no parent transcript,
write tools, shell tools, test runner, skills, or arbitrary code execution.
Decision nodes receive those read-only tools plus `decide`.

## Install this local checkout in Pi

From the repository root:

```sh
npm ci
npm run build
pi install /home/chenhuarong/repo/github/Epsirom/braid
```

The absolute path avoids ambiguity. To install for only one project instead of
all Pi sessions, add `-l`:

```sh
pi install -l /home/chenhuarong/repo/github/Epsirom/braid
```

The package is local-path based, so edits in this checkout are picked up after a
Pi reload. In Pi, run `/reload`. Restart Pi if the package was installed into an
already running process and the tool does not appear. Inspect installation with:

```sh
pi list
pi config
```

The extension imports the checked-out `dist/` build and the Pi package dependencies
from `integrations/pi/node_modules`. Run `npm install --prefix integrations/pi`
after changing Pi dependency versions. The adapter uses the `grok-mermaid` terminal renderer for Mermaid flowcharts.
The local install is trusted code: Pi extensions execute with the process's full
permissions.

## Test the adapter without spending money

First verify the core and adapter compile and run their deterministic tests:

```sh
npm run check
npm test
npm run build
npm run check:pi
npm run test:pi
npm run demo
```

The Pi adapter tests use a fake model registry and assert exact model lookup,
fresh contexts, tool isolation, decision handling, read-only file-tool execution,
continuation behavior, usage aggregation, context-token progress, and tool counts. Renderer tests cover Mermaid
topology, live active-node highlighting, handoff/failure logs, expanded per-node
output, and bounded event previews. Selection tests cover one-shot `/braid`
arming and automatic disarming. They make no provider requests.

## Node filesystem capabilities

Braid's framework-agnostic core does not provide tools to nodes. The Pi adapter
uses a default read-only capability set:

- `read` — read text/images
- `grep` — search file contents
- `find` — find paths by glob
- `ls` — list directories

The adapter does not provide `edit`, `write`, `bash`, or `powershell`. This means
parallel nodes can inspect the same checkout without shared-write conflicts. Read
access still uses Pi's normal filesystem permissions and is not a sandbox or
snapshot. Read-only calls are bounded to 12 tool rounds or 32 calls per node.

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
- While running, active nodes are highlighted and the execution log updates with starts and handoffs.
- The result shows completion/failure, node counts, terminal IDs, decisions, failures, skips, and the execution log. Expand the result row to see per-node output and more events.

To test per-node model selection, add `model: "provider/modelId"` to one node.
Use an exact ID shown by `/model` or `pi --list-models`; an unrecognized model
fails that node cleanly and does not invoke another provider.

## Cancellation and limits

The Pi extension has no node or graph time limit by default. Press Escape while
the `braid` tool is running to cancel it. Pi passes its active abort signal to
Braid, which aborts running nodes and marks queued nodes `cancelled`. To set a
node or graph timeout, supply milliseconds in the tool input under `options`;
each omitted timeout remains unlimited:

```json
{
  "maxConcurrency": 2,
  "nodeTimeoutMs": 30000,
  "graphTimeoutMs": 120000
}
```

The adapter sets `maxRetries: 0`, `cacheRetention: "none"`, and gives each node a
fresh provider context. Read-only tools are bounded to 12 tool rounds or 32
calls per node. Missing paths and invalid read-only tool arguments are returned
as tool errors so the node can recover; write/shell tool requests are unavailable
and are also returned as errors. Provider authentication and calls may still
incur normal provider costs. Braid cannot forcibly stop synchronous JavaScript
or a remote provider that ignores cancellation. Read access follows Pi's normal
filesystem permissions and is not a sandbox or snapshot.

The tool output is capped at 50KB/2000 lines to protect Pi context. When exceeded,
the adapter writes a mode-600 full JSON result to a temporary file and includes
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
call and its live graph/handoff log.
