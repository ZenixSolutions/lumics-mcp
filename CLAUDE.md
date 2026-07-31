# CLAUDE.md — instructions for AI agents working in this repository

This file governs AI agents (Claude Code and equivalents) making changes to `lumics-mcp`. Read it
before writing code. Human contributors should read [CONTRIBUTING.md](./CONTRIBUTING.md), which says
the same things in a different register.

## Governance

This project is governed by the **Engineering OS** framework. Engineering OS defines _how_ the
project is built — architecture, standards, testing, security, workflow, review, and decision
making. This repository defines _what_ is being built.

Consequences for you:

1. Engineering OS is the source of truth for process and convention. Follow it.
2. **Do not invent new conventions.** If Engineering OS or this repository already defines one, use
   it. If neither does, ask rather than deciding silently.
3. Where a repository requirement appears to conflict with Engineering OS, **ask for
   clarification**. Do not resolve the conflict on your own initiative.
4. Distinguish facts, assumptions, inferences, and preferences when you report. Say "I have not
   verified this" when you have not.

## Approval before implementation

**Do not begin meaningful implementation without explicit approval.** Silence is not approval, and
neither is an ambiguous instruction that could be read as approval. This is Article V of the
Engineering OS Constitution and it is the rule most likely to be broken by an eager agent.

The sequence is: issue → discovery → RFC where required → **explicit owner approval** → ADR →
implementation → independent review → validation → merge approval.

Stop and ask for approval before:

- Meaningful implementation of any kind
- Architecture or layer-boundary changes
- Security-model changes, including anything touching credentials, redaction, or the gating flags
- Adding or upgrading a material dependency (see [docs/DEPENDENCY_POLICY.md](./docs/DEPENDENCY_POLICY.md))
- Public interface changes — adding, removing, or renaming a tool, or changing its arguments
- Releases and meaningful merges
- Any deviation from an already-approved design

Documentation fixes, tests for existing behaviour, and bug fixes that restore already-agreed
behaviour without changing an interface do not need an RFC. Everything above does.

**You may not be the sole reviewer of your own work** (Article VI). If you implemented the change,
you do not approve it. Do not attempt to satisfy the review requirement yourself.

## The API contract is authoritative

[`docs/reference/lumics-api-v1.md`](./docs/reference/lumics-api-v1.md) is the authoritative contract
for the Lumics REST API v1.0. It was captured from the vendor's own documentation and ships in the
repository so that the contract the code targets is auditable.

Rules:

- **Do not invent endpoints, paths, parameters, enum values, or response fields.** If it is not in
  that file, the code does not use it. Article IV permits only officially documented interfaces.
- **Do not "fix" the API in code.** The spec records genuine upstream oddities: `PUT` is the only
  routed verb on `/devices/:id/modules/:module/lastDiscovery` while every neighbouring device write
  is `PATCH`; `:context` legal values vary per endpoint; identifiers come back as `id` from some
  routes and `_id` from others; some documented parameters do not exist and some existing ones are
  undocumented. §14 of the spec lists the known documentation defects. Follow what the spec says and
  reference it in a comment where the behaviour looks wrong.
- **But a confident note in the spec is not evidence that anyone checked.** §0 records live-tenant
  measurements that contradict the vendor's text, marked and dated; where the two disagree, §0 is
  what the code follows. Read §0 before you trust a page in §5–§15. The example that used to sit in
  the bullet above was the IPAM `/ipsubnet/` versus `/ipsubnets/` split, presented as an upstream
  oddity to preserve rather than correct. It was a vendor typo. Every ipaddress route is singular
  (measured 2026-07-31, §0.5 M13), the plural is not routed for any verb, and `0.1.0` shipped three
  IPAM write tools that could never have worked. **Do not put that example back.**
- **Documentation gaps get reported, not guessed around.** If you need behaviour the spec does not
  document, say so and stop. Do not infer it from a plausible-looking pattern, and do not probe the
  live API to find out.
- If you believe the spec is wrong about live behaviour, that is a contract-test finding and an
  issue, not a licence to change the code.
- The parts most likely to trip you up: §3 (the error table is the _only_ documented status codes),
  §4.3 (no pagination), §12 (metric parameters, especially the required resolution and the
  `fromMs`/`toMs` epoch-millisecond window).

## Layer separation

Keep these boundaries. They are required by the TypeScript standard and by the approved design.

```
src/
  index.ts          thin bin: shebang, argument parse, delegate. No logic.
  server.ts         buildServer() factory, exported for in-process testing.
  transport/        stdio.ts, http.ts. Swappable. No domain knowledge.
  api/              typed Lumics client: path building, auth, retry, redaction.
  domain/           domain types: Device, Collector, IpSubnet, Component, MetricSeries.
  tools/            one module per resource, built on the defineTool factory.
  presentation/     output shaping and token-budget control.
  util/             cross-cutting helpers, including the redacting logger.
```

- Transport code carries no domain knowledge and no Lumics specifics.
- Tool code does not build URLs or call `fetch`; it calls the `api` layer.
- Presentation shaping does not live inside tool handlers.
- `main` must not point at an executable, and importing a module must not start a transport as a
  side effect. That is what `buildServer()` is for and why it is testable in-process.
- Prefer small, composable modules. Do not create a new top-level directory without approval.

## No `console` — stdout is the protocol channel

**Never write to stdout.** On the stdio transport, stdout _is_ the MCP JSON-RPC channel. A single
stray `console.log` interleaves with protocol frames and corrupts the stream, and the failure looks
like a broken client rather than a logging mistake — which makes it expensive to diagnose.

- ESLint enforces `no-console` as an error across `src/`.
- Diagnostics go to **stderr**, through the redacting logger in `src/util/logger.ts`, which is the
  single file exempted from the rule.
- Do not add exemptions. Do not disable the rule inline. If you think you need stdout, you need the
  logger instead.

## Every tool carries an operation classification

Per the Engineering OS security standard, every public operation is classified as **Read**,
**Create**, **Update**, **Admin**, or **Destructive**, and the classification is mapped to the MCP
tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can prompt
appropriately.

- A new tool without a classification is incomplete. There is no default.
- `LUMICS_READ_ONLY=1` registers **only** Read tools. This is registration-time filtering, not a
  runtime check — do not reimplement it as a guard inside a handler, and do not add a tool in a way
  that bypasses the filter.
- Destructive and materially consequential operations require explicit confirmation and a clear
  statement of impact (Article IX).
- Bulk device update and token revocation are gated behind `LUMICS_ENABLE_BATCH_UPDATE` and
  `LUMICS_ENABLE_TOKEN_REVOCATION` respectively. Do not remove, weaken, or default-enable either
  gate. An agent-supplied `confirm` argument is a prompt-level speed bump; the environment variable
  is the real control.
- Token revocation revokes _every_ token on the account, including the one the server is using. Its
  description must say so.

## Never fabricate pagination

The Lumics API has **no pagination**. Only `limit` exists — no `offset`, `page`, `skip`, `cursor`,
`after`, `sort`, or `order` — list responses are bare arrays, and nothing carries a total or a
next-page link.

Therefore:

- **Do not emit `offset`, `has_more`, `next_offset`, `page`, `total`, or any equivalent.** Not even
  set to a "safe" value. The prototype emitted `has_more: false` and a `next_offset` pointing at a
  parameter that does not exist; an agent reading that reports a partial inventory as complete. This
  was the most damaging defect found in the prototype and it must not return.
- When a result count reaches the requested `limit`, **say explicitly** that results may be
  truncated and that the API provides no mechanism to page further.
- Ranking for `metrics/summaries` is done client-side because the endpoint accepts no `limit` or
  sort. Disclose in the output that the sort was applied locally.
- The same honesty rule applies to output truncation under `LUMICS_MAX_OUTPUT_CHARS`: truncation is
  always disclosed, never silent.

Silent truncation reads as completeness. That is the failure mode to design against.

## Secrets

Never log, echo, expose, or commit secrets. This includes examples, test fixtures, error messages,
issue text, and commit messages.

- Credential redaction happens **structurally** at the error boundary, not incidentally. Error
  objects can carry request headers; assume they do and strip them.
- Redaction is verified by test in `tests/security`. If you touch the error path, extend that test.
- `.env` is gitignored and must never be committed. `.env.example` contains placeholders only.
  Adding a real value to it is a security incident.
- Never write a real token into a test, a comment, or a documentation example. Use an obvious
  placeholder.
- Do not read credentials out of a user's client configuration files, and do not embed live tenant
  data in the repository. The prototype's `sync-create.mjs` did both; it is not ported in any form.
- Secret scanning runs in CI, but it is a backstop, not a control.

## Working practice

- Read [`docs/rfc/RFC-001-lumics-mcp-foundation.md`](./docs/rfc/RFC-001-lumics-mcp-foundation.md)
  before making design decisions. It is the approved foundation and it explains why several things
  that look wrong are deliberate.
- Check [`docs/DECISION_LOG.md`](./docs/DECISION_LOG.md) and [`docs/adr/`](./docs/adr/) before
  proposing anything that touches architecture or security. An existing approved decision may
  already answer the question, and several ADRs record why the obvious alternative was rejected. An
  approved ADR is never edited in place; superseding it requires a new ADR and owner approval.
- Run `npm run validate` (typecheck, lint, format:check, test) before proposing a change.
- Coverage is gated on `src/api` and `src/tools` only — 80% lines, functions, and statements, 70%
  branches. Do not add a global gate, and do not chase the number with tests that assert nothing.
- Tests and documentation are part of the change, not follow-up work. A feature with stale docs is
  incomplete (Article VII).
- Security controls are verified by test, not asserted in prose (Article VIII).
- When priorities conflict, the order is: security, correctness, maintainability, then usability.
  Choose security over feature completeness — the withheld raw Mongo query passthrough and the
  read-only default are both deliberate examples of exactly that trade.
- Do not expose `componentQuery` or `filters` as tool arguments. They accept raw Mongo query
  expressions; that is a NoSQL injection and unbounded-query surface, and withholding it is an
  approved decision, not an oversight.
- Prose you write for users is direct, without marketing language or emoji. Be candid about
  limitations; overstating what works is the fastest way to lose community trust.
- Escalate unresolved conflicts and uncertainty rather than silently choosing.
