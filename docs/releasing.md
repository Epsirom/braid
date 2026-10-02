# Releasing

Core and Pi are separate public npm packages built from one commit. Both use the
same version. The core has no runtime dependencies. Pi declares an exact
`@chrok/braid` dependency and includes only its own compiled integration code.

## Registry and source association

The public packages are [@chrok/braid](https://www.npmjs.com/package/@chrok/braid)
and [@chrok/pi-braid](https://www.npmjs.com/package/@chrok/pi-braid) on npmjs.
Keep `publishConfig.registry` set to `https://registry.npmjs.org`. Both manifests
link to `Epsirom/braid`; Pi's `repository.directory` is `integrations/pi`.
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
```

For a release, query the exact `@X.Y.Z` versions too. Confirm both `gitHead`
values match the release commit, the source links point to this repository, and
provenance identifies this repository's release workflow. The successful
[Publish runs](https://github.com/Epsirom/braid/actions/workflows/release.yml)
and public npm attestations provide release evidence; inspecting or changing
the trusted-publisher account settings requires npm authentication.

## Prepare a release

Version tags (`v*`) cannot be moved or deleted. New GitHub releases are immutable:
prepare a draft and attach any assets before publishing. Published tag/asset
corrections require a new version. See [repository settings](repository-settings.md).

1. Update both `package.json` versions, Pi's exact `@chrok/braid` dependency,
   and the root workspace lockfile (`npm install --package-lock-only`). Use a minor version
   for breaking 0.x changes, and describe migrations in the changelog.
2. Run `npm ci` and `npm run verify` from the repository root.
   The package check verifies clean builds, public ESM imports, declarations,
   licenses, and Pi registration in a temporary consumer outside the checkout.
   A temporary local registry serves the unpublished core tarball; installing
   only the Pi tarball must fetch core transitively through its version dependency.
3. Update the changelog, migration guidance, package descriptions/keywords, and
   supported Pi version. Reconcile README/Pi development notices and ROADMAP
   status with the release being prepared; mark publication complete only after
   both packages are available. Commit and review the changes;
   require the CI matrix to pass before tagging that commit `vX.Y.Z`.
4. Inspect `npm pack --dry-run` and `npm pack --dry-run` from `integrations/pi`.
   `prepack` rebuilds each package. Never publish stale prebuilt output.

## First publication

Enable two-factor authentication in the npm account's web settings before the
first publish. An emailed login code does not replace enrolling a security key
or passkey for publishing. Complete credential enrollment yourself and keep
recovery codes private.

Log in locally with `npm login --registry=https://registry.npmjs.org`; confirm the
account with `npm whoami`. Publish the core with `npm publish --access public`,
then run `npm publish --access public` from `integrations/pi`. Complete npm's
interactive account/2FA checks if requested. Never put credentials in source,
issues, shell history, or CI logs. An npm registration alone does not guarantee
ownership of a previously used package name.

New packages may temporarily return `E404` after a successful publish while npm
runs its [publish-time scan](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).
Allow time for the exact versions to become available through `npm view`; do not
republish or bump versions just to work around this delay.

After availability is confirmed, install the registry versions in a fresh project and verify
both exported core entry points and the Pi extension. Add the actual publication
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
npm trust list @chrok/braid
npm trust list @chrok/pi-braid
```

Publishing a non-prerelease GitHub release triggers `.github/workflows/release.yml`.
It validates the tag/version relationship, repeats all checks, and publishes
core then Pi using short-lived OIDC credentials. After each publish (or retry
of an existing version), it waits for matching version/commit metadata and a
successful tarball download. Pi is not published until core is available. npm
processing is polled every 15 seconds for up to 10 minutes; a timeout fails the
workflow with retry instructions. It does not require `NPM_TOKEN`.
The workflow installs npm 11 and uses Node 24. See
[npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

If the second publish fails, rerun the same workflow after resolving the error.
The script skips an existing version only when npm records the exact current
Git commit as its `gitHead`. A collision from another commit fails explicitly;
never unpublish/reuse a version to repair it. Publish a new patch instead.

Prereleases are deliberately excluded from the automatic `latest` workflow.
Publish them manually with an explicit tag such as `--tag next` after checks.
