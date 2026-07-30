# RFC-001: Lumics MCP Server — Foundation, Stack, and Distribution

- **Status:** Proposed — awaiting Project Owner decision
- **Author:** Claude (acting as Repository Architect / API-MCP Architect / Security Engineer per `ACTIVATION_MATRIX.md`)
- **Date:** 2026-07-29
- **Related issue:** Establish the first governed MCP repository (`bootstrap/issues/008-first-external-adoption.md`)
- **Reviewers:** Pending — Chief Architect, Security Engineer, Devil's Advocate
- **Owner decision:** Pending

---

## Summary

This RFC proposes the foundational engineering decisions for a public, open-source MCP server for the Lumics (NetCuras) network monitoring platform: language and runtime, repository layout, tooling, testing policy, transport architecture, distribution model, security posture, and release conventions.

It exists because Engineering OS deliberately does not define these. `governance/decision-hierarchy.md` ranks "general conventions" last and states that lower levels may not silently override higher levels; the project instructions direct that conventions not already defined must not be invented. Every decision below is therefore submitted for explicit approval rather than assumed. Per `CONSTITUTION.md` Article I, "Silence is not approval."

Four decisions have already been made by the Project Owner and are recorded here as approved inputs, not open questions:

| Decision | Owner selection |
|---|---|
| Distribution | Phased — stdio/npx in v0.1, hosted remote in v0.2 |
| Authentication | Self-hosted per-tenant deployment; no multi-tenant OAuth broker |
| API contract source | Captured from vendor documentation via authenticated browser session |
| Repository identity | Community server under `ZenixSolutions`, non-affiliated |

---

## Problem

Zenix needs a publishable, community-credible MCP server that lets an AI assistant operate the Lumics platform. Three constraints shape the work:

1. **The install experience is the product.** The stated goal is a single copy-paste command from GitHub into Claude, ChatGPT, or Grok. This is a distribution and transport problem before it is a code problem.
2. **An unpublishable prototype already exists** at `/Users/josh/mcp-servers/lumics-mcp` (2,170 lines, 39 tools, no git history). It is valuable as API reconnaissance and unfit as a release base.
3. **Engineering OS is unratified and technically silent.** It governs process rigorously and specifies almost no build mechanics, so this repository is simultaneously the first adopter and the source of the gap report Milestone 6 asks for.

---

## Goals

- A GitHub repository that meets `standards/repository-standard.md` in full and is credible to external contributors.
- Install by copying one command, per client, with an explicit and honest matrix of what works where.
- Complete, typed coverage of the documented Lumics API v1.0 surface.
- Tool design that an LLM can use correctly on the first attempt, per `standards/ai-interface-standard.md` and `CONSTITUTION.md` Article X.
- A security posture that survives public scrutiny, per `standards/security-standard.md`.
- A recorded gap report feeding Engineering OS v0.2.

## Non-Goals

- Multi-tenant hosted SaaS, OAuth authorization server, or credential brokering. Explicitly deferred by owner decision to self-hosted per-tenant.
- Vendor endorsement, official badging, or listing as a first-party connector.
- Undocumented API surface. `CONSTITUTION.md` Article IV permits "only officially documented and supported APIs… Documentation gaps must be reported, not guessed around."
- Feature parity with the prototype where the prototype is wrong. Several of its behaviours are defects to drop, not features to port.

---

## Current State

**Repository:** `/Users/josh/Library/CloudStorage/.../Dev/lumics-mcp` — git initialised, one empty commit, `origin` configured, no source.

**Prototype:** unversioned, no tests, no lint, no CI, no README or LICENSE. Audit found, among others: an unauthenticated HTTP transport bound to all interfaces with no DNS-rebinding protection; unencoded string interpolation into URL paths; fabricated pagination metadata; every response serialised twice; a `sync-create.mjs` script that reads the token out of the Claude desktop config and embeds 41 rows of live Zenix network topology.

**API contract:** now captured in full at `docs/reference/lumics-api-v1.md` — 41 endpoints across 9 resources, with parameter tables, body schemas, response envelopes, and the global error table. This supersedes the prototype's reverse-engineered understanding, which covered 17 endpoints.

### What the captured spec changes

These are not refinements. Each one invalidates prototype behaviour:

| Finding | Consequence |
|---|---|
| `dataPoints` **or** `width` is **required** on all four metric-data endpoints (`width` wins if both set) | The prototype sends neither. Its five metric tools cannot reliably have worked. |
| `sum` is a string enum — `min` \| `max` \| `avg` | The prototype types it `boolean`. Every call is malformed. |
| Time window is `fromMs`/`toMs` in **epoch milliseconds**, defaulting to the last hour | Never modelled; LLMs are poor at epoch arithmetic, so this needs a human-friendly wrapper. |
| `interval` is an enum — `minute` \| `fiveMin` \| `hour` \| `day` | Never modelled. |
| **The API has no pagination whatsoever** — only `limit`; no offset, page, cursor, or sort, and list endpoints return bare arrays with no total | The prototype synthesises `offset`, `has_more`, and `next_offset`. `next_offset` points at a parameter that does not exist. An agent reading `has_more: false` will report a partial inventory as complete. This is the most damaging defect found. |
| `metrics/summaries` — the endpoint whose own description advertises "top X lists of devices" — accepts **no `limit`** | Ranking must be done client-side. |
| Legal values of `:context` **vary per endpoint**; device writes are `companies`-only | A single global context enum is wrong. The prototype's allows `system` on `/devices`, producing malformed URLs. |
| `componentQuery` and `filters` accept **raw Mongo query expressions** | A NoSQL injection and unbounded-query surface, newly discovered. See Security Impact. |
| IPAM ipaddress routes use singular `/ipsubnet/` for reads and plural `/ipsubnets/` for writes | Confirmed real in the vendor's route definitions, not a docs typo. |
| Documented codes include 304, 423 (Locked), and 429, with no documented rate limits, windows, or headers | Retry and caching behaviour must be defensive. |

---

## Evidence and Assumptions

**Evidence:** vendor API documentation read directly from an authenticated session (44 pages, all retrieved); a read-only audit of the prototype; the Engineering OS corpus; current client documentation for Claude Code, Claude Desktop, ChatGPT developer mode, and Grok connectors; the MCP specification and its authorization sub-spec.

**Assumptions requiring validation:**

- **A1.** The vendor documentation matches live behaviour. The IPAM singular/plural asymmetry and the prototype's contradictory comments suggest drift is possible. Mitigation: a contract test suite run against a live tenant, and per-verb path spellings with an optional fallback retry.
- **A2.** Rate limits exist (429 is documented) but are unpublished. Mitigation: conservative client-side concurrency and honour `Retry-After`.
- **A3.** No Lumics OAuth support exists or is imminent. Confirmed by the authentication page: JWT only. This is what makes self-hosted per-tenant the correct call rather than merely the expedient one.
- **A4.** Tokens default to 86,400 seconds and `expiresIn` has no documented maximum. Long-lived tokens are therefore possible and dangerous; the server must not encourage them.

---

## Constraints

- `CONSTITUTION.md` Article III priority order: Security, Correctness, Maintainability, then usability.
- Article IV: documented APIs only.
- Article VI: the implementation author may not be the sole reviewer.
- Article IX: destructive or materially consequential actions require explicit confirmation and described impact.
- `standards/release-standard.md`: semantic versioning.
- `standards/security-standard.md`: classify every public operation as Read, Create, Update, Admin, or Destructive.
- **Client capability, not preference:** ChatGPT developer-mode connectors and Grok custom connectors cannot execute local stdio servers. Grok explicitly rejects localhost and private addresses. No packaging trick changes this — those two clients require a publicly reachable HTTPS endpoint.

---

## Alternatives Considered

**Distribution.** *Rejected:* remote-first hosted (blocks all tool work behind hosting and OAuth decisions); stdio-only (permanently excludes ChatGPT and Grok, failing the stated goal); `mcp-remote` bridge (a local process — it does not make the server reachable by ChatGPT web or Grok, so it does not actually solve the problem it appears to).

**Language.** *Rejected:* Python/FastMCP. Engineering OS's only language standard is `standards/typescript-standard.md`; choosing Python would mean authoring a second language standard as a prerequisite. TypeScript also matches the prototype, the `.mcpb` bundle format, and the wider MCP ecosystem.

**Repairing the prototype.** *Rejected.* It has no git history, its metric layer is built on parameters now known to be wrong, and its pagination contract must be deleted rather than fixed. A rewrite against the captured spec — reusing the prototype only as a cross-check — is lower risk than incremental repair.

**Tooling.** Biome considered for lint plus format in one fast binary. *Rejected for v0.1* in favour of ESLint plus Prettier, on contributor familiarity (`CONSTITUTION.md` Article III ranks contributor friendliness above performance for this purpose). Revisitable.

---

## Proposed Design

### D1 — Language, runtime, tooling

| Decision | Proposal | Rationale |
|---|---|---|
| Language | TypeScript 5.7+, `strict: true` | Only language standard Engineering OS defines |
| Runtime | Node.js ≥ 20 LTS | 18 is end-of-life; 20 is the conservative floor |
| Modules | ESM, `module: NodeNext` | Prototype's `Node16` is stale for `"type": "module"` |
| Package manager | npm with committed lockfile | Lowest friction for external contributors |
| Additional strictness | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | Both off in the prototype; both catch real defects |
| Lint / format | ESLint flat config + Prettier | Familiarity; enforced in CI |
| Tests | Vitest, with HTTP mocked at the transport boundary | Native ESM and TS support |
| Validation | Zod, at every tool boundary | Already the SDK's idiom |
| HTTP client | Native `fetch` | Drops the axios dependency; `standards/typescript-standard.md` requires pinning and reviewing material dependencies, so fewer is better |

### D2 — Repository layout

Implements `standards/repository-standard.md` in full, plus the layer separation `standards/typescript-standard.md` requires ("Separate transport, domain, API, and presentation layers"):

```
src/
  index.ts            # thin bin only — shebang, arg parse, delegate
  server.ts           # buildServer() factory, exported for in-process testing
  transport/          # stdio.ts, http.ts — swappable, no domain knowledge
  api/                # typed Lumics client: paths, auth, retry, redaction
  domain/             # Device, Collector, IpSubnet, Component, MetricSeries types
  tools/              # one module per resource, built on a defineTool factory
  presentation/       # output shaping and token-budget control
docs/
  rfc/ adr/ reference/   # reference/ holds the captured API spec as a committed artifact
tests/
.github/            # workflows, issue templates, PR template
```

`main` must not point at an executable. The prototype's entry point starts a transport as an import side effect, which makes it untestable in-process; `buildServer()` fixes both.

### D3 — Transport and protocol

- Transport-independent core, per `subagents/architecture/api-mcp-architect.md` ("transport independence").
- **v0.1:** stdio. **v0.2:** Streamable HTTP on a single `/mcp` endpoint.
- Target protocol revision **2025-11-25** — what clients actually implement today — while keeping the core free of session assumptions so the stateless 2026-07-28 revision is a transport-layer change. Legacy HTTP+SSE will not be implemented; it is deprecated.
- HTTP transport hardened from the first commit: bearer auth required, DNS-rebinding protection with explicit `allowedHosts`/`allowedOrigins`, loopback bind by default, rate limiting, Express error middleware, and `GET`/`DELETE` handlers alongside `POST`.

### D4 — Distribution

| Phase | Artifact | Reaches |
|---|---|---|
| v0.1 | npm package, `npx` invocation | Claude Code, Claude Desktop, Codex |
| v0.1 | `.mcpb` bundle | Claude Desktop one-click |
| v0.2 | Docker image + deployment template | ChatGPT, Grok, Claude.ai — each tenant's own URL |

The README will state plainly that ChatGPT and Grok require the v0.2 self-hosted endpoint. Overstating client support is the single fastest way to lose community trust.

### D5 — AI-first tool design

Per `standards/ai-interface-standard.md`, and treating the captured spec's rough edges as our problem to absorb rather than the model's:

1. **Time windows.** Accept ISO-8601 timestamps or a relative `lookback` (e.g. `24h`); convert to `fromMs`/`toMs` internally. Never make a model compute epoch milliseconds.
2. **Required resolution.** Default `dataPoints` to a sane value so metric calls succeed without the model knowing the constraint, and document it.
3. **Honest pagination.** Because the API has none, emit no `offset`, `has_more`, or `next_offset`. When a result count equals the requested `limit`, say explicitly that results may be truncated and that no pagination mechanism exists. Silent truncation reads as completeness.
4. **Client-side ranking** for `metrics/summaries`, with the sort applied in our layer and disclosed in the output.
5. **Per-endpoint context enums**, not one global union — `system` must not be offerable where it produces a malformed URL.
6. **Typed enums** for `sum` and `interval`.
7. **Correct path spelling per verb** for IPAM, with the asymmetry documented in code comments and the tool reference.
8. **No double serialisation.** Either declare an `outputSchema` or omit `structuredContent` — not both.
9. Shaped, field-projected output under an explicit token budget, replacing raw pretty-printed dumps.

### D6 — Security posture

Every tool classified Read / Create / Update / Admin / Destructive per `standards/security-standard.md`, mapped to MCP annotations.

- **`LUMICS_READ_ONLY=1`** registers only Read tools. Without it, an audit-only consumer must fork.
- **Raw Mongo passthrough (`componentQuery`, `filters`) is not exposed in v0.1.** These accept raw Mongo query expressions; handing that to a model is a NoSQL injection and unbounded-query surface, and `standards/security-standard.md` requires validating all external input and using secure defaults. Typed `itemType`, `isMonitored`, and `properties` cover the real use cases. Raw passthrough, if ever added, goes behind an explicit opt-in flag. **This is a deliberate capability reduction and needs owner acknowledgement.**
- **Token revocation** gated behind both a required `confirm` and an opt-in env flag. It revokes every token on the account including the one the server is using — self-DoS plus collateral damage to other integrations. Note that an agent-supplied `confirm` is a prompt-level speed bump, not human-in-the-loop control; the env flag is the real gate.
- **Batch device update** gated equivalently: one call can rewrite arbitrary fields on N devices.
- `encodeURIComponent` on every interpolated path segment, enforced by test.
- Credential redaction at the error boundary, with a test asserting no token material can reach logs or responses. An `AxiosError`-style object carries request headers, so this must be structural, not incidental.
- No secret material committed. `.env.example` with placeholders only. Secret scanning in CI.
- Documentation will recommend short `expiresIn` values and warn that no maximum is documented.
- `sync-create.mjs` will not be ported in any form.

### D7 — Workflow, versioning, release

Trunk-based development on `main` with short-lived branches; Conventional Commits; squash merge; branch protection requiring CI plus one non-author approval (Article VI). Semantic versioning per `standards/release-standard.md`, tags `vX.Y.Z`, `CHANGELOG.md` in Keep a Changelog format. CI on every PR: typecheck, lint, test, build, secret scan, and an install smoke test. Initial release `0.1.0` — pre-1.0 signals that the tool surface may still move.

### D8 — Licensing and identity

MIT. Repository `ZenixSolutions/lumics-mcp`; npm `@zenixsolutions/lumics-mcp`. `CODE_OF_CONDUCT.md` (Contributor Covenant) as `standards/repository-standard.md` requires for public repositories. A prominent README disclaimer of non-affiliation with, and non-endorsement by, Lumics and NetCuras, and no use of their marks beyond nominative reference.

Note that Engineering OS's own `LICENSE` is an abridged, non-standard MIT text — it omits the notice-retention and liability clauses. This repository will use the full canonical MIT text, and the discrepancy is logged as a gap report item.

---

## Security Impact

Materially positive against the prototype: the unauthenticated all-interfaces HTTP listener, the path-injection surface, and the credential-harvesting script all disappear. Two new risks are introduced by publication itself — a public repository invites scrutiny of our auth handling, and a self-hosted deployment template makes us responsible for a secure-by-default posture in environments we do not control. Both are addressed in D6. Residual risk to document per `standards/security-standard.md`: undocumented rate limits, no documented `expiresIn` ceiling, and the possibility of documentation-versus-behaviour drift. Security controls will be verified by test, not assumed (Article VIII).

## Testing Impact

Proportionate layers per `standards/testing-standard.md`: unit (path building, param mapping, time conversion, redaction), integration (mocked HTTP per endpoint), contract (opt-in, against a live tenant, validating A1), security (redaction, path encoding, read-only mode, destructive gating), installation (the README's copy-paste commands actually work), and regression (one test per defect listed in Current State). Engineering OS sets no coverage threshold; a threshold is proposed as an open question below.

## Documentation Impact

Full set per `standards/documentation-standard.md`: README, Quick Start, Installation, User Guide, Tool Reference, compatibility notes, security guidance, limitations, migration guidance, release notes. Limitations must name the absent pagination, the metric resolution requirement, the withheld Mongo passthrough, and the ChatGPT/Grok phase gap. `docs/reference/lumics-api-v1.md` ships as a committed artifact so the contract our code targets is auditable — and so drift becomes visible.

## Compatibility Impact

Greenfield, so no backward-compatibility obligations. Forward-looking: the tool surface is the public contract, so `standards/ai-interface-standard.md`'s stability requirement applies from 0.1.0. Pre-1.0 permits breaking tool changes with a minor bump and changelog notice; post-1.0, Article III gives backward compatibility substantially greater weight.

## Migration Plan

None required — the prototype has no users and no history. It stays in place, unpublished, until the new server reaches parity, then Josh's local Claude Desktop config is repointed at the published package. The prototype's `sync-create.mjs` should be deleted from disk regardless of this project, and the credentials currently in plaintext in `claude_desktop_config.json` rotated.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Docs diverge from live API behaviour | High | Contract tests against a live tenant before 0.1.0 |
| Undocumented rate limits cause failures at scale | Medium | Conservative concurrency, honour `Retry-After`, backoff |
| Withholding Mongo passthrough blocks a real use case | Medium | Owner acknowledgement now; opt-in flag if evidence emerges |
| v0.2 slips and ChatGPT/Grok never land | Medium | Documented honestly as a phase gap, not implied support |
| "Community" framing limits adoption | Low | Re-badgeable if the vendor engages |
| Engineering OS remains unratified, leaving this repo's basis provisional | Low | Recorded as the Milestone 6 gap report |

## Constitutional Compliance

Article III priority order honoured — the Mongo-passthrough and read-only-mode decisions choose security over feature completeness, deliberately. Article IV honoured: documented API surface only, and gaps reported in Limitations rather than guessed around. Article VI honoured: independent review is a separate task before merge. Article IX honoured via destructive-action classification and gating. Article X honoured via D5. Article VIII honoured via D6.

---

## Open Questions

Owner input needed on these; the rest of the RFC is a recommendation to accept or amend.

1. **Test coverage threshold.** Engineering OS sets none. Proposal: 80% lines on `src/api` and `src/tools`, no global gate — a number low enough to be honest and targeted where defects actually live. Accept, change the number, or decline to set one?
2. **Withholding raw Mongo passthrough (D6).** This removes capability the vendor API offers. Confirm you accept the reduction for v0.1.
3. **Scope of `admingroups` and `system` contexts in v0.1.** They roughly double the test matrix. Proposal: `companies` only for v0.1, others in v0.2. Do you need multi-context now?
4. **npm scope.** `@zenixsolutions/lumics-mcp` (clear provenance) or unscoped `lumics-mcp` (better discoverability, weaker non-affiliation signal)?
5. **Contract testing against a live tenant.** Validating A1 requires a real Lumics token in CI, or a documented manual pre-release run. Which do you prefer? A CI secret is a standing credential in GitHub.

---

## Approval Requested

Approval is requested for D1–D8 as the foundation for implementation, and a decision on each of the five open questions.

Per `governance/approval-workflow.md`, this RFC touches several approval-required categories at once — architecture, security controls, authentication, material dependencies, and public interfaces. Per `BOOT.md` §8, implementation must not begin before that approval is recorded.

Available outcomes: Approved / Approved with conditions / Revision requested / Rejected / Deferred / Limited override approved.

On approval, ADR-001 (transport and distribution architecture) and ADR-002 (security posture and capability reductions) will be recorded from D3–D4 and D6, and the decision entered in `decisions/DECISION_LOG.md`.
