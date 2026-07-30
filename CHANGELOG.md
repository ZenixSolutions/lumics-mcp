# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note that while the version is below `1.0.0`, the tool surface is not yet stable: a breaking change
to a tool name or its arguments ships as a **minor** bump with an explicit notice in this file. See
[docs/RELEASE.md](./docs/RELEASE.md).

## [0.1.0] - Unreleased

First release. Nothing below has shipped yet; this section is the release note under construction
and is finalised at tag time.

### Added

- **39 tools**, one for each of the 41 documented Lumics REST API v1.0 endpoints except the two token
  endpoints withheld on security grounds: collectors (5, spec §5), components and component types
  (5, §6), devices (7, §7), IPAM addresses (5, §8), IPAM groups (5, §9), IPAM subnets (5, §10),
  identity (2 of the 4 endpoints in §11), and metrics (5, §12). **37 are registered in a default
  deployment**; 20 under `LUMICS_READ_ONLY=1`.
- stdio transport, distributed as the npm package `@zenixsolutions/lumics-mcp` and runnable with
  `npx`. **`LUMICS_TRANSPORT=http` is refused at startup** in this release: ADR-001 decision 3 makes
  v0.1 stdio-only and states that it opens no network listener at all, so the configuration path to
  the listener is closed rather than left reachable while three documents say it does not exist.
  `src/transport/http.ts` stays in the tree so v0.2 is additive, and the five `LUMICS_HTTP_*`
  variables are documented for forward reference only. Streamable HTTP is ADR-001 decision 4,
  scheduled for v0.2.
- `LUMICS_COMPANY_ID` is **optional**. Without it the server starts, registers only the tools that
  need no company (`lumics_get_me`, `lumics_get_device_definition_components`,
  `lumics_get_device_metrics`, `lumics_get_device_item_metrics`) and logs a warning. This is what
  makes the documented first-run flow possible: the way to discover a company id is `lumics_get_me`,
  and a server that refused to start without the id could not run the tool that finds it. Call
  `lumics_get_me`, set the variable, restart. A value that _is_ supplied is still format-checked at
  startup.
- Operation classification on every tool — Read, Create, Update, Admin, or Destructive — with the MCP
  annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) derived from the classification
  rather than written by hand, so an annotation cannot contradict it. `openWorldHint` is `true`
  everywhere.
- Per-tool reference documentation at [`docs/TOOLS.md`](./docs/TOOLS.md): every tool's arguments,
  types, defaults, constraints, return shape, underlying endpoint, and gating.
- `LUMICS_READ_ONLY=1` safety switch, which registers read tools only.
- Opt-in gates for the two highest-impact operations: `LUMICS_ENABLE_BATCH_UPDATE` for bulk device
  update and `LUMICS_ENABLE_TOKEN_REVOCATION` for token revocation. Both are registration-time
  controls: without the flag the tool is absent from `tools/list` entirely.
- Human-friendly time windows on metric tools: a relative `lookback` such as `15m`, `6h` or `7d`, or
  ISO-8601 `from`/`to`, converted internally to the API's epoch-millisecond `fromMs`/`toMs`. The
  window defaults to the last hour. Nobody has to compute epoch milliseconds. Reversed windows,
  epoch-seconds mistakes, windows wider than 366 days, a `to` in the future, and `from` combined
  with `lookback` are all rejected locally with an explanation.
- **Timestamp arguments require an explicit timezone.** `from`/`to` on every metric tool and `date`
  on `lumics_update_device_last_discovery` accept a bare `YYYY-MM-DD` (meaning UTC midnight), an
  ISO-8601 timestamp carrying `Z` or a numeric offset, or epoch milliseconds. A timestamp with a
  time component and no zone — `2026-07-29T14:00:00` — is **rejected**, with a message naming the
  fix. `Date.parse` reads that form in the server's local timezone while reading a bare date as UTC,
  which shifted a window by up to fourteen hours while the response notes reported the shifted
  window: a wrong answer that looked internally consistent. On
  `lumics_update_device_last_discovery` the same input would have persisted a shifted discovery time
  to Lumics.
- A default `fields` projection on `lumics_list_devices` — `id`, `name`, `ipAddress`, `deviceType`,
  `collector`, `enabled`, `maintenanceMode` — because a full device record is around 1.9 kB and the
  default `limit` of 100 could not fit the 25,000-character output budget: a default call returned
  thirteen of the hundred devices it asked for, with two disclosure notes giving opposite advice.
  The projection is disclosed in every response, an explicit `fields` argument replaces it, and
  `fields: []` asks for whole records. No other list tool projects by default.
- `LUMICS_ALLOW_CROSS_COMPANY`, off by default. Every tool takes an optional `companyId`; with the
  flag unset, a value differing from `LUMICS_COMPANY_ID` is refused with `not_permitted`. See
  **Security** below.
- A default resolution of 60 `dataPoints` on metric calls, since the Lumics API requires `dataPoints`
  or `width` on every metric-data endpoint and rejects a call with neither. The effective value, and
  whether it was defaulted, is disclosed in the output.
- Client-side ranking (`topN`, `sortBy`, `sortDirection`) for `metrics/summaries`, which accepts no
  `limit`, top-N or sort parameter of any kind. The output states that the ranking was applied by
  this server after fetching the full set, and reports how many items had no value at the sort path.
- Local input validation ahead of the API: identifiers must be 24-character hex ObjectIds, IP
  addresses must parse as addresses, netmasks as dotted quads, MAC addresses as MAC addresses, and a
  PATCH with no changed fields is refused rather than reported as a successful no-op.
- Output shaping with an optional `fields` projection and a `LUMICS_MAX_OUTPUT_CHARS` budget
  (default 25,000). Arrays shed whole items **from the end** so what remains still parses and the
  loss is positional; every drop is disclosed with a count. The completeness note and the truncation
  note are generated together, so a response cut by both no longer tells you to raise the limit and
  to lower it in the same breath.
- No `limit` is sent to a metric endpoint unless the caller supplies one — deliberately unlike the
  list tools, which default to 100. `limit` is optional upstream, and injecting a default silently
  truncated a multi-thousand-row time series in an order Lumics does not document, cutting across
  time as well as across components. An incomplete inventory looks incomplete; a series with holes
  looks like data. The output budget sheds from the end instead, and the row-count note on every
  metric response states which of the two happened and what it means for reading the series.
- The captured Lumics API contract as a committed artifact at `docs/reference/lumics-api-v1.md`, so
  the contract the code targets is auditable and upstream drift is visible.
- Governance and community documentation: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT,
  CLAUDE.md, dependency policy, release policy, issue and pull request templates.
- CI on every push to `main` and every pull request: typecheck, lint, format check, tests, build,
  secret scan, and a stdio startup smoke test on Node 20 and 22.

### Security

- `LUMICS_READ_ONLY=1` filters at **registration** time rather than refusing calls at runtime: write
  tools are never advertised, so a model cannot be talked into attempting one.
- Bulk device update is classified **Admin**, not Update, and carries `destructiveHint`: one call
  rewrites arbitrary fields across many devices and the API documents no cap on how many.
- Token revocation is gated off by default because the Lumics API has **no per-token revoke**. It
  revokes every JWT on the account, including the one this server is using, and every other
  integration or session authenticating as the same user.
- Cross-company access is refused by default. A Lumics token issued to an MSP user reaches every
  company that user administers, and `companyId` is an ordinary tool argument, so a model holding
  another tenant's id could otherwise read or write there — while the tool description told the
  approving human the call applied to the configured company. An explicit `companyId` differing from
  `LUMICS_COMPANY_ID` now fails with `not_permitted` unless the operator sets
  `LUMICS_ALLOW_CROSS_COMPANY`, which is an out-of-band setting no prompt can change. With the flag
  on, every write tool's description says so, so an approval prompt shows that a foreign `companyId`
  will be honoured.
- `confirm: true` is required on every Admin and Destructive tool, injected by the tool factory so it
  cannot be forgotten. It is documented as a **prompt-level speed bump, not a control** — the model
  supplies it itself. The environment flags are the real gate.
- `GET /me/token` and `POST /me/token` are deliberately not exposed. Both return a live JWT in the
  response body, which would put credential material into a conversation transcript; the second also
  takes the user's password. Operators mint tokens out of band.
- Raw Mongo query passthrough (`componentQuery`, `filters`) is deliberately **not** exposed as a
  tool argument. Handing a model a raw query language is a NoSQL injection and unbounded-query
  surface. Typed `itemType`, `isMonitored`, and `properties` arguments cover the practical cases.
  This is a deliberate reduction of capability the vendor API offers.
- Write surfaces are narrowed to documented fields rather than accepting free-form objects. Notably
  `company` is never writable — writing it would move a record between tenants — and collector-owned
  observational fields (`needsRestart`, subnet scan counters, address `scanHistory`) are readable but
  not writable, so no scan or observation can be fabricated by hand.
- Credential redaction happens **structurally** at the error boundary, on the shape of error and
  request objects rather than by filtering strings, and is verified by test.
- `encodeURIComponent` is applied to every interpolated URL path segment in one central path-builder
  module, enforced by test. Segments consisting only of dots are rejected outright.
- This release opens **no network listener at all**, and `LUMICS_TRANSPORT=http` is refused at
  startup so that stays true in every configuration. The HTTP transport shipping in v0.2 requires
  bearer authentication of at least 32 characters, binds to loopback by default, and enforces
  explicit host and origin allowlists for DNS-rebinding and CORS protection; those checks are
  validated (and unit-tested) even while the transport is refused, so an operator preparing a v0.2
  deployment learns now if their configuration would be unsafe.

### Known limitations

- The Lumics API has **no pagination** — only `limit` (1–1000; the list tools default to 100, the
  metric tools send none). Large result sets can be
  truncated with no mechanism to page further, and the server emits no `offset`, `has_more`,
  `next_offset`, `page` or `total` field, not even set to a plausible value. When a list returns
  exactly `limit` items the response says that more may exist and that the API offers no way to page
  to them.
- Four tools accept no `limit` at all, because their endpoints document none:
  `lumics_list_components`, `lumics_list_component_types`,
  `lumics_get_device_definition_components` and `lumics_get_metric_summary`. Each carries its own
  disclosure that the response is the entire set Lumics returned.
- Ranking on `lumics_get_metric_summary` is performed locally, after the whole set has been fetched.
  Narrowing `itemType`, `properties` or the window is the only way to reduce the response size.
- `lumics_update_component` renames a component and nothing else: spec §6.3 documents no writable
  field list, and its only documented example sets `name`.
- Deleting an IP subnet or IP group has **undocumented cascade behaviour**. Lumics does not say
  whether contained records are removed or orphaned, and this server cannot tell you. Both tools say
  so and tell you to enumerate the contents first.
- v0.1 supports the `companies` context only. `admingroups` and `system` are not offered.
- The HTTP transport, Docker deployment, and `.mcpb` bundle are not in v0.1. `LUMICS_TRANSPORT=http`
  fails at startup with a message pointing at ADR-001 and v0.2; the `LUMICS_HTTP_*` variables are
  documented but inert.
- ChatGPT, Grok, and Claude.ai web are **not supported** in v0.1. All three require a publicly
  reachable HTTPS endpoint and cannot run a local stdio server; Grok additionally rejects localhost
  and private addresses. Support arrives with the v0.2 self-hosted HTTP deployment.
- The API documents `429 Too Many Requests` but publishes no rate limits, windows, or headers. The
  client is conservative about concurrency and honours `Retry-After` when present; where the ceiling
  actually is, we cannot say.
- Identifier field names are inconsistent upstream (`id` on most list reads, `_id` elsewhere) and
  component objects carry the Mongoose internals `__t` and `__v`. These are passed through as they
  arrive rather than normalised.

[0.1.0]: https://github.com/ZenixSolutions/lumics-mcp/commits/main
