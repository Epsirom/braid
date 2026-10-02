# Changelog

## Unreleased

- Add submission-local `promptTemplates` and explicit template-reference prompts
  to core and Pi's `braid` tool. Core expands `{{name}}` placeholders using literal
  string variables, validates every rendered prompt before execution, and keeps
  existing plain-string/default merge prompts and runner contracts. Shared
  instructions no longer need repeating in each node's tool-call arguments (#29).

## 0.1.3 — 2026-09-29

- Add per-node `workspace: "read-only" | "worktree"` for execute/decision nodes.
  Read-only nodes inspect the live source directory with Git inspection, without
  writable tools, snapshots, worktrees, or merge sources. Existing defaults are
  preserved. Pi's braid tool guides analysis/review/routing/synthesis to read-only
  nodes and implementation to worktrees; explicit read-only workspace metadata
  is included in results and events (#22).
- Skip the automatic merge agent when all remaining workspaces match their
  snapshots, preserving analysis-only terminal outputs and original node errors.
  Mixed runs pass only changed sources to the automatic merge. Unchanged sources
  retain recovery refs pointing to their snapshots without empty checkpoint
  commits; explicit merge nodes still run even for unchanged sources (#21).
- Prevent Pi TUI crashes in narrow terminals by truncating the flowchart fallback
  message to the terminal width.
- Scan fork pull requests with CodeQL advanced setup so external contributions
  can satisfy the required security checks.

## 0.1.2 — 2026-09-27

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
