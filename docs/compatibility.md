# Compatibility and stability

| Surface | Supported / tested contract |
| --- | --- |
| Core runtime | Node.js 22+, ESM imports, TypeScript declarations, no runtime dependencies |
| Pi package | Node.js 22.19+, Pi 0.87.1 is the pinned validation target |
| CI | Core minimum Node 22.0; both packages on Node 22.19 and 24 on Linux, macOS, Windows |
| OpenAI-compatible runner | Chat Completions text and function-tool calls; decisions and merge/integrate nodes require tool calling |
| Browsers / CommonJS | No supported browser build or CommonJS entry point in 0.2 |

The CI matrix describes configured checks; see actual workflow results for each
commit. Offline HTTP fixtures validate the adapter contract. They do not prove
that every provider advertising OpenAI compatibility supports its tool schema.
Run a small opt-in live test with your chosen provider before relying on it.

Pi's upstream packaging guide requires `*` peer dependencies for packages the
host provides. Braid follows that convention and pins dev dependencies to 0.87.1.
The wildcard is a loader/distribution convention, **not a claim that every Pi
version works**. Test the whole Pi suite before updating the supported target.
The offline host compatibility test loads the extension into a real Pi session
with an in-memory model provider. It checks worker prompt/tool normalization and
exactly one automatic continuation per node/job reminder delivered during
`agent_settled`, including retrieval of a node output while its job still runs.
This covers the Pi 0.86/0.87 transcript and settling changes without provider
credentials or network model calls. Version 0.1.0 was originally validated with
Pi 0.85.1; the current checkout's pinned validation target is 0.87.1.
The Pi npm package declares an exact dependency on the matching `@chrok/braid`
release. npm installs the core automatically; Pi does not bundle another copy of
its runtime and does not need a source checkout.

Git must be installed for workspace execution inside a Git checkout. Non-Git
text-only runs do not require Git workspace management.
## Migrating from 0.1 to 0.2

This release deliberately changes the execution and workspace contracts:

- Replace old source-checkout `merge` nodes with `integrate`. The new `merge`
  combines inputs in a fresh isolated worktree.
- Add explicit integrate nodes where a graph previously relied on automatic
  final integration. Runs no longer append `__braid_merge__`.
- Treat node IDs as definition identities. Read exact historical instances from
  `executions[executionId]`; `nodes[nodeId]` returns the latest instance.
- Key workspace lookups and `finish_merge` dispositions by `executionId`.
  Source workspaces remain reusable; target `dispositions` records selections.
- Read-only nodes now use isolated predecessor snapshots in Git. They receive
  checkpoints and cleanup events. All non-Git allocations also report metadata.
- Set `requireSuccess: true` on nodes whose failures must fail the whole job.
  Optional failures now retain their error and artifacts while allowing recovery.
- Handle repeated instance events and the new revision/loop/gate events. Use
  `braid_status({jobId, executionId})` for precise Pi result retrieval.
- Set finite `maxExecutions` (default 1000) and per-loop `maxIterations`. Deadlines
  and execution limits span live graph updates and paused gates.

Use `startBraid` for live updates or pause/resume. Existing `braid` callers can
still await a static graph result. See [execution control](execution-control.md)
for the full scheduling and update contract; there is no old-behavior mode.

Graph submissions may include `promptTemplates` and template-reference prompts.
`BraidInput.nodes` uses `BraidInputNode`, whose `NodePrompt` accepts a string or
`PromptTemplateReference`. Code inspecting unrendered input prompts must narrow
that union; use `satisfies BraidInput` to preserve the inferred types of a literal
graph. Runner-facing `BraidNode` and `ModelRequest.node` retain string prompts,
so existing runners need no template support. Rendering happens in core before
execution, including for Pi submissions. Older versions reject template inputs.

All node types accept optional `notifyOnCompletion: boolean` (default `false`).
Core captures this preference per execution; Pi implements parent reminders for successful and failed executions.
Skipped nodes do not notify. Pi's optional `braid_status` `nodeId` parameter
requires `jobId` and retrieves full intermediate node results. Whole-job queries and reminders remain available. Paused executions send a
separate gate reminder; when both preferences are enabled it supplies the single
completion reminder for that instance. Cancellation still sends failure reminders
for opted-in running instances.

## Versioning

Core and Pi release together with matching versions. During 0.x, patch releases
preserve documented behavior; breaking API or semantic changes require a minor
version bump, a changelog entry, and migration guidance. New optional fields or
fixes that restore the documented contract may ship in a patch.

Supported core entry points are `@chrok/braid` and `@chrok/braid/adapters/openai`.
The root `@chrok/braid` entry point also exports adapter helpers:
`formatBudgetReminder`, `gitToolDefinition`, `finishMergeToolDefinition`,
`mergeInstructions`, `parseGitToolArguments`, and `parseFinishMergeArguments`.
These helpers share the core's compatibility policy; Git workspace implementation
classes remain internal. Internal files and Pi helper classes are not stable
public APIs. Documented result/error
fields, routing behavior, `ModelRunner`, and existing event meanings are part of
the public contract. Consumers should ignore new diagnostic fields and provide a
fallback for new event types; event sequence numbers order events within a run,
but concurrent nodes need not finish in a fixed order.

There is no cross-version serialized job/checkpoint format. Pi jobs are scoped to
one host session and are lost on exit, reload, switch, or fork. The project is
experimental and maintained on a best-effort basis.
