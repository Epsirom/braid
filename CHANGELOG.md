# Changelog

## Unreleased

- Make Pi depend on the exact `@chrok/braid` version instead of bundling core.
  Export shared model-adapter helpers from the existing root entry point.
- Use one npm workspace lockfile and a development-only local core link; test
  Pi-only installation against the unpublished core tarball outside the checkout.
- Wait for core registry metadata and tarball availability before publishing Pi.

## 0.1.1 — 2026-09-27

- Validate the Pi integration against Pi 0.87.1; update GitHub Actions and tsx.
- Group routine dependency updates and reserve Node/TypeScript major upgrades
  for deliberate compatibility changes across both packages.
- Clarify Pi tool and context guidance for parallel implementation and merge
  nodes; describe read-only filesystem access by the node's assigned workspace
  instead of assuming its directory is outside Git.
- Trim OpenAI-compatible base URL trailing slashes in linear time, avoiding
  excessive regular-expression backtracking on long internal slash sequences.
- Protect the main branch and version tags; document repository governance,
  CodeQL checks, Actions restrictions, and immutable releases.

## 0.1.0 — 2026-09-27

Initial public release. Publication is tracked in
[GitHub releases](https://github.com/Epsirom/braid/releases).

- Framework-independent DAG runtime with conditional decisions, bounded
  concurrency, explicit joins, failure propagation, and isolated node context.
- Caller cancellation, node/graph deadlines, immutable events, partial results,
  model overrides, and provider-reported token accounting.
- OpenAI-compatible Chat Completions runner with validated decision tool calls.
- Pi background jobs, completion reminders, cancellation, guarded worker tools,
  and a live flow panel. The Pi package includes the matching core runtime.
- Core-managed Git worktrees, checkpoint/backup refs, agent-driven merge nodes,
  failure context on unconditional edges, and optional Pi tool budgets.
- Clean package builds, isolated tarball checks, CI for Node and supported
  operating systems, and an npm trusted-publishing workflow.
- Install guides, runnable offline examples, compatibility and resource-limit
  documentation, scheduler benchmarks, and contribution/security policies.

Limitations: no persistent jobs, retries, token/spend budgets, streaming core
responses, graph mutation, nested runs, or sandboxing. See the roadmap and
resource-limit documentation before using it as a service.
