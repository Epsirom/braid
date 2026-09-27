# Releasing

Core and Pi are separate public npm packages built from one commit. Both use the
same version. The core has no runtime dependencies. Pi bundles compiled core
source so its installed extension never reaches outside its own package.

## Prepare a release

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

Log in locally with `npm login --registry=https://registry.npmjs.org`; confirm the
account with `npm whoami`. Publish the core with `npm publish --access public`,
then run `npm publish --access public` from `integrations/pi`. Complete npm's
interactive account/2FA checks if requested. Never put credentials in source,
issues, shell history, or CI logs. An npm registration alone does not guarantee
ownership of a previously used package name.

After publication, install the registry versions in a fresh project and verify
both exported core entry points and the Pi extension. Add the actual publication
date to the changelog and create the corresponding GitHub release.

## Subsequent releases with trusted publishing

For **each** package, configure an npm GitHub trusted publisher:

- Owner: `Epsirom`
- Repository: `braid`
- Workflow filename: `release.yml`
- Environment: leave blank (this workflow does not declare one)
- Allow direct `npm publish`

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
