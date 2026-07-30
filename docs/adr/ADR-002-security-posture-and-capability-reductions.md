# ADR-002: Security Posture and Capability Reductions

- **Status:** Approved
- **Date:** 2026-07-29
- **Related RFC:** RFC-001
- **Approved by:** Project Owner

## Context

This server hands control of a production network-monitoring platform to a language model. The Lumics API v1.0 surface it wraps includes destructive operations, an all-or-nothing token revocation endpoint, a batch write endpoint, and two parameters that accept raw MongoDB query expressions. Three facts from the captured specification (`docs/reference/lumics-api-v1.md`) shape the posture:

- **`componentQuery` and `filters` accept raw Mongo query expressions.** §12.0 documents `componentQuery` as *"A mongo query expression to limit the components for which metrics will be returned"* and `filters` as *"A filter object which can be converted into a mongo query"*. They appear on three of the metric-data endpoints (§12.1, §12.2, and the multi-component device endpoint in §12.3).
- **`POST /api/v1/me/token/revoke` revokes every token for the user.** §11.4: *"Revoke all previously issued JWT tokens for your user."* There is no single-token revoke and no endpoint that lists outstanding tokens, so there is no way to see what would be destroyed and no way to destroy less.
- **Path segments are all caller-supplied identifiers.** Every resource route interpolates `:context`, `:contextId`, `:id`, `:company`, `:ipSubnet`, `:component`, `:module`, `:moduleType`, or `:item`. The prototype interpolated these unencoded.

Governing authority:

- `standards/security-standard.md` requires classifying every public operation as Read, Create, Update, Admin, or Destructive; validating all external input; using secure defaults; requiring confirmation for high-impact actions; never committing, logging, echoing, or exposing secrets; redacting credentials in errors and diagnostics; and documenting threat assumptions and residual risk.
- `CONSTITUTION.md` Article III ranks **Security first** and **Feature completeness seventh** — security outranks feature completeness explicitly, not by interpretation.
- `CONSTITUTION.md` Article IX requires explicit confirmation and clearly described impact for destructive, privileged, or materially consequential actions.
- `CONSTITUTION.md` Article VIII requires security controls to be verified, not assumed.

The prototype this project replaces contained an unauthenticated HTTP listener bound to all interfaces, unencoded interpolation into URL paths, and a `sync-create.mjs` script that read the API token out of the Claude Desktop configuration file and embedded live Zenix network topology.

## Decision

1. **Every public operation is classified** Read / Create / Update / Admin / Destructive per `standards/security-standard.md`, and the classification is mapped onto the corresponding MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so the classification is visible to the client, not only to us.
2. **`LUMICS_READ_ONLY` registers only Read tools.** In read-only mode the write tools are *not present in the tool list* — the server does not register them and then refuse calls. An audit-only consumer therefore gets a server that cannot be talked into a write, and does not have to fork to get one.
3. **Raw Mongo query passthrough is not exposed in v0.1.** `componentQuery` and `filters` are not surfaced as tool parameters. Typed `itemType`, `isMonitored`, and `properties` parameters cover the documented use cases.
4. **Token revocation (`POST /me/token/revoke`) is gated behind an opt-in environment flag *and* a `confirm` argument.** Absent the flag, the tool is not registered at all.
5. **Batch device update (`PATCH /:context/:contextId/devices/:ids/batch`) is gated equivalently** — opt-in environment flag plus `confirm` — because one call can rewrite arbitrary fields on N devices.
6. **`encodeURIComponent` is applied to every interpolated path segment**, enforced by a test that fails if a segment reaches the URL builder unencoded.
7. **Credential redaction at the error boundary is structural.** Redaction operates on the shape of error and request objects — an `AxiosError`-style object carries request headers, so incidental string filtering is insufficient. A test asserts that no token material can reach logs or responses.
8. **No secret material is committed.** `.env.example` carries placeholders only; secret scanning runs in CI; `sync-create.mjs` is not ported in any form.
9. **Documentation recommends short `expiresIn` values** and states that the API documents no maximum (§11.2, §13 Q3), so long-lived tokens are possible and must not be encouraged.

### On the capability reduction (decision 3): this is a real trade-off, not a free win

The vendor API offers `componentQuery` and `filters`. This server withholds them. Something is being given up, and the record should say so.

**Why:** a raw Mongo query expression composed by a language model is both a NoSQL injection surface and an unbounded-query surface. It lets the caller reach component documents outside the intended selection and lets it issue queries whose cost is not bounded by anything in our layer. `standards/security-standard.md` requires validating all external input and using secure defaults; a passthrough of arbitrary query expressions is the opposite of both. `CONSTITUTION.md` Article III ranks Security above Feature completeness, so where the two conflict — and here they do conflict, directly — security wins.

**What it costs:** any use case that genuinely needs a component selection not expressible via `itemType`, `isMonitored`, and `properties` is unreachable in v0.1. RFC-001 rates this a Medium risk. We do not have evidence that such a use case exists; we also cannot prove it does not.

**Owner position:** the Project Owner was asked to confirm this reduction explicitly (RFC-001 Open Question 2) and **explicitly accepted it** for v0.1.

**Reversal path:** if evidence of a real need emerges, raw passthrough may be added behind an explicit opt-in environment flag, defaulting off, with the query surface documented as unvalidated. That change requires a new ADR superseding this one; it is not an implementation detail.

### On `confirm` (decisions 4 and 5): a model-supplied argument is not human-in-the-loop control

A `confirm` argument in a tool schema is satisfied by the model itself. The model reads that confirmation is required and supplies it. Nothing in that loop involves a human, and nothing about it is a control. It is a prompt-level speed bump: useful for making impact legible in the tool description and for discouraging a casual call, worth nothing against a determined or confused agent.

**The environment flag is the actual gate.** It is set by the human who deploys the server, out of band from the conversation, and cannot be set by the model. When the flag is absent the tool is not registered, so there is no call for the model to attempt. This ADR does not claim that `confirm` provides safety, and the tool documentation must not imply that it does. `confirm` satisfies Article IX's requirement to describe impact and require explicit confirmation; the flag is what makes the operation unreachable by default.

### Why token revocation is unusually dangerous

`POST /me/token/revoke` revokes *every* token issued to the user account, with no per-token revocation and no way to list what exists first (§11.4). Two consequences follow:

- **Self-DoS.** The token this server is authenticating with is one of the tokens revoked. A successful call breaks the server that made it, immediately and until a human mints a new token and redeploys.
- **Collateral damage.** Any other integration, script, dashboard, or human session authenticating as the same Lumics account is broken at the same instant, with no warning and no rollback. The blast radius is the account, not the caller.

There is no non-destructive rehearsal for this operation and no undo. That combination — irreversible, self-defeating, account-wide, and invisible before the fact — is why it is gated twice and disabled by default rather than merely annotated `destructiveHint`.

## Consequences

- An audit-only or least-privilege deployment is a supported first-class configuration (`LUMICS_READ_ONLY`), not a fork.
- Because read-only mode omits tools rather than refusing calls, the model never sees a capability it cannot use, so it cannot narrate a refusal as a platform error or retry against it. Clients that cache the tool list must be restarted when the mode changes.
- Metric tools cannot express arbitrary component selections in v0.1. Some legitimate query will eventually be unserviceable, and the correct response is to record the evidence and revisit, not to work around the gate.
- Token revocation and batch device update are unavailable in a default deployment. An operator who needs them must knowingly opt in, which is the intent.
- Every destructive operation classification, the read-only registration behaviour, path-segment encoding, and credential redaction are verified by tests (Article VIII). These tests are security controls, not coverage filler, and removing one is a security change requiring review.
- Structural redaction adds a mandatory boundary that every error path must pass through, which constrains how errors may be constructed and logged throughout the API layer.
- Residual risk documented per `standards/security-standard.md`: undocumented rate limits (429 is documented, its limits and headers are not), no documented `expiresIn` ceiling, and the possibility of drift between the vendor's documentation and live behaviour.

## Alternatives Rejected

- **Expose `componentQuery`/`filters` as-is because the vendor does.** Rejected: it delegates input validation to a language model and hands it an unbounded query surface. Article III settles the conflict in favour of security.
- **Expose them with a query validator or allow-list in front.** Rejected for v0.1: a partial Mongo-expression validator is a security-critical parser with no test corpus and no specification to validate against, and getting it subtly wrong is worse than not shipping it. Reconsiderable if a real need appears.
- **Rely on `confirm` alone for destructive operations.** Rejected: the model supplies its own confirmation, so this is no control at all.
- **Rely on the environment flag alone, without `confirm`.** Rejected: Article IX requires explicit confirmation and a described impact at the point of action, and the confirmation argument is where the impact statement lives.
- **Implement read-only mode by registering all tools and rejecting write calls at execution time.** Rejected: it leaves the write surface advertised, makes refusal a runtime behaviour that can be misread or retried, and any registration bug becomes an authorization bug.
- **Omit token revocation entirely.** Rejected: it is a documented part of the API and is exactly the operation an operator needs after a token leak. Gating it off by default preserves the capability for the incident that requires it.
- **Ad-hoc string-based redaction of secrets in log lines.** Rejected: error objects carry credentials in nested request metadata, so redaction has to be structural to be reliable.
- **Trust that callers pass well-formed identifiers instead of encoding path segments.** Rejected: this is the prototype's path-injection defect, and the encoding is enforced by test precisely so it cannot regress.

## Security and Compatibility Impact

**Security.** The posture is materially better than the prototype's: the unauthenticated all-interfaces listener, the unencoded path interpolation, and the credential-harvesting script are all gone. The remaining deliberate exposures are enumerated above and each is gated, typed, or withheld. Two risks are introduced by publication itself — a public repository invites scrutiny of our auth handling, and a self-hosted deployment template makes secure-by-default configuration our responsibility in environments we do not operate. Threat assumptions and residual risk are documented per `standards/security-standard.md`; controls are verified by test per Article VIII.

**Compatibility.** Withholding `componentQuery`/`filters` is a reduction relative to the vendor API, not relative to any prior release of this server, so nothing breaks. Adding them later behind an opt-in flag would be additive. Changing `LUMICS_READ_ONLY` semantics, un-gating a destructive tool, or relaxing redaction would each be a security-model change: per `BOOT.md` §8 that requires explicit Project Owner approval, and per this ADR it requires a superseding ADR. The tool surface is the public contract from 0.1.0 per `standards/ai-interface-standard.md`; pre-1.0, breaking tool changes are permitted with a minor bump and a changelog notice.

## Supersedes

None.

## Superseded By

None. This ADR is current. It must not be edited in place once approved; a change to any decision above requires a new ADR that names this one in its `Supersedes` field, and this ADR's `Superseded By` field is then filled in.
