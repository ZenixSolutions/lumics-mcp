# Architecture Decision Records

Approved, long-lived architectural decisions for this repository. Recorded per step 8 of `governance/engineering-lifecycle.md` ("ADR — Record approved long-lived architectural decisions") and ranked third in `governance/decision-hierarchy.md`, above approved RFCs and adopted standards.

An ADR records a decision that has already been approved. It is not a proposal — proposals are RFCs, under `docs/rfc/`.

## Current ADRs

| ADR | Title | Status | Date | Related RFC | Supersedes | Superseded By |
|---|---|---|---|---|---|---|
| [ADR-001](ADR-001-transport-and-distribution.md) | Transport and Distribution Architecture | Approved | 2026-07-29 | RFC-001 | — | — |
| [ADR-002](ADR-002-security-posture-and-capability-reductions.md) | Security Posture and Capability Reductions | Approved | 2026-07-29 | RFC-001 | — | — |

Every ADR is also indexed in [`../DECISION_LOG.md`](../DECISION_LOG.md).

## How to add an ADR

1. **Confirm the decision is approved.** An ADR records an approved decision; it does not seek approval. Per `CONSTITUTION.md` Article I, approval must be explicit and scoped, and silence is not approval. If approval has not been recorded, write or amend an RFC instead.
2. **Copy the structure of the Engineering OS `templates/adr-template.md`.** Use those headers and no invented ones:
   - Title: `# ADR-NNN: Title`
   - Header fields: `Status`, `Date`, `Related RFC`, `Approved by`
   - Sections, in order: `## Context`, `## Decision`, `## Consequences`, `## Alternatives Rejected`, `## Security and Compatibility Impact`, `## Supersedes`, `## Superseded By`
3. **Number sequentially.** The next number is one higher than the highest existing ADR, whatever its status. Numbers are never reused, even if an ADR is superseded or withdrawn. File name: `ADR-NNN-kebab-case-title.md`.
4. **Never edit an approved ADR in place.** An approved ADR is a historical record of what was decided and why. To change a decision, write a new ADR that:
   - names the old one in its `## Supersedes` section, and
   - is then referenced from the old one's `## Superseded By` section — the only edit permitted to an approved ADR.

   Both directions must be filled in, so the chain reads forwards and backwards. Correcting a typo is fine; changing a decision, its rationale, or its consequences is not.
5. **Update this index and `docs/DECISION_LOG.md`** in the same change, including the `Supersedes`/`Superseded By` columns.
6. **State consequences honestly.** Record what the decision costs, what it makes unavailable, and what remains unverified. An ADR that reads as though the decision had no downside is not a usable record.
