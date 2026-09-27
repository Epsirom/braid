# Releasing

Core and Pi are separate public npm packages built from one commit. Both use the
same version. The core has no runtime dependencies. Pi bundles compiled core
source so its installed extension never reaches outside its own package.

## Prepare a release

Version tags (`v*`) cannot be moved or deleted. New GitHub releases are immutable:
prepare a draft and attach any assets before publishing. Published tag/asset
corrections require a new version. See [repository settings](repository-settings.md).

1. Update both `package.json` versions and both lockfiles. Use a minor version
   for breaking 0.x changes, and describe migrations in the changelog.
2. Run `npm ci`, `npm ci --prefix integrations/pi`, and `npm run verify`.
   The package check verifies clean builds, public ESM imports, declarations,
   licenses, and Pi registration in a temporary consumer outside the checkout.
3. Update the changelog and supported Pi version. Commit and review the changes;
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
core then Pi using short-lived OIDC credentials. It does not require `NPM_TOKEN`.
The workflow installs npm 11 and uses Node 24. See
[npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

If the second publish fails, rerun the same workflow after resolving the error.
The script skips an existing version only when npm records the exact current
Git commit as its `gitHead`. A collision from another commit fails explicitly;
never unpublish/reuse a version to repair it. Publish a new patch instead.

Prereleases are deliberately excluded from the automatic `latest` workflow.
Publish them manually with an explicit tag such as `--tag next` after checks.
