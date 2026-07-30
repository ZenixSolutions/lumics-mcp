# lumics-mcp

[![CI](https://github.com/ZenixSolutions/lumics-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ZenixSolutions/lumics-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zenixsolutions/lumics-mcp)](https://www.npmjs.com/package/@zenixsolutions/lumics-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A Model Context Protocol (MCP) server that lets an AI assistant read and operate the Lumics network monitoring platform.

> **Not affiliated with Lumics or NetCuras.** This is an independent, community-maintained
> open-source project. It is not affiliated with, sponsored by, endorsed by, or supported by
> Lumics or NetCuras. No claim is made to their trademarks or other marks; "Lumics" and
> "NetCuras" are used here only to identify the platform this software talks to. For support
> with the Lumics platform itself, contact Lumics. For support with this server, open an issue
> here.

---

## Contents

- [What it does](#what-it-does)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration](#configuration)
- [Security](#security)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Tool reference](#tool-reference)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

The server exposes the documented Lumics REST API v1.0 surface as MCP tools, so an assistant can
answer questions about your monitored estate and — when you allow it — change it. Tools cover
these resource areas:

- **Devices** — list, read, create, update, delete; update a module's last-discovery time; bulk
  update (gated, off by default).
- **Collectors** — list, read, create, update, delete.
- **Components and component types** — list and read components of a given type, update a
  component, enumerate component types and device definitions.
- **IPAM subnets** — list, read, create, update, delete.
- **IPAM addresses** — list and read addresses within a subnet, create, update, delete.
- **IPAM groups** — list, read, create, update, delete, including parent/child grouping.
- **Metrics** — per-component metrics for a company or a device, single-item metrics, summarized
  (averaged or summed) metrics, and cross-device metric summaries.
- **Identity** — read the current user and company; revoke tokens (gated, off by default).

The underlying contract is captured verbatim in [`docs/reference/lumics-api-v1.md`](./docs/reference/lumics-api-v1.md),
which ships with the repository so you can audit what the code targets and see when the vendor
API drifts from it.

---

## Prerequisites

You need two things before installing:

1. **A Lumics account** with access to the data you want the assistant to see. The server acts as
   your user; it cannot see anything you cannot see.
2. **A JWT API token.** Lumics issues JWT bearer tokens only — there is no OAuth.

You also want **your company id**, a 24-character hex value — but you do not need it in hand
before you start, because the server will help you find it. See
[First run: finding your company id](#first-run-finding-your-company-id).

### Minting a token

The simplest route is to log into the Lumics web UI and visit `/api/v1/me/token`. You can also
POST your credentials:

```bash
curl -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'username=you@example.com&password=YOUR_PASSWORD' \
  'https://app.lumics.io/api/v1/me/token?expiresIn=86400'
```

Replace `you@example.com` and `YOUR_PASSWORD` with your own credentials. The response is
`{ "token": "...", "expiresIn": 86400 }`.

`expiresIn` is in seconds and defaults to `86400` (one day). The Lumics API accepts larger values
and **documents no maximum**, so it is entirely possible to mint a token that effectively never
expires. Do not. Use the shortest lifetime that is workable and rotate. See [Security](#security).

### First run: finding your company id

`LUMICS_COMPANY_ID` is **optional**. Without it the server still starts, so you can use it to
discover the id:

1. Configure the server with `LUMICS_TOKEN` only, leaving `LUMICS_COMPANY_ID` unset, and connect it
   from your client.
2. Ask the assistant to call **`lumics_get_me`**. It returns the user this token authenticates as
   and the company that user belongs to. The company id is the 24-character hex string.
3. Set `LUMICS_COMPANY_ID` to that value and **restart the server** (and your client, if it caches
   the tool list).

Until the variable is set, only the tools that need no company are registered — `lumics_get_me` and
`lumics_get_device_definition_components`, which is **two** tools (three, if you have enabled
`lumics_revoke_tokens`). Everything else is company-scoped and is withheld from `tools/list` rather
than left to fail on every call, so a partly-configured server looks small rather than broken. The
server logs a warning on stderr saying exactly this.

`lumics_get_device_metrics` and `lumics_get_device_item_metrics` are in that withheld set even
though their Lumics paths carry no company segment: they enforce the company pin by reading the
device inside `LUMICS_COMPANY_ID` first, so without a configured company there is nothing for them
to check against. See [Cross-company access is off by default](#cross-company-access-is-off-by-default).

If you already know the id you can skip all of that and set it up front; the examples below do. A
value that is supplied is validated at startup and must be 24 hex characters, so a typo fails
immediately instead of turning into a 404 mid-conversation.

You can also read the id out of the Lumics web UI URL after `/companies/`.

---

## Install

Node.js 20 or newer is required. Every command below runs the published package with `npx`, so
there is nothing to clone or build.

### Claude Code

```bash
claude mcp add lumics \
  --env LUMICS_TOKEN=your-jwt-token \
  --env LUMICS_COMPANY_ID=your-company-id \
  --env LUMICS_READ_ONLY=1 \
  -- npx -y @zenixsolutions/lumics-mcp
```

Two details matter here:

- The bare `--` separates `claude mcp add`'s own flags from the command it should run. Without
  it, `npx` and its arguments are parsed as flags to `claude` and the command fails.
- By default the server is registered for the current project only. Add `-s user` to make it
  available in every project:

```bash
claude mcp add lumics -s user \
  --env LUMICS_TOKEN=your-jwt-token \
  --env LUMICS_COMPANY_ID=your-company-id \
  --env LUMICS_READ_ONLY=1 \
  -- npx -y @zenixsolutions/lumics-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` — Settings → Developer → Edit Config will open it, or find it at
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. Add:

```json
{
  "mcpServers": {
    "lumics": {
      "command": "npx",
      "args": ["-y", "@zenixsolutions/lumics-mcp"],
      "env": {
        "LUMICS_TOKEN": "your-jwt-token",
        "LUMICS_COMPANY_ID": "your-company-id",
        "LUMICS_READ_ONLY": "1"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. Note that this file stores your token in plaintext; treat it
as a credential file.

### VS Code

Add to `.vscode/mcp.json` in your workspace, or to your user `settings.json` under `"mcp"`:

```json
{
  "servers": {
    "lumics": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@zenixsolutions/lumics-mcp"],
      "env": {
        "LUMICS_TOKEN": "your-jwt-token",
        "LUMICS_COMPANY_ID": "your-company-id",
        "LUMICS_READ_ONLY": "1"
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` inside a project:

```json
{
  "mcpServers": {
    "lumics": {
      "command": "npx",
      "args": ["-y", "@zenixsolutions/lumics-mcp"],
      "env": {
        "LUMICS_TOKEN": "your-jwt-token",
        "LUMICS_COMPANY_ID": "your-company-id",
        "LUMICS_READ_ONLY": "1"
      }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.lumics]
command = "npx"
args = ["-y", "@zenixsolutions/lumics-mcp"]

[mcp_servers.lumics.env]
LUMICS_TOKEN = "your-jwt-token"
LUMICS_COMPANY_ID = "your-company-id"
LUMICS_READ_ONLY = "1"
```

### ChatGPT and Grok — not yet supported in v0.1

**Do not expect these to work today.** This is a capability gap in those clients, not an
oversight here, and no packaging trick works around it:

- ChatGPT developer-mode connectors and Grok custom connectors both connect to MCP servers over a
  **publicly reachable HTTPS URL**. Neither client can launch or talk to a local process over
  stdio, which is the only transport v0.1 ships.
- Grok additionally **rejects `localhost` and private/internal addresses** outright, so tunnelling
  to a machine on your own network is not a workaround either.
- The `mcp-remote` bridge does not help. It is itself a local process; it does not make your
  server reachable from ChatGPT's or Grok's servers.

Support for both arrives with the **v0.2 self-hosted HTTP deployment**, where you run the server
behind your own TLS-terminated HTTPS endpoint and point the client at your own URL. That
deployment is not released yet. Until it is, this section describes work that has not been done.

### Client support matrix

| Client         | v0.1 (stdio via `npx`) | Notes                                        |
| -------------- | ---------------------- | -------------------------------------------- |
| Claude Code    | Supported              | `claude mcp add`, `-s user` for all projects |
| Claude Desktop | Supported              | `claude_desktop_config.json`                 |
| VS Code        | Supported              | `.vscode/mcp.json`                           |
| Cursor         | Supported              | `.cursor/mcp.json`                           |
| Codex          | Supported              | `~/.codex/config.toml`                       |
| ChatGPT        | Not supported          | Needs public HTTPS endpoint — planned v0.2   |
| Grok           | Not supported          | Needs public HTTPS endpoint — planned v0.2   |
| Claude.ai web  | Not supported          | Needs public HTTPS endpoint — planned v0.2   |

---

## Configuration

All configuration is by environment variable. The canonical, commented list is
[`.env.example`](./.env.example); this table mirrors it.

| Variable                         | Required                                       | Default                                        | Description                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LUMICS_TOKEN`                   | Yes                                            | —                                              | Lumics API token (JWT bearer). Sent as `Authorization: Bearer <token>`.                                                                                                                                                                               |
| `LUMICS_COMPANY_ID`              | No                                             | unset                                          | Your Lumics company id (24-character hex), used as the `companies` context id. Unset, the server starts with only the tools that need no company and logs a warning — see [First run](#first-run-finding-your-company-id). Validated when supplied.   |
| `LUMICS_BASE_URL`                | No                                             | `https://app.lumics.io/api/v1`                 | API base URL. Override only for a self-hosted or non-production Lumics. **Must use `https:`**, except for a loopback host (`127.0.0.1`, `localhost`, `[::1]`) — the token is a bearer credential sent on every request. Refused at startup otherwise. |
| `LUMICS_TIMEOUT_MS`              | No                                             | `30000`                                        | Per-request timeout in milliseconds.                                                                                                                                                                                                                  |
| `LUMICS_MAX_OUTPUT_CHARS`        | No                                             | `25000`                                        | Maximum characters of tool output — disclosure notes and JSON payload together, not the payload alone. Truncation is always disclosed in the response.                                                                                                |
| `LUMICS_LOG_LEVEL`               | No                                             | `info`                                         | Diagnostic verbosity on stderr: `debug`, `info`, `warn`, `error`, `silent`. `debug` adds a per-call record with duration, output size and truncation counts; `silent` quiets stderr entirely. Never touches stdout, which is the protocol channel.    |
| `LUMICS_READ_ONLY`               | No                                             | unset (off)                                    | Set to `1` to register **only** read tools. No create, update, delete, or admin tool is exposed to the model. Recommended.                                                                                                                            |
| `LUMICS_ALLOW_CROSS_COMPANY`     | No                                             | unset (off)                                    | Set to `1` to let a tool call name a `companyId` other than `LUMICS_COMPANY_ID`. Off, such a call is refused with `not_permitted`. Read [Security](#security) first.                                                                                  |
| `LUMICS_ENABLE_BATCH_UPDATE`     | No                                             | unset (off)                                    | Set to `1` to expose bulk device update. One call can rewrite arbitrary fields on many devices.                                                                                                                                                       |
| `LUMICS_ENABLE_TOKEN_REVOCATION` | No                                             | unset (off)                                    | Set to `1` to expose token revocation. Revokes **every** token on your account. Read [Security](#security) first.                                                                                                                                     |
| `LUMICS_TRANSPORT`               | No                                             | `stdio`                                        | `stdio` is the only value 0.1.0 accepts. **`http` is refused at startup** and arrives in v0.2 — see [The HTTP transport is not in 0.1.0](#the-http-transport-is-not-in-010).                                                                          |
| `LUMICS_HTTP_PORT`               | No _(v0.2 only)_                               | `3000`                                         | HTTP listener port. Inert in 0.1.0; documented for forward reference.                                                                                                                                                                                 |
| `LUMICS_HTTP_HOST`               | No _(v0.2 only)_                               | `127.0.0.1`                                    | HTTP bind address. Loopback by default. Change only behind TLS and authentication. Inert in 0.1.0.                                                                                                                                                    |
| `LUMICS_HTTP_AUTH_TOKEN`         | Yes when `LUMICS_TRANSPORT=http` _(v0.2 only)_ | —                                              | Shared secret clients must present as `Authorization: Bearer <value>`. Minimum 32 characters, enforced at startup. Generate with `openssl rand -hex 32`. Inert in 0.1.0.                                                                              |
| `LUMICS_HTTP_ALLOWED_HOSTS`      | No _(v0.2 only)_                               | `127.0.0.1,localhost,[::1]` plus the bind host | Comma-separated `Host` allowlist for DNS-rebinding protection. Setting it replaces the default list, so repeat every loopback spelling you use — including `[::1]` — and the bind host. Inert in 0.1.0.                                               |
| `LUMICS_HTTP_ALLOWED_ORIGINS`    | No _(v0.2 only)_                               | empty (no origin allowed)                      | Comma-separated `Origin` allowlist for CORS. Inert in 0.1.0.                                                                                                                                                                                          |
| `LUMICS_CONTRACT_TESTS`          | No                                             | unset (off)                                    | Maintainers only. Set to `1` to run tests that make real, read-only calls against a live tenant.                                                                                                                                                      |

The five `LUMICS_HTTP_*` variables are listed because they are validated at startup when you ask for
the HTTP transport — but 0.1.0 then refuses the transport itself, so setting any of them changes
nothing about how this release runs. They are documented so a v0.2 deployment can be prepared and
reviewed before it exists.

### The server does not read a `.env` file

Configuration comes from the environment the process is given, and from nowhere else. **Nothing here
discovers a `.env`.** An earlier build did, using a relative path, which for a published server meant
whichever directory the MCP client happened to launch it from — so a file planted there could
redirect `LUMICS_BASE_URL` and send the token elsewhere, or reopen every safety gate the operator had
left closed. See [Security](#security).

Two supported ways to use a `.env`, both of which are the operator choosing a file rather than the
server finding one:

- **Your MCP client's `env` block.** Every install above already does this; nothing extra is needed.
- **Node's own flag**, for local development:

  ```bash
  cp .env.example .env      # then edit it
  node --env-file=.env dist/index.js
  ```

  `--env-file=.env` requires the file to exist; `--env-file-if-exists=.env` tolerates its absence.

`.env` is gitignored and must never be committed.

---

## Security

Read this section before you give an assistant a write-capable token.

### Start read-only

```
LUMICS_READ_ONLY=1
```

This is the recommended default posture, and it is a registration-time control rather than a
runtime check: with it set, create, update, delete, and admin tools are never advertised to the
model at all. A model cannot misuse a tool it cannot see. Turn it off only when you specifically
intend the assistant to modify your Lumics data, and prefer running two separately configured
server entries — one read-only for everyday use, one write-capable for deliberate change work —
over leaving writes permanently enabled.

### Two operations are gated off by default

Both stay unavailable unless you opt in with an environment variable. A model cannot enable them.

- **`LUMICS_ENABLE_BATCH_UPDATE`** — bulk device update. A single call applies the same field
  changes to a comma-separated list of device ids. The Lumics API documents no cap on how many.
  The blast radius of one malformed call is your whole device inventory.
- **`LUMICS_ENABLE_TOKEN_REVOCATION`** — token revocation. **The Lumics API has no per-token
  revoke.** `POST /me/token/revoke` revokes _every_ JWT ever issued to your user, including the
  token this server is currently using, and including tokens used by any other integration,
  script, or session you own. It is self-inflicted denial of service plus collateral damage, it
  cannot be undone, and everything affected must be re-issued by hand. The tool also requires an
  explicit confirmation argument, but treat that as a speed bump: an agent can supply it. The
  environment variable is the real gate.

### Cross-company access is off by default

**Every tool is covered by the company pin.** Most take an optional `companyId` argument, and by
default a value that differs from `LUMICS_COMPANY_ID` is refused with a `not_permitted` error. A
Lumics token issued to an MSP user reaches every company that user administers, so without this gate
a model that had picked up another tenant's id — from a conversation, a document, a previous answer —
could read or write there, while the tool description said the call applied to the configured
company.

Two tools have no `companyId` argument to check, because their Lumics paths carry no company segment:
`lumics_get_device_metrics` and `lumics_get_device_item_metrics` are addressed by device id alone.
They enforce the same pin a different way — **a device-ownership read first**: the device is fetched
inside `LUMICS_COMPANY_ID`, and the metric read happens only if that confirms the device belongs
there. A device in another tenant is refused with `not_permitted` and no metric request is made. That
costs one extra round trip per call, which is the price of a control with no exception in it. Both
tools are therefore company-scoped, and are withheld entirely when `LUMICS_COMPANY_ID` is unset.

Set `LUMICS_ALLOW_CROSS_COMPANY=1` only if you deliberately operate several tenants through one
server, and understand that it widens the blast radius of every write from one company to every
company the token can reach. It is an operator setting; nothing in a conversation can turn it on.
See [SECURITY.md](./SECURITY.md#cross-company-access).

### Token handling

- Mint tokens with the shortest workable `expiresIn`. The default is one day; the API documents no
  maximum, so nothing stops you creating a token that outlives its usefulness by years.
- Rotate regularly, and rotate immediately if a token has been pasted anywhere it might persist —
  chat transcripts, shell history, CI logs, an issue comment.
- Client configuration files (`claude_desktop_config.json`, `.cursor/mcp.json`, `~/.codex/config.toml`)
  store tokens in plaintext. Protect them like private keys.
- The server redacts credential material at the error boundary, so tokens do not appear in tool
  output or diagnostics. That is verified by test, not assumed.
- Never commit `.env`. Secret scanning runs in CI.

### Reporting a vulnerability

See [SECURITY.md](./SECURITY.md). Do not open a public issue for a security problem.

---

## Limitations

These are real constraints of the current release and the underlying API. They are listed here
rather than buried because knowing them changes how you should read the server's answers.

### The Lumics API has no pagination

This is the most important limitation. Across all 41 documented endpoints the only result-control
parameter is `limit`. There is no `offset`, `page`, `skip`, `cursor`, `after`, `sort`, or `order`,
list responses are bare JSON arrays with no total count, and no response carries a next-page link.

Consequences:

- **Large result sets can be truncated with no way to fetch the rest.** If you have more devices
  than the effective limit, you cannot page through them. Narrowing the query is the only option.
- The server therefore emits **no** `offset`, `has_more`, or `next_offset` fields. Inventing them
  would be lying: a `has_more: false` on a truncated list would make an agent report a partial
  inventory as complete.
- When a result count reaches the requested limit, the server says explicitly that results may be
  truncated and that the API provides no pagination mechanism. Read that disclosure as "this may
  not be everything."
- Some list endpoints (`component`, `componenttypes`, `deviceDefinitions/components`, and
  `metrics/summaries`) do not document even a `limit`.

### Metric tools require a `properties` argument, and a wrong one is not an error

`properties` is **required** on `lumics_get_company_metrics`, `lumics_summarize_company_metrics`,
`lumics_get_device_metrics` and `lumics_get_device_item_metrics`. The vendor documentation calls it
optional and is wrong: without it the API answers
`400 "Must supply required component metrics as properties parameter"`, so those four tools cannot
make a single successful call. It is required rather than defaulted because no metric name is
correct for every module — a default would answer a question nobody asked. It stays optional on
`lumics_get_metric_summary`, where it means something different (see below).

**The syntax is `<TypeGroup>.<metric>`, comma-separated, no spaces** — `Calculated.cpu`, or
`Calculated.cpu,Calculated.mem`. Type groups seen on live tenants are `Calculated`, `Rate` and
`TimeTicks`; there is no `Counter` or `Gauge` group despite those being plausible SNMP type names.
Property names are **tenant-specific**, so treat the examples as shapes rather than as a vocabulary.

**To find legal names, call `lumics_get_metric_summary` with no `properties`** and read
`data.<class>[].stats`: the outer keys are type groups and the inner keys are metric names, so
joining them with a dot gives a value the other four tools accept. Two limits on that, both real:

- it enumerates **device-scoped** names only, so a component-level name — an interface counter, say —
  is discoverable from **no endpoint at all** and has to come from the Lumics UI or from someone who
  already knows it;
- its response key depends on the module (`devices` for `snmp`, `http_endpoints` for `http`), so read
  whichever key is present rather than assuming `devices`.

On `lumics_get_metric_summary` itself, `properties` **filters rather than projects**: supplying it
drops items that do not carry the property instead of narrowing the items that do, and it has been
observed emptying a response that was otherwise full. Leave it unset there unless you have a reason.

**A name the API does not recognise is not rejected.** It returns HTTP 200 with the full row count
and empty `stats` on every row, which reads exactly like "this metric has no data". This server
rejects the worst form of it locally — a value in which no entry carries a `Group.` prefix — and
detects the rest after the fact, disclosing in the response that the names may be wrong rather than
letting an empty answer stand. See
[A metric call returned rows but no values](#a-metric-call-returned-rows-but-no-values).

One more thing about component selection: `itemType` takes the **singular** component id
(`snmp_common_cpu`), which is **not** what `lumics_list_component_types` returns — that endpoint
returns plural aliases and most of them are rejected with `400 Unknown component`. Build the id from
`lumics_get_device_definition_components` instead, or copy the `type` field off a row a metric call
already returned. Lumics validates `itemType` **before** `properties`, so a wrong `itemType` hides a
`properties` problem entirely: fix `itemType` first.

### The company-scoped metric endpoint is unreliable; prefer the device-scoped tools

`lumics_get_company_metrics` and `lumics_summarize_company_metrics` read
`/api/v1/metrics/companies/...`, and that route did not answer dependably when it was measured
against a production tenant on 2026-07-30 (spec §12.5 M12, §14 defect 25). What was observed:

- **`lumics_get_company_metrics` returned HTTP 500 on ordinary queries** that carried a valid
  `properties` value — `{"error":"Sorry, an error occurred. Please try again.","code":500}`. It
  failed with `lastMetric`, `isMonitored`, `minIntervals` and `limit`, and with `interval=minute` and
  `interval=fiveMin`. It **succeeded** with `interval=hour`, `interval=day`, `aggregate` and
  `alignTimeRange`, and a minimal query returned 200 earlier the same day.
- **`lumics_summarize_company_metrics` never returned at all** — over 90 seconds, with and without
  `itemType` narrowing. That is the same finding as the slowness below, seen from the other side.
- **The device-scoped tools worked throughout**, returning populated data in one to two seconds.
- Browsing the vendor's own web application, a **company dashboard load issued 57 API calls,
  including its "Top devices by CPU" and "Top devices by memory" widgets, and never once called
  `/api/v1/metrics/companies/`.** The vendor's own product does not use this endpoint for
  company-wide metrics.

**This is intermittent and query-dependent, not a dead endpoint, and no cause has been established.**
It is a correlation measured on one tenant on one day. Both tools are still registered and still
work for some queries — the decision was to document this, not to withhold the capability.

What to do with it:

- **Prefer the device-scoped route for anything estate-wide.** List the devices you care about with
  `lumics_list_devices`, then call `lumics_get_device_metrics` per device, or
  `lumics_get_device_item_metrics` for one component. More calls, and it is the path that answered.
- If you do use the company-scoped tools, **drop the parameters above** and prefer `interval=hour` or
  `interval=day`.
- **A 500 or a timeout there is not an absence of data.** The tool descriptions say so, and a 500 from
  these two endpoints carries endpoint-specific guidance rather than the generic "this is not a
  problem with your arguments" — because on this route the arguments do correlate with the failure.
- The server does **not** retry a 500 here. It never has (500 is not in its retryable status set), and
  the error now says so instead of implying a retry already happened.

### `lumics_summarize_company_metrics` is slow, and a timeout is not an empty result

`metrics/.../summarize` aggregates every matching component in the company before it answers. It has
been measured taking **over 90 seconds without returning**, where the other metric endpoints answer
the same module and window in one to two seconds. Nothing in the vendor documentation mentions this.

This server gives that one endpoint a **three-minute deadline of its own** rather than the shared
`LUMICS_TIMEOUT_MS`, and attempts it exactly **once** — three attempts at three minutes is nine
minutes of silence, which from a client is indistinguishable from a hung server, and a retry cannot
help an endpoint that is slow because of how much work it is doing. On a large tenant it can still
time out. **A timeout there is a timeout, not evidence that there is no data**, and the error says
so. Narrow it with `itemType`, a tighter `properties` or a shorter window, or use
`lumics_get_company_metrics`, which reads the same module without the cross-component aggregation.

Everything the vendor documents about this endpoint's response — its envelope, the `sum` semantics,
the bucket shape — is **unverified against live behaviour**, because it never returned during the
contract run.

### Metric endpoints require a resolution parameter

All four metric-data endpoints require either `dataPoints` or `width` (`width` wins if both are
set). The server supplies a sensible default so calls do not fail on a parameter a model has no
way to reason about, and the effective value is disclosed in the output. You can override it. Time
windows are accepted as ISO-8601 timestamps or a relative lookback and converted to the API's
epoch-millisecond `fromMs`/`toMs` internally.

The server sends **no `limit`** on a metric call unless you supply one. A metric result carries one
row per component per time bucket, and Lumics documents no ordering for those rows, so a limit
applied on your behalf would cut across time as well as across components and leave a series with
holes that look like real gaps in the monitoring data. Where a metric response is too large, the
output budget shortens it instead — from the end of the order Lumics returned, disclosed as such —
so what you lose is the tail of the series rather than scattered points.

`metrics/summaries` — the endpoint whose own vendor description advertises "top X lists of
devices" — accepts no `limit`, `sort`, or `top` parameter at all. Any ranking you see was
performed client-side by this server after retrieving the full set, and the output says so.

### Timestamps must carry a timezone

`from` and `to` on every metric tool, and `date` on `lumics_update_device_last_discovery`, accept
two forms and only two:

- a bare date, `2026-07-29`, which means **00:00:00Z** — UTC midnight;
- a timestamp with an explicit zone, `2026-07-29T14:00:00Z` or `2026-07-29T14:00:00+02:00`.

A timestamp carrying a time but no zone — `2026-07-29T14:00:00` — is **rejected**, with a message
naming the fix. It is not guessed at, because `Date.parse` reads that form in the _server's_ local
timezone while reading a bare date as UTC: the window moves by up to fourteen hours, and the
response notes report the moved window, so the wrong answer looks internally consistent. Epoch
milliseconds are also accepted, and a relative `lookback` such as `6h` or `7d` needs no timezone at
all.

`to` may not be in the future either, beyond 24 hours of clock skew. Monitoring data only exists
for the past, so a future end date does not widen the result — it only makes the reported window
wrong.

### `lumics_list_devices` returns a compact projection by default

A full device record is around 1.9 kB, mostly its `modules` polling map, so the default
`limit` of 100 and the 25,000-character output budget cannot both be satisfied — a default call
would ask for a hundred devices and be able to show about thirteen. So `lumics_list_devices` applies
a default field projection: `id`, `name`, `ipAddress`, `deviceType`, `collector`, `enabled`,
`maintenanceMode`. Nothing is dropped from the device _list_ by this; only fields are, and the
response says so.

Pass `fields` with the names you want to override it, pass `fields: []` to get whole records, or
call `lumics_get_device` for one device in full. No other list tool projects by default.

### A write is never retried after a transport failure

If the connection drops, times out, or delivers an incomplete body on a `POST`, `PATCH`, or `DELETE`,
the server makes **one** attempt and no more. The request may have been applied before the connection
died, and the transport cannot tell that apart from a request Lumics never saw, so a replay would
duplicate a record, double-apply a change, or hit a record the first attempt had already deleted. The
error text says the write may already have landed and instructs a verifying read rather than a retry;
read that as "go and look", not "it failed".

`DELETE` is in that set even though HTTP calls it idempotent. Idempotence guarantees the same state,
not the same answer: a replayed delete 404s, and `not_found` — "Lumics has no such resource" — is what
would surface, so a completed deletion would be reported as never having happened.

Retries on a **status code** are unchanged and still apply to every verb, `429` included: a status
proves the server answered, which removes the ambiguity.

### The HTTP transport is not in 0.1.0

`LUMICS_TRANSPORT=http` is **refused at startup** in this release. 0.1.0 ships stdio only
([ADR-001](./docs/adr/ADR-001-transport-and-distribution.md) decision 3) and opens no network
listener at all; Streamable HTTP is decision 4 of the same ADR and is scheduled for v0.2. The
listener code is in the tree so that v0.2 is additive, but it is not reachable from configuration
here, and the five `LUMICS_HTTP_*` variables are documented for forward reference only.

Unset `LUMICS_TRANSPORT`, or set it to `stdio`, and connect over stdio from your MCP client.

### Raw Mongo query passthrough is deliberately not exposed

The Lumics metric endpoints accept `componentQuery` (a raw Mongo query expression) and `filters`
(a filter object convertible to one). **Neither is exposed as a tool argument in v0.1.** Handing a
language model a raw database query language is a NoSQL injection and unbounded-query surface. The
typed `itemType`, `isMonitored`, and `properties` arguments cover the practical use cases. This is
a deliberate reduction of capability the vendor API offers, chosen on security grounds. If raw
passthrough is ever added it will go behind an explicit opt-in flag.

### v0.1 supports the `companies` context only

Several Lumics endpoints take a `:context` path segment whose legal values vary per endpoint —
`companies`, `admingroups`, and in two read cases `system`. v0.1 supports **`companies` only**.
`admingroups` and `system` are not offered. Note also that the vendor documentation never
specifies what context id to supply for `system`, so it is documented-but-unspecified and not safe
to rely on.

### Rate limits are undocumented

The API documents a `429 Too Many Requests` response but publishes no limits, no windows, and no
headers. The server is conservative about concurrency and honours `Retry-After` when present, but
we cannot tell you where the ceiling is because Lumics does not say.

### Other API-level caveats

- Documented status codes include `304 Not Modified` and `423 Locked`, but no endpoint documents
  its own caching or locking semantics.
- Identifier field names are inconsistent upstream: some responses return `id`, others `_id`, and
  component objects leak Mongoose internals (`__t`, `__v`).
- No enumerations are published for `deviceType`, `role`, `moduleType`, or component `itemType`.
  `lumics_list_component_types` is the lookup for the `componentType` key the component tools take,
  but **not** for the metric tools' `itemType` — it returns plural aliases the metrics API rejects.
  Build an `itemType` from `lumics_get_device_definition_components`, or copy the `type` field off a
  row a metric call returned. Metric **property** names are enumerable from one endpoint only, and
  only for device-scoped metrics — see
  [Metric tools require a `properties` argument](#metric-tools-require-a-properties-argument-and-a-wrong-one-is-not-an-error).
- IPAM address routes use singular `/ipsubnet/` for reads and plural `/ipsubnets/` for writes.
  This asymmetry is real in the vendor's route definitions, not a documentation typo, and the
  server sends each spelling as documented.
- **The vendor documentation does drift from live behaviour, and has been measured doing so.** The
  first contract run against a live tenant, on 2026-07-30, contradicted it in seven places, four of
  them in the metric layer. Those measurements are recorded, dated and marked in
  [`docs/reference/lumics-api-v1.md`](./docs/reference/lumics-api-v1.md) — §0 indexes them, §14
  defects 17–23 carry the detail — with the vendor's original text left in place beside them, and the
  decisions taken about them are in
  [ADR-003](./docs/adr/ADR-003-metric-layer-live-contract-corrections.md). Contract tests run against
  a live tenant before each release; see [docs/RELEASE.md](./docs/RELEASE.md).

### Release maturity

This is a `0.x` release. **The tool surface may change before 1.0**, including breaking renames
and argument changes, which pre-1.0 semver permits with a minor bump and a changelog entry. Pin an
exact version if you depend on stability. The HTTP transport, Docker deployment, and `.mcpb`
bundle are not in v0.1.

---

## Troubleshooting

### It worked yesterday and now every tool fails

Your token expired. Lumics tokens default to `expiresIn=86400` — **one day** — so this is the most
common failure by a wide margin, and it presents as an authentication error (`unauthorized`, HTTP 401) on every call rather than as anything that looks like expiry.

Mint a fresh token, update it wherever your client stores it, and **restart the server**. The token
is read once at startup; editing a config file is not enough on its own. If you find yourself doing
this daily, mint with a longer `expiresIn` deliberately rather than by accident, and read
[Security](#security) first — there is no documented maximum, and a token that never expires is a
credential you will forget you issued.

### The server started but almost no tools are there

`LUMICS_COMPANY_ID` is not set. Company-scoped tools are withheld from `tools/list` when there is
no company to scope them to, which leaves two tools in a default deployment — `lumics_get_me` and
`lumics_get_device_definition_components`. The server logs a warning on stderr saying so. Follow
[First run: finding your company id](#first-run-finding-your-company-id).

### Tools work but every list comes back empty

Check that `LUMICS_COMPANY_ID` is the company your **token** belongs to. A syntactically valid id
for a company your user cannot see returns empty results rather than an error, which reads as "you
have no devices". `lumics_get_me` reports the user the token authenticates as and the company it
belongs to; compare the two.

### A call was refused with `not_permitted` and a companyId in the message

The call named a `companyId` other than `LUMICS_COMPANY_ID`, and `LUMICS_ALLOW_CROSS_COMPANY` is
off. Omit `companyId` to use the configured company. If you genuinely need another tenant, see
[Cross-company access is off by default](#cross-company-access-is-off-by-default) — it is an
operator setting and cannot be changed from a conversation.

### A device list is truncated, or says it may be incomplete

**Do not raise the limit.** The Lumics API has no pagination, and a larger `limit` fetches records
the output budget then drops — you get fewer, not more. Pass a `fields` projection instead so each
record is small enough that more of them fit, narrow the query, or ask for a higher
`LUMICS_MAX_OUTPUT_CHARS`. See
[`lumics_list_devices` returns a compact projection by default](#lumics_list_devices-returns-a-compact-projection-by-default).

The same applies to a metric response: shrink it with `properties`, `itemType`, `lastMetric` or a
shorter window rather than with `limit`.

### A metric call returned rows but no values

The property names are probably wrong. This is the most likely explanation, and it is far more
likely than the metric genuinely having no data.

Lumics does not reject an unrecognised `properties` value. It answers **HTTP 200 with the full row
count and an empty `stats` object on every row** — a successful, complete-looking, empty answer that
is indistinguishable from a real absence of data except by inspection. This server inspects it: when
the paths you asked for resolve on none of the returned rows, the response says the names may be
malformed and does **not** present the result as a negative finding about your estate. Read that
note as "nothing was measured", not as "nothing is being collected".

What to check, in order:

1. **Syntax.** Each entry must be `<TypeGroup>.<metric>` with no spaces — `Calculated.cpu`, not
   `cpu`. A value with no dotted entry at all is refused locally before any request is made.
2. **The type group.** If the note says the group never appeared in any row's `stats`, the group half
   is wrong. `Calculated`, `Rate` and `TimeTicks` are what live tenants have shown; `Counter` and
   `Gauge` do not exist.
3. **The metric name.** If the note says the group came back but held no such metric, the name half is
   wrong. Enumerate the real names with `lumics_get_metric_summary` called with no `properties`, and
   read `data.<class>[].stats`.
4. **`itemType`, if you passed one.** Lumics validates it before `properties`, and a wrong value fails
   with `400 Unknown component` — which hides the properties problem rather than showing it.

If the names are right and the rows are still empty, the metric may genuinely not be collected on
those components. Confirm it in the Lumics UI before reporting it: the API gives no signal that
distinguishes the two. See
[Metric tools require a `properties` argument](#metric-tools-require-a-properties-argument-and-a-wrong-one-is-not-an-error).

### A company metric call failed with a 500

Expected, unfortunately. `/api/v1/metrics/companies/...` returned 500 on ordinary queries when it was
measured, and the failures tracked specific parameters: drop `lastMetric`, `isMonitored`,
`minIntervals` and `limit`, and use `interval=hour` or `interval=day` rather than `minute` or
`fiveMin`. If it still fails, go device-scoped — `lumics_list_devices`, then
`lumics_get_device_metrics` per device — which is the route that answered in every run. The failure is
not evidence that the company has no data for that module. See
[The company-scoped metric endpoint is unreliable](#the-company-scoped-metric-endpoint-is-unreliable-prefer-the-device-scoped-tools).

### A timestamp was rejected

Add an explicit zone: `2026-07-29T14:00:00Z`, or an offset such as `2026-07-29T14:00:00+02:00`. A
bare `2026-07-29` is fine and means UTC midnight. A relative `lookback` like `6h` avoids the
question entirely. See [Timestamps must carry a timezone](#timestamps-must-carry-a-timezone).

If the rejection says the value is in the future, that is `to` — it may not be later than now, give
or take 24 hours of clock skew.

### A metric call was refused and named a device in another company

`lumics_get_device_metrics` and `lumics_get_device_item_metrics` take no `companyId`, so they check
the pin by reading the device inside `LUMICS_COMPANY_ID` first. A `not_permitted` refusal there means
the device is in a different Lumics company, or does not exist at all; no metric request was made.
Pick a device with `lumics_list_devices`, which lists only the configured company. See
[Cross-company access is off by default](#cross-company-access-is-off-by-default).

### The server refuses to start and says `LUMICS_BASE_URL must use https:`

Your `LUMICS_BASE_URL` is a plain `http:` URL for a host that is not loopback. The Lumics token is a
bearer credential sent on every request, so over plaintext to a remote host it crosses the network in
the clear and is readable by anything on the path. Switch the URL to `https:`.

Plain `http:` is accepted only for `127.0.0.1`, `localhost`, or `[::1]`, which covers a local
development proxy. The comparison is exact, so a host like `localhost.example.invalid` gets no
exemption. No environment flag widens this — if a deployment genuinely needs plaintext to a remote
host, terminate TLS in front of Lumics or tunnel to loopback.

### The server refuses to start with `LUMICS_TRANSPORT=http`

That is deliberate in 0.1.0, not a bug. See
[The HTTP transport is not in 0.1.0](#the-http-transport-is-not-in-010).

### The server exits immediately with a configuration error

Configuration is validated at startup and the message names the variable and what to do about it.
Read it on **stderr** — most clients hide server stderr behind a "server disconnected" message, so
check your client's MCP log rather than concluding the server is broken. Nothing is requested and no
credential is read when validation fails.

### I need to see what the server is actually doing

Turn the verbosity up with `LUMICS_LOG_LEVEL=debug` and restart. Diagnostics go to **stderr** —
stdout is the MCP protocol channel and carries nothing else — so look in your client's MCP log.

`debug` adds a record per tool call: which tool, how long it took, how many characters it returned,
whether a list reached the `limit` it asked for, and how many items the output budget dropped. That is
what to reach for when a tool returns less than you expected. The default is `info`; `warn` and
`error` are quieter, and `silent` turns the stream off entirely for a supervisor that treats any
stderr output as a fault.

---

## Tool reference

Tools are named `lumics_<action>_<resource>` and grouped by resource below. Every tool carries an
operation classification — **Read**, **Create**, **Update**, **Admin**, or **Destructive** — as
required by the Engineering OS security standard, mapped to MCP tool annotations so clients can
present the right confirmation prompts.

**39 tools exist; 37 are registered in a default deployment.** The two missing are
`lumics_batch_update_devices` and `lumics_revoke_tokens`, each behind its own environment flag. With
`LUMICS_READ_ONLY=1` only the Read rows are registered, which is 20 tools. Without
`LUMICS_COMPANY_ID` only the two tools that need no company are registered — see
[First run](#first-run-finding-your-company-id).

### Devices

| Tool                                  | Class       | Gate                         |
| ------------------------------------- | ----------- | ---------------------------- |
| `lumics_list_devices`                 | Read        | —                            |
| `lumics_get_device`                   | Read        | —                            |
| `lumics_create_device`                | Create      | —                            |
| `lumics_update_device`                | Update      | —                            |
| `lumics_update_device_last_discovery` | Update      | —                            |
| `lumics_batch_update_devices`         | Admin       | `LUMICS_ENABLE_BATCH_UPDATE` |
| `lumics_delete_device`                | Destructive | —                            |

Bulk device update is classified **Admin**, not Update: one call rewrites arbitrary fields across
many devices and the Lumics API documents no cap on how many, so it carries `destructiveHint` and
requires a `confirm` argument alongside its environment flag. See
[ADR-002](./docs/adr/ADR-002-security-posture-and-capability-reductions.md).

### Collectors

| Tool                      | Class       | Gate |
| ------------------------- | ----------- | ---- |
| `lumics_list_collectors`  | Read        | —    |
| `lumics_get_collector`    | Read        | —    |
| `lumics_create_collector` | Create      | —    |
| `lumics_update_collector` | Update      | —    |
| `lumics_delete_collector` | Destructive | —    |

### Components

| Tool                                      | Class  | Gate |
| ----------------------------------------- | ------ | ---- |
| `lumics_list_components`                  | Read   | —    |
| `lumics_get_component`                    | Read   | —    |
| `lumics_list_component_types`             | Read   | —    |
| `lumics_get_device_definition_components` | Read   | —    |
| `lumics_update_component`                 | Update | —    |

### IPAM — subnets

| Tool                     | Class       | Gate |
| ------------------------ | ----------- | ---- |
| `lumics_list_ipsubnets`  | Read        | —    |
| `lumics_get_ipsubnet`    | Read        | —    |
| `lumics_create_ipsubnet` | Create      | —    |
| `lumics_update_ipsubnet` | Update      | —    |
| `lumics_delete_ipsubnet` | Destructive | —    |

### IPAM — addresses

| Tool                      | Class       | Gate |
| ------------------------- | ----------- | ---- |
| `lumics_list_ipaddresses` | Read        | —    |
| `lumics_get_ipaddress`    | Read        | —    |
| `lumics_create_ipaddress` | Create      | —    |
| `lumics_update_ipaddress` | Update      | —    |
| `lumics_delete_ipaddress` | Destructive | —    |

### IPAM — groups

| Tool                    | Class       | Gate |
| ----------------------- | ----------- | ---- |
| `lumics_list_ipgroups`  | Read        | —    |
| `lumics_get_ipgroup`    | Read        | —    |
| `lumics_create_ipgroup` | Create      | —    |
| `lumics_update_ipgroup` | Update      | —    |
| `lumics_delete_ipgroup` | Destructive | —    |

### Metrics

| Tool                               | Class | Gate |
| ---------------------------------- | ----- | ---- |
| `lumics_get_company_metrics`       | Read  | —    |
| `lumics_summarize_company_metrics` | Read  | —    |
| `lumics_get_device_metrics`        | Read  | —    |
| `lumics_get_device_item_metrics`   | Read  | —    |
| `lumics_get_metric_summary`        | Read  | —    |

### Identity

| Tool                   | Class | Gate                             |
| ---------------------- | ----- | -------------------------------- |
| `lumics_get_me`        | Read  | —                                |
| `lumics_revoke_tokens` | Admin | `LUMICS_ENABLE_TOKEN_REVOCATION` |

**Per-tool argument detail lives in [`docs/TOOLS.md`](./docs/TOOLS.md)**, which ships alongside
the implementation — arguments, types, defaults, enums, output shape, and the endpoint each tool
maps to. The table above is structural only;
treat `docs/TOOLS.md` and the server's own `tools/list` response as authoritative for signatures,
and remember that names may change before 1.0.

---

## Development

Requires Node.js 20 or newer.

```bash
git clone https://github.com/ZenixSolutions/lumics-mcp.git
cd lumics-mcp
npm ci
cp .env.example .env   # then set LUMICS_TOKEN, and LUMICS_COMPANY_ID once you have it
npm run build
node --env-file=.env dist/index.js
```

The `--env-file` flag is how the `.env` gets read: the server does not look for one itself. See
[The server does not read a `.env` file](#the-server-does-not-read-a-env-file).

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/` and mark the bin executable        |
| `npm run dev`           | Compile in watch mode                                            |
| `npm start`             | Run the built server (`node dist/index.js`)                      |
| `npm run typecheck`     | `tsc --noEmit`                                                   |
| `npm run lint`          | ESLint                                                           |
| `npm run lint:fix`      | ESLint with `--fix`                                              |
| `npm run format`        | Prettier write                                                   |
| `npm run format:check`  | Prettier check — what CI runs                                    |
| `npm test`              | Vitest, single run                                               |
| `npm run test:watch`    | Vitest in watch mode                                             |
| `npm run test:coverage` | Vitest with V8 coverage                                          |
| `npm run test:contract` | Contract tests against a live tenant (needs a real token)        |
| `npm run validate`      | typecheck + lint + format:check + test — run before opening a PR |

`npm run validate` is the gate CI enforces. Run it locally first.

Contract tests are opt-in because they make real API calls. They are read-only, but they consume
quota against a live tenant. See [docs/RELEASE.md](./docs/RELEASE.md) for when they are required.

---

## Contributing

Contributions are welcome. This repository is governed by the Engineering OS framework, which
means meaningful changes go through issue, discovery, approval, independent review, and validation
before merge — and that no author may be the sole reviewer of their own work. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) before you start writing code; it will save you a rejected
pull request.

- [CONTRIBUTING.md](./CONTRIBUTING.md) — contribution flow, branch and commit conventions
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — Contributor Covenant 2.1
- [SECURITY.md](./SECURITY.md) — vulnerability reporting and hardening guidance
- [CHANGELOG.md](./CHANGELOG.md) — release history
- [docs/DEPENDENCY_POLICY.md](./docs/DEPENDENCY_POLICY.md) — dependency rules
- [docs/RELEASE.md](./docs/RELEASE.md) — release and tagging policy
- [docs/DECISION_LOG.md](./docs/DECISION_LOG.md) — approved decisions and recorded exceptions
- [docs/rfc/](./docs/rfc/) and [docs/adr/](./docs/adr/) — approved designs and architectural
  decisions
- [docs/reference/lumics-api-v1.md](./docs/reference/lumics-api-v1.md) — the captured Lumics API
  contract this server targets

---

## License

[MIT](./LICENSE) © 2026 Zenix Solutions
