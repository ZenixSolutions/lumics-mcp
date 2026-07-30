# Tool reference

Per-tool reference for `lumics-mcp` 0.1.0: every registered tool, its operation classification, the
Lumics endpoint behind it, its arguments, and what it returns.

Two things about authority. The server's own `tools/list` response is generated from the zod schemas
in `src/tools/`, so it is the final word on signatures; this document is written from those same
schemas and is kept in step with them. The Lumics API contract itself is captured verbatim in
[`reference/lumics-api-v1.md`](./reference/lumics-api-v1.md), and the `spec §` references below
point into it. Where the vendor documentation and this server disagree, the spec file says which
one is a known documentation defect (its §14).

This is a `0.x` release: **tool names and arguments may change before 1.0**, with a minor bump and a
[changelog](../CHANGELOG.md) entry. Pin an exact version if you depend on the surface.

---

## Contents

- [How to read this reference](#how-to-read-this-reference)
  - [Operation classes and MCP annotations](#operation-classes-and-mcp-annotations)
  - [What is registered, and when](#what-is-registered-and-when)
  - [Arguments almost every tool shares](#arguments-almost-every-tool-shares)
  - [What a tool returns](#what-a-tool-returns)
- [Cross-cutting behaviour you need to know first](#cross-cutting-behaviour-you-need-to-know-first)
  - [There is no pagination](#there-is-no-pagination)
  - [Time windows on metric tools](#time-windows-on-metric-tools)
  - [Metric resolution: `dataPoints`](#metric-resolution-datapoints)
  - [`lumics_get_metric_summary` ranks locally](#lumics_get_metric_summary-ranks-locally)
  - [`companyId` defaults to `LUMICS_COMPANY_ID`](#companyid-defaults-to-lumics_company_id)
  - [`confirm` is not human-in-the-loop control](#confirm-is-not-human-in-the-loop-control)
  - [Deliberate omissions](#deliberate-omissions)
- [Collectors — spec §5](#collectors--spec-5)
- [Components — spec §6](#components--spec-6)
- [Devices — spec §7](#devices--spec-7)
- [IPAM subnets — spec §10](#ipam-subnets--spec-10)
- [IPAM addresses — spec §8](#ipam-addresses--spec-8)
- [IPAM groups — spec §9](#ipam-groups--spec-9)
- [Identity — spec §11](#identity--spec-11)
- [Metrics — spec §12](#metrics--spec-12)

---

## How to read this reference

### Operation classes and MCP annotations

Every tool carries exactly one operation classification, as required by the Engineering OS security
standard. The classification is the only risk input: the MCP annotations are derived from it in
`annotationsFor()` (`src/tools/factory.ts`), never written by hand, so an annotation cannot
contradict the classification.

| Class           | Meaning                                                        | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `confirm` required | Registered under `LUMICS_READ_ONLY=1` |
| --------------- | -------------------------------------------------------------- | -------------- | ----------------- | ---------------- | ------------------ | ------------------------------------- |
| **Read**        | No state change.                                               | `true`         | `false`           | `true`           | No                 | Yes                                   |
| **Create**      | Adds a record. Repeating the call creates a second one.        | `false`        | `false`           | `false`          | No                 | No                                    |
| **Update**      | Modifies an existing record in place. Repeating it is a no-op. | `false`        | `false`           | `true`           | No                 | No                                    |
| **Admin**       | Account-wide effect, or one call mutating many records.        | `false`        | `true`            | `false`          | Yes                | No                                    |
| **Destructive** | Removes data.                                                  | `false`        | `true`            | `false`          | Yes                | No                                    |

`openWorldHint` is **`true` on every tool without exception**: each one talks to a live external
Lumics tenant whose contents this server neither controls nor caches.

`idempotentHint` describes _repeating the same call_, not safety. Update is idempotent because
setting a name twice leaves one name. Destructive is not, because the second call 404s rather than
reproducing the first result.

### What is registered, and when

**39 tools exist. 37 are registered by default; 20 are registered under `LUMICS_READ_ONLY=1`.**

| Configuration                                                         | Tools registered |
| --------------------------------------------------------------------- | ---------------- |
| Default                                                               | 37               |
| `LUMICS_READ_ONLY=1`                                                  | 20 (all Read)    |
| `LUMICS_ENABLE_BATCH_UPDATE=1` and `LUMICS_ENABLE_TOKEN_REVOCATION=1` | 39               |
| `LUMICS_COMPANY_ID` unset                                             | 2                |

The two tools missing from a default deployment are `lumics_batch_update_devices`
(`LUMICS_ENABLE_BATCH_UPDATE`) and `lumics_revoke_tokens` (`LUMICS_ENABLE_TOKEN_REVOCATION`).

Without `LUMICS_COMPANY_ID` the 36 company-scoped tools are withheld too, leaving
`lumics_get_me` and `lumics_get_device_definition_components` — three, if
`LUMICS_ENABLE_TOKEN_REVOCATION` is also on, since token revocation is scoped to the token's own user
rather than to a company. See [`companyId` defaults](#companyid-defaults-to-lumics_company_id) for the
bootstrap this exists to allow.

`lumics_get_device_metrics` and `lumics_get_device_item_metrics` count as company-scoped even though
they take no `companyId`: they enforce the company pin with a device-ownership read against
`LUMICS_COMPANY_ID`, so with no company configured there is nothing to check the device against.

Gating is **registration-time**, not a runtime refusal: a tool that is gated off does not appear in
`tools/list` at all, so a model cannot see it, cannot try it, and cannot narrate a refusal as a
platform fault. Changing any of these variables requires a server restart, and clients that cache
the tool list must be restarted too.

### Arguments almost every tool shares

These four are defined once in `src/tools/schemas.ts` and reused, so their meaning does not change
between tools. Per-tool tables below list them without repeating the detail.

| Argument    | Type             | Required                       | Default             | Constraints and notes                                                                                                                                                                                                                                                            |
| ----------- | ---------------- | ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `companyId` | string           | Optional                       | `LUMICS_COMPANY_ID` | 24-character hex ObjectId. Omit it — a value differing from the configured company is **refused** unless the operator set `LUMICS_ALLOW_CROSS_COMPANY`. See [`companyId` defaults](#companyid-defaults-to-lumics_company_id).                                                    |
| `limit`     | integer          | Optional                       | `100` on list tools | 1–1000. The **only** result-control parameter the Lumics API has. Present on the list tools whose endpoint documents it; four list-style tools have no `limit` at all — see [There is no pagination](#there-is-no-pagination). On the **metric** tools it has no default.        |
| `fields`    | array of strings | Optional                       | all fields          | Up to 50 top-level field names to keep, e.g. `["id","name","ipAddress"]`. Applied by this server after the response arrives. Unknown names are ignored rather than rejected. `lumics_list_devices` is the one tool with a default projection; pass `[]` there for whole records. |
| `confirm`   | literal `true`   | Required on Admin, Destructive | —                   | Injected by the tool factory, not declared per tool. Must be exactly `true`. Read [`confirm` is not human-in-the-loop control](#confirm-is-not-human-in-the-loop-control).                                                                                                       |

Every identifier argument (`collectorId`, `deviceId`, `ipSubnetId`, `componentId`, …) is a
24-character hex MongoDB ObjectId and is validated against that pattern locally, so a name, an IP
address or a numeric id fails immediately with a useful message instead of costing a 400 round trip.

### What a tool returns

A tool returns exactly one text block: any disclosure notes, then compact JSON. There is no
`structuredContent`, because v0.1 declares no `outputSchema`.

The vendor envelopes documented in spec §4.2 are unwrapped before you see them, so a write returns
the same shape as the corresponding read:

| Lumics response          | What the tool returns                          |
| ------------------------ | ---------------------------------------------- |
| GET list — bare array    | the array                                      |
| GET single — bare object | the object                                     |
| POST — created object    | the created object                             |
| PATCH / PUT single       | the object inside `updated`                    |
| PATCH batch              | the array inside `updated`                     |
| DELETE                   | the object inside `deleted`                    |
| Metric `{data, …meta}`   | the `data` payload; the metadata becomes notes |

Two upstream inconsistencies survive unwrapping, because hiding them would be a lie about the
tenant's data: identity keys differ per endpoint (`id` on most list reads, `_id` on component reads,
the single ipgroup read, and every create/update/delete payload), and component objects carry the
Mongoose internals `__t` (discriminator, e.g. `"pingtcp.Port"`) and `__v` (version key).

`LUMICS_MAX_OUTPUT_CHARS` caps the entire text a tool returns — disclosure notes and JSON payload
together. Notes are reserved first and the payload is fitted to what remains, so output never exceeds
the budget except in one case: when the mandatory disclosures alone are longer than the budget they
are still emitted in full and the payload is reduced to nothing, because a disclosure is never dropped
or shortened to save space.

Within that budget, arrays shed whole items from the end so what survives still parses; a single large
object is cut. **Either way the response says so, with a count of what was dropped.** Truncation is
never silent.

Errors come back as `isError: true` with the text `<code>: <message>` — for example
`not_found: …` or `not_permitted: …`. Credential material is stripped structurally at the error
boundary before anything is logged or returned.

One error shape is worth knowing in advance. When a **write** (`POST`, `PATCH`, `DELETE`) fails at the
transport — a dropped connection, a timeout, an incomplete response body — the server makes exactly
one attempt and the error says the request **may already have been applied**, then instructs a
verifying read. It does not say "retry the call", because the transport cannot distinguish a request
Lumics never processed from one it processed and then failed to answer, and replaying it would
duplicate a record, double-apply a change, or 404 on a record the first attempt deleted. Do not report
a write as failed on the strength of such an error: read the record back, or list its parent
collection, and report what is actually there.

`DELETE` is in that set alongside `POST` and `PATCH` even though HTTP calls it idempotent —
idempotence guarantees the same state, not the same answer, and a replayed delete returns `not_found`,
which reads as "the record never existed". Retries triggered by a **status code** are unaffected and
still apply to every verb, `429` included: a status proves the server answered.

---

## Cross-cutting behaviour you need to know first

These behaviours surprise people, and most of them are properties of the Lumics API rather than
choices this server made. Read them before reading any individual tool.

### There is no pagination

Across all 41 documented endpoints the only result-control parameter is `limit` (spec §4.3). There
is no `offset`, `page`, `skip`, `cursor`, `after`, `sort` or `order`; list responses are bare JSON
arrays; nothing carries a total count or a next-page link.

Consequences you have to live with:

- **The server emits no `offset`, `has_more`, `next_offset`, `page` or `total`** — not even set to a
  plausible value. A `has_more: false` on a truncated list would make an assistant report a partial
  inventory as complete.
- **When a list comes back exactly `limit` long, the response says explicitly that more records may
  exist and that the API offers no way to page to them.** Read that note as "this may not be
  everything". What to do about it depends on whether the same response was _also_ cut by the output
  budget, and the note says which: if it was not, raise `limit` (up to 1000) or narrow the query. If
  it was, **raising `limit` makes it worse** — the extra records are fetched and then dropped by the
  budget, and there is no pagination to recover them with. Pass a `fields` projection so each record
  is small enough that more of them fit, narrow the query, or raise `LUMICS_MAX_OUTPUT_CHARS`.
- **Four tools accept no `limit` at all**, because their endpoints document none. Each one carries
  its own disclosure saying the response is the entire set Lumics returned and that no parameter
  exists to ask for more or less:

  | Tool                                      | Endpoint with no limit                                   |
  | ----------------------------------------- | -------------------------------------------------------- |
  | `lumics_list_components`                  | `GET /:context/:contextId/component/:component/`         |
  | `lumics_list_component_types`             | `GET /:context/:contextId/componenttypes/`               |
  | `lumics_get_device_definition_components` | `GET /system/deviceDefinitions/components`               |
  | `lumics_get_metric_summary`               | `GET /:context/:contextId/metrics/summaries/:moduleType` |

  For those four, `fields` and a narrower request are the only levers on response size.

### Time windows on metric tools

The Lumics metric endpoints take the window as `fromMs`/`toMs` in **epoch milliseconds** (spec
§12.0). No tool here exposes those. Instead every metric tool accepts:

| Argument   | Type   | Required | Default               | Constraints                                                                                                          |
| ---------- | ------ | -------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `lookback` | string | Optional | `1h`                  | `<integer><unit>` with unit `m`, `h` or `d` — `15m`, `6h`, `7d`, `30d`. Must be > 0. Mutually exclusive with `from`. |
| `from`     | string | Optional | `to` minus `lookback` | ISO-8601 **with an explicit zone**, e.g. `2026-07-29T14:00:00Z`. Mutually exclusive with `lookback`.                 |
| `to`       | string | Optional | now                   | ISO-8601 with an explicit zone. Must not be in the future (24h skew tolerance).                                      |

`src/util/time.ts` converts these to `fromMs`/`toMs`. **Nobody — model or human — should ever
hand-compute epoch milliseconds.** The default window is the last hour, which matches the API's own
documented default.

#### A timestamp with a time must carry a timezone

Exactly three input forms are accepted, and nothing else:

| Form                                                 | Meaning                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `2026-07-29`                                         | UTC midnight — `2026-07-29T00:00:00Z`                                               |
| `2026-07-29T14:00:00Z` / `2026-07-29T14:00:00+02:00` | exactly what it says; `Z`, `z` or a numeric offset (`+02:00`, `-0700`)              |
| `1785333600000`                                      | epoch **milliseconds**, as a digits-only string (the same instant as the row above) |

Seconds and fractional seconds are optional in the second form; the zone is not.

**`2026-07-29T14:00:00` — a time with no zone — is rejected**, with an error naming the fix. It is
not guessed at. `Date.parse` reads that form in the _server's_ local timezone while reading a bare
date as UTC, so two adjacent input forms in the same argument land on two different clocks: under
`TZ=America/Los_Angeles` the naive form silently becomes `21:00Z`, the window moves seven hours, and
the response notes then report the _moved_ window. The wrong answer is internally consistent, which
is what makes it dangerous — nothing in the output looks wrong. The shape is checked here rather
than delegated for a second reason: `Date.parse` is also permitted to accept non-ISO input like
`July 29 2026 14:00` and `2026/07/29`.

The same rule and the same parser apply to `date` on
[`lumics_update_device_last_discovery`](#lumics_update_device_last_discovery), where the value is
_written_ to Lumics — a naive timestamp there would persist a discovery time shifted by the server's
offset.

If you do not need an exact window, `lookback` avoids the question entirely: `6h` and `7d` have no
timezone to get wrong.

The conversion also refuses input that is wrong in ways that would otherwise return plausible
nonsense:

- `from` together with `lookback` is rejected rather than silently resolved; they describe the same
  thing and guessing which was meant is how wrong data gets reported as right.
- A reversed or zero-width window is rejected.
- A window wider than **366 days** is rejected: with no pagination, a window that wide would be
  silently cut off by the result limit.
- A timestamp before 2000-01-01 is rejected as an epoch-seconds-instead-of-milliseconds mistake, not
  interpreted as 1970.
- A shape-valid but calendar-invalid instant such as `2026-02-31T00:00:00Z` is rejected.
- **`from` or `to` more than 24 hours in the future is rejected.** The check is symmetric on
  purpose. Unchecked, `from = now - 1h` with `to = now + 120d` was accepted: Lumics holds no data
  past now, so the result is one hour of samples, but the window note reported a four-month span and
  a model would describe an hour of data as four months of monitoring.

Note that `alignTimeRange`, and Lumics' own rollup selection, mean the window you get back is not
always the window you asked for. Every metric response reports the requested window **and** the
effective window Lumics says the data covers. Where they differ, the effective one is the truth.

### Metric resolution: `dataPoints`

Spec §12.0 makes `dataPoints` **or** `width` _required_ on all four metric-data endpoints, and
`width` wins when both are sent. A model has no way to know that, so this server always sends a
resolution: **`dataPoints` defaults to 60** (`DEFAULT_METRIC_DATA_POINTS` in `src/constants.ts`)
across the whole window. You can override it with any integer from 1 to 5000. When the default was
used, the response note says so.

`dataPoints` and `limit` are different parameters and easy to conflate: `dataPoints` is the _time
resolution_ of a series, `limit` is a cap on the _number of result rows_.

`lumics_get_metric_summary` accepts neither — its endpoint documents no resolution parameter at all.

### `lumics_get_metric_summary` ranks locally

The `metrics/summaries` endpoint's own vendor description advertises "top X lists of devices", and
it accepts **no `limit`, `top`, `sort` or `order` parameter of any kind** (spec §12.4). Lumics
always returns the entire matching set.

So `topN`, `sortBy` and `sortDirection` on this tool are applied **by this server, after fetching
everything**, and the output says so in as many words. It also reports how many items had no numeric
value at the `sortBy` path — those are listed last and unranked, so an `asc` "lowest N" cannot be
filled with items that were simply never measured. Lumics' own `count` is echoed too, so you can see
when the visible rows are fewer than the rows that were summarised.

Client-side ranking is the honest option here. The alternative — leaving a model to sort a large
JSON blob in its head — is how a "top 10" ends up containing an eleventh device nobody checked.

#### `topN` is per item class, not per response

Lumics keys its `data` by item class (spec §12.4 documents `devices`; a tenant can return others, such
as pools). Sorting and trimming happen **inside each class**, so `topN` is not a cap on the response:
with `topN: 2` over two item classes you can get up to **four** rows back, and the top item of one
class is not comparable with the top item of another because no ranking crosses a class boundary.

The response says so whenever more than one class is present, whether or not any class was long enough
to trim. For a single global top-N, pass `itemType` to reduce the response to one class.

### `companyId` defaults to `LUMICS_COMPANY_ID`

Almost every Lumics route is scoped to a company. Rather than making callers repeat the id, every
company-scoped tool takes `companyId` as an **optional** argument that defaults to the configured
`LUMICS_COMPANY_ID`. Omitting it is correct for almost every call.

**An explicit `companyId` that differs from `LUMICS_COMPANY_ID` is refused** with a `not_permitted`
error, unless the operator has set `LUMICS_ALLOW_CROSS_COMPANY`. A Lumics token issued to an MSP
user reaches every company that user administers, and `companyId` is an ordinary tool argument, so
without the gate a value picked up from anywhere at all would read or write a tenant nobody
configured — while the tool description said the call applied to the configured company. The flag is
an operator setting; nothing in a conversation can change it. When it _is_ on, every write tool's
description says so explicitly, so a client's approval prompt shows the human that a foreign
`companyId` will be honoured.

Five tools take no `companyId` **argument**, because their endpoints have no company segment:
`lumics_get_device_definition_components` (platform metadata), `lumics_get_device_metrics` and
`lumics_get_device_item_metrics` (addressed by device id), and `lumics_get_me` and
`lumics_revoke_tokens` (scoped to the token's own user).

**No argument does not mean no pin.** The two device-scoped metric tools are covered by it, and
enforce it with a **device-ownership read** instead: before any metric request, the device is fetched
inside `LUMICS_COMPANY_ID` (spec §7.2), and the metric read is issued only if that confirms the device
belongs there. A device in another company is refused with `not_permitted` and no metric request is
made; a 404 from the scoped read, or a device record carrying no `company` field, is also a refusal,
because an unverified owner is not a verified one. This costs **one extra round trip per call**. The
check is skipped when the operator has set `LUMICS_ALLOW_CROSS_COMPANY`, since there is then no pin to
enforce. `deviceId` is exactly the kind of value that arrives from a document or another tool's output,
and the metric path carries no company segment of its own to constrain it, so the absence of this gate
was the absence of the control rather than a narrower version of it.

Because that check needs a configured company, both metric tools are company-scoped for registration
purposes. **`LUMICS_COMPANY_ID` is optional, and without it you get two tools: `lumics_get_me` and
`lumics_get_device_definition_components`** (plus `lumics_revoke_tokens` if its flag is on). The
server starts, registers only the tools that need no company, and logs a warning. That is
deliberate: the documented way to discover a company id is `lumics_get_me`, and a server that
refused to start without the id could not run the tool that finds it. The bootstrap is therefore:
start with `LUMICS_TOKEN` alone → call **`lumics_get_me`**, which returns the user this server
authenticates as and the company that user belongs to → set `LUMICS_COMPANY_ID` to that value →
restart. `lumics_get_me` is also the cheapest way to check the configured token works at all.

A value that _is_ supplied is format-checked at startup and must be 24 hex characters, so a typo
fails immediately rather than as a 404 mid-conversation. A company-scoped tool called with no id
available at all fails with a message saying exactly this, though in practice you will not see it:
those tools are not registered in that state.

### `confirm` is not human-in-the-loop control

Admin and Destructive tools require `confirm: true`. **The model supplies that argument itself.** A
model that decides to delete something also decides to set `confirm: true`; nothing in that loop
involves a human, and nothing about it is a control. Do not let a reader — or a deployment review —
believe otherwise.

What `confirm` is actually worth: it makes intent explicit in the transcript, it gives a client's own
approval UI something concrete to prompt on, and it satisfies the constitutional requirement to
state impact at the point of action.

**The real gate is the environment.** `LUMICS_READ_ONLY` and the two `LUMICS_ENABLE_*` flags are set
by the human who deploys the server, out of band from the conversation, and no prompt can change
them — nor can a file, since the server reads no `.env` of its own
([SECURITY.md](../SECURITY.md#configuration-is-not-read-from-the-filesystem)). When a flag is absent
the tool is not registered, so there is no call for a model to attempt.
See [ADR-002](./adr/ADR-002-security-posture-and-capability-reductions.md), which says the same
thing at greater length.

### Deliberate omissions

Capability this server withholds from the documented vendor API. Each is a choice with a reason, not
a gap waiting to be filled.

| Withheld                                                             | Why                                                                                                                                                                                                                                                                                                                                          | Recorded in                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `componentQuery` and `filters` on the metric tools                   | They accept raw Mongo query expressions; handing a language model a database query language is a NoSQL injection and unbounded-query surface. The typed `itemType`, `isMonitored` and `properties` arguments cover the documented use cases.                                                                                                 | [D-0004](./DECISION_LOG.md); [ADR-002](./adr/ADR-002-security-posture-and-capability-reductions.md) decision 3              |
| `width` on the metric tools                                          | A pixel-width proxy for the same quantity as `dataPoints` that silently overrides it when both are sent — and a model has no graph. Two arguments meaning one thing, one winning invisibly, is a way to be wrong.                                                                                                                            | `src/tools/metrics.ts` module comment; RFC-001 D5                                                                           |
| `GET /me/token` and `POST /me/token` (spec §11.2, §11.3)             | Both mint a JWT and return it in the body. Returning that to a model puts live credential material into a conversation transcript — a credential leak by design, which no redaction layer fixes after the fact. `POST /me/token` additionally takes the user's password. Operators mint tokens themselves, out of band.                      | `src/tools/me.ts`; `standards/security-standard.md`; [ADR-002](./adr/ADR-002-security-posture-and-capability-reductions.md) |
| The `admingroups` and `system` `:context` values                     | v0.1 is `companies`-only. Supporting the others roughly doubles the test matrix, and the vendor never specifies what context id `system` takes, so it is documented-but-unspecified.                                                                                                                                                         | [D-0005](./DECISION_LOG.md)                                                                                                 |
| Component update narrowed to `name`                                  | Spec §6.3 documents no body field list at all (spec §14 defect 3); the only documented example sets `name`. A free-form object here would let a model rewrite `device` (re-parenting a component), `company` (moving it between tenants) or `__t` (making the document unreadable to Mongoose).                                              | `src/tools/components.ts`                                                                                                   |
| Device PATCH narrowed to nine fields                                 | Spec §7.5 enumerates no fields either. The exposed set is what §7.3 documents as writable plus the operational toggles every device example carries. `company` is excluded deliberately: writing it would move a device between tenants.                                                                                                     | `src/tools/devices.ts`                                                                                                      |
| Collector-owned and collector-observed fields on collectors and IPAM | `needsRestart` on a collector; `lastScan`, `scanProgress`, `addressCount`, `usedCount` and `ipamDiscoveryRule` on a subnet; `scanHistory` on an address. These are the collector's record of what it observed. A hand-written value is a fabricated observation, and every one of them is still **readable** through the get and list tools. | `src/tools/collectors.ts`, `src/tools/ipam.ts`                                                                              |
| `_id` on every create                                                | Letting a model choose a record's own primary key invites collisions with records it cannot see, and id spoofing. Lumics assigns one.                                                                                                                                                                                                        | `src/tools/collectors.ts`, `src/tools/ipam.ts`                                                                              |

Reversing the first of these requires a superseding ADR and an explicit opt-in flag; it is not an
implementation detail.

---

## Collectors — spec §5

The poller appliances that reach into a customer network and gather device data. Every device needs
one, so a collector id is usually the first thing to look up.

### `lumics_list_collectors`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/collectors` (spec §5.1)
- **Gating:** none

| Argument    | Type             | Required | Default             | Constraints          |
| ----------- | ---------------- | -------- | ------------------- | -------------------- |
| `companyId` | string           | Optional | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `limit`     | integer          | Optional | `100`               | 1–1000               |
| `fields`    | array of strings | Optional | all fields          | ≤ 50 names           |

**Returns** an array of collector objects: `name`, `description`, `location`, `ipAddress`,
`version`, `needsRestart` (a date when a restart is pending, or `false`), the collector `user`
account, `osConfig.ntpServers`, the audit fields, and `id`. The API cannot filter or sort this list,
so retrieve it and filter locally.

### `lumics_get_collector`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/collectors/:id` (spec §5.2)
- **Gating:** none

| Argument      | Type             | Required     | Default             | Constraints          |
| ------------- | ---------------- | ------------ | ------------------- | -------------------- |
| `collectorId` | string           | **Required** | —                   | 24-char hex ObjectId |
| `companyId`   | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `fields`      | array of strings | Optional     | all fields          | ≤ 50 names           |

**Returns** one collector object, same fields as the list. There is no lookup by name; get the id
from `lumics_list_collectors`.

### `lumics_create_collector`

- **Class:** Create
- **Endpoint:** `POST /companies/:companyId/collectors` (spec §5.3)
- **Gating:** none

| Argument      | Type   | Required     | Default             | Constraints                                                                          |
| ------------- | ------ | ------------ | ------------------- | ------------------------------------------------------------------------------------ |
| `name`        | string | **Required** | —                   | 1–255 characters                                                                     |
| `description` | string | Optional     | —                   | ≤ 1000 characters                                                                    |
| `location`    | string | Optional     | —                   | ≤ 255 characters                                                                     |
| `user`        | string | Optional     | Lumics creates one  | 24-char hex ObjectId of an existing Lumics user account                              |
| `ipAddress`   | string | Optional     | —                   | A single IPv4 or IPv6 address — not a hostname, CIDR block or range                  |
| `version`     | string | Optional     | —                   | ≤ 64 characters                                                                      |
| `osConfig`    | object | Optional     | —                   | Closed object; the only key is `ntpServers`, an array of ≤ 10 strings of 1–255 chars |
| `companyId`   | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; also sent as the required `company` body field                 |

**Returns** the created collector, including the `id` that `lumics_create_device` needs.

Two side effects worth stating to a user before calling: omitting `user` makes Lumics **create a new
collector user account automatically**, which changes the tenant's user list; and nothing stops a
second collector with the same name, so check the list first. This registers a record only — it does
not install, provision or connect any software.

### `lumics_update_collector`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/collectors/:id` (spec §5.4)
- **Gating:** none

| Argument      | Type   | Required     | Default             | Constraints                                                         |
| ------------- | ------ | ------------ | ------------------- | ------------------------------------------------------------------- |
| `collectorId` | string | **Required** | —                   | 24-char hex ObjectId                                                |
| `companyId`   | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                |
| `name`        | string | Optional     | unchanged           | 1–255 characters                                                    |
| `description` | string | Optional     | unchanged           | ≤ 1000 characters                                                   |
| `location`    | string | Optional     | unchanged           | ≤ 255 characters                                                    |
| `user`        | string | Optional     | unchanged           | 24-char hex ObjectId                                                |
| `ipAddress`   | string | Optional     | unchanged           | IPv4 or IPv6 address                                                |
| `version`     | string | Optional     | unchanged           | ≤ 64 characters                                                     |
| `osConfig`    | object | Optional     | unchanged           | As on create; **replaces** the whole object, including `ntpServers` |

**Returns** the complete updated collector. At least one changeable field must be supplied: a
no-field PATCH would return 200 and change nothing, which reads to a model as success, so it is
refused locally instead.

This tool cannot restart a collector, upgrade it, or clear a pending `needsRestart` — Lumics
documents no field write that does any of those.

### `lumics_delete_collector`

- **Class:** Destructive
- **Endpoint:** `DELETE /companies/:companyId/collectors/:id` (spec §5.5)
- **Gating:** requires `confirm: true`; not registered under `LUMICS_READ_ONLY=1`

| Argument      | Type           | Required     | Default             | Constraints            |
| ------------- | -------------- | ------------ | ------------------- | ---------------------- |
| `collectorId` | string         | **Required** | —                   | 24-char hex ObjectId   |
| `companyId`   | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId   |
| `confirm`     | literal `true` | **Required** | —                   | Must be exactly `true` |

**Returns** the record that was deleted, plus a note that any devices which referenced this
collector must now be reassigned or they stop being polled.

Lumics refuses to delete a collector while any device is still assigned to it and answers **409
Conflict** (spec §5.5, verbatim). Move those devices with `lumics_update_device` or delete them
first. There is no undo and no trash.

---

## Components — spec §6

Components are the sub-parts Lumics monitors inside devices: interfaces, TCP ports, fan sensors, F5
pools. Two things govern this whole group.

**The component type key cannot be guessed.** Spec §6.1 takes a free-form
`<module>_<group>_<type>` key such as `cisco_ast_devices`, and the vendor documents no enumeration
anywhere (spec §14 defect 14). A wrong key returns a 404 that is indistinguishable from "this type
has no members". `lumics_list_component_types` exists for exactly that lookup — call it first and
copy a value verbatim.

**Three of these five endpoints accept no `limit`.** See
[There is no pagination](#there-is-no-pagination); each affected tool carries its own completeness
note.

### `lumics_list_components`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/component/:component/` (spec §6.1 — singular
  `component`, trailing slash preserved)
- **Gating:** none

| Argument        | Type             | Required     | Default             | Constraints                                                       |
| --------------- | ---------------- | ------------ | ------------------- | ----------------------------------------------------------------- |
| `componentType` | string           | **Required** | —                   | 1–128 characters; the `id` of a `lumics_list_component_types` row |
| `companyId`     | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                              |
| `fields`        | array of strings | Optional     | all fields          | ≤ 50 names                                                        |

**No `limit` argument** — the endpoint has none.

**Returns** an array of component objects: `_id` (components use `_id`, not `id`), the parent
`device` id, `name`, `index`, `isMonitored`, `__t` naming the concrete type (e.g. `"pingtcp.Port"`),
`__v`, and type-specific fields. Scoped to the whole company, not to a device: filter locally on
`device` if you want one device's components. On a large tenant this is a big response — use `fields`.

### `lumics_get_component`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/component/:component/:id` (spec §6.2)
- **Gating:** none

| Argument        | Type             | Required     | Default             | Constraints                                               |
| --------------- | ---------------- | ------------ | ------------------- | --------------------------------------------------------- |
| `componentType` | string           | **Required** | —                   | 1–128 characters                                          |
| `componentId`   | string           | **Required** | —                   | 24-char hex ObjectId — the `_id` of a component, not `id` |
| `companyId`     | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                      |
| `fields`        | array of strings | Optional     | all fields          | ≤ 50 names                                                |

**Returns** one component object with its type-specific fields. Prefer this over
`lumics_list_components` whenever you have the id: the list form has no limit and returns every
component of the type in the company. A correct id under the wrong `componentType` returns 404.

### `lumics_update_component`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/component/:component/:id` (spec §6.3 — company-scoped
  only; there is no `:context` variant)
- **Gating:** none

| Argument        | Type   | Required     | Default             | Constraints                                                                           |
| --------------- | ------ | ------------ | ------------------- | ------------------------------------------------------------------------------------- |
| `componentType` | string | **Required** | —                   | 1–128 characters                                                                      |
| `componentId`   | string | **Required** | —                   | 24-char hex ObjectId                                                                  |
| `name`          | string | **Required** | —                   | 1–255 characters                                                                      |
| `companyId`     | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; sent as the `company` body field the documented example carries |

**Returns** the complete updated component, plus a note naming the id and stating that nothing else
changed.

**This tool renames a component and does nothing else.** It cannot move a component to another
device, change its type, or toggle monitoring — see
[Deliberate omissions](#deliberate-omissions) for why the write surface is one field. Components are
created by discovery, so renaming one changes its label in Lumics and does not touch the device.

### `lumics_list_component_types`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/componenttypes/` (spec §6.4 — the documented `component`
  path parameter does not exist in the template, spec §14 defect 2, and is not accepted)
- **Gating:** none

| Argument    | Type             | Required | Default             | Constraints          |
| ----------- | ---------------- | -------- | ------------------- | -------------------- |
| `companyId` | string           | Optional | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `fields`    | array of strings | Optional | all fields          | ≤ 50 names           |

**No `limit` argument** — the endpoint has none.

**Returns** an array of `{id, module, group, type}`, e.g.
`{"id":"cisco_ast_devices","module":"cisco","group":"ast","type":"devices"}`. Cheap and small.

This is the lookup tool for the rest of the group: `id` is what `componentType` and the metric
tools' `itemType` take, and `module` is what `moduleType` takes.

### `lumics_get_device_definition_components`

- **Class:** Read
- **Endpoint:** `GET /system/deviceDefinitions/components` (spec §6.5 — the one genuinely
  system-scoped route: a literal `system` segment, no context id, no documented parameters)
- **Gating:** none

| Argument | Type             | Required | Default    | Constraints |
| -------- | ---------------- | -------- | ---------- | ----------- |
| `fields` | array of strings | Optional | all fields | ≤ 50 names  |

**No `companyId` and no `limit`** — the endpoint takes neither.

**Returns** an array of platform-wide component definitions: `filePath` plus a `data` block with
`modelName`, `itemType`, `componentAlias`, `isDefaultMonitored`, `nameProperty`, the field `schema`
(which properties a component of that type carries, and their types) and `componentManagement`.

This is Lumics platform metadata, not tenant data: identical for every company, describing every
type the product supports rather than the types this tenant uses. It is large. If all you need is a
valid component type key for this tenant, call `lumics_list_component_types` instead.

---

## Devices — spec §7

Device **writes are `companies`-only** in the spec itself (§7.3–§7.7). Reads additionally document
`admingroups` and `system`, but v0.1 is `companies`-only throughout ([D-0005](./DECISION_LOG.md)).

### `lumics_list_devices`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/devices` (spec §7.1)
- **Gating:** none

| Argument    | Type             | Required | Default                      | Constraints                                         |
| ----------- | ---------------- | -------- | ---------------------------- | --------------------------------------------------- |
| `companyId` | string           | Optional | `LUMICS_COMPANY_ID`          | 24-char hex ObjectId                                |
| `limit`     | integer          | Optional | `100`                        | 1–1000                                              |
| `fields`    | array of strings | Optional | **a seven-field projection** | ≤ 50 names. Pass `[]` for whole records — see below |

**Returns** an array of devices. A device carries `name`, `ipAddress`, `deviceType`, the assigned
`collector`, `enabled`, `maintenanceMode`, `priority`, `location`, `description`, `model`,
`version`, `customProperties` and the full `modules` map of polling configuration. The API cannot
filter or sort, so retrieve and filter locally.

**This is the one tool with a default `fields` projection.** With `fields` omitted, each device is
reduced to `id`, `name`, `ipAddress`, `deviceType`, `collector`, `enabled`, `maintenanceMode`
(`DEFAULT_DEVICE_LIST_FIELDS` in `src/constants.ts`), and the response says so.

The reason is arithmetic. A full device record is around 1.9 kB — most of it the `modules` map,
three nested module objects one of which holds an array of snapshot items — so the default
`limit` of 100 comes to roughly 190 kB against a 25,000-character budget. Without the projection the
budget, not the limit, decided how many devices a default call returned: thirteen of the hundred
requested, with the completeness note and the truncation note giving opposite advice about whether
to raise or lower `limit`. Projected, a device is about 200 bytes and a hundred of them fit.

The projection removes **fields, not devices** — nothing is filtered out of the list itself. To
override it:

| You pass                          | You get                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| nothing                           | the seven default fields                                       |
| `fields: ["id","name","modules"]` | exactly those names                                            |
| `fields: []`                      | whole records, every field — expect the budget to shed devices |

For one device in full, `lumics_get_device` is the better tool.

### `lumics_get_device`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/devices/:id` (spec §7.2 — the vendor's parameter list
  omits `:id` even though the template contains it, spec §14 defect 1)
- **Gating:** none

| Argument    | Type             | Required     | Default             | Constraints          |
| ----------- | ---------------- | ------------ | ------------------- | -------------------- |
| `deviceId`  | string           | **Required** | —                   | 24-char hex ObjectId |
| `companyId` | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `fields`    | array of strings | Optional     | all fields          | ≤ 50 names           |

**Returns** one device including its complete `modules` map — per-module polling configuration (SNMP
credential and version, ping intervals, configuration-snapshot items) and each module's
`lastDiscovery`. Note that a module's **key** in that map is not always its `module` value: the key
`deviceConfigs` carries module `snapshots`.

### `lumics_create_device`

- **Class:** Create
- **Endpoint:** `POST /companies/:companyId/devices` (spec §7.3)
- **Gating:** none

| Argument     | Type   | Required     | Default             | Constraints                                                                                               |
| ------------ | ------ | ------------ | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `name`       | string | **Required** | —                   | 1–255 characters; usually the hostname                                                                    |
| `ipAddress`  | string | **Required** | —                   | A single IPv4 or IPv6 address Lumics will poll                                                            |
| `collector`  | string | **Required** | —                   | 24-char hex ObjectId of an existing collector that can reach the device                                   |
| `deviceType` | string | **Required** | —                   | Non-empty string. No enumeration is documented; `default` suits most hosts, `switch` is used for switches |
| `companyId`  | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; also sent as the required `company` body field                                      |

**Returns** the created device. Lumics populates the rest itself: `priority` 0, `enabled` true,
`maintenanceMode` false, and a ping module enabled as primary. It does **not** configure SNMP — that
is a separate change in the Lumics UI. Creating the same device twice returns 409 Conflict.

### `lumics_update_device_last_discovery`

- **Class:** Update
- **Endpoint:** `PUT /companies/:companyId/devices/:id/modules/:module/lastDiscovery` (spec §7.4)
- **Gating:** none

| Argument    | Type   | Required     | Default             | Constraints                                                                                                                                              |
| ----------- | ------ | ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceId`  | string | **Required** | —                   | 24-char hex ObjectId                                                                                                                                     |
| `module`    | string | **Required** | —                   | Non-empty. The module **key** in the device's `modules` map — e.g. `snmp`, `ping`, `deviceConfigs` — which is not always the module's own `module` value |
| `date`      | string | **Required** | —                   | ISO-8601 timestamp **with an explicit zone**, e.g. `2026-07-29T14:14:41.000Z`. Validated locally and normalised to UTC ISO-8601 before sending           |
| `companyId` | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                                                                                                     |

`date` goes through the same parser as the metric window arguments, so the same rule applies: a
timestamp with a time but no zone is **rejected**, a bare `2026-07-29` means UTC midnight, and `Z`
or a numeric offset is required otherwise. See
[A timestamp with a time must carry a timezone](#a-timestamp-with-a-time-must-carry-a-timezone).
The rule matters more here than on a read, because this value is _written_ to Lumics: a naive
timestamp would persist a discovery time shifted by the server's own timezone offset, and nothing
downstream would know.

**Returns** the complete updated device (Lumics answers `{updated: {...full device...}}`).

This writes a bookkeeping field a collector normally maintains for itself. **It does not run a
discovery.** To find out when a module last discovered, read the device with `lumics_get_device`
instead.

### `lumics_update_device`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/devices/:id` (spec §7.5 — the documented body field is
  `device` but the example is flat and "must include the device ID", spec §14 defect 5; the example
  is authoritative and the handler adds `id` itself)
- **Gating:** none

| Argument          | Type    | Required     | Default             | Constraints                                       |
| ----------------- | ------- | ------------ | ------------------- | ------------------------------------------------- |
| `deviceId`        | string  | **Required** | —                   | 24-char hex ObjectId                              |
| `companyId`       | string  | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                              |
| `name`            | string  | Optional     | unchanged           | 1–255 characters                                  |
| `ipAddress`       | string  | Optional     | unchanged           | IPv4 or IPv6 address                              |
| `collector`       | string  | Optional     | unchanged           | 24-char hex ObjectId                              |
| `deviceType`      | string  | Optional     | unchanged           | Non-empty string                                  |
| `description`     | string  | Optional     | unchanged           | ≤ 1000 characters                                 |
| `location`        | string  | Optional     | unchanged           | ≤ 255 characters                                  |
| `enabled`         | boolean | Optional     | unchanged           | `false` stops polling without deleting the device |
| `maintenanceMode` | boolean | Optional     | unchanged           | `true` suppresses alerting during planned work    |
| `priority`        | integer | Optional     | unchanged           | 0–10                                              |

**Returns** the complete updated device. At least one changeable field is required; a no-field PATCH
is refused locally rather than returning a 200 that changed nothing.

The write surface is nine fields on purpose — see [Deliberate omissions](#deliberate-omissions).
Notably `company` is not writable, because writing it would move a device between tenants.

### `lumics_batch_update_devices`

- **Class:** Admin
- **Endpoint:** `PATCH /companies/:companyId/devices/:ids/batch` (spec §7.6; `:ids` is a
  comma-delimited list, each id encoded individually)
- **Gating:** **`LUMICS_ENABLE_BATCH_UPDATE`** must be set, **and** `confirm: true`. Not registered
  under `LUMICS_READ_ONLY=1`. Absent the flag the tool does not exist in `tools/list`.

| Argument                                                 | Type             | Required     | Default             | Constraints                                                                                  |
| -------------------------------------------------------- | ---------------- | ------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `deviceIds`                                              | array of strings | **Required** | —                   | 1–200 ids, each a 24-char hex ObjectId. Every change below is applied to every device listed |
| `confirm`                                                | literal `true`   | **Required** | —                   | Must be exactly `true`                                                                       |
| `companyId`                                              | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                                         |
| _the same nine mutable fields as `lumics_update_device`_ |                  | Optional     | unchanged           | At least one must be supplied                                                                |

**Returns** the full updated record for each device (Lumics answers `{updated: [ … ]}` — an array,
unlike the single PATCH), plus a note stating how many field changes were applied to how many
devices and how many records came back. **If that count is lower than the number of ids you sent,
some ids did not match a device in this company** — nothing else tells you that.

**Why this is Admin rather than Update, and gated.** One call rewrites arbitrary fields across N
devices and spec §7.6 documents no cap on N. That blast radius earns the `destructiveHint`
annotation, the `confirm` argument and the environment flag. There is no dry run and no undo. The
200-id cap is this server's, not the API's. Prefer `lumics_update_device` for one device.

### `lumics_delete_device`

- **Class:** Destructive
- **Endpoint:** `DELETE /companies/:companyId/devices/:id` (spec §7.7)
- **Gating:** requires `confirm: true`; not registered under `LUMICS_READ_ONLY=1`

| Argument    | Type           | Required     | Default             | Constraints            |
| ----------- | -------------- | ------------ | ------------------- | ---------------------- |
| `deviceId`  | string         | **Required** | —                   | 24-char hex ObjectId   |
| `companyId` | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId   |
| `confirm`   | literal `true` | **Required** | —                   | Must be exactly `true` |

**Returns** the record that was deleted, plus a note that it is gone permanently.

This removes the device and its monitoring configuration. There is no undo and no trash. If the
device is only temporarily out of service, call `lumics_update_device` with `enabled: false` instead
— that stops polling and keeps the record and its history.

---

## IPAM subnets — spec §10

Documented before addresses and groups because every address tool needs a subnet id. Every IPAM
route is `companies`-scoped in the spec itself, with no `:context` variant to reason about.

### `lumics_list_ipsubnets`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipsubnets` (spec §10.1)
- **Gating:** none

| Argument    | Type             | Required | Default             | Constraints                                                       |
| ----------- | ---------------- | -------- | ------------------- | ----------------------------------------------------------------- |
| `parent`    | string           | Optional | no filter           | 24-char hex ObjectId of a containing IP group. Server-side filter |
| `companyId` | string           | Optional | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                              |
| `limit`     | integer          | Optional | `100`               | 1–1000                                                            |
| `fields`    | array of strings | Optional | all fields          | ≤ 50 names                                                        |

**Returns** an array of subnets with `network`, `netmask`, `cidr`, `description`, `vlan`, `vrf`, the
`collector` and `component` they are tied to, `parent`, and the scan state `lastScan`,
`scanProgress`, `addressCount`, `usedCount`. `parent` is the only filter the API offers — it cannot
filter by network, VLAN or utilisation.

### `lumics_get_ipsubnet`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipsubnets/:id` (spec §10.2)
- **Gating:** none

| Argument     | Type             | Required     | Default             | Constraints          |
| ------------ | ---------------- | ------------ | ------------------- | -------------------- |
| `ipSubnetId` | string           | **Required** | —                   | 24-char hex ObjectId |
| `companyId`  | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `fields`     | array of strings | Optional     | all fields          | ≤ 50 names           |

**Returns** one subnet, including its full scan state and custom property assignments. This is the
subnet definition only — for the addresses recorded inside the range, call
`lumics_list_ipaddresses` with this id.

### `lumics_create_ipsubnet`

- **Class:** Create
- **Endpoint:** `POST /companies/:companyId/ipsubnets` (spec §10.3)
- **Gating:** none

| Argument                   | Type            | Required     | Default             | Constraints                                                                                                                                                                   |
| -------------------------- | --------------- | ------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                  | string          | **Required** | —                   | The subnet's base address, e.g. `172.27.16.0` — not a host inside the range                                                                                                   |
| `netmask`                  | string          | **Required** | —                   | Dotted-quad IPv4 netmask, e.g. `255.255.255.0`                                                                                                                                |
| `cidr`                     | integer         | **Required** | —                   | 0–32. Must agree with `netmask`; Lumics derives neither from the other                                                                                                        |
| `description`              | string          | Optional     | —                   | ≤ 1000 characters                                                                                                                                                             |
| `vlan`                     | string          | Optional     | —                   | ≤ 255 characters, free text, e.g. `vlan120`                                                                                                                                   |
| `vrf`                      | string          | Optional     | —                   | ≤ 255 characters, free text                                                                                                                                                   |
| `component`                | string          | Optional     | —                   | 24-char hex ObjectId of the SNMP-discovered network component this subnet corresponds to                                                                                      |
| `collector`                | string          | Optional     | none — record only  | 24-char hex ObjectId of the collector that will scan the range; it must be able to reach it                                                                                   |
| `excludeFromScheduledScan` | boolean         | Optional     | —                   | `true` keeps the collector from scanning it during a scheduled scan                                                                                                           |
| `scanNetworkAndBroadcast`  | boolean         | Optional     | —                   | `true` includes the network and broadcast addresses when scanning; Lumics skips them by default                                                                               |
| `parent`                   | string or null  | Optional     | —                   | 24-char hex ObjectId of the containing group, or `null` for top level                                                                                                         |
| `customProperties`         | array of object | Optional     | —                   | ≤ 100 entries of `{customProperty: <24-char hex id>, value: <any>}`. Replaces the whole array. The definitions must already exist; the API documents no endpoint to list them |
| `companyId`                | string          | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; also sent as the required `company` body field                                                                                                          |

**Returns** the created subnet plus a note quoting its id, which the address tools need.

`cidr` is bounded to 0–32 because the same endpoint requires a dotted-quad IPv4 `netmask`, so a
subnet expressible through this API is IPv4. **Nothing is scanned by this call.** The API does not
reject an overlapping or duplicate subnet, so check the list first — a second definition of the same
range is easy to create and confusing to find later.

### `lumics_update_ipsubnet`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/ipsubnets/:id` (spec §10.4. The vendor's body table
  repeats POST's `required` markers, but the documented example sends only `{netmask, cidr}` — spec
  §14 defect 6. The example is authoritative, so every field is optional here.)
- **Gating:** none

| Argument                                                                             | Type   | Required     | Default             | Constraints                   |
| ------------------------------------------------------------------------------------ | ------ | ------------ | ------------------- | ----------------------------- |
| `ipSubnetId`                                                                         | string | **Required** | —                   | 24-char hex ObjectId          |
| `companyId`                                                                          | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId          |
| `network`, `netmask`, `cidr`, and every optional field from `lumics_create_ipsubnet` |        | Optional     | unchanged           | Same constraints as on create |

**Returns** the complete updated subnet. At least one changeable field is required.

Changing `network`, `netmask` or `cidr` redefines which addresses the subnet covers, and **the
address records already stored under it are not re-homed** — re-check them afterwards with
`lumics_list_ipaddresses`.

### `lumics_delete_ipsubnet`

- **Class:** Destructive
- **Endpoint:** `DELETE /companies/:companyId/ipsubnets/:id` (spec §10.5)
- **Gating:** requires `confirm: true`; not registered under `LUMICS_READ_ONLY=1`

| Argument     | Type           | Required     | Default             | Constraints            |
| ------------ | -------------- | ------------ | ------------------- | ---------------------- |
| `ipSubnetId` | string         | **Required** | —                   | 24-char hex ObjectId   |
| `companyId`  | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId   |
| `confirm`    | literal `true` | **Required** | —                   | Must be exactly `true` |

**Returns** the subnet record that was deleted, plus a note that the addresses it held are no longer
reachable.

This is not a small act. Every IP address route in this API is nested under a subnet id, so once the
subnet is gone the address inventory kept under it — names, DNS names, MAC addresses, NAT mappings,
notes and scan history — is unreachable. **Lumics documents no cascade behaviour either way and no
restore**, so this server cannot tell you whether those records were deleted or orphaned. Call
`lumics_list_ipaddresses` first and report how many records the subnet holds. To stop scanning
without losing anything, use `excludeFromScheduledScan` instead.

---

## IPAM addresses — spec §8

> **The path asymmetry is real.** The two reads use the **singular** segment `/ipsubnet/`; POST,
> PATCH and DELETE use the **plural** `/ipsubnets/`. Spec §13 Q1 confirms this from the vendor's own
> generated route slugs, so it exists in the route definitions rather than only in prose. This
> server sends each spelling as documented, per verb.

### `lumics_list_ipaddresses`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipsubnet/:ipSubnet/ipaddresses` (spec §8.1 — **singular**)
- **Gating:** none

| Argument     | Type             | Required     | Default             | Constraints          |
| ------------ | ---------------- | ------------ | ------------------- | -------------------- |
| `ipSubnetId` | string           | **Required** | —                   | 24-char hex ObjectId |
| `companyId`  | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `limit`      | integer          | Optional     | `100`               | 1–1000               |
| `fields`     | array of strings | Optional     | all fields          | ≤ 50 names           |

There is no `parent` filter here, unlike subnets and groups, and **no company-wide address list
exists in this API** — you must have a subnet id.

**Returns** an array of address records with `ipAddress`, `name`, `dnsName`, `macAddress`, `nat`,
`description`, `note`, `state` (`used` or `reserved`) and `scanHistory` (`firstUp`, `lastScan`,
`lastStatus`, and the run of `statusChanges`).

One caveat worth passing on to a user: only addresses Lumics has a record for appear here. **An
address absent from this list is not proven unused, only unrecorded.**

### `lumics_get_ipaddress`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipsubnet/:ipSubnet/ipaddresses/:id` (spec §8.2 —
  **singular**)
- **Gating:** none

| Argument      | Type             | Required     | Default             | Constraints                                                  |
| ------------- | ---------------- | ------------ | ------------------- | ------------------------------------------------------------ |
| `ipSubnetId`  | string           | **Required** | —                   | 24-char hex ObjectId                                         |
| `ipAddressId` | string           | **Required** | —                   | 24-char hex ObjectId — the record id, not the address itself |
| `companyId`   | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                         |
| `fields`      | array of strings | Optional     | all fields          | ≤ 50 names                                                   |

**Returns** one address record including its full `scanHistory` — useful for reading the complete
status-change history behind an intermittent host.

### `lumics_create_ipaddress`

- **Class:** Create
- **Endpoint:** `POST /companies/:companyId/ipsubnets/:ipSubnet/ipaddresses` (spec §8.3 — **plural**)
- **Gating:** none

| Argument      | Type   | Required     | Default             | Constraints                                                                   |
| ------------- | ------ | ------------ | ------------------- | ----------------------------------------------------------------------------- |
| `ipSubnetId`  | string | **Required** | —                   | 24-char hex ObjectId; also sent as the required `ipSubnet` body field         |
| `ipAddress`   | string | **Required** | —                   | A single IPv4 or IPv6 address that falls inside the named subnet              |
| `name`        | string | Optional     | —                   | ≤ 255 characters — a person's name for the address, as opposed to DNS         |
| `dnsName`     | string | Optional     | —                   | ≤ 255 characters, e.g. `host1.example.com`                                    |
| `macAddress`  | string | Optional     | —                   | MAC in colon or hyphen form, e.g. `00:1a:2b:3c:4d:5e`                         |
| `nat`         | string | Optional     | —                   | A single IPv4 or IPv6 address — typically the public address this one NATs to |
| `description` | string | Optional     | —                   | ≤ 1000 characters                                                             |
| `note`        | string | Optional     | —                   | ≤ 2000 characters                                                             |
| `state`       | enum   | Optional     | nothing sent        | `used` or `reserved`. No API default is documented — see the note below       |
| `companyId`   | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; also sent as the required `company` body field          |

**Returns** the created record plus a note quoting its id.

The address must fall inside the subnet you name; Lumics does not move it for you and there is no
company-wide address route to fix it from afterwards. **No default for `state` is documented** — the
vendor's §8.3 example came back `reserved` when none was sent, so set it explicitly if it matters.
Creating the same address twice in one subnet is not documented as rejected, so check the list first.
A bare address with no name or description is a record nobody can interpret later; supply at least
one.

### `lumics_update_ipaddress`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/ipsubnets/:ipSubnet/ipaddresses/:id` (spec §8.4 —
  **plural**)
- **Gating:** none

| Argument                                                               | Type   | Required     | Default             | Constraints                                                                                                   |
| ---------------------------------------------------------------------- | ------ | ------------ | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ipSubnetId`                                                           | string | **Required** | —                   | 24-char hex ObjectId                                                                                          |
| `ipAddressId`                                                          | string | **Required** | —                   | 24-char hex ObjectId                                                                                          |
| `companyId`                                                            | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                                                          |
| `ipAddress`                                                            | string | Optional     | unchanged           | Corrected address. It must still fall inside the same subnet — this tool cannot move a record between subnets |
| `name`, `dnsName`, `macAddress`, `nat`, `description`, `note`, `state` |        | Optional     | unchanged           | Same constraints as on create                                                                                 |

**Returns** the complete updated record. At least one changeable field is required.

`ipSubnet` is deliberately not changeable: moving a record between subnets by PATCH is not documented
as supported, and getting it wrong strands the record under a subnet whose range does not contain it.
Prefer this over delete when an address is being released but its history is worth keeping — set
`state` to `reserved` and say why in `note`.

### `lumics_delete_ipaddress`

- **Class:** Destructive
- **Endpoint:** `DELETE /companies/:companyId/ipsubnets/:ipSubnet/ipaddresses/:id` (spec §8.5 —
  **plural**)
- **Gating:** requires `confirm: true`; not registered under `LUMICS_READ_ONLY=1`

| Argument      | Type           | Required     | Default             | Constraints            |
| ------------- | -------------- | ------------ | ------------------- | ---------------------- |
| `ipSubnetId`  | string         | **Required** | —                   | 24-char hex ObjectId   |
| `ipAddressId` | string         | **Required** | —                   | 24-char hex ObjectId   |
| `companyId`   | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId   |
| `confirm`     | literal `true` | **Required** | —                   | Must be exactly `true` |

**Returns** the record that was deleted, plus a note that its scan history went with it.

Everything recorded about the address goes: name, DNS name, MAC, NAT mapping, description, note, and
`scanHistory` — first time seen up, last scan, every status change since. **That history is an
observational record and cannot be reconstructed by re-scanning.** If the address is simply being
released, use `lumics_update_ipaddress` with `state: "reserved"` instead. Delete only when the record
itself is wrong, for example an address entered into the wrong subnet.

---

## IPAM groups — spec §9

Containers that organise the IPAM tree. Groups hold no addresses themselves; the addresses live in
subnets.

### `lumics_list_ipgroups`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipgroups` (spec §9.1)
- **Gating:** none

| Argument    | Type             | Required | Default             | Constraints                              |
| ----------- | ---------------- | -------- | ------------------- | ---------------------------------------- |
| `parent`    | string           | Optional | no filter           | 24-char hex ObjectId; server-side filter |
| `companyId` | string           | Optional | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                     |
| `limit`     | integer          | Optional | `100`               | 1–1000                                   |
| `fields`    | array of strings | Optional | all fields          | ≤ 50 names                               |

**Returns** an array of groups with `name`, `description`, `type` (`group` or `supernet`), `parent`
and `id`. Walk the hierarchy by calling this with `parent` set to a group id, and pair it with
`lumics_list_ipsubnets` using the same `parent` to see the subnets at that level.

### `lumics_get_ipgroup`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/ipgroups/:id` (spec §9.2)
- **Gating:** none

| Argument    | Type             | Required     | Default             | Constraints          |
| ----------- | ---------------- | ------------ | ------------------- | -------------------- |
| `ipGroupId` | string           | **Required** | —                   | 24-char hex ObjectId |
| `companyId` | string           | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId |
| `fields`    | array of strings | Optional     | all fields          | ≤ 50 names           |

**Returns** the group record only, not its contents. This endpoint returns the identifier as `_id`
while the list returns `id` (spec §4.2, §14 defect 12); both mean the same thing. To see what the
group holds, call `lumics_list_ipgroups` and `lumics_list_ipsubnets` with `parent` set to this id.

### `lumics_create_ipgroup`

- **Class:** Create
- **Endpoint:** `POST /companies/:companyId/ipgroups` (spec §9.3)
- **Gating:** none

| Argument      | Type           | Required     | Default             | Constraints                                                                                                                 |
| ------------- | -------------- | ------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string         | **Required** | —                   | 1–255 characters, e.g. `Branch sites`                                                                                       |
| `description` | string         | Optional     | —                   | ≤ 1000 characters                                                                                                           |
| `type`        | enum           | Optional     | none sent           | `group` (plain container) or `supernet` (aggregating supernet). No default is documented, so nothing is sent unless you ask |
| `parent`      | string or null | Optional     | —                   | 24-char hex ObjectId of the containing group, or `null` for top level                                                       |
| `companyId`   | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId; also sent as the required `company` body field                                                        |

Spec §14 defect 8: the vendor's body table describes `name` as "The description of the group" — a
copy-paste of the `description` row. `name` is the group's name.

**Returns** the created group plus a note quoting its id. Creating a group moves nothing into it —
assign subnets afterwards with `lumics_update_ipsubnet`, setting `parent` to that id.

### `lumics_update_ipgroup`

- **Class:** Update
- **Endpoint:** `PATCH /companies/:companyId/ipgroups/:id` (spec §9.4)
- **Gating:** none

| Argument      | Type           | Required     | Default             | Constraints                                     |
| ------------- | -------------- | ------------ | ------------------- | ----------------------------------------------- |
| `ipGroupId`   | string         | **Required** | —                   | 24-char hex ObjectId                            |
| `companyId`   | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                            |
| `name`        | string         | Optional     | unchanged           | 1–255 characters                                |
| `description` | string         | Optional     | unchanged           | ≤ 1000 characters                               |
| `type`        | enum           | Optional     | unchanged           | `group` or `supernet`                           |
| `parent`      | string or null | Optional     | unchanged           | Group id, or `null` to move it to the top level |

The documented example body carries `id` and `company` alongside the changed fields, so both are
sent; `company` is the company already in the path and cannot move the group between tenants.

**Returns** the complete updated group. At least one changeable field is required.

**Re-parenting moves the group and everything under it**, so check what that is first with
`lumics_list_ipgroups` and `lumics_list_ipsubnets` filtered by this group id.

### `lumics_delete_ipgroup`

- **Class:** Destructive
- **Endpoint:** `DELETE /companies/:companyId/ipgroups/:id` (spec §9.5)
- **Gating:** requires `confirm: true`; not registered under `LUMICS_READ_ONLY=1`

| Argument    | Type           | Required     | Default             | Constraints            |
| ----------- | -------------- | ------------ | ------------------- | ---------------------- |
| `ipGroupId` | string         | **Required** | —                   | 24-char hex ObjectId   |
| `companyId` | string         | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId   |
| `confirm`   | literal `true` | **Required** | —                   | Must be exactly `true` |

No request body is sent. Spec §14 defect 10: the vendor shows an example body (`{id, company}`) for
this DELETE while documenting no body fields at all; the path already carries both ids, and inventing
a body on the strength of an example is how a 400 becomes a mystery.

**Returns** the group record that was deleted, plus a note stating the unknown below.

**Lumics does not document what happens to the subnets and child groups whose `parent` this group
is.** They may be orphaned or removed with it, and this server cannot tell you which. So list the
contents first, tell the user exactly what is inside, and prefer to re-parent those records with
`lumics_update_ipsubnet` and `lumics_update_ipgroup` — then delete an empty group, where the outcome
is not in doubt. Deleting a group does not delete IP address records directly; only subnets hold
those.

---

## Identity — spec §11

Two of the four endpoints in spec §11 are exposed. `GET /me/token` and `POST /me/token` are withheld
deliberately and must not be added — see [Deliberate omissions](#deliberate-omissions).

### `lumics_get_me`

- **Class:** Read
- **Endpoint:** `GET /me` (spec §11.1)
- **Gating:** none

| Argument | Type             | Required | Default    | Constraints |
| -------- | ---------------- | -------- | ---------- | ----------- |
| `fields` | array of strings | Optional | all fields | ≤ 50 names  |

**Returns** the Lumics user this server authenticates as and the company that user belongs to — the
company id, name, IANA timezone and active flag.

**This is how you discover your company id.** It is also the cheapest way to check that the
configured credential works at all. Takes no other arguments and changes nothing.

### `lumics_revoke_tokens`

- **Class:** Admin
- **Endpoint:** `POST /me/token/revoke` (spec §11.4)
- **Gating:** **`LUMICS_ENABLE_TOKEN_REVOCATION`** must be set, **and** `confirm: true`. Not
  registered under `LUMICS_READ_ONLY=1`. Absent the flag the tool does not exist in `tools/list`.

| Argument  | Type           | Required     | Default | Constraints            |
| --------- | -------------- | ------------ | ------- | ---------------------- |
| `confirm` | literal `true` | **Required** | —       | Must be exactly `true` |

No other arguments and no body. **Returns** `{message: "all tokens revoked"}` plus a note stating
what has just broken.

Read this before enabling the flag. **The Lumics API has no per-token revoke.** This revokes _every_
JWT ever issued to the user account, which includes:

- **The token this server is using.** The moment it succeeds, this server can no longer talk to
  Lumics, and every subsequent tool call fails with an authentication error until a human mints a new
  token and restarts it.
- **Every other integration, script, dashboard or browser session** authenticating as the same
  account — broken immediately, without warning.

There is no undo, and because Lumics offers no endpoint that lists outstanding tokens, **there is no
way to find out what will be destroyed before destroying it.** That combination — irreversible,
self-defeating, account-wide and invisible beforehand — is why it is gated twice and off by default
rather than merely annotated `destructiveHint`.

---

## Metrics — spec §12

Five tools, one per endpoint in spec §12 — note that §12.3 documents two. Read
[Time windows](#time-windows-on-metric-tools), [Metric resolution](#metric-resolution-datapoints) and
[`lumics_get_metric_summary` ranks locally](#lumics_get_metric_summary-ranks-locally) before using
any of them; those three behaviours apply across the group and are not repeated per tool.

All five are **Read**, so all five are available under `LUMICS_READ_ONLY=1`. Two of them —
`lumics_get_device_metrics` and `lumics_get_device_item_metrics` — additionally require
`LUMICS_COMPANY_ID`, because that is what they check a device's ownership against.

### The shared metric argument set

Four of the five tools take this set (spec §12.0). Per-tool tables below name only their own path
arguments and any deviation.

| Argument         | Type    | Required | Default                | Constraints and notes                                                                                                                                       |
| ---------------- | ------- | -------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookback`       | string  | Optional | `1h`                   | `<integer><unit>`, unit `m`/`h`/`d`. Mutually exclusive with `from`. Span > 0 and ≤ 366 days                                                                |
| `from`           | string  | Optional | `to` minus `lookback`  | ISO-8601. Mutually exclusive with `lookback`                                                                                                                |
| `to`             | string  | Optional | now                    | ISO-8601                                                                                                                                                    |
| `dataPoints`     | integer | Optional | **`60`** (always sent) | 1–5000. Number of points across the window. The API requires this or `width`; `width` is not exposed                                                        |
| `interval`       | enum    | Optional | Lumics chooses         | `minute`, `fiveMin`, `hour`, `day`. Overrides the rollup granularity. Leave unset unless you have a reason                                                  |
| `minIntervals`   | integer | Optional | 40 (Lumics' default)   | 1–10000. How many intervals must fall in the window for a rollup collection to be eligible. Lower it if a short window returns nothing                      |
| `aggregate`      | boolean | Optional | —                      | On-the-fly aggregation, so points are rollups matching the requested resolution rather than raw samples                                                     |
| `alignTimeRange` | boolean | Optional | —                      | Snap the window to hour/day/month boundaries. Lumics then returns data for the **snapped** window; the response notes state the effective one               |
| `properties`     | string  | Optional | all properties         | Comma-separated metric property paths, e.g. `status` or `aggr-space-attributes.size-used`. **The single most effective way to keep a response small**       |
| `lastMetric`     | boolean | Optional | —                      | Return only the most recent matching metric. Use this for "what is the current status" — far cheaper than fetching a series                                 |
| `isMonitored`    | boolean | Optional | —                      | Restrict to components Lumics actively monitors, which filters out empty results                                                                            |
| `limit`          | integer | Optional | **none sent**          | 1–1000. A cap on result **rows**, not resolution. Unlike the list tools this has **no default**: nothing is sent unless you ask for it. See below           |
| `itemType`       | string  | Optional | all types              | Component type to restrict to, e.g. `snmp_f5_f5pools`; or the literal `device` for device-level metrics. Discover values with `lumics_list_component_types` |
| `fields`         | array   | Optional | all fields             | ≤ 50 top-level names                                                                                                                                        |

Not exposed on any metric tool: `componentQuery`, `filters` and `width`. See
[Deliberate omissions](#deliberate-omissions).

#### `limit` has no default on a metric tool

`limit` is optional upstream on these endpoints, and this server **sends nothing unless the caller
supplies a value** — deliberately unlike the list tools, which default to 100.

The reason is what a metric row is. A metric result carries one row per component per time bucket,
so a 24-hour window at the default resolution across 40 components is roughly 2,400 rows; a cap of
100 would return four per cent of them. Lumics documents no ordering for those rows, so the cap can
cut across **time** as well as across components, and what comes back is a series with holes in it.
An incomplete inventory looks incomplete. A series with holes looks like data — like real gaps in
the monitoring — and there is no offset, page or cursor to recover the missing rows with, nor any
escape by asking for more, since the maximum is 1,000.

So the output budget does the shaping instead. It sheds rows from the **end** of the order Lumics
returned and reports how many, which makes the loss positional and disclosed: what you have is the
head of the series, covering part of the requested window, rather than an unknown scatter.

The row-count note on every metric response states which of the two happened:

- **No `limit` sent** — the note says no cap was sent, Lumics returned every matching row, and that
  any shortening came from this server's output budget, which drops from the end and says so in a
  separate truncation note. It tells the reader the series is missing its **tail**, not scattered
  points.
- **A `limit` you supplied** — the note names the number, says Lumics applied it, and warns that the
  cap can cut across time as well as components, that the visible series may have holes that look
  like real gaps, that a component may appear for only part of the window, and that the omitted rows
  cannot be fetched. It then points at the tools that shrink a response without mutilating it:
  narrow `properties` or `itemType`, use a shorter window, or set `lastMetric: true` — and drop the
  limit.

If you are reaching for `limit` to make a response smaller, it is almost always the wrong lever.

**Every metric response also carries notes** stating the requested window, the resolution actually
sent and whether it was this server's default, and — from Lumics' own envelope metadata — the
effective window, the bucket size, the aggregation mode used (`standard`, `minMaxAvg`, `summed`) and
how many components were aggregated. Where the effective window differs from the requested one, the
effective one describes the data.

### `lumics_get_company_metrics`

- **Class:** Read
- **Endpoint:** `GET /metrics/companies/:companyId/modules/:moduleType` (spec §12.1)
- **Gating:** none

| Argument                         | Type   | Required     | Default             | Constraints                                                                                                                                              |
| -------------------------------- | ------ | ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleType`                     | string | **Required** | —                   | Polling module name, e.g. `snmp`, `ping`, `netapp`. No fixed list is documented; discover from a device's `modules` map or `lumics_list_component_types` |
| `companyId`                      | string | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                                                                                                     |
| _the shared metric argument set_ |        | Optional     | see above           | `sum` is **not** accepted here                                                                                                                           |

**Returns** the `data` array from the metric envelope: one row per item per time bucket, each with
`_id`, `item`, `type`, `timeMs` and a `stats` map (type bucket → property → value, with `status`
sub-objects carrying `{status, text}`).

Use it for "what does X look like across the estate". Two settings decide between a usable answer and
a wall of numbers: narrow `properties`, and set `lastMetric: true` when you want current values
rather than a series. For a total or average across components instead of a row per component, use
`lumics_summarize_company_metrics`; for one device, `lumics_get_device_metrics`.

### `lumics_summarize_company_metrics`

- **Class:** Read
- **Endpoint:** `GET /metrics/companies/:companyId/modules/:moduleType/summarize` (spec §12.2)
- **Gating:** none

| Argument                         | Type   | Required     | Default                   | Constraints                                                                                                                                                                                                |
| -------------------------------- | ------ | ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleType`                     | string | **Required** | —                         | Polling module name                                                                                                                                                                                        |
| `companyId`                      | string | Optional     | `LUMICS_COMPANY_ID`       | 24-char hex ObjectId                                                                                                                                                                                       |
| `sum`                            | enum   | Optional     | average across components | `min`, `max` or `avg`. **A property NAME, not a boolean.** Its presence switches the cross-component reduction from average to sum; its value picks the per-component rollup property that feeds the total |
| _the shared metric argument set_ |        | Optional     | see above                 | —                                                                                                                                                                                                          |

**Returns** the `data` array: one row per **time bucket** rather than per component, each with an
integer bucket `_id`, `type`, `timeMs`, `count` and `countAggDocs` describing the bucket, and `stats`.
A note always states whether the values are averages or sums, and which rollup property fed a sum.

Two things to carry into any answer built on this: **buckets with no data are omitted entirely rather
than returned as zero**, so do not read a gap as a zero; and if a short window returns nothing,
lower `minIntervals` — that is how the vendor's own example gets buckets out of a ten-hour range.

### `lumics_get_device_metrics`

- **Class:** Read
- **Endpoint:** `GET /metrics/devices/:id/modules/:moduleType` (spec §12.3)
- **Gating:** requires `LUMICS_COMPANY_ID` — see below

| Argument                         | Type   | Required     | Default   | Constraints                                      |
| -------------------------------- | ------ | ------------ | --------- | ------------------------------------------------ |
| `deviceId`                       | string | **Required** | —         | 24-char hex ObjectId; from `lumics_list_devices` |
| `moduleType`                     | string | **Required** | —         | Polling module name                              |
| _the shared metric argument set_ |        | Optional     | see above | `sum` is **not** accepted here                   |

**No `companyId`** — this path has no company segment, so the device id addresses the request on its
own. The company pin still applies: this server reads the device inside `LUMICS_COMPANY_ID` first and
refuses the call if the device belongs elsewhere, which costs one extra request and means the tool is
**not registered when `LUMICS_COMPANY_ID` is unset**. See
[`companyId` defaults](#companyid-defaults-to-lumics_company_id).

**Returns** the same envelope shape as §12.1: a row per component per bucket. This is the tool for
"how is this device doing" — every fan, interface, pool or volume the named module polls on it. Pair
`lastMetric: true` with a narrow `properties` list for a current-status readout, or leave `lastMetric`
unset for a series. For one specific component, or the device's own device-level metrics, use
`lumics_get_device_item_metrics`.

### `lumics_get_device_item_metrics`

- **Class:** Read
- **Endpoint:** `GET /metrics/devices/:id/modules/:moduleType/:item` (spec §12.3)
- **Gating:** requires `LUMICS_COMPANY_ID` — see below

| Argument                         | Type   | Required     | Default   | Constraints                                                                                                                                                 |
| -------------------------------- | ------ | ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceId`                       | string | **Required** | —         | 24-char hex ObjectId of the device that owns the item                                                                                                       |
| `moduleType`                     | string | **Required** | —         | Polling module name                                                                                                                                         |
| `itemId`                         | string | **Required** | —         | 24-char hex ObjectId. **Pass the device's own id for device-level metrics** (CPU, memory, uptime), or a component id for one interface, fan, pool or volume |
| _the shared metric argument set_ |        | Optional     | see above | Neither `sum` nor `itemType` is accepted — the item is already identified                                                                                   |

**No `companyId`**, and the same device-ownership check as `lumics_get_device_metrics`: the device is
read inside `LUMICS_COMPANY_ID` before any metric request, one extra round trip, and the tool is not
registered when `LUMICS_COMPANY_ID` is unset.

**Returns** the `data` array of time buckets, typically carrying `min`, `max` and `avg` per property
plus `parentId` and `parentName` for the owning device (envelope `type: "minMaxAvg"`).

This is the narrowest and cheapest metric read, and the right one for charting a single series or
checking one thing.

### `lumics_get_metric_summary`

- **Class:** Read
- **Endpoint:** `GET /companies/:companyId/metrics/summaries/:moduleType` (spec §12.4)
- **Gating:** none

| Argument        | Type    | Required     | Default             | Constraints                                                                                                                                                                                                |
| --------------- | ------- | ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moduleType`    | string  | **Required** | —                   | Polling module name                                                                                                                                                                                        |
| `companyId`     | string  | Optional     | `LUMICS_COMPANY_ID` | 24-char hex ObjectId                                                                                                                                                                                       |
| `itemType`      | string  | Optional     | all types           | `device` for device-level summaries, or a component type for component-level ones                                                                                                                          |
| `properties`    | string  | Optional     | all properties      | Comma-separated metric property paths                                                                                                                                                                      |
| `lookback`      | string  | Optional     | `1h`                | As in the shared set                                                                                                                                                                                       |
| `from`, `to`    | string  | Optional     | see shared set      | ISO-8601 with an explicit zone, as in the shared set                                                                                                                                                       |
| `sortBy`        | string  | Optional     | no sort             | 1–200 characters. Dot-separated path to the numeric value to rank by, resolved against the item and then inside its `stats` — e.g. `Calculated.cpu.avg`. **Applied by this server**                        |
| `sortDirection` | enum    | Optional     | `desc`              | `desc` (largest first) or `asc`. **Applied by this server**                                                                                                                                                |
| `topN`          | integer | Optional     | keep everything     | 1–1000. A client-side trim of a full response, not a server-side limit — and applied [**per item class**](#topn-is-per-item-class-not-per-response), so with two classes you can get up to `2 × topN` rows |
| `fields`        | array   | Optional     | all fields          | ≤ 50 names                                                                                                                                                                                                 |

**This endpoint has a much smaller parameter surface than the rest of the group.** Only `itemType`,
`properties`, `fromMs` and `toMs` are documented (spec §12.4), so **no `dataPoints`, `width`,
`interval`, `minIntervals`, `aggregate`, `alignTimeRange`, `isMonitored`, `lastMetric`, `sum` — and no
`limit`** are offered. Offering a parameter the endpoint ignores would teach a false model of the API
and produce answers a caller believes were filtered when they were not.

**Returns** one row per item with its averaged and peak values over the window — `_id`, `name`,
`parents` and a `stats` map (the documented example carries `avg` and `max`, no `min` and no `sum`).
Lumics keys `data` by item class, and only `devices` is documented. When exactly one class comes back
the tool returns that array directly, with a note naming the class; when there is more than one it
returns the vendor's keyed object, because flattening would lose which class each item belongs to. In
that multi-class case the `fields` projection is applied **per class**, and the output budget sheds
items per class as well — a single cap across all of them, so no class is emptied while another keeps
a hundred rows — with a note giving the cap and the number dropped.

Notes on every response state that the endpoint accepts no limit or pagination of any kind, that what
follows is therefore the full matching set, that `topN`/`sortBy` were applied locally afterwards, how
many items had no numeric value at the `sortBy` path, and Lumics' own `count` so you can see when
fewer rows are visible than were summarised. Narrowing `itemType`, `properties` or the window is the
only way to make the response smaller.
