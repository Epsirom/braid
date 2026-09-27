# Changelog

## Unreleased

No changes yet.

## 0.1.0

Initial public release candidate. Publication is tracked in
[GitHub releases](https://github.com/Epsirom/braid/releases).

- Framework-independent DAG runtime with conditional decisions, bounded
  concurrency, explicit joins, failure propagation, and isolated node context.
- Caller cancellation, node/graph deadlines, immutable events, partial results,
  model overrides, and provider-reported token accounting.
- OpenAI-compatible Chat Completions runner with validated decision tool calls.
- Pi background jobs, completion reminders, cancellation, read-only worker tools,
  and a live flow panel. The Pi package includes the matching core runtime.
- Clean package builds, isolated tarball checks, CI for Node and supported
  operating systems, and an npm trusted-publishing workflow.
- Install guides, runnable offline examples, compatibility and resource-limit
  documentation, scheduler benchmarks, and contribution/security policies.

Limitations: no persistent jobs, retries, token/spend budgets, streaming core
responses, graph mutation, nested runs, or sandboxing. See the roadmap and
resource-limit documentation before using it as a service.
