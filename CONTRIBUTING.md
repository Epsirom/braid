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
npm ci --prefix integrations/pi
npm run verify
```

There are two packages and two lockfiles. The core has no runtime dependencies;
Pi's dependencies belong in `integrations/pi`. Update and commit the corresponding
lockfile when changing a dependency. Do not commit generated `dist` directories,
tarballs, credentials, or provider output containing private data.

`verify` type-checks both packages, runs deterministic tests and offline examples,
then builds tarballs and installs them into a temporary consumer outside the
checkout. That last check needs registry access for Pi dependencies but never
calls a model. `npm test` is the fast core-only loop; `npm run test:pi` tests Pi.
`npm run bench` measures the scheduler without a provider.

## Changes and reviews

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
