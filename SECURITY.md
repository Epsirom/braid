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
- The core has no filesystem or shell tools. Pi workers have read-only tools,
  but normal Pi path resolution can expose files outside the checkout. Read-only
  access does not prevent disclosure to a model provider.
- Prompts, predecessor outputs, tool results, errors, and model answers may be
  untrusted. Do not execute generated text or grant additional capabilities based
  solely on a model answer.
- Results and event logs retain full output. The Pi adapter may write a complete
  result to a mode-600 temporary file when the preview is truncated. These files
  are not automatically deleted by Braid. Redact exports and remove temporary
  results when no longer needed; filesystem permissions vary by platform.
- Cancellation and timeout cannot stop synchronous JavaScript or remote work
  that ignores the abort signal. Enforce provider quotas and host-side admission
  limits for untrusted callers. See [resource limits](docs/resource-limits.md).

The OpenAI-compatible adapter sends its API key only to the configured base URL.
Treat that URL as trusted configuration. Keep credentials out of graphs, logs,
issues, and committed files.
