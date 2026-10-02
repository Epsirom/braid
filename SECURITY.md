# Security policy

## Reporting

Use GitHub's **Report a vulnerability** on the
[Security tab](https://github.com/Epsirom/braid/security/advisories/new) to contact
the maintainer privately. Include the affected version, minimal reproduction,
impact, and suggested mitigation. Do not open a public issue containing an
unfixed exploit, API key, private transcript, or confidential source code.

Reports are handled on a best-effort basis. We will coordinate a fix and public
advisory where appropriate. There is no response-time guarantee or bounty program.
Only the latest released 0.x minor series receives fixes; older series should
upgrade. Before the first release, report issues against the current main branch.

## Trust boundaries

- Braid isolates invocation context; it is not a process or filesystem sandbox.
  A custom runner is trusted code with the host process's permissions.
- The core manages Git snapshots, worktrees, checkpoint refs, and merge tools.
  Pi workers can write/edit their assigned Git worktree. Integrate agents can apply
  changes to the source checkout; merge agents use isolated worktrees; they are not restricted to read-only analysis.
  Outside Git, Pi file tools stay read-only. Read paths can expose files outside
  the checkout and disclose content to a model provider.
- Execute/decision nodes can request `workspace: "read-only"` inside Git. Pi
  omits write/edit tools, and core rejects write-barrier operations. Git inspection
  remains available. These nodes read an isolated predecessor
  snapshot; custom runners must honor this capability themselves.
- Guarded write tools reject external paths, Git metadata, symlinks, hard links,
  and special files, but are not an OS sandbox against concurrent filesystem
  attacks. Avoid concurrent external source edits while integrate agents run. A
  cancellation or failed merge can leave partial integration/conflicts for review;
  checkpoint and backup refs support recovery.
- Prompts, predecessor outputs, tool results, errors, and model answers may be
  untrusted. Do not execute generated text or grant additional capabilities based
  solely on a model answer.
- Results and event logs retain full output. The Pi adapter may write a complete
  result to a temporary file (mode 600 on POSIX; inherited ACLs on Windows) when
  the preview is truncated. These files
  are not automatically deleted by Braid. Redact exports and remove temporary
  results when no longer needed; filesystem permissions vary by platform.
- Cancellation and timeout cannot stop synchronous JavaScript or remote work
  that ignores the abort signal. Enforce provider quotas and host-side admission
  limits for untrusted callers. See [resource limits](docs/resource-limits.md).

The OpenAI-compatible adapter sends its API key only to the configured base URL.
Treat that URL as trusted configuration. Keep credentials out of graphs, logs,
issues, and committed files.
