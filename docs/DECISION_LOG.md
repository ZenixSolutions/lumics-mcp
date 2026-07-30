# Decision Log

Approved decisions governing this repository, in the pattern of Engineering OS `decisions/DECISION_LOG.md`.

Per `CONSTITUTION.md` Article I, the Project Owner has final authority and **approval must be explicit and scoped — silence is not approval**. A decision appears here as `Approved` only when the Project Owner approved it explicitly, and the row records the scope of that approval, not an inference about intent. Decisions still awaiting a decision are recorded as `Proposed` in the governing RFC, not here.

Per the authority order in the Engineering OS `README.md` — Project Owner instruction, then constitutional override, then `CONSTITUTION.md`, then approved ADRs, then approved RFCs, then adopted standards — **every exception must be recorded.** Where this repository departs from an Engineering OS standard, or accepts a reduction against a documented capability, the departure is entered in this log with its governing RFC or ADR and is not left to be inferred from code.

Decisions that are long-lived and architectural are additionally recorded as ADRs under [`adr/`](adr/README.md). Rows below link to the governing document.

## Decisions

| ID | Date | Decision | Status | Approved By | Governing RFC / ADR | Scope |
|---|---|---|---|---|---|---|
| D-0001 | 2026-07-29 | Adopt Engineering OS governance for this repository — Constitution, boot sequence, engineering lifecycle, approval gates, RFC/ADR governance, and adopted standards apply to `lumics-mcp` | Approved | Project Owner | — | Governance |
| D-0002 | 2026-07-29 | RFC-001 foundation approved — D1 (language, runtime, tooling), D2 (repository layout), D3 (transport and protocol), D4 (distribution), D5 (AI-first tool design), D6 (security posture), D7 (workflow, versioning, release), D8 (licensing and identity) | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md); [ADR-001](adr/ADR-001-transport-and-distribution.md); [ADR-002](adr/ADR-002-security-posture-and-capability-reductions.md) | Architecture, security, distribution, release |
| D-0003 | 2026-07-29 | Test coverage thresholds: 80% lines, 80% functions, 80% statements, 70% branches, measured on `src/api` and `src/tools` only. No global repository gate — a repo-wide number is satisfied by testing trivia. Engineering OS sets no threshold, so this is a project-specific addition | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md) Open Question 1 | Testing |
| D-0004 | 2026-07-29 | Withhold raw Mongo query passthrough (`componentQuery`, `filters`) in v0.1 — a deliberate capability reduction against the documented vendor API, accepted explicitly. Reversible only behind an opt-in flag and a superseding ADR | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md) Open Question 2; [ADR-002](adr/ADR-002-security-posture-and-capability-reductions.md) | Security, tool surface |
| D-0005 | 2026-07-29 | `companies` context only in v0.1; `admingroups` and `system` deferred to v0.2 — they roughly double the test matrix, and `system` is documented but unspecified (no contextId sentinel is given for it) | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md) Open Question 3 | Tool surface, testing |
| D-0006 | 2026-07-29 | Contract tests run manually as a documented pre-release gate; no standing Lumics credential in CI. Opt-in via `LUMICS_CONTRACT_TESTS`, excluded from the default suite so `npm test` never needs a token | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md) Open Question 5 | Testing, security |
| D-0007 | 2026-07-29 | npm scope `@zenixsolutions/lumics-mcp` (clear provenance over discoverability); full canonical MIT licence text, not the abridged text used by Engineering OS's own `LICENSE` | Approved | Project Owner | [RFC-001](rfc/RFC-001-lumics-mcp-foundation.md) Open Question 4 and D8 | Identity, licensing |

## Recorded exceptions and additions

Departures from, or additions to, Engineering OS, each traceable to a row above:

| Item | Nature | Recorded in |
|---|---|---|
| Full canonical MIT licence text instead of the abridged text in Engineering OS's `LICENSE` | Departure from the framework's own artifact; the abridged text omits the notice-retention and liability clauses | D-0007; [ENGINEERING_OS_GAPS.md](ENGINEERING_OS_GAPS.md) |
| Coverage thresholds, branching model, commit format, CI job list, test framework, linter, formatter, and other build mechanics | Additions where Engineering OS defines nothing | D-0002, D-0003; [ENGINEERING_OS_GAPS.md](ENGINEERING_OS_GAPS.md) |
| Capability reduction against the documented vendor API (`componentQuery`, `filters`) | Deliberate reduction, explicitly accepted | D-0004; [ADR-002](adr/ADR-002-security-posture-and-capability-reductions.md) |
| Deferred API surface (`admingroups`, `system` contexts) in v0.1 | Scope reduction | D-0005 |
| Engineering OS standards are formally unratified (`CONSTITUTION.md` is `0.1.0-draft`; its decision log entries are `Proposed`/`Pending`) | This repository proceeds on explicit Project Owner instruction, which the authority order ranks first | D-0001; [ENGINEERING_OS_GAPS.md](ENGINEERING_OS_GAPS.md) |
