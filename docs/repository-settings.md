# Repository settings

The live [GitHub rulesets](https://github.com/Epsirom/braid/rules) enforce these
policies. JSON files in [.github/rulesets](../.github/rulesets) are reviewable
copies of the API payloads; committing a change to them does not apply it to
GitHub automatically. Update the existing ruleset in Settings or through the
REST API after reviewing a policy change, then verify the live settings.

## Repository identity and npm links

The GitHub About section describes the current `main` capabilities:

> TypeScript runtime for LLM agent graphs with bounded loops, live updates,
> isolated Git worktrees, and explicit integration. Framework-agnostic core,
> OpenAI-compatible runner, and Pi extension.

The repository website points to
[@chrok/braid on npm](https://www.npmjs.com/package/@chrok/braid). The root README
links both published packages and displays their npm version badges. Topics are
`llm`, `ai-agents`, `agent-runtime`, `agent-orchestration`, `multi-agent`,
`graph-execution`, `bounded-loops`, `git-worktree`, `parallel-execution`,
`typescript`, `nodejs`, `openai-compatible`, and `pi-package`.
The old DAG-only and workflow-engine labels do not describe the 0.2 scope.

Both packages publish to `https://registry.npmjs.org`:

| Package | Repository location |
| --- | --- |
| [@chrok/braid](https://www.npmjs.com/package/@chrok/braid) | Repository root |
| [@chrok/pi-braid](https://www.npmjs.com/package/@chrok/pi-braid) | `integrations/pi` |

Each manifest declares `repository`, `homepage`, and `bugs`; Pi additionally sets
`repository.directory`. These fields link npm pages back to the correct source
and issue tracker. Descriptions and keywords take effect on npm when a new
version is published; editing `main` does not change existing registry versions.

GitHub's **Packages** section represents its separate registry. It does not list
an npmjs package just because that package points to this repository. The project
uses npmjs only; no GitHub Packages mirror or additional package scope is
maintained. See [GitHub's npm registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
and the [release guide](releasing.md#registry-and-source-association).

## Main branch

[Protect main](https://github.com/Epsirom/braid/rules/24072177) applies to `main`,
including administrators, with no bypass actors:

- Changes must go through a pull request. Direct pushes, force pushes, and
  branch deletion are blocked.
- All review conversations must be resolved. New commits dismiss previous
  approvals.
- The branch must be up to date and all seven CI checks must pass: `core-minimum`
  and `verify` on Ubuntu, macOS, and Windows with Node 22.19.0 and 24. Checks must
  originate from the GitHub Actions app.
- CodeQL must supply analysis results. Code scanning errors and new security
  findings rated high or critical block merging.
- Squash is the only merge method, keeping a linear history. The squash commit
  uses the PR title and description.

There is currently one maintainer with write access. Required approval count is
therefore zero: GitHub does not allow authors to approve their own PRs.
[CODEOWNERS](../.github/CODEOWNERS) requests maintainer review for contributions,
but code-owner approval and approval of the last push are not mandatory. When a
second maintainer joins, require at least one approving review and consider
requiring code-owner and last-push approval. CI and PR requirements apply to the
current maintainer as well.

Automatic merge is available when explicitly enabled for a PR; it still waits
for the rules above. GitHub offers an Update branch button and deletes merged
head branches automatically. Do not bypass a failing check to merge a change.

## Releases

[Protect version tags](https://github.com/Epsirom/braid/rules/24072178) prevents
updates and deletion of `v*` tags, with no bypass actors. New version tags can
still be created by maintainers.

Immutable releases are enabled for future releases. Prepare a draft and upload
any assets before publishing; the release tag and assets become immutable when
published. This setting does not retroactively make existing releases immutable.
Use a new version for a correction. See [the release guide](releasing.md).

## Actions and security

- Actions use read-only `GITHUB_TOKEN` permissions by default and cannot create
  or approve PRs through that token. Individual workflows request only their
  needed permissions; the release job uses `id-token: write` for npm OIDC.
- External actions and reusable workflows are limited to GitHub-owned
  repositories; local actions remain allowed. External actions must be pinned
  to full commit SHAs. Review and explicitly allow any future third-party action
  before using it.
- Workflows from all external fork contributors require maintainer approval
  before running. Inspect workflow and code changes before approving a run.
- CodeQL advanced setup in [.github/workflows/codeql.yml](../.github/workflows/codeql.yml)
  scans GitHub Actions and JavaScript/TypeScript with the default query suite and
  remote threat model. It runs on pushes to `main`, pull requests targeting
  `main` (including forks), and a weekly schedule, with a manual trigger available.
  Default setup must remain disabled because it skips fork pull requests and
  prevents advanced-setup analysis uploads. Fork PR scans use `pull_request`
  and remain subject to the contributor approval policy above.
- Dependabot alerts/security updates, secret scanning, secret push protection,
  and private vulnerability reporting are enabled. Dependency updates remain
  configured in [.github/dependabot.yml](../.github/dependabot.yml).

These are repository settings, not organization-wide changes. Neither commit
sign-off nor a CLA is required for contributions.

## Dependency maintenance

Dependabot checks both npm workspace manifests through the root lockfile weekly.
The internal `@chrok/braid` dependency is updated by the coordinated release process. Pi host packages stay in a separate
group because even 0.x minor releases can change extension contracts. Other npm
minor/patch updates are grouped; GitHub Actions updates are grouped monthly and
retain full commit SHA pins. Grouping does not enable automatic merging.

Keep `@types/node` on 22.x to match the oldest supported Node major. TypeScript
major upgrades require a coordinated migration of core and Pi, including the
standalone package/declaration checks; the current migration is tracked in the
[roadmap](../ROADMAP.md). Automatic major version updates for these two packages
are ignored until their compatibility policy changes. Minor/patch updates,
vulnerability alerts, and security-update configuration remain enabled. Review
any security fix that requires crossing an ignored major version manually.
