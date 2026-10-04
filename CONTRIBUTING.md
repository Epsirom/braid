# Contributing to Braid

Bug reports, documentation fixes, small examples, and focused runtime or adapter
improvements are welcome. Start with an issue before a large API change. Explain
the user problem and how it fits the [scope and roadmap](ROADMAP.md).

## Development

Use Node.js 22.19+ and npm. From a fresh checkout:

```sh
git clone https://github.com/Epsirom/braid.git
cd braid
npm ci
npm run verify
```

The root npm workspace lockfile covers both packages. A development-only
`@chrok/braid: file:.` dependency links the core checkout into `node_modules`;
Pi's manifest still declares the exact release version. This lets CI test a
new core before it is published. `check:pi`, `test:pi`, and `build:pi` rebuild
core so package imports resolve current JavaScript and declarations. Consumers
installing either published package do not install this development dependency.
Use `npm install --workspace @chrok/pi-braid <dependency>` for Pi dependency
updates; do not create a separate lockfile in `integrations/pi`.

The core has no runtime dependencies. Pi's dependencies belong in its workspace
manifest. Update and commit the root lockfile when changing a dependency. Do not commit generated `dist` directories,
tarballs, credentials, or provider output containing private data.

`verify` type-checks both packages, runs deterministic tests and offline examples,
then builds tarballs and installs them into a temporary consumer outside the
checkout. That last check needs registry access for Pi dependencies but never
calls a model. `npm test` is the fast core-only loop; `npm run test:pi` tests Pi.
`npm run bench` measures the scheduler without a provider.

Run `npm run audit:dependencies` after `npm ci` to scan the complete dependency
tree, including development dependencies. The separate Dependency security
workflow runs this on pull requests, pushes to main, and weekly. The command
exits 1 for vulnerabilities and 2 for scanner failures or incomplete reports;
both fail the workflow, with details in its log and a separate result summary.
This registry-backed check is separate from `verify` so deterministic tests do
not depend on audit service availability. See [dependency security](SECURITY.md#dependency-security)
for the known Pi shrinkwrap issue and the required upgrade verification.

## Changes and reviews

Submit changes to `main` through a pull request, including maintainer changes.
Keep the branch up to date, pass the required CI and CodeQL checks, and resolve
review conversations before squash merging. See the
[repository policies](docs/repository-settings.md) for the complete settings and
the current single-maintainer review policy.

- Keep the TypeScript strict checks passing. Follow nearby code and the
  repository's two-space formatting; use explicit public types.
- For behavior changes, add a regression test that fails before the change.
  Use deferred promises or fake runners instead of live models or long sleeps.
- Preserve decision-tool validation, join semantics, cancellation, context
  isolation, partial results, and provider usage accounting.
- Explain the observable change, why it is needed, and how it was verified in
  the PR. Update relevant docs and the Unreleased changelog for user-facing work.
- Read [compatibility](docs/compatibility.md) before changing public fields or
  error/event shapes. Discuss breaking changes before implementing them.

Small documentation fixes do not need extra tests. No CLA is required;
contributions are provided under this project's MIT license. Do not submit code
or data you do not have permission to share.

## Reporting and maintenance

Use [issues](https://github.com/Epsirom/braid/issues) for reproducible bugs,
questions, and feature proposals. Include package/Node/Pi versions, a minimal
graph, expected vs actual behavior, and redacted errors. Never include API keys,
private repository content, or a full model transcript unless safe to publish.
Report vulnerabilities through [SECURITY.md](SECURITY.md).

[Epsirom](https://github.com/Epsirom) maintains the project and reviews releases
and public API changes. Support is best effort, with no guaranteed response time.
For conduct concerns, contact the maintainer through a contact method listed on
their GitHub profile; use GitHub's Report abuse feature if private contact is
unavailable or the maintainer is involved. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Maintainers: follow the [release guide](docs/releasing.md).
