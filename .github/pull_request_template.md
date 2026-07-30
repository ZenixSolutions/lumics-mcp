## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem, not the solution. Link the issue. -->

Closes #

## Governance

This repository is governed by Engineering OS. See
[CONTRIBUTING.md](https://github.com/ZenixSolutions/lumics-mcp/blob/main/CONTRIBUTING.md).

- [ ] A tracked issue exists and is linked above
- [ ] An RFC was written if required (architecture, security, tool surface, dependencies,
      transport, or a deviation from an approved design) — link it, or state why none is needed
- [ ] **Approval was obtained before implementation** where required
- [ ] This change stays within the approved scope

<!-- RFC / ADR: -->

## Type of change

- [ ] Bug fix (no interface change)
- [ ] New feature
- [ ] Breaking change to the tool surface or configuration
- [ ] Documentation only
- [ ] Tests only
- [ ] Build, CI, or dependency change
- [ ] Refactor (no behaviour change)

## Operation classification

<!-- Skip if no tool was added or changed. -->

- [ ] Every added or changed tool carries a classification: Read, Create, Update, Admin, or
      Destructive
- [ ] Destructive or materially consequential operations describe their impact and require
      confirmation
- [ ] `LUMICS_READ_ONLY=1` still registers read tools only
- [ ] No gate (`LUMICS_ENABLE_BATCH_UPDATE`, `LUMICS_ENABLE_TOKEN_REVOCATION`) was weakened or
      default-enabled

## API contract

- [ ] Every endpoint, parameter, and enum value used is documented in
      `docs/reference/lumics-api-v1.md` — nothing was invented or inferred
- [ ] No pagination metadata is fabricated (`offset`, `has_more`, `next_offset`, totals)
- [ ] Truncation is disclosed rather than silent
- [ ] `encodeURIComponent` is applied to every interpolated path segment

## Tests

- [ ] `npm run validate` passes locally
- [ ] New behaviour has tests; the bug fix has a regression test that failed before the fix
- [ ] Security-relevant changes extend `tests/security` — redaction, path encoding, read-only mode,
      destructive gating
- [ ] No test calls the live API outside `tests/contract`

<!-- Contract tests, if run: result, tenant, date. -->

## Documentation

- [ ] README updated where user-visible
- [ ] A new or changed environment variable appears in **both** `.env.example` and the README
      configuration table
- [ ] New known constraints added to the README Limitations section
- [ ] `CHANGELOG.md` updated under the unreleased section
- [ ] Tool reference updated

## Security

- [ ] No secrets, tokens, credentials, real hostnames, IP addresses, or live tenant data in the
      diff, the tests, the fixtures, or this description
- [ ] Nothing new writes to stdout (`console` is banned; stdout is the stdio protocol channel)
- [ ] No credential material can reach logs, errors, or tool output
- [ ] Dependency changes follow
      [docs/DEPENDENCY_POLICY.md](https://github.com/ZenixSolutions/lumics-mcp/blob/main/docs/DEPENDENCY_POLICY.md)
      — exact pins, provenance and maintenance assessed, approval obtained for material additions

## Review

Per Constitution Article VI, **the author may not be the sole reviewer.** One non-author approval
plus green CI is required to merge. Pull requests are squash merged; the title is used as the commit
message, so write it as a Conventional Commit.

## Anything a reviewer should look at first

<!-- Trade-offs you made, things you are unsure about, what you would push back on. Be direct. -->
