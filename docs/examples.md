# Runnable examples

From the repository root, run `npm ci`, then `npm run examples`. All examples
use deterministic runners, require no credentials, and make no model calls.
Replace a runner with the documented provider adapter for live use.

| Example | Run | Expected result |
| --- | --- | --- |
| [Design comparison](../examples/basic.ts) | `npm run demo` | Decision chooses comparison, benefits/risks run concurrently, answer synthesizes them; brief branch skips |
| [Code review](../examples/code-review.ts) | `npx tsx examples/code-review.ts` | Correctness and test reviews run independently; final review lists both findings |
| [Failure handling](../examples/failure-handling.ts) | `npx tsx examples/failure-handling.ts` | `completed`; optional failure stays in history and join completes with local findings and explicit `remote` error context |
| [Loop and live update](../examples/execution-control.ts) | `npx tsx examples/execution-control.ts` | Two refinement rounds, a pause, and an atomic graph update/resume |
| [Custom runner](../examples/custom-runner.ts) | `npx tsx examples/custom-runner.ts` | `Received direct predecessors: route` |

These text-only examples use temporary non-Git directories. The code-review
example supplies a short diff in `goal`. In a real Git checkout, core manages
worktrees and merge agents; Pi can inspect and edit its assigned workspaces.
Fake responses illustrate control flow; they do not demonstrate model quality.

## Live comparison

Export `OPENAI_API_KEY` and `BRAID_MODEL`; optionally export `OPENAI_BASE_URL`.
Then run `npm run demo -- --live`. This makes billable requests and needs a model
that supports the decision function schema. `.env.example` documents variables;
Braid does not automatically load `.env` files.

## Pi panel

`npm run demo:panel` regenerates the [panel snapshot](assets/pi-panel.svg) from
the actual TUI renderer using deterministic fake model responses. It does not
require a running Pi session or model credentials. Install the extension and
run `/braid` in Pi to see real jobs update while they execute.
