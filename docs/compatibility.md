# Compatibility and stability

| Surface | Supported / tested contract |
| --- | --- |
| Core runtime | Node.js 22+, ESM imports, TypeScript declarations, no runtime dependencies |
| Pi package | Node.js 22.19+, Pi 0.85.1 is the pinned validation target |
| CI | Core minimum Node 22.0; both packages on Node 22.19 and 24 on Linux, macOS, Windows |
| OpenAI-compatible runner | Chat Completions text and function-tool calls; decisions and merge nodes require tool calling |
| Browsers / CommonJS | No supported browser build or CommonJS entry point in 0.1 |

The CI matrix describes configured checks; see actual workflow results for each
commit. Offline HTTP fixtures validate the adapter contract. They do not prove
that every provider advertising OpenAI compatibility supports its tool schema.
Run a small opt-in live test with your chosen provider before relying on it.

Pi's upstream packaging guide requires `*` peer dependencies for packages the
host provides. Braid follows that convention and pins dev dependencies to 0.85.1.
The wildcard is a loader/distribution convention, **not a claim that every Pi
version works**. Test the whole Pi suite before updating the supported target.
The Pi npm package compiles and includes the same core source as the matching
core release, so it does not need another installed copy of Braid or a checkout.

Git must be installed for workspace execution inside a Git checkout. Non-Git
text-only runs do not require Git workspace management.

## Versioning

Core and Pi release together with matching versions. During 0.x, patch releases
preserve documented behavior; breaking API or semantic changes require a minor
version bump, a changelog entry, and migration guidance. New optional fields or
fixes that restore the documented contract may ship in a patch.

Supported core entry points are `braid` and `braid/adapters/openai`. Internal
files and Pi helper classes are not stable public APIs. Documented result/error
fields, routing behavior, `ModelRunner`, and existing event meanings are part of
the public contract. Consumers should ignore new diagnostic fields and provide a
fallback for new event types; event sequence numbers order events within a run,
but concurrent nodes need not finish in a fixed order.

There is no cross-version serialized job/checkpoint format. Pi jobs are scoped to
one host session and are lost on exit, reload, switch, or fork. The project is
experimental and maintained on a best-effort basis.
