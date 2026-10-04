# Releasing

Core, Pi, and DSH are separate public npm packages built from one commit. All use
the same version. The core has no runtime dependencies. Each integration declares
an exact `@chrok/braid` dependency and includes its own compiled integration code.

## Registry and source association

The public packages are [@chrok/braid](https://www.npmjs.com/package/@chrok/braid),
[@chrok/pi-braid](https://www.npmjs.com/package/@chrok/pi-braid), and
[@chrok/dsh-braid](https://www.npmjs.com/package/@chrok/dsh-braid) on npmjs.
DSH joins the coordinated release starting with 0.3.1.
Keep `publishConfig.registry` set to `https://registry.npmjs.org`. All manifests
link to `Epsirom/braid`; integration `repository.directory` values are
`integrations/pi` and `integrations/dsh`.
The repository About website and README badges provide the reverse links.
GitHub Packages is a separate registry and is not a mirror in this release flow.

Package descriptions, keywords, source links, and README content are uploaded
with the package release. A commit on `main` does not update the published npm
metadata. Keep development-version notices accurate until publication, and link
users of the current npm release to its tagged documentation.

To inspect the public release without npm account credentials:

```sh
npm view @chrok/braid dist-tags description repository homepage gitHead dist.attestations --json
npm view @chrok/pi-braid dist-tags description repository homepage gitHead dist.attestations --json
npm view @chrok/dsh-braid dist-tags description repository homepage gitHead dist.attestations --json
```

For a release, query the exact `@X.Y.Z` versions too. Confirm all `gitHead`
values match the release commit, the source links point to this repository, and
provenance identifies this repository's release workflow. The successful
[Publish runs](https://github.com/Epsirom/braid/actions/workflows/release.yml)
and public npm attestations provide release evidence; inspecting or changing
the trusted-publisher account settings requires npm authentication.

## Prepare a release

Version tags (`v*`) cannot be moved or deleted. New GitHub releases are immutable:
prepare a draft and attach any assets before publishing. Published tag/asset
corrections require a new version. See [repository settings](repository-settings.md).

1. Update all `package.json` versions, both integrations' exact `@chrok/braid` dependencies,
   and the root workspace lockfile (`npm install --package-lock-only`). Use a minor version
   for breaking 0.x changes, and describe migrations in the changelog.
2. Run `npm ci` and `npm run verify` from the repository root.
   The package check verifies clean builds, public ESM imports, declarations,
   licenses, Pi/DSH background jobs, and the DSH browser entry in temporary consumers outside the checkout.
   A temporary local registry serves the unpublished core tarball; installing
   either integration tarball must fetch core transitively through its version dependency.
3. Update the changelog, migration guidance, package descriptions/keywords, and
   supported Pi/DSH versions. Reconcile README/integration development notices and ROADMAP
   status with the release being prepared; mark publication complete only after
   all packages are available. Commit and review the changes;
   require the CI matrix to pass before tagging that commit `vX.Y.Z`.
4. Inspect `npm pack --dry-run` from the root, `integrations/pi`, and `integrations/dsh`.
   `prepack` rebuilds each package. Never publish stale prebuilt output.
5. Prepare the GitHub release draft using the release-note policy below. After
   publishing, verify all registry versions, `latest` tags, provenance, and a
   clean install before reporting the release complete.

## Release notes and contributor credit

Every release must describe user-visible features, fixes, and breaking changes
in both `CHANGELOG.md` and the GitHub release notes. For each item, link the
implementing pull request and credit its author by GitHub handle, for example:
`Add graph-local prompt templates ([#33](https://github.com/Epsirom/braid/pull/33)) — @Epsirom.`
Use the PR author, not the person who merged it. Issue links can add context but
do not replace PR links. Credit each relevant PR/author when an item combines
several contributions; credit direct-commit authors with commit links if no PR
exists. Keep dependency and release maintenance separate from feature summaries.

Compare the previous release tag with the exact candidate commit. Inspect the
merged PRs in that range and their authors; GitHub's generated release notes
are a useful starting point, not a substitute for checking the actual changes.
Keep the changelog and GitHub notes consistent, include migration guidance for
breaking changes, and link the full tag-to-tag comparison.

Mark a human author's first contribution to this repository with
`**First-time contributor**` next to their credit. Also add a **New Contributors**
section that thanks them and links their first included PR (or direct commit).
Verify this against all earlier merged PRs and commit history through the
previous release, not just the latest release notes. An existing contributor's
first PR in this release is not their first repository contribution. Exclude
bot accounts from newcomer thanks, while retaining their maintenance credits.
If there are no first-time human contributors, say so in that section; do not
infer newcomer status from a missing credit in an older release.

Before publishing the draft, check that every feature/fix has its implementing
PR link and author, newcomer labels match the history, and version, date,
comparison, and migration links refer to the release being published.

## First publication

Enable two-factor authentication in the npm account's web settings before the
first publish. An emailed login code does not replace enrolling a security key
or passkey for publishing. Complete credential enrollment yourself and keep
recovery codes private.

Log in locally with `npm login --registry=https://registry.npmjs.org`; confirm the
account with `npm whoami`. Publish the core with `npm publish --access public`,
then run `npm publish --access public` from each integration directory. Complete npm's
interactive account/2FA checks if requested. Never put credentials in source,
issues, shell history, or CI logs. An npm registration alone does not guarantee
ownership of a previously used package name.

New packages may temporarily return `E404` after a successful publish while npm
runs its [publish-time scan](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
Allow time for the exact versions to become available through `npm view`; do not
republish or bump versions just to work around this delay.

After availability is confirmed, install the registry versions in a fresh project and verify
both exported core entry points and the Pi/DSH integrations. Add the actual publication
date to the changelog and create the corresponding GitHub release.

## Subsequent releases with trusted publishing

For **each** package, configure an npm GitHub trusted publisher:

- Owner: `Epsirom`
- Repository: `braid`
- Workflow filename: `release.yml`
- Environment: leave blank (this workflow does not declare one)
- Allow direct `npm publish`

With npm 11.20 or later, the equivalent CLI setup is:

```sh
npm trust github @chrok/braid --file release.yml --repo Epsirom/braid --allow-publish
npm trust github @chrok/pi-braid --file release.yml --repo Epsirom/braid --allow-publish
npm trust github @chrok/dsh-braid --file release.yml --repo Epsirom/braid --allow-publish
npm trust list @chrok/braid
npm trust list @chrok/pi-braid
npm trust list @chrok/dsh-braid
```

Publishing a non-prerelease GitHub release triggers `.github/workflows/release.yml`.
It validates the tag/version relationship, repeats all checks, and publishes
core then Pi and DSH using short-lived OIDC credentials. After each publish (or retry
of an existing version), it waits for matching version/commit metadata and a
successful tarball download. Integrations are not published until core is available. npm
processing is polled every 15 seconds for up to 10 minutes; a timeout fails the
workflow with retry instructions. It does not require `NPM_TOKEN`.
The workflow installs npm 11 and uses Node 24. See
[npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

If a later publish fails, rerun the same workflow after resolving the error.
The script skips an existing version only when npm records the exact current
Git commit as its `gitHead`. A collision from another commit fails explicitly;
never unpublish/reuse a version to repair it. Publish a new patch instead.

Prereleases are deliberately excluded from the automatic `latest` workflow.
Publish them manually with an explicit tag such as `--tag next` after checks.
