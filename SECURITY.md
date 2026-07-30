# Security Policy

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security vulnerability.**

Report it privately by either route:

- **Email** — [security@zenixsolutions.com](mailto:security@zenixsolutions.com)
- **GitHub private vulnerability reporting** — the _Report a vulnerability_ button under the
  repository's **Security** tab, which opens a private advisory visible only to maintainers

Either channel is fine; do not use both for the same issue. If you do not receive an
acknowledgement within five business days, resend — assume the mail was lost rather than ignored.

### What to include

- A description of the vulnerability and why it matters
- Affected version or commit
- Reproduction steps or a proof of concept
- The impact you believe it has, and any suggested fix

**Redact your own credentials.** Never include a live Lumics token, company id, or real hostnames
and IP addresses in a report. A placeholder or a truncated fingerprint is enough for us to
reproduce.

### What to expect

| Stage                                          | Target                                       |
| ---------------------------------------------- | -------------------------------------------- |
| Acknowledgement of your report                 | 5 business days                              |
| Initial assessment and severity                | 10 business days                             |
| Fix or documented mitigation for high/critical | 30 days from confirmation, where practicable |
| Public advisory                                | On release of the fix, coordinated with you  |

These are targets for a volunteer-maintained community project, not a contractual SLA. We will tell
you where we are rather than go quiet.

We will keep you informed, credit you in the advisory unless you ask us not to, and coordinate
disclosure timing with you. Please give us a reasonable window to ship a fix before publishing.
There is no bug bounty.

### Scope

In scope: this MCP server — credential handling, redaction, path construction, the read-only and
gating controls, the HTTP transport's authentication and origin/host checks, dependency
vulnerabilities affecting shipped code, and the published npm package.

Out of scope: vulnerabilities in the Lumics platform or API itself (report those to Lumics),
vulnerabilities in the AI clients that host this server (report those to their vendors), and
findings that require an attacker to already control the machine running the server or its
environment variables.

## Supported versions

| Version | Supported                     |
| ------- | ----------------------------- |
| `0.1.x` | Yes — current release line    |
| `< 0.1` | No — pre-release, unpublished |

This is a pre-1.0 project. Only the latest minor release line receives security fixes: fixes ship
forward in a new patch or minor release rather than being backported. If you are pinned to an older
`0.x` line, expect to upgrade in order to receive a fix.

## Hardening guidance for users

The server is only as safe as the token you give it and the mode you run it in.

### Token scope and lifetime

- **The token is your user.** A Lumics JWT grants exactly the access your account has — there is no
  scoping, no read-only token type, and no per-integration credential. Whatever you can see and
  change, the token can. If you have a lower-privilege Lumics account that covers your use case,
  use it to mint the token.
- **Use short lifetimes.** `expiresIn` is in seconds and defaults to `86400` (one day). The API
  documents **no maximum**, so nothing stops you minting a token that lasts for years. Do not. Pick
  the shortest lifetime that is workable and re-mint.
- **Rotate deliberately, and rotate on exposure.** Treat a token as exposed the moment it lands
  somewhere durable: a chat transcript, shell history, a CI log, an issue comment, a screenshot.
- **Revocation is all-or-nothing.** The only revocation endpoint Lumics offers revokes _every_
  token issued to your user, including ones other integrations depend on. Plan for that before you
  need it: know what else would break.

### A `.env` file configures nothing unless you point the server at it

The server reads the environment it is given and nothing else. It does **not** look for a `.env` in
the working directory, and that is a security property rather than an omission — see
[Configuration is not read from the filesystem](#configuration-is-not-read-from-the-filesystem)
below. To use a file, either put the variables in your MCP client's own `env` block, or pass Node's
flag yourself: `node --env-file=.env dist/index.js`.

### Never commit `.env`

`.env` is gitignored, and `.gitignore` also covers `*.pem` and `*.key`. Keep it that way. Use
`.env.example` — which contains placeholders only — as the template. Secret scanning runs on every
push and pull request in CI, but a scanner is a backstop, not a control.

Be aware that client configuration files store tokens in **plaintext**:
`claude_desktop_config.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `~/.codex/config.toml`. Never
commit a project-scoped one. Protect the rest as you would a private key, and remember that
anything that syncs your home directory syncs them too.

### Configuration is not read from the filesystem

Every control in this document — `LUMICS_READ_ONLY`, the two `LUMICS_ENABLE_*` gates,
`LUMICS_ALLOW_CROSS_COMPANY`, `LUMICS_BASE_URL` — is only as strong as the answer to "who can supply
it". The answer is: whoever launches the process, and nobody else.

An earlier build weakened that. `src/index.ts` called Node's own dotenv loader with the **relative**
path `.env`, which for a published MCP server resolves against whichever directory the client
happened to launch it from: a user's workspace, a cloned repository, a directory the very agent this
server serves can write to. Two consequences, both reproduced end to end during review:

- **Token exfiltration.** A planted `LUMICS_BASE_URL` redirected every request, so the bearer token
  was delivered to a host of the file's choosing.
- **Gate escalation.** `LUMICS_ALLOW_CROSS_COMPANY`, `LUMICS_ENABLE_BATCH_UPDATE` and
  `LUMICS_ENABLE_TOKEN_REVOCATION` came back on, registering tools a default install does not have.

Real environment variables always won over the file, so only variables the operator had left unset
were hijackable — which is every gate, by default. The defaults _are_ the security posture, so that
was the whole of it.

The load was removed. Nothing in the server now reads a dotfile, and
`tests/security/dotenv-not-loaded.test.ts` runs the **built** binary in a directory holding a
hostile `.env` and asserts that the base URL is untouched, that no request reaches the planted host,
that the gated tools stay unregistered, and that `LUMICS_READ_ONLY` cannot be switched on from the
file either — a control a file can turn on is a control an operator cannot rely on.

### The base URL must use TLS

`LUMICS_BASE_URL` is refused at startup unless it is `https:`, with one exception: a loopback host
(`127.0.0.1`, `localhost`, `[::1]`), which covers a local development proxy and cannot put traffic on
a network. The comparison is against `URL.hostname` and is exact, so `localhost.example.invalid` gets
no exemption.

The reason is that the URL decides who receives the credential. The Lumics token is a bearer token
sent on **every** request, so plaintext to a remote host puts it on the wire in the clear for
anything on the path. No environment flag widens this. If a deployment genuinely needs plaintext to a
remote host, that is a change to argue for on its merits, not a default to leave open.

### Why `LUMICS_READ_ONLY` matters

```
LUMICS_READ_ONLY=1
```

This is the recommended default posture. It is a **registration-time** control, not a runtime
check: with it set, create, update, delete, and admin tools are never advertised to the model. That
distinction is the point — a model cannot be talked into calling a tool that was never registered,
so the control holds even against prompt injection reaching the model through monitoring data,
device descriptions, or a note field.

It holds against a file on disk too, which is a separate claim and used not to be true: the value
comes from the process environment alone, and
[configuration is not read from the filesystem](#configuration-is-not-read-from-the-filesystem).
`tests/security/dotenv-not-loaded.test.ts` verifies it in both directions — a planted `.env` can
neither switch this control off nor switch it on.

Most real use of this server is investigative: asking what is down, what a subnet contains, how a
metric has trended. That work needs no write access. Run read-only by default and keep a second,
write-capable server entry for the rare occasions you intend to change something.

Two operations remain off even without read-only mode, and no model can enable them:

- `LUMICS_ENABLE_BATCH_UPDATE` — one call rewrites arbitrary fields on an unbounded list of devices.
- `LUMICS_ENABLE_TOKEN_REVOCATION` — revokes every token on the account, including the one the
  server is using and any used by other integrations. Irreversible, and everything affected must be
  re-issued by hand. The tool's `confirm` argument is a prompt-level speed bump that an agent can
  satisfy; the environment variable is the actual gate.

### Cross-company access

```
LUMICS_ALLOW_CROSS_COMPANY=1
```

Off by default, and worth leaving off. **Every tool is covered by the pin.** Most take an optional
`companyId` argument, and with the flag unset an explicit `companyId` that differs from
`LUMICS_COMPANY_ID` is refused with a `not_permitted` error before any request is made.

The reason is that a Lumics token is not scoped to one company. A token issued to an MSP or
multi-company user reaches **every** company that user administers, and `companyId` is an ordinary
tool argument — a string a model can pick up from a document, a prior answer, a pasted URL, or an
injected instruction sitting in a device description. Without the gate, one such value is enough to
read or write a tenant nobody configured, while the tool's own description told the approving human
that writes apply to the configured company. That is the specific failure this closes: not a model
exceeding its instructions, but a model following them into a tenant that was never named.

Two tools have no `companyId` argument for the check to read, because their Lumics paths carry no
company segment (spec §12.3): `lumics_get_device_metrics` and `lumics_get_device_item_metrics` are
addressed by device id alone. That was a hole, and a reviewer walked through it — metrics for a device
in another company, read with the pin on, while every other tool refused the same tenant. A
`deviceId` is precisely the untrusted value described above.

They now enforce the pin with a **device-ownership read**: the device is fetched inside
`LUMICS_COMPANY_ID` first, and the metric read is issued only if that confirms ownership. Every
ambiguous case fails closed — a 404 from the scoped read, or a device record carrying no `company`
field, is a refusal, not an assumption. Because that check needs a configured company, both tools are
company-scoped and are withheld from `tools/list` entirely when `LUMICS_COMPANY_ID` is unset. The cost
is one extra request per call; the alternative was a security control with a documented exception,
which is much weaker than one without.

Enabling the flag is therefore a blast-radius decision, not a convenience one. It widens the reach
of every write from one company to every company the token can reach, and the two are not
comparable: a wrong `companyId` under the default is a refusal, and under the flag it is a change to
someone else's inventory. If you do enable it, prefer a token minted from a lower-privilege Lumics
account that can see only the companies you intend, and pair it with `LUMICS_READ_ONLY=1` unless you
specifically intend cross-tenant writes.

Like the other gates this is registration- and call-time enforcement driven by the environment: it
is set by the human who deploys the server, out of band from any conversation, and no prompt can
change it — and, since the dotenv load was removed, no file in the working directory can change it
either. `tests/security/dotenv-not-loaded.test.ts` asserts exactly that, because the claim in this
paragraph was previously false: see
[Configuration is not read from the filesystem](#configuration-is-not-read-from-the-filesystem).
When it is on, the description of every write tool says so explicitly, so a client's approval UI shows
the human that a foreign `companyId` will be honoured.

### Self-hosting the HTTP transport (v0.2)

**The HTTP transport is not available in 0.1.0.** `LUMICS_TRANSPORT=http` is refused at startup:
this release ships stdio only ([ADR-001](./docs/adr/ADR-001-transport-and-distribution.md) decision 3) and opens no network listener at all. The `LUMICS_HTTP_*` variables are present in
`.env.example` and validated when you ask for the transport, but the transport itself is then
refused, so nothing in this section describes something you can deploy today.

The guidance below is therefore **v0.2 guidance**, written now so a deployment can be designed and
reviewed before the release exists. When you do run it:

- **Terminate TLS in front of it.** The server speaks plain HTTP. Put a reverse proxy with a valid
  certificate ahead of it and never accept plaintext connections from outside the host.
- **Set `LUMICS_HTTP_AUTH_TOKEN`.** It is required when `LUMICS_TRANSPORT=http`, and it is a
  distinct secret from your Lumics token. Generate it with `openssl rand -hex 32` and rotate it
  independently. Do not reuse the Lumics token as the transport secret. Clients present it as
  `Authorization: Bearer <value>`.
- **Keep the loopback default.** `LUMICS_HTTP_HOST` defaults to `127.0.0.1`. Change it only once TLS
  and authentication are genuinely in front of the listener. Binding to `0.0.0.0` on a machine with
  a public interface publishes an authenticated-but-plaintext endpoint holding a credential that
  can rewrite your network inventory.
- **Set the allowlists explicitly.** `LUMICS_HTTP_ALLOWED_HOSTS` (DNS-rebinding protection, default
  `127.0.0.1`, `localhost` and `[::1]`, plus the bind host) and `LUMICS_HTTP_ALLOWED_ORIGINS` (CORS,
  default empty — nothing allowed). Enumerate exactly the hostnames and origins you intend to serve.
  A wildcard here undoes the protection. Setting `LUMICS_HTTP_ALLOWED_HOSTS` **replaces** the
  default list rather than adding to it, so repeat every loopback spelling you actually use —
  dropping `[::1]` gives an IPv6-loopback client a `403 Invalid Host` that reads as a server fault.
- **One tenant per deployment.** The design is deliberately self-hosted per tenant: the server
  holds one Lumics credential and serves one company. It is not a multi-tenant broker, and running
  it as though it were would mean sharing one tenant's credential across users.
- **Log and monitor the endpoint** at your proxy. The server itself writes diagnostics to stderr
  with credentials redacted.

## Threat assumptions and residual risk

We assume the machine running the server, and its environment variables, are trusted. An attacker
with either has your token regardless of anything this server does.

Known residual risks, disclosed rather than hidden:

- **Undocumented rate limits.** The API documents `429` but publishes no limits, windows, or
  headers. We are conservative and honour `Retry-After`, but we cannot bound this.
- **No documented `expiresIn` ceiling.** Long-lived tokens are possible; the server discourages
  them but cannot prevent them.
- **Documentation-versus-behaviour drift.** The code targets the captured contract in
  `docs/reference/lumics-api-v1.md`. Live behaviour may differ. Contract tests against a live tenant
  before each release are the detection mechanism.
- **Prompt injection through monitoring data.** Device names, descriptions, and note fields are
  attacker-influenceable in some environments and flow into model context. `LUMICS_READ_ONLY=1` is
  the mitigation that actually holds; nothing at the prompt layer does.
- **Tenant data flows outward into model context and the transcript, unfiltered.** The mirror image
  of the risk above, and the one people miss because it is not an attack. Tool payloads pass the
  API's response through verbatim by design, so **anything an operator has typed into a free-text
  field is copied into model context and into the chat transcript**: a device `description` or
  `location`, an IP address `note`, an IPAM subnet or group description. If someone recorded a
  door code, an escalation phone number, a customer name under NDA, or a "temporary" credential in
  one of those fields, this server hands it to the model — and, through the client, to whatever
  retains that conversation.

  This is accepted rather than mitigated. Redacting or heuristically filtering free-text inventory
  data would corrupt the answers the server exists to give: a `location` is exactly what a model
  needs to answer "which site is this in", and a description is often the only record of why a
  device is configured the way it is. A redactor cannot tell an operator's note from a secret, so it
  would either miss secrets or damage real data, and both failures are silent. The controls that do
  apply are: **credential material the server itself handles** is stripped structurally at the error
  boundary and verified by test; the token is never echoed; and a transcript should be treated as an
  exposure surface in its own right — the README already says that of credentials, and it is no less
  true of inventory data. If a field holds something that must not leave your tenant, remove it from
  Lumics; this server will not.

- **Plaintext tokens in client configuration files.** Outside our control; called out above.

## Security-sensitive fixes and review

Security fixes follow the same governance as any other change: they require independent review, and
per Constitution Article VI no author may be the sole reviewer of their own work. There is no
"urgent" path that skips review.

What may differ is the **public record**. To avoid disclosing an unpatched vulnerability, the issue,
pull request, and commit message for a security-sensitive fix may be deliberately terse, and the
full analysis may live in a private advisory until the fix is released. The review happens either
way; only its visibility is limited, and the complete record is retained internally.
