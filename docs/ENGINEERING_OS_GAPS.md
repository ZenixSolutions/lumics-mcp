# Engineering OS Gap Report

**Reporting project:** `lumics-mcp` (first external adopter)
**Engineering OS version reviewed:** `0.1.0-draft`
**Date:** 2026-07-29
**Governing decision:** [D-0001, D-0002](DECISION_LOG.md)

Engineering OS Roadmap Milestone 6 ("First External Adoption") lists "Record gaps" and "Propose version 0.2" as deliverables of the first adopting project. This document is that record.

Scope: what Engineering OS did **not** define, and which this project therefore decided itself via RFC-001. Each row states the gap, what this project chose, and where the choice is recorded. This is an inventory, not a criticism; Engineering OS states in its own `README.md` that it provides governance, standards, roles, and templates, and RFC-001 records that it "specifies almost no build mechanics."

## 1. Undefined: language, runtime, and build mechanics

Engineering OS defines `standards/typescript-standard.md`, which applies "when TypeScript is used" but does not select a language, and no other language standard exists.

| Gap | Not defined by Engineering OS | Decided by this project | Recorded in |
|---|---|---|---|
| Language | Which language a project uses | TypeScript 5.7+, `strict: true` | RFC-001 D1 |
| Runtime and minimum version | Any runtime or version floor | Node.js ≥ 20 LTS | RFC-001 D1 |
| Module system | ESM vs CommonJS; `module` setting | ESM, `module: NodeNext` | RFC-001 D1 |
| Package manager and lockfile policy | Which package manager; whether the lockfile is committed | npm, lockfile committed | RFC-001 D1 |
| Compiler strictness beyond "strict type checking" | Specific flags | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | RFC-001 D1 |
| Runtime validation library | That runtime inputs must be validated, but not with what | Zod, at every tool boundary | RFC-001 D1 |
| HTTP client | Nothing | Native `fetch` | RFC-001 D1 |

## 2. Undefined: source directory layout

`standards/typescript-standard.md` requires separating "transport, domain, API, and presentation layers" but prescribes no directory structure. `standards/repository-standard.md` lists required root files but no `src/` layout.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Source tree layout | `src/index.ts` (bin only), `src/server.ts` (`buildServer()`), `src/transport/`, `src/api/`, `src/domain/`, `src/tools/`, `src/presentation/` | RFC-001 D2 |
| Docs tree layout | `docs/rfc/`, `docs/adr/`, `docs/reference/` | RFC-001 D2 |
| Where the decision log lives in an adopting project | `docs/DECISION_LOG.md` (Engineering OS keeps its own at `decisions/DECISION_LOG.md`) | RFC-001 D2; D-0002 |
| Entry point requirements | `main` must not point at an executable; server construction must not be an import side effect | RFC-001 D2 |

## 3. Undefined: code style and naming

| Gap | Not defined by Engineering OS | Decided by this project | Recorded in |
|---|---|---|---|
| Linter | Any linter | ESLint, flat config, enforced in CI | RFC-001 D1 |
| Formatter | Any formatter | Prettier, `format:check` in CI | RFC-001 D1 |
| Code naming conventions | File, directory, type, function, variable, or constant naming | Project-local convention; no framework rule to follow | RFC-001 D1, D2 |

Note: `standards/ai-interface-standard.md` requires AI-facing interfaces to be "clearly named" but sets no naming scheme; `standards/documentation-standard.md` names required documents but not file-naming conventions.

## 4. Undefined: testing mechanics

`standards/testing-standard.md` lists possible test layers (unit, integration, contract, end-to-end, compatibility, security, installation, regression, performance) and requires "proportionate testing", but selects no framework, sets no coverage threshold, and prescribes no layout.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Test framework | Vitest, HTTP mocked at the transport boundary | RFC-001 D1 |
| Coverage thresholds | 80% lines / functions / statements, 70% branches, on `src/api` and `src/tools` only; no global gate | RFC-001 Open Question 1; D-0003 |
| Test layout | `tests/**/*.test.ts`, with `tests/contract/` excluded from the default run | RFC-001 D2; D-0006 |
| Whether contract tests may hold a live credential in CI | Manual pre-release gate; no standing Lumics credential in CI; opt-in via `LUMICS_CONTRACT_TESTS` | RFC-001 Open Question 5; D-0006 |

## 5. Undefined: development workflow and version control

`standards/repository-standard.md` requires "branch protection" and "review requirements" without specifying either; `CONSTITUTION.md` Article VI requires that no implementation author be the sole reviewer of their own work.

| Gap | Not defined by Engineering OS | Decided by this project | Recorded in |
|---|---|---|---|
| Branching model | Any model | Trunk-based on `main`, short-lived branches | RFC-001 D7 |
| Merge strategy | Any strategy | Squash merge | RFC-001 D7 |
| Commit message format | Any format | Conventional Commits | RFC-001 D7 |
| Concrete branch protection rules | The rules themselves | CI green plus one non-author approval | RFC-001 D7 |
| Concrete CI requirements | That "CI validation" exists | Per PR: typecheck, lint, format check, test, build, secret scan, install smoke test | RFC-001 D7 |

## 6. Undefined: release and publication mechanics

`standards/release-standard.md` lists release prerequisites and requires semantic versioning, but names no publication target, tag format, or changelog artifact.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Publishing target | npm, plus a `.mcpb` bundle in v0.1 and a Docker image in v0.2 | RFC-001 D4; [ADR-001](adr/ADR-001-transport-and-distribution.md) |
| Tag format | `vX.Y.Z` | RFC-001 D7 |
| Changelog file requirement | `CHANGELOG.md` in Keep a Changelog format (not required by any Engineering OS standard, including `standards/documentation-standard.md`) | RFC-001 D7 |
| Initial version | `0.1.0` | RFC-001 D7 |
| Package name and scope | `@zenixsolutions/lumics-mcp` | RFC-001 Open Question 4; D-0007 |

## 7. Undefined: licensing and contribution policy

`standards/repository-standard.md` requires a `LICENSE`, `CONTRIBUTING`, `SECURITY`, and `CODE_OF_CONDUCT` (when public), but does not say which licence, which code of conduct, or what contributor agreement policy applies. `CONTRIBUTING.md` describes the governance sequence and does not mention a CLA or DCO.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Which licence | MIT, full canonical text | RFC-001 D8; D-0007 |
| Which code of conduct | Contributor Covenant | RFC-001 D8 |
| CLA / DCO policy | No CLA and no DCO sign-off requirement; no framework guidance exists either way | RFC-001 D8 |

## 8. Undefined: security implementation patterns

`standards/security-standard.md` states requirements — never commit, log, echo, or expose secrets; redact credentials in errors and diagnostics; validate all external input; use least privilege; require confirmation for high-impact actions; classify every public operation as Read/Create/Update/Admin/Destructive; use secure defaults; fail closed; document threat assumptions and residual risk — without specifying mechanisms or tooling.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Authentication pattern for a server that holds a third-party credential | Self-hosted per-tenant, JWT bearer from environment; no credential brokering, no OAuth authorization server | RFC-001 D3, D6; ADR-001 |
| Secret-scanning tooling | Secret scanning in CI (tool selected at implementation time; no framework requirement to scan at all) | RFC-001 D6, D7 |
| How "require confirmation for high-impact actions" is implemented for an AI-facing interface | Opt-in environment flag as the real gate, plus a `confirm` argument for impact disclosure; the standard does not distinguish a model-supplied confirmation from a human one | RFC-001 D6; [ADR-002](adr/ADR-002-security-posture-and-capability-reductions.md) |
| How the Read/Create/Update/Admin/Destructive classification maps to a protocol | Mapped to MCP tool annotations | RFC-001 D6; ADR-002 |
| Redaction mechanism | Structural redaction at the error boundary, verified by test | RFC-001 D6; ADR-002 |
| Path-injection prevention | `encodeURIComponent` on every interpolated path segment, verified by test | RFC-001 D6; ADR-002 |

## 9. Undefined: MCP-specific technical standards

Engineering OS includes MCP-oriented roles (`subagents/architecture/api-mcp-architect.md`) and `standards/ai-interface-standard.md`, which requires AI-facing interfaces to be clearly named, narrowly scoped, unambiguous, explicit about required inputs and destructive impact, structured in outputs, stable where possible, token-conscious, and compatible with multiple AI clients. It defines no MCP technical standard.

| Gap | Decided by this project | Recorded in |
|---|---|---|
| Which MCP SDK | `@modelcontextprotocol/sdk` (TypeScript) | RFC-001 D1 |
| Which transport, and transport architecture | Transport-independent core with `buildServer()`; stdio in v0.1, Streamable HTTP on `/mcp` in v0.2; legacy HTTP+SSE not implemented | RFC-001 D3; ADR-001 |
| Which protocol revisions to support | Target 2025-11-25; core free of session assumptions so the stateless 2026-07-28 revision is a transport-layer change | RFC-001 D3; ADR-001 |
| Tool naming scheme | Project-local convention; `standards/ai-interface-standard.md` requires clear names but defines no scheme | RFC-001 D5 |
| Error shape returned to a model | Project-local; no framework definition | RFC-001 D5 |
| Output contract | Either declare an `outputSchema` or omit `structuredContent`, never both; field-projected output under an explicit token budget | RFC-001 D5 |
| Read-only operating mode | `LUMICS_READ_ONLY` registers only Read tools | RFC-001 D6; ADR-002 |
| How to represent an upstream API's absence of pagination | Emit no synthetic `offset`/`has_more`/`next_offset`; state explicitly that results may be truncated and that no pagination mechanism exists | RFC-001 D5 |
| Client compatibility matrix requirements | Per-client install instructions and an explicit statement of which clients are unsupported per phase | RFC-001 D4; ADR-001 |

## 10. Framework artifact observation: the Engineering OS `LICENSE` is an abridged, non-standard MIT text

Engineering OS's own `LICENSE` reads:

> MIT License
>
> Copyright (c) 2026
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Measured against the canonical MIT text, it omits:

- the **notice-retention condition** — "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software";
- the clause permitting distribution "to persons to whom the Software is furnished to do so, subject to the following conditions";
- the **warranty enumeration** — "INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT";
- the **liability limitation** — "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY…";
- a named copyright holder (the year is present, the holder is not).

It is therefore not the MIT licence as commonly recognised by tooling or licence scanners, despite the "MIT License" heading. This repository uses the full canonical MIT text (D-0007).

## 11. Framework status observation: all Engineering OS standards remain formally unratified

- `CONSTITUTION.md` is version `0.1.0-draft`, "Status: Draft pending Project Owner approval". Its Amendment History records the initial Constitution with Date `TBD` and Approval `Pending`.
- `README.md` reports Version `0.1.0-draft`, Phase "Self-bootstrap foundation", Adoption status "Draft pending Project Owner approval".
- `decisions/DECISION_LOG.md` contains three entries (D-0001 through D-0003), each with Date `TBD`, Status `Proposed`, and Approved By `Pending`.
- `PROJECT_MEMORY.md` lists the Constitution, role roster, roadmap, and repository creation as pending owner decisions, and records under Blockers that "No official approvals have been recorded."
- Roadmap Milestones 1 through 5 — which cover approving the Constitution, governance, the standards this project applies, the roles, and the templates — precede Milestone 6, under which this adoption occurs.

Consequently, the standards this repository applies are drafts rather than ratified documents. This repository proceeds on **explicit Project Owner instruction**, which the Engineering OS authority order (`README.md`) ranks first — above a constitutional override, above `CONSTITUTION.md` itself, and above adopted standards. That instruction is recorded as [D-0001](DECISION_LOG.md).

## 12. Input to Engineering OS v0.2

Items above that would each close a gap if defined at the framework level:

1. A build-mechanics standard, or an explicit statement that build mechanics are deliberately delegated to each project's RFC — sections 1, 2, 3.
2. A testing-mechanics section covering framework choice, coverage policy, test layout, and whether live credentials may be held in CI — section 4.
3. A workflow standard covering branching, merge strategy, commit format, and the concrete content of "branch protection", "review requirements", and "CI validation" — section 5.
4. A release-mechanics section covering tag format, changelog requirement, and publication artifacts — section 6.
5. Licence selection guidance and an explicit CLA/DCO position — section 7.
6. Security implementation patterns for the requirements the standard already states, including the distinction between a model-supplied confirmation and a human authorization gate — section 8.
7. An MCP standard covering SDK, transport, protocol-revision policy, tool naming, error shape, output contract, and client compatibility disclosure — section 9.
8. Replacement of the abridged `LICENSE` with the canonical MIT text — section 10.
9. Ratification of the Constitution and the standards, so adopting projects cite approved documents rather than drafts — section 11.
