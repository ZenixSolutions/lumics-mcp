# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note that while the version is below `1.0.0`, the tool surface is not yet stable: a breaking change
to a tool name or its arguments ships as a **minor** bump with an explicit notice in this file. See
[docs/RELEASE.md](./docs/RELEASE.md).

## [0.1.0] - 2026-07-30

First release.

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
- `LUMICS_COMPANY_ID` is **optional**. Without it the server starts, registers only the two tools that
  need no company (`lumics_get_me` and `lumics_get_device_definition_components`; three with
  `LUMICS_ENABLE_TOKEN_REVOCATION` on) and logs a warning. This is what makes the documented first-run
  flow possible: the way to discover a company id is `lumics_get_me`, and a server that refused to
  start without the id could not run the tool that finds it. Call `lumics_get_me`, set the variable,
  restart. A value that _is_ supplied is still format-checked at startup.
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
- `LUMICS_ALLOW_CROSS_COMPANY`, off by default. Every tool is covered by the company pin: most take an
  optional `companyId` and, with the flag unset, a value differing from `LUMICS_COMPANY_ID` is refused
  with `not_permitted`. See **Security** below.
- `LUMICS_LOG_LEVEL`, one of `debug`, `info` (default), `warn`, `error` or `silent`. Diagnostics have
  always gone to stderr — stdout is the MCP protocol channel — but there was no way to turn the
  verbosity up or off. `debug` adds a record per tool call with its duration, output size, whether the
  limit was reached and how many items the output budget dropped, which is what Troubleshooting needs
  when a tool returns less than expected. `silent` quiets stderr entirely, for a supervisor that treats
  any stderr output as a fault. The level is parsed in `src/config.ts` and applied by `src/index.ts`,
  so importing this package cannot change a host application's logging.
- A default resolution of 60 `dataPoints` on metric calls, since the Lumics API requires `dataPoints`
  or `width` on every metric-data endpoint and rejects a call with neither. The effective value, and
  whether it was defaulted, is disclosed in the output.
- Client-side ranking (`topN`, `sortBy`, `sortDirection`) for `metrics/summaries`, which accepts no
  `limit`, top-N or sort parameter of any kind. The output states that the ranking was applied by
  this server after fetching the full set, and reports how many items had no value at the sort path.
  Lumics keys its results by item class, and the trim is applied **per class**: with `topN: 2` over two
  classes you can get four rows, and no ranking crosses a class boundary. The response says so whenever
  more than one class is present, rather than only when the output budget happened to drop something.
- Local input validation ahead of the API: identifiers must be 24-character hex ObjectIds, IP
  addresses must parse as addresses, netmasks as dotted quads, MAC addresses as MAC addresses, and a
  PATCH with no changed fields is refused rather than reported as a successful no-op.
- Output shaping with an optional `fields` projection and a `LUMICS_MAX_OUTPUT_CHARS` budget
  (default 25,000). The budget caps the **entire** text a tool returns, disclosure notes and JSON
  payload together: notes are reserved first and the payload is fitted to what remains. The one
  exception is disclosures that exceed the budget by themselves — they are emitted in full and the
  payload is reduced to nothing, because a disclosure is never dropped or shortened to save space.
  Arrays shed whole items **from the end** so what remains still parses and the loss is positional;
  every drop is disclosed with a count. The completeness note and the truncation note are generated
  together, so a response cut by both no longer tells you to raise the limit and to lower it in the
  same breath.
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

### Changed

Everything in this section comes from the first contract run against a live Lumics tenant, on
2026-07-30, which contradicted the vendor documentation in the metric layer. The measurements are
recorded in [`docs/reference/lumics-api-v1.md`](./docs/reference/lumics-api-v1.md) §0, §12.5 and §14
defects 17–23; the decisions are
[ADR-003](./docs/adr/ADR-003-metric-layer-live-contract-corrections.md).

- **BREAKING (tool surface): `properties` is now a required argument** on
  `lumics_get_company_metrics`, `lumics_summarize_company_metrics`, `lumics_get_device_metrics` and
  `lumics_get_device_item_metrics`. Spec §12.0 marks it optional; the live API answers
  `400 {"error":"Must supply required component metrics as properties parameter"}` without it, so
  those four tools **could not make a single successful call at all** before this change. The break
  is therefore real in form and removes a call shape that never worked. It is required rather than
  defaulted because no metric name is correct for every module, and a default would turn every
  unqualified request into a confident answer to a question nobody asked. The syntax is
  `<TypeGroup>.<metric>`, comma-separated — `Calculated.cpu`. It stays **optional** on
  `lumics_get_metric_summary` (spec §12.4), where it is genuinely optional upstream and acts as a
  **filter** rather than a projection: supplying it returned `count: 0` on a live tenant, dropping
  items rather than narrowing them.
- **Local validation of `properties` that the captured API contract does not contain.** A value in
  which no comma-separated entry carries a `Group.` prefix is rejected before any request is issued.
  This is a deliberate deviation from `docs/reference/lumics-api-v1.md`, which `CLAUDE.md` otherwise
  forbids, and it is justified by measurement rather than taste: an invalid `properties` value is
  **not** rejected upstream. `properties=cpu` and `properties=bogusXYZ` both returned **HTTP 200 with
  658 rows and an empty `stats` object on every one**, so the API cannot be relied on to reject the
  value and the failure is invisible. The guard is deliberately the weakest one that still catches
  that trap — a single qualified entry lets the whole value through, since nothing establishes that a
  bare name is never legal.
- **A new disclosure class for the same trap.** When rows come back but the requested property paths
  resolve on none of them, the response says the property names may be malformed and states
  explicitly that this is **not** a claim that no data exists. Where only some paths fail, it says the
  returned rows are real and names which entries produced nothing, classifying each as an unqualified
  name, a recognised group holding no such metric, or a group that never appeared — those need
  different fixes. It fires only when there are rows to inspect. Without it, 658 rows of empty stats
  under a successful tool result is a confident negative about the estate built on a typo.
- **Discovery routing corrected.** `lumics_list_component_types` is no longer named as the route to a
  metric tool's `itemType`: it returns **plural aliases**, and 213 of its 246 ids were rejected with
  `400 Unknown component <value>` (`snmp_common_cpus` fails, `snmp_common_cpu` succeeds). The
  singular id is built from `lumics_get_device_definition_components` — the module and group from an
  entry's `filePath` joined to the singular `data.itemType` — or copied from the `type` field of a row
  a metric call already returned. `lumics_get_metric_summary` is documented as the **only**
  enumeration path for metric property names, with both of its limits stated: device-scoped names
  only, and a module-dependent response key (`devices` for `snmp`, `http_endpoints` for `http`). It is
  also now documented that Lumics validates `itemType` **before** `properties`, so a wrong `itemType`
  hides a properties problem entirely.
- **A per-request timeout override, and a three-minute deadline for
  `lumics_summarize_company_metrics`.** That endpoint aggregates every matching component in the
  company before answering and was measured **exceeding 90 seconds without returning**, where the
  other metric endpoints answered the same module and window in one to two seconds — so under the
  shared `LUMICS_TIMEOUT_MS` it could never succeed. The override applies to that one request, is set
  by calling code and is **not a tool argument**, so a model cannot ask the server to hold a
  connection open for minutes; an operator whose configured timeout is already higher keeps theirs.
  The call is also capped at **one attempt**, because the deadline and the retry budget multiply:
  three attempts at three minutes was nine minutes of silence, which from a client is
  indistinguishable from a hung server, for retries that cannot help an endpoint that is slow because
  of how much work it is doing. A per-request attempt budget can only ever **lower** the client-wide
  one, never raise it. A `/summarize` timeout now carries its own guidance saying it was attempted
  once deliberately, that **a timeout is not an empty result**, and what to narrow.
- **The two company-scoped metric tools now say that the endpoint behind them is unreliable, and
  route the model to the device-scoped tools instead.** Measured on 2026-07-30 across two contract
  runs and a manual probe (spec §12.5 M12, §14 defect 25):
  `GET /metrics/companies/:c/modules/:m` (spec §12.1) returned
  `500 {"error":"Sorry, an error occurred. Please try again.","code":500,"level":"error"}` on
  **ordinary queries carrying a valid `properties` value** — with `lastMetric`, `isMonitored`,
  `minIntervals` and `limit`, and with `interval=minute` and `interval=fiveMin` — while
  `interval=hour`, `interval=day`, `aggregate` and `alignTimeRange` were served, as was a minimal
  probe. `/summarize` (spec §12.2) never returned at all. The device-scoped endpoints (spec §12.3)
  answered the same tenant in one to two seconds with populated data throughout. Separately, the
  vendor's own web UI **never calls this route**: a company dashboard load issued 57 API calls,
  including its "Top devices by CPU" and "Top devices by memory" widgets, and none of them was
  `/api/v1/metrics/companies/`. `lumics_get_company_metrics` and `lumics_summarize_company_metrics`
  therefore carry a reliability warning in their descriptions naming the parameters that correlated
  with a 500, the ones that were served, and the fallback sequence — `lumics_list_devices`, then
  `lumics_get_device_metrics` or `lumics_get_device_item_metrics` per device. **Neither tool is
  withheld or removed**: the endpoint is intermittent and query-dependent rather than dead, no cause
  has been established, and a minimal query is still served, so the decision is to state the shape of
  the risk rather than the blanket claim that it is broken.
- **A 500 from those two endpoints no longer reaches the model as a flat internal error.** The generic
  spec §3 mapping says "This is not a problem with your arguments. The server already retried where
  safe" — both halves of which are misleading on this one route, where the arguments **do** correlate
  with the failure and a working alternative exists. A 500 whose path is `/metrics/companies/:c/
modules/:m`, with or without `/summarize`, now carries endpoint-specific guidance: that the endpoint
  is known-unreliable, which parameters correlated and which were served, that the failure is
  intermittent rather than total and no cause is claimed, the device-scoped fallback by tool name, and
  that a 500 is not evidence of an absence of data. **Every other endpoint's 500 is unchanged**, as is
  every other status on the metric route — a 400 there is still a 400.
- **A 500 on that route is marked non-retryable.** No retry loop changed: 500 has never been in
  `RETRYABLE_STATUSES`, so the client already failed fast on it, and the `retryable: true` flag
  carried by the error was metadata that disagreed with the behaviour and with the new guidance. On a
  known-unreliable, query-dependent endpoint that disagreement is load-bearing, so the flag now says
  what the client does. The company-scoped tools deliberately did **not** get a one-attempt budget of
  the kind `/summarize` has: it would change nothing about a 500 and would disable retrying of
  genuinely transient statuses (429, 502, 503, 504) on an endpoint that answers in one to two seconds
  when it answers, which would weaken a control that is doing useful work.

### Security

- **The server reads no `.env` file.** An earlier build in this release cycle called Node's dotenv
  loader with the relative path `.env`, which for a published MCP server resolves against whichever
  directory the client launched it from — including a directory the agent being served can write to. A
  planted file could redirect `LUMICS_BASE_URL` and exfiltrate the bearer token (reproduced during
  review against a loopback sink) and reopen every `LUMICS_ENABLE_*` and cross-company gate the
  operator had left unset, which is all of them by default. Real environment variables won over the
  file, so only the defaults were hijackable — and the defaults are the security posture. The load is
  gone; `tests/security/dotenv-not-loaded.test.ts` runs the built binary in a directory holding a
  hostile `.env` and asserts the file changes nothing, in both directions. **This will break a setup
  that relied on the implicit load**: use your MCP client's own `env` block, as every documented
  install does, or `node --env-file=.env dist/index.js`.
- **`LUMICS_BASE_URL` must use `https:`**, except for a loopback host (`127.0.0.1`, `localhost`,
  `[::1]`), and is refused at startup otherwise. The Lumics token is a bearer credential sent on every
  request, so plain `http:` to a remote host puts it on the wire in clear text. The hostname comparison
  is exact, so `localhost.example.invalid` gets no exemption, and no flag widens the rule. **This will
  reject a configuration that previously started**, namely a plaintext base URL for a remote
  self-hosted Lumics.
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
  `LUMICS_ALLOW_CROSS_COMPANY`, which is an out-of-band setting no prompt — and, per the dotenv item
  above, no file — can change. With the flag on, every write tool's description says so, so an approval
  prompt shows that a foreign `companyId` will be honoured.
- **The company pin now covers the two device-scoped metric tools.** `lumics_get_device_metrics` and
  `lumics_get_device_item_metrics` take no `companyId`, because the Lumics metric path for a device
  carries no company segment (spec §12.3), and they consequently bypassed the pin entirely: a reviewer
  read metrics for a device in another company with the pin on, while every other tool refused the same
  tenant. Both now resolve the device's owner first, with a company-scoped device read (spec §7.2)
  against `LUMICS_COMPANY_ID`, and refuse the call unless the device belongs there — a 404 from that
  read, or a device record with no `company` field, is a refusal rather than an assumption. The metric
  request is not made at all when the check fails. This costs one extra round trip per call, and because
  the check needs a configured company both tools are now **withheld when `LUMICS_COMPANY_ID` is
  unset**, which changes the no-company tool set from four tools to two.
- **A write is never retried after a transport failure, `DELETE` included.** `POST`, `PATCH` and
  `DELETE` get exactly one attempt when the connection drops, the request times out, or the response
  body arrives incomplete. `DELETE` was previously replayed on the grounds that HTTP calls it
  idempotent, but idempotence guarantees the same state, not the same answer: a delete whose connection
  dropped after Lumics applied it was retried, 404'd, and surfaced as `not_found` — "Lumics has no such
  resource" — so a completed destructive action was reported as never having happened. Retries driven by
  a **status code**, `429` included, are unchanged for every verb: a status proves the server answered
  and did not act.
- **Transport-failure errors on writes now instruct a verifying read instead of a retry.** On `POST`,
  `PATCH` or `DELETE`, a timeout, network error or incomplete body says the request may already have
  been applied, that this server deliberately did not retry it, and that the model should read the
  record back or list its parent collection rather than reporting a failure. Read paths keep the old
  "retry the call" advice, which is correct there because nothing changed either way. The same wording
  applies when Lumics returns the documented `updated`/`deleted` envelope with nothing inside it.
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
  Narrowing `itemType` or the window is the only safe way to reduce the response size — `properties`
  filters items out on that endpoint rather than narrowing them.
- **A component-level metric property name is discoverable from no endpoint at all.**
  `lumics_get_metric_summary` enumerates real property names but only **device-scoped** ones, and
  `lumics_get_device_definition_components` is the inventory schema and carries none. So an interface
  counter such as `Calculated.ifInOctets` — found by probing — cannot be obtained from any documented
  route, while `properties` is mandatory and a wrong value looks like success. Component-level metric
  questions are answerable only when you already know the name, from the Lumics UI or from
  institutional knowledge. This is a gap in the vendor API and this server cannot close it.
- **The company-scoped metric endpoint is unreliable in practice.** `lumics_get_company_metrics`
  returned HTTP 500 on ordinary queries carrying a valid `properties` (with `lastMetric`,
  `isMonitored`, `minIntervals`, `limit`, `interval=minute`, `interval=fiveMin`), while
  `interval=hour`, `interval=day`, `aggregate`, `alignTimeRange` and a minimal query were served;
  `lumics_summarize_company_metrics` never returned at all. The device-scoped tools answered in one to
  two seconds throughout, and the vendor's own dashboard never calls this route. It is intermittent
  and query-dependent, not dead, and no cause has been established. Both tools remain available and
  both say this; for anything estate-wide, resolve devices with `lumics_list_devices` and read them
  with `lumics_get_device_metrics`. This server cannot fix an upstream fault — it can only stop a
  failure being read as an absence of data.
- **`lumics_summarize_company_metrics` is slow and its response shape is unverified.** The endpoint
  never returned during the contract run, so everything the vendor documents about it — the envelope,
  the `sum` semantics, `type: "summed"`, `components`, the integer bucket `_id` — is unverified
  against live behaviour. The three-minute deadline makes success possible; it does not make it
  demonstrated. On a large tenant the call can still time out, and a timeout there is a timeout, not
  evidence that no data exists.
- **`lumics_get_metric_summary` does not support every module**, and fails non-JSON when it does not:
  `snmp` and `http` answered 200, `ping` and `syslog` returned HTML error pages, `deviceConfigs`
  returned 500. No per-module availability is documented anywhere.
- **`lumics_list_component_types` does not always return `type`** — 41 of 246 entries omitted it,
  present only when `id` has three or more underscore-separated segments, where spec §6.4 documents an
  unconditional four-field object.
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
