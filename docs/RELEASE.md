# Release and Tagging Policy

This document is the release policy for `@zenixsolutions/lumics-mcp`: how versions are chosen, how
tags are formed, what must be true before a release, and the one gate that is deliberately manual.

Releases require owner approval. Nothing here authorises a release on its own.

## Versioning

The project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), as required by
the Engineering OS release standard.

The **public contract is the tool surface** — tool names, arguments, enum values, output shape — plus
the environment-variable configuration surface. Internal module structure is not part of the
contract; the package exports `buildServer()` for in-process testing, but reorganising `src/` is not
a breaking change.

### Pre-1.0 rules

While the version is below `1.0.0`, semver permits breaking changes in a minor release, and this
project uses that latitude deliberately. `0.1.0` signals that the tool surface may still move.

| Change                                                  | Bump  |
| ------------------------------------------------------- | ----- |
| Breaking change to a tool name, argument, or output     | Minor |
| Breaking change to an environment variable              | Minor |
| New tool, new optional argument, new configuration      | Minor |
| Bug fix, documentation, dependency patch, internal work | Patch |

Every breaking change, minor bump or not, gets an explicit entry in
[CHANGELOG.md](../CHANGELOG.md) under a `### Changed` or `### Removed` heading stating what breaks
and what to do instead. A breaking change that is not called out in the changelog is a defect in the
release, not a minor inconvenience.

### At and after 1.0.0

`1.0.0` is cut when the tool surface has been stable across at least one release cycle, contract
tests have validated the captured API contract against live behaviour, and the v0.2 HTTP deployment
path is either shipped or explicitly out of scope for 1.0.

From `1.0.0` onward, normal semver applies: breaking changes require a major bump, and backward
compatibility carries substantially greater weight in the priority order.

## Tagging

- Tags are `vX.Y.Z` — `v0.1.0`, `v0.2.0`, `v1.0.0`. The leading `v` is required; the release workflow
  triggers on `v*.*.*` and will not fire without it.
- **The tag must match `package.json` `version` exactly.** The release workflow verifies this and
  fails the release if they disagree, rather than publishing a package whose version does not match
  the tag that produced it.
- Tags are annotated and are created on `main` only, never on a branch.
- **Tags are immutable.** A tag is never moved, deleted, or re-pointed once pushed. A bad release is
  superseded by a new patch version, and the broken version is deprecated on npm
  (`npm deprecate`) — it is not unpublished, because unpublishing breaks every lockfile that already
  references it.
- Pre-releases, if ever needed, use `vX.Y.Z-rc.N` and publish under the `next` npm dist-tag so
  `npm install @zenixsolutions/lumics-mcp` continues to resolve to the latest stable.

## Release checklist

Per the Engineering OS release standard, a release requires approved scope, passing validation,
independent review, updated documentation, release notes, a version decision, a compatibility
assessment, a security assessment, and owner approval. In practice:

1. **Scope is approved.** Everything in the release landed through the normal flow: tracked issue,
   approval where required, independent review, merged to `main`.
2. **`main` is green.** CI passes on the merge commit being released.
3. **`npm run validate` passes locally** — typecheck, lint, format check, tests.
4. **Contract tests pass.** See [the manual contract-test gate](#the-manual-contract-test-gate)
   below. This is mandatory and it is not automated.
5. **Documentation is current.** README, configuration table, `.env.example`, tool reference, and
   Limitations all reflect what actually ships. A configuration change that appears in one of
   `.env.example` and the README but not the other blocks the release.
6. **Changelog is finalised.** The `[Unreleased]` heading becomes `[X.Y.Z] - YYYY-MM-DD`, entries are
   edited into release notes a user can read, and the comparison link is added.
7. **Compatibility assessment is recorded.** What breaks, for whom, and what they should do. State
   explicitly if nothing breaks.
8. **Security assessment is recorded.** New or changed security-relevant behaviour, dependency
   advisories, and any residual risk. `npm audit` findings are assessed, not skipped.
9. **Version decision is recorded**, with the reasoning if the bump is not obvious.
10. **Owner approval is obtained.** Explicitly. Silence is not approval.
11. **Tag and push.** The release workflow does the rest.

### Cutting the release

```bash
git switch main && git pull
npm run validate
npm run test:contract          # requires a real token; see the gate below

npm version 0.1.0 --no-git-tag-version   # edits package.json only
# finalise CHANGELOG.md, commit both through a reviewed pull request

git switch main && git pull
git tag -a v0.1.0 -m 'v0.1.0'
git push origin v0.1.0
```

The version bump and changelog edit go through a pull request like any other change — they are not
pushed directly to `main`. The tag is created only after that pull request has merged.

`.github/workflows/release.yml` then runs the full validation, builds, verifies the tag against
`package.json`, and publishes to npm with `--provenance --access public`. Provenance ties the
published artifact to the workflow run and the commit that produced it, which is what lets a
consumer verify where the package came from. It requires `id-token: write` on the job and an
`NPM_TOKEN` secret with publish rights on the `@zenixsolutions` scope.

### After publishing

- Verify the published artifact: `npm view @zenixsolutions/lumics-mcp version` and confirm the
  provenance badge appears on the npm page.
- Smoke-test the actual install path from a clean directory:
  `npx -y @zenixsolutions/lumics-mcp@0.1.0`. The README's copy-paste commands are a user-facing
  contract; if one of them is wrong, the release is wrong.
- Create the GitHub release from the tag, with the changelog section as its body.
- Update `PROJECT_MEMORY.md` and the decision log with what was released and when.

## The manual contract-test gate

**Contract tests are run manually before every release. They never run in CI.**

Contract tests (`npm run test:contract`, gated on `LUMICS_CONTRACT_TESTS=1`) make real calls against
a live Lumics tenant. They exist to validate the assumption the whole codebase rests on: that the
captured contract in [`docs/reference/lumics-api-v1.md`](./reference/lumics-api-v1.md) matches live
behaviour. That assumption is not free — the specification contains documented oddities such as the
IPAM singular/plural path asymmetry and several parameters documented as optional that cannot be, and
upstream drift is a real, rated risk.

They are deliberately excluded from CI:

- Running them in CI would require a **standing Lumics credential stored as a GitHub secret**. That
  is a long-lived, unscoped token — Lumics issues no read-only or per-integration token type — sitting
  in a public repository's secret store, reachable by every workflow run. The credential is a worse
  risk than the automation is a benefit.
- Pull requests from forks cannot access secrets anyway, so the check would be unreliable exactly
  where an external contribution needs it.
- The tests consume quota against a live tenant, and the API publishes no rate limits.

So the gate is a person:

1. A maintainer with access to a live tenant supplies `LUMICS_TOKEN` and `LUMICS_COMPANY_ID` **in
   the environment of the command** — `npm run test:contract` sets `LUMICS_CONTRACT_TESTS=1` itself.
   A `.env` file does not do this on its own: the server never reads one (see
   [SECURITY.md](../SECURITY.md)), and vitest reads `process.env`, so the values have to be exported
   or prefixed:

   ```bash
   LUMICS_TOKEN=... LUMICS_COMPANY_ID=... npm run test:contract
   # or, from a file you keep locally:
   set -a && . ./.env && set +a && npm run test:contract
   ```

2. They run `npm run test:contract`.
3. **They record the result in the release pull request** — pass or fail, the tenant used
   (identified, not credentialed), and the date. An unrecorded run did not happen.
4. Any divergence between documented and live behaviour is filed as an issue and reflected in
   `docs/reference/lumics-api-v1.md` before the release proceeds. The captured contract is the thing
   that must be corrected; the code follows it.

The contract tests are read-only by design. They do not create, modify, or delete tenant data. A
contract test that needed to write would need its own approval and is not currently in scope.

If no maintainer can run them for a given release, say so in the release notes rather than skipping
the step silently. An undisclosed skip is worse than a disclosed one.

## What CI does and does not do

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Node 20 and 22:
typecheck, lint, format check, tests, build, a secret scan, and a smoke test that the built server
starts on stdio with dummy credentials. **No CI job requires a secret to run**, which means CI works
identically for a fork's pull request and for a maintainer's.

CI does not run contract tests, does not publish, and does not have credentials for anything except
the release workflow's `NPM_TOKEN`, which is scoped to publishing and used only on a tag.

## Hotfixes

A hotfix is still a release: branch from `main`, fix, test, review, merge, bump the patch version,
tag. There is no path that skips independent review, including for security fixes — per Constitution
Article VI no author is the sole reviewer of their own work.

For a security fix, the public record may be terse to avoid disclosing an unpatched vulnerability;
see [SECURITY.md](../SECURITY.md). The review still happens, and the full analysis is retained
privately.
