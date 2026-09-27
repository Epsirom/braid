# Roadmap

Braid is a small execution primitive for complete, dynamically constructed DAGs
of isolated model calls. The goal is a predictable core and thin host adapters.
This is a direction for discussion, not a delivery schedule.

## 0.1 release foundation

- [x] Deterministic validation, scheduling, decisions, cancellation, and events.
- [x] OpenAI-compatible runner and Pi background-job integration.
- [x] Core-managed worktrees, recovery refs, merge agents, and Pi tool budgets.
- [x] Clean builds and standalone package installation checks.
- [x] CI configuration, contribution policies, examples, and compatibility docs.
- [x] Reproducible scheduler benchmark and explicit resource limits.
- [x] Confirm hosted CI on Linux, macOS, Windows, and the minimum Node version.

Published versions are listed in [GitHub releases](https://github.com/Epsirom/braid/releases).

## Next candidates

- Migrate both packages from TypeScript 5 to 7 in one dedicated change. Explicitly
  load Node types, review compiler default changes, and validate public declaration
  consumption, package builds, and the complete Node/platform matrix. Keep Node
  declarations on 22.x while Node 22 remains the minimum supported runtime.
- Measure real applications before changing scheduler data structures.
- Discuss optional per-run node/output limits and host-wide admission controls.
- Define budget semantics that account for missing usage and in-flight calls
  before adding token or spend enforcement.
- Improve provider diagnostics and add adapters backed by real compatibility
  tests. Keep SDK dependencies outside the core.
- Explore explicit job retention and temporary-result cleanup policies for long
  Pi sessions without breaking result retrieval or usage accounting.

## Scope

Loops, durable workflows, checkpoints/resume, graphical workflow editing,
arbitrary code nodes, graph mutation during execution, and recursive worker
delegation remain outside the current scope. Proposals should explain why a
small runtime primitive needs the behavior rather than a caller or host adapter.

Useful early contributions include minimal bug reproductions, platform testing,
small real-world examples, and documentation fixes. See [CONTRIBUTING.md](CONTRIBUTING.md).
