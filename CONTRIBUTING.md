# Contributing to lumics-mcp

Thank you for considering a contribution. Please read this document before writing code — this
repository is governed by the Engineering OS framework, and its process expects design and approval
to happen _before_ implementation. A pull request that arrives with no tracked issue and no
approval may be closed regardless of code quality.

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## The contribution flow

Every meaningful change follows this sequence. Steps 3 and 4 are the ones contributors most often
skip, and skipping them is what causes wasted work.

1. **Open or select an issue.** Nothing meaningful is implemented without a tracked issue. Use the
   bug or feature template. If an issue already exists, comment on it before starting so two people
   do not build the same thing.
2. **Complete discovery.** Establish what actually happens today — read the relevant code, verify
   the behaviour, and check
   [`docs/reference/lumics-api-v1.md`](./docs/reference/lumics-api-v1.md) for what the Lumics API
   actually documents. Do not reason from what the API _ought_ to do.
3. **Write an RFC when one is required.** See [When an RFC is required](#when-an-rfc-is-required).
   RFCs live in `docs/rfc/` and follow the existing format; approved architectural decisions are
   then recorded as ADRs in `docs/adr/`.
4. **Obtain approval before implementation.** This is a hard gate, not a formality. For anything in
   the RFC-required list, wait for explicit maintainer approval on the issue or RFC before you
   start building. Silence is not approval.
5. **Implement the approved scope — and only that scope.** Scope expansion needs its own approval.
6. **Add tests and documentation.** Both are part of the change, not follow-up work. A feature with
   missing or stale documentation is incomplete. See [Tests](#tests) and [Documentation](#documentation).
7. **Obtain independent review.** At least one non-author approval is required.
8. **Complete validation.** `npm run validate` must pass, and CI must be green.
9. **Obtain merge approval.** A maintainer merges. Contributors do not self-merge.

### Independent review is mandatory

Per Engineering OS Constitution **Article VI, no implementation author may be the sole reviewer of
their own work.** This applies to maintainers as much as to outside contributors: if you wrote the
change, someone else reviews it. Branch protection enforces this mechanically, and you should not
look for a way around it — the requirement exists because self-review reliably misses things.

### When an RFC is required

Write an RFC, and get it approved, before implementing anything that touches:

- Architecture or the layer boundaries (`transport` / `api` / `domain` / `tools` / `presentation`)
- Security controls, authentication, or credential handling
- Destructive-action behaviour or the gating environment variables
- The public tool surface — adding, removing, or renaming a tool, or changing its arguments
- New or upgraded material dependencies (see [docs/DEPENDENCY_POLICY.md](./docs/DEPENDENCY_POLICY.md))
- Transport or distribution
- Anything that would deviate from an already-approved design

You do **not** need an RFC for: a typo or documentation fix, a bug fix that restores already-agreed
behaviour without changing an interface, a test that covers existing behaviour, or a lockfile
refresh.

If you are unsure, open the issue and ask. Asking costs a day; building the wrong thing costs a
week.

---

## Development setup

Node.js 20 or newer.

```bash
git clone https://github.com/ZenixSolutions/lumics-mcp.git
cd lumics-mcp
npm ci
cp .env.example .env   # fill in LUMICS_TOKEN and LUMICS_COMPANY_ID
npm run validate
```

**The server does not read that `.env` on its own.** Nothing in `src/` looks for a dotfile; the
implicit load was removed because it resolved a relative path against whatever directory the client
launched the server from, which made a planted file a token-exfiltration and gate-escalation vector
(`tests/security/dotenv-not-loaded.test.ts` locks that shut). Pass the file explicitly instead:

```bash
npm run build
node --env-file=.env dist/index.js
```

For anything that reads `process.env` directly — the contract tests, a one-off script — export the
variables in your shell, or prefix the command.

`.env` is gitignored. **Never commit credentials**, and never paste a real token into an issue,
pull request, test fixture, or example. See [SECURITY.md](./SECURITY.md).

`npm run validate` builds before it tests, deliberately: the tests in `tests/installation/` are
guarded on `dist/index.js` existing, so with no build they skip and the suite still exits 0. If you
reorder those steps you will get a green run that never exercised the installed server.

### If `npm ci` installs no dev tooling

If `npm run validate` fails with `tsc: command not found` (or the same for `eslint`, `prettier`, or
`vitest`), your npm is omitting devDependencies. Two settings cause it, and npm does not warn:

```bash
echo $NODE_ENV                  # `production` makes npm skip devDependencies
npm config get omit             # an `omit=dev` in your global npmrc does the same
```

Fix with either `NODE_ENV= npm ci --include=dev`, or by removing `omit=dev` from your npm config.
This is a local environment issue rather than a repository one, but it presents as a broken checkout.

---

## Branches, commits, and pull requests

### Trunk-based on `main`

Development is trunk-based. `main` is always releasable. Branch off `main`, keep the branch
**short-lived** — days, not weeks — and rebase rather than accumulating merge commits. Long-running
branches are a source of conflict and of review fatigue; if your change is too big to land in a few
days, it is probably too big for one pull request.

Branch names: `type/short-description`, for example `fix/ipam-path-spelling` or
`feat/metric-lookback`.

### Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`.

```
feat(tools): add lookback argument to metric tools
fix(api): send singular ipsubnet path on ipaddress reads
docs(readme): correct ChatGPT support status
```

A breaking change is marked with `!` after the type (`feat(tools)!: ...`) and a
`BREAKING CHANGE:` footer explaining what breaks and what to do about it. Note that pre-1.0, a
breaking tool-surface change ships as a **minor** bump with a changelog notice; see
[docs/RELEASE.md](./docs/RELEASE.md).

### Squash merge

Pull requests are **squash merged**. The squash commit message becomes the release-note source, so
write the PR title as a Conventional Commit. Individual commits within your branch do not need to
be perfectly formed; the title does.

### Branch protection on `main`

`main` is protected. Merging requires:

- **CI green** — every required check on `.github/workflows/ci.yml` passes
- **One approving review from a non-author** (Constitution Article VI)
- Branch up to date with `main`
- Linear history via squash merge
- No force pushes, no branch deletion
- Conversations resolved

Administrators are not exempt. If a required check is broken, fix the check.

---

## Tests

Run `npm test` locally; `npm run validate` runs the full gate CI enforces.

Testing is proportionate to risk, and the layers in use are:

| Layer       | Location            | Covers                                                              |
| ----------- | ------------------- | ------------------------------------------------------------------- |
| Unit        | `tests/unit`        | Path building, parameter mapping, time conversion, redaction        |
| Integration | `tests/integration` | Each endpoint with HTTP mocked at the transport boundary            |
| Security    | `tests/security`    | Redaction, path encoding, read-only mode, destructive-action gating |
| Contract    | `tests/contract`    | Live tenant, opt-in via `LUMICS_CONTRACT_TESTS=1`                   |

What a change must bring with it:

- Any externally visible behaviour needs a test. That includes every tool argument and every error
  path a user can reach.
- Any bug fix needs a regression test that fails before the fix.
- Security controls are **verified by test, not asserted in prose**. If your change touches
  redaction, path encoding, read-only mode, or a gate, extend `tests/security`.
- HTTP is mocked at the transport boundary. Do not write a test that calls the live API outside
  `tests/contract`.
- Contract tests never run in CI — they require a real token. Maintainers run them manually before
  a release; see [docs/RELEASE.md](./docs/RELEASE.md).

### Coverage

Coverage is measured on `src/api` and `src/tools` only, with thresholds of 80% lines, 80%
functions, 80% statements, and 70% branches (`npm run test:coverage`). There is deliberately **no
repository-wide gate**: a global number is easily satisfied by testing trivia, so the threshold is
pointed at the two layers where defects actually live. Engineering OS sets no coverage requirement;
this is a project-specific addition recorded in [docs/DECISION_LOG.md](./docs/DECISION_LOG.md).

Treat the threshold as a floor, not a target. Hitting 80% while leaving an error path untested is
not compliance.

A passing suite does not substitute for independent review.

---

## Documentation

Documentation is part of the feature, not a follow-up. A pull request that changes behaviour
without updating the docs is incomplete.

- New or changed tool → update the tool reference and, if user-visible, the README.
- New or changed environment variable → update **both** `.env.example` and the README
  configuration table. They must not drift.
- New known constraint → add it to the README **Limitations** section. Being candid about what does
  not work is a requirement here, not a stylistic choice.
- Every user-visible change → add an entry to [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]`.
- Never document behaviour you have not verified, and never invent Lumics API behaviour that
  `docs/reference/lumics-api-v1.md` does not document. Documentation gaps get reported, not guessed
  around.

Prose style: direct, no marketing language, no emoji. Assume a skeptical senior engineer is reading.

---

## Code standards

- TypeScript, `strict` mode, ESM. Avoid `any`; if it is genuinely justified, add an inline
  `eslint-disable` with a reason.
- Respect the layer separation: `transport/`, `api/`, `domain/`, `tools/`, `presentation/`.
  Transport code carries no domain knowledge; tool code does not build URLs.
- **No `console`.** On stdio, stdout _is_ the MCP protocol channel — anything written there
  corrupts the stream. Diagnostics go to stderr through the redacting logger. ESLint enforces this.
- Validate every tool input with Zod at the boundary.
- `encodeURIComponent` every interpolated path segment.
- Never fabricate pagination metadata. The Lumics API has no pagination; the server must not
  pretend otherwise.
- Never log, echo, or return credential material.
- Every tool carries an operation classification — Read, Create, Update, Admin, or Destructive —
  mapped to the corresponding MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

[CLAUDE.md](./CLAUDE.md) states the same rules in the form AI coding agents need, and is worth
reading whether or not you use one.

---

## Reporting bugs and requesting features

Use the issue templates. For a bug, we need the version, the client and its version, your Node
version, what you expected, what happened, and the exact tool call if you have it. **Redact tokens,
company ids, hostnames, and IP addresses** before pasting anything.

For a security vulnerability, do **not** open a public issue. Follow
[SECURITY.md](./SECURITY.md).

---

## Governance

This project follows the Engineering OS framework: Engineering OS defines _how_ the project is
built; this repository defines _what_ is being built. Where a rule here and an Engineering OS
standard appear to conflict, ask rather than assume — do not invent a new convention when one
already exists.

Where the governing records live:

- [`docs/rfc/`](./docs/rfc/) — approved designs. Read RFC-001 before proposing an architectural
  change; it explains why several things that look wrong are deliberate.
- [`docs/adr/`](./docs/adr/) — approved architectural decisions. An ADR is not edited in place once
  approved; changing a decision means a new ADR that supersedes it.
- [`docs/DECISION_LOG.md`](./docs/DECISION_LOG.md) — what was approved, by whom, and the scope of
  that approval, including every recorded exception and capability reduction.
- [`docs/reference/`](./docs/reference/) — the captured Lumics API contract. Authoritative for what
  the API does; the code must not exceed it.

If you are about to argue that an existing decision is wrong, read its ADR first. Several of them
anticipate the objection and record why it was rejected — which is useful either way, because it
tells you what new evidence would actually change the answer.
