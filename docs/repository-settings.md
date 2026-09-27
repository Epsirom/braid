# Repository settings

The live [GitHub rulesets](https://github.com/Epsirom/braid/rules) enforce these
policies. JSON files in [.github/rulesets](../.github/rulesets) are reviewable
copies of the API payloads; committing a change to them does not apply it to
GitHub automatically. Update the existing ruleset in Settings or through the
REST API after reviewing a policy change, then verify the live settings.

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
- Repository workflows allow GitHub-owned actions and reusable workflows only.
  Actions must be pinned to full commit SHAs. Review and explicitly allow any
  future third-party action before using it.
- Workflows from all external fork contributors require maintainer approval
  before running. Inspect workflow and code changes before approving a run.
- CodeQL default setup scans GitHub Actions and JavaScript/TypeScript with the
  default query suite and remote threat model, including its weekly schedule.
- Dependabot alerts/security updates, secret scanning, secret push protection,
  and private vulnerability reporting are enabled. Dependency updates remain
  configured in [.github/dependabot.yml](../.github/dependabot.yml).

These are repository settings, not organization-wide changes. Neither commit
sign-off nor a CLA is required for contributions.
