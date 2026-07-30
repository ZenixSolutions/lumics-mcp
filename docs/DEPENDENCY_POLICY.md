# Dependency Policy

Every dependency is code we ship, code we are responsible for, and attack surface we inherit. This
policy exists because adding one is cheap and removing one is not.

## Fewer dependencies is the default

The preference is to write a small amount of code rather than take on a package. Concretely:

- The server uses the platform's native `fetch` rather than an HTTP client library. Node 20 provides
  it, the surface we need is small, and the alternative would be a material dependency with its own
  transitive tree, its own release cadence, and its own error objects carrying request headers we
  would then have to redact. Dropping the HTTP library was a deliberate decision recorded in
  RFC-001, not an accident of scope.
- A dependency that saves fewer lines than it costs in review, audit, and upgrade attention is not
  worth taking. Say so in the RFC rather than reaching for the package.
- A dependency added only for developer convenience should be a `devDependency`, never a runtime
  one. Runtime dependencies are shipped to every user.

The current runtime dependency list is deliberately two entries: `@modelcontextprotocol/sdk` and
`zod`. Both are load-bearing. Treat that count as a budget to defend.

## Exact-version pinning

**Every dependency is pinned to an exact version.** No `^`, no `~`, no ranges, in either
`dependencies` or `devDependencies`.

```json
"zod": "4.4.3"          // correct
"zod": "^4.4.3"         // rejected
```

This is deliberate, and it is what the TypeScript standard means by "pin and review material
dependencies":

- An upgrade becomes an explicit, reviewable commit with a diff, not something that happens silently
  when someone runs `npm install` on a Tuesday.
- CI, a contributor's laptop, and a user's `npx` invocation resolve the same tree.
- Supply-chain compromise of a patch release does not reach us without a human deciding to take it.

`package-lock.json` is committed and authoritative. `npm ci` — never `npm install` — is used in CI
and is what contributors should use to install. A lockfile change with no corresponding
`package.json` change needs an explanation in the pull request.

## Review criteria

Per the Engineering OS security standard — _"Review dependencies for provenance, maintenance, and
known vulnerabilities"_ — assess each of the three before proposing any addition or upgrade, and
record the assessment in the RFC or the pull request. An unassessed dependency is not reviewable.

### Provenance

- Who publishes it, and is that identity credible and verifiable?
- Does the published package correspond to the public source repository? Prefer packages published
  with npm provenance attestation.
- Is the license compatible with MIT redistribution? Copyleft runtime dependencies are not
  acceptable.
- How large is the transitive tree? A package with forty transitive dependencies is forty
  provenance questions, not one.
- Typosquat check: is the name what you actually meant?

### Maintenance

- Recent, meaningful releases; not abandoned, but not churning either.
- Open issues and pull requests are triaged rather than accumulating unanswered.
- More than one maintainer where the package is material. A single-maintainer package in the runtime
  path is a documented risk.
- Security issues in its history were handled promptly and disclosed.
- Does it support our floor — Node 20, ESM, TypeScript types?

### Known vulnerabilities

- `npm audit` clean, or every finding assessed and justified in writing.
- Check the GitHub Advisory Database, not just `npm audit`, before adding something new.
- Advisories in transitive dependencies count. "It is not our direct dependency" is not an
  assessment.
- An unfixed high or critical vulnerability in a runtime dependency blocks a release.

## Approval gate

**New material dependencies require explicit owner approval before implementation**, per the
Engineering OS approval workflow. A pull request that introduces one without prior approval will be
asked to stop and open an RFC.

A dependency is material if it is a runtime dependency, if it handles credentials, network I/O,
parsing, or serialisation, or if removing it later would require restructuring code.

| Change                                                                   | Requires                                     |
| ------------------------------------------------------------------------ | -------------------------------------------- |
| New runtime dependency                                                   | RFC and owner approval before implementation |
| New `devDependency` affecting the build, lint, format, or test toolchain | RFC and owner approval                       |
| Major version upgrade of any dependency                                  | Owner approval; changelog review in the PR   |
| Minor or patch upgrade                                                   | Normal pull request review                   |
| Security patch upgrade                                                   | Normal pull request review, expedited        |
| Removing a dependency                                                    | Normal pull request review                   |

Every dependency change, whatever its size, still needs CI green and one non-author approval.

## Dependabot cadence

[`.github/dependabot.yml`](../.github/dependabot.yml) configures automated update pull requests:

| Ecosystem      | Cadence        | Grouping                                              |
| -------------- | -------------- | ----------------------------------------------------- |
| npm            | Weekly, Monday | Production separate from development; majors separate |
| GitHub Actions | Weekly, Monday | All actions in one pull request                       |

Notes on how to treat those pull requests:

- Dependabot **proposes**; it does not decide. Each pull request goes through the same review as any
  other change: CI green, one non-author approval, and the criteria above applied proportionately.
- Because versions are pinned exactly, Dependabot pull requests edit `package.json` as well as the
  lockfile. That is expected and is the point — the upgrade is visible in the diff.
- Major-version updates are raised separately and are never merged without reading the upstream
  changelog for breaking changes. Note in the pull request what you read.
- Security updates are prioritised over routine ones. Do not let a security update queue behind a
  cosmetic patch bump.
- Open pull requests are capped so the queue stays reviewable rather than becoming noise that
  everyone learns to ignore.
- GitHub Actions are pinned by tag in the workflows. Never reference a mutable ref such as `@master`
  or `@main` — that is a remote-code-execution path into CI.

## Removing dependencies

Removal is always in scope and does not need an RFC. If a dependency is no longer used, or its job
can be done by a handful of lines of code we understand, remove it and say so in the changelog.
