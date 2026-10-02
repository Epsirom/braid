# Compatibility and stability

| Surface | Supported / tested contract |
| --- | --- |
| Core runtime | Node.js 22+, ESM imports, TypeScript declarations, no runtime dependencies |
| Pi package | Node.js 22.19+, Pi 0.87.1 is the pinned validation target |
| CI | Core minimum Node 22.0; both packages on Node 22.19 and 24 on Linux, macOS, Windows |
| OpenAI-compatible runner | Chat Completions text and function-tool calls; decisions and merge nodes require tool calling |
| Browsers / CommonJS | No supported browser build or CommonJS entry point in 0.1 |

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
exactly one automatic continuation when a job finishes during `agent_settled`.
This covers the Pi 0.86/0.87 transcript and settling changes without provider
credentials or network model calls. Version 0.1.0 was originally validated with
Pi 0.85.1; the current checkout's pinned validation target is 0.87.1.
The Pi npm package declares an exact dependency on the matching `@chrok/braid`
release. npm installs the core automatically; Pi does not bundle another copy of
its runtime and does not need a source checkout.

Git must be installed for workspace execution inside a Git checkout. Non-Git
text-only runs do not require Git workspace management.
Execute/decision nodes can opt into `workspace: "read-only"`; omitted or
`"worktree"` values preserve the existing allocation behavior. Merge nodes reject
this field. Explicit read-only nodes report workspace metadata/events even when
the entire run is read-only; implicit non-Git runs keep their existing shapes.
Older versions reject the new field during validation.

Graph submissions may include `promptTemplates` and template-reference prompts.
`BraidInput.nodes` uses `BraidInputNode`, whose `NodePrompt` accepts a string or
`PromptTemplateReference`. Code inspecting unrendered input prompts must narrow
that union; use `satisfies BraidInput` to preserve the inferred types of a literal
graph. Runner-facing `BraidNode` and `ModelRequest.node` retain string prompts,
so existing runners need no template support. Rendering happens in core before
execution, including for Pi submissions. Older versions reject template inputs.

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
