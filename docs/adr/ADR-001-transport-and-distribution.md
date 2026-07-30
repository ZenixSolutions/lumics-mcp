# ADR-001: Transport and Distribution Architecture

- **Status:** Approved
- **Date:** 2026-07-29
- **Related RFC:** RFC-001
- **Approved by:** Project Owner

## Context

How this server is reached decides which AI clients can use it, so transport and distribution are one decision, not two.

**The binding constraint is a client capability limit, not a preference.** ChatGPT developer-mode connectors and Grok custom connectors **cannot execute a local stdio server**. Both require a publicly reachable HTTPS endpoint, and Grok explicitly rejects `localhost` and private addresses. No packaging choice changes this. In particular, `mcp-remote` does not help: it is itself a local process, so it cannot make this server reachable from ChatGPT on the web or from Grok. This limit — and nothing about our preferences — is the entire reason distribution is phased. Any plan that claims those two clients at v0.1 is wrong on the facts.

Claude Code, Claude Desktop, and Codex do execute local stdio servers, so stdio reaches real users on day one while requiring no hosting, no TLS certificate, no public attack surface, and no operational commitment.

Further context from RFC-001:

- **The install experience is the product.** The stated goal is a single copy-paste command per client, with an honest matrix of what works where.
- **The vendor is JWT-only.** RFC-001 assumption A3 records that Lumics offers no OAuth and none is imminent. A multi-tenant hosted service would therefore have to broker user credentials itself. The Project Owner has instead decided on self-hosted per-tenant deployment, which removes credential brokering from scope entirely.
- **Protocol revisions are in motion.** Clients in the field today implement MCP revision **2025-11-25**. A later revision dated **2026-07-28** removes session assumptions. Committing the domain core to session semantics would make that revision a rewrite rather than a transport change.
- **The prototype is not transport-independent.** Its entry point starts a transport as an import side effect, so the server cannot be constructed in a test without also starting I/O.

## Decision

1. **Transport-independent core.** Domain, API-client, tool, and presentation layers hold no transport knowledge, no session assumptions, and no I/O side effects at import time. Transport modules under `src/transport/` are swappable and hold no domain knowledge.
2. **Exported `buildServer()` factory.** `src/server.ts` exports `buildServer()`, which returns a fully configured but unstarted MCP server. It is the package's `main`/`exports` entry. `src/index.ts` is a thin bin only — shebang, argument parsing, delegate. `main` does not point at an executable.
3. **v0.1 transport: stdio.**
4. **v0.2 transport: Streamable HTTP on a single `/mcp` endpoint**, with `GET` and `DELETE` handlers alongside `POST`. Hardened from its first commit: bearer auth required, DNS-rebinding protection with explicit `allowedHosts`/`allowedOrigins`, loopback bind by default, rate limiting, and Express error middleware.
5. **Target MCP protocol revision 2025-11-25** — what clients actually implement — while keeping the core free of session assumptions so that adopting the stateless **2026-07-28** revision is a change confined to the transport layer.
6. **Legacy HTTP+SSE will not be implemented.** It is deprecated in the specification.
7. **Phased distribution:**

| Phase | Artifact | Reaches |
|---|---|---|
| v0.1 | npm package, `npx` invocation | Claude Code, Claude Desktop, Codex |
| v0.1 | `.mcpb` bundle | Claude Desktop one-click install |
| v0.2 | Docker image + self-hosted deployment template | ChatGPT, Grok, Claude.ai — each at the tenant's own URL |

8. **Self-hosted per-tenant, not multi-tenant hosted.** Zenix operates no shared endpoint, holds no third-party Lumics credentials, and runs no authorization server or credential broker.

## Consequences

- **ChatGPT and Grok are unsupported until v0.2.** This is the honest statement of the position and the README must make it plainly, without hedging. Users of those two clients get nothing from the v0.1 release. If v0.2 slips, they continue to get nothing; the phase gap is documented as a gap and never as implied support. Overstating client coverage is the fastest available way to lose community trust.
- Claude Code, Claude Desktop, and Codex are fully served by v0.1.
- `buildServer()` makes the server constructible and testable in-process, without a transport and without I/O, which is what allows integration tests to mock HTTP at the transport boundary.
- Adding HTTP in v0.2 is additive: no v0.1 consumer has to change anything.
- The claim that the 2026-07-28 revision is "only a transport-layer change" is an expectation, not a verified fact, and stays unverified until an HTTP transport exists. It is cheap to hold now (avoid session state in the core) and expensive to retrofit later, which is why it is decided now.
- v0.2 moves operational responsibility — TLS, ingress, patching, secrets — to each adopting tenant. That is the price of not brokering credentials. The deployment template must therefore be secure by default in environments we do not control.
- Self-hosting confines the blast radius of a leaked Lumics token to the tenant that owns it. There is no shared credential store to breach, and no single hosted URL to hand out either.
- v0.1 releases must build and publish two artifacts (npm package and `.mcpb` bundle) from one source tree, so release automation carries that cost from the first release.
- Declining legacy HTTP+SSE means any client that implements only that deprecated transport is out of scope permanently, not just until v0.2.

## Alternatives Rejected

- **Remote-first hosted (v0.1 as a hosted endpoint).** Rejected: it blocks all tool work behind hosting, TLS, and OAuth decisions, and delivers nothing to the clients that already work.
- **stdio only, permanently.** Rejected: it permanently excludes ChatGPT and Grok and therefore fails the stated goal outright.
- **`mcp-remote` bridge as the answer for ChatGPT and Grok.** Rejected on the facts: it is a local process. It does not make the server reachable from ChatGPT on the web or from Grok, so it does not solve the problem it superficially appears to solve.
- **Legacy HTTP+SSE transport.** Rejected: deprecated; implementing it would add a second HTTP surface to secure and maintain for no durable gain.
- **Multi-tenant hosted service with an OAuth broker.** Rejected by owner decision and unsupported by the vendor: Lumics issues JWTs only (A3), so a hosted service would have to collect and store tenant credentials. That is a materially larger security obligation than this project accepts.
- **Targeting the 2026-07-28 revision as the primary now.** Rejected: clients in the field implement 2025-11-25, so targeting the newer revision first would trade real compatibility for anticipated compatibility. The forward path is preserved by design instead.
- **Transport-coupled core (as in the prototype).** Rejected: it makes in-process testing impossible and makes any transport change a core change.

## Security and Compatibility Impact

**Security.** v0.1 opens no network listener at all; stdio is the smallest attack surface available, and it eliminates the prototype's unauthenticated HTTP listener bound to all interfaces with no DNS-rebinding protection. v0.2 knowingly introduces a public HTTPS endpoint, which is why its controls — required bearer auth, explicit `allowedHosts`/`allowedOrigins` DNS-rebinding protection, loopback bind by default, rate limiting, and error middleware that does not leak internals — are fixed by this decision rather than left to implementation time. Publishing a self-hosted deployment template makes secure-by-default configuration our responsibility in environments we do not operate. Self-hosted per-tenant means Zenix never holds another organisation's Lumics token. Per `CONSTITUTION.md` Article VIII these controls are to be verified by test, not assumed.

**Compatibility.** Greenfield, so there are no backward-compatibility obligations at 0.1.0. Forward-looking: the tool surface is the public contract from 0.1.0 per `standards/ai-interface-standard.md`, while pre-1.0 permits breaking tool changes with a minor version bump and a changelog notice. Transport additions are additive. Protocol-revision changes are confined to `src/transport/` by construction, which is the specific compatibility property this ADR buys.

## Supersedes

None. This is the first architectural decision record in this repository.

## Superseded By

None. This ADR is current. It must not be edited in place once approved; a change to any decision above requires a new ADR that names this one in its `Supersedes` field, and this ADR's `Superseded By` field is then filled in.
