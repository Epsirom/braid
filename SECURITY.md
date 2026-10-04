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

## Dependency security

Audit the development tree as well as runtime dependencies with
`npm ci` followed by `npm run audit:dependencies`. Scanner errors are incomplete
results and fail the check; they must not be treated as zero vulnerabilities.

The Pi development dependencies are pinned together to 1.0.1. Its
[published npm tarball](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.0.1.tgz)
removes `npm-shrinkwrap.json` and directly pins `brace-expansion` 5.0.12, fixing
[GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) and related
advisories tracked in [issue #37](https://github.com/Epsirom/braid/issues/37).
The regenerated Braid lockfile resolves Pi's `minimatch 10.2.6` to
`brace-expansion 5.0.12` after a clean `npm ci`, verified on 2026-10-03.

An upstream release does not update an existing Braid lockfile or installation.
When upgrading Pi, inspect the published package (including any shrinkwrap),
update the Pi development dependencies together, regenerate the root lockfile,
and inspect `npm ls brace-expansion --all` after a clean `npm ci`. Confirm the
version resolved by Pi's installed minimatch, run `npm run verify`, and review
`npm run audit:dependencies` before declaring a dependency issue fixed.

These Braid lockfile entries are development dependencies. This does not
establish exposure in a separately installed Pi host; inspect that host's actual
dependency tree independently. A production-only audit of this repository cannot
answer that question.

## Trust boundaries

- Braid isolates invocation context; it is not a process or filesystem sandbox.
  A custom runner is trusted code with the host process's permissions.
- The core manages Git snapshots, worktrees, checkpoint refs, and merge tools.
  Writable Pi workers can write/edit and run shell commands in their assigned Git
  worktree. Shells run with host permissions; prompts constrain workspace writes,
  shared Git state, and external side effects. Integrate agents can apply
  changes to the source checkout; merge agents use isolated worktrees; they are not restricted to read-only analysis.
  Outside Git, Pi file tools stay read-only. Read paths can expose files outside
  the checkout and disclose content to a model provider.
- Execute/decision nodes can request `workspace: "read-only"` inside Git. Pi
  omits write/edit and shell tools, and core rejects write-barrier operations. Git inspection
  remains available. These nodes read an isolated predecessor
  snapshot; custom runners must honor this capability themselves.
- Guarded write tools reject external paths, Git metadata, symlinks, hard links,
  and special files, but are not an OS sandbox against concurrent filesystem
  attacks. Shell commands can bypass these guards. Parent extension/MCP tools and
  their interception policies are not inherited by nodes. Avoid concurrent external
  source edits while integrate agents run. A
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
  Pi shell calls are drained before checkpointing and stop their process group
  (Windows uses `taskkill /T`); daemonized processes outside that group and external
  services can outlive a call. Windows cleanup after parent exit is best effort.
  Ignored new files are excluded from checkpoints and discarded with the worktree;
  explicitly staged files still follow Git tracking semantics.

The OpenAI-compatible adapter sends its API key only to the configured base URL.
Treat that URL as trusted configuration. Keep credentials out of graphs, logs,
issues, and committed files.
