/**
 * Shared machinery for the live contract suite. **Not a test file** — nothing
 * here runs on its own; `vitest.config.ts` only collects `*.test.ts`.
 *
 * The contract suite is the release gate for RFC-001's one High risk ("docs
 * diverge from live API behaviour"). It is run once, by an operator, against a
 * real tenant, and whatever it prints is the evidence that 0.1.0 is or is not
 * safe to tag. That job imposes three requirements this module exists to serve.
 *
 * **1. A pass must mean something.** A tenant can be sparse: no components, no
 * ipgroups, no metric history for the module we happened to pick. A test that
 * silently returns early on empty data reports green while validating nothing,
 * and an assumption that was never exercised is indistinguishable from one that
 * held. So there is no early `return` anywhere in this suite. Where the data
 * needed to exercise an assumption is absent, the test calls
 * {@link unverifiable}, which marks the case **skipped with a stated reason**
 * and records it in the evidence ledger under UNVERIFIED. The operator gets an
 * explicit list of what this run could not check.
 *
 * **2. Asserted and observed are different claims.** Some documented facts can
 * be asserted outright (`fromMs` is epoch milliseconds). Others are genuinely
 * unknown until a real API answers — the vendor's docs speculate about the keys
 * of the §12.4 `data` object, and say nothing about how an out-of-enum value is
 * treated. Guessing an assertion for those produces a failure that means
 * "unknown", not "wrong". Those cases {@link recordObserved} instead: they still
 * assert something real (that the call resolved one of the ways spec §3 permits)
 * and they report what actually happened. Test names carry `ASSERT:` or
 * `OBSERVE:` so the distinction survives into the run output.
 *
 * **3. No tenant data may escape.** Assertions compare shapes, types and
 * runtime-to-runtime equalities; they never contain a literal company id, device
 * id, address or hostname, and the evidence report prints structure rather than
 * values ({@link describeValue}). Module and component *type* names are printed,
 * because they are vendor catalogue vocabulary from `componenttypes` and the
 * report is useless without saying which module an assumption was checked
 * against.
 *
 * **4. A device id may only come from the configured company.** The two
 * device-scoped metric tools (spec §12.3) now perform an ownership **pre-read**
 * before the metric call: `src/tools/metrics.ts` reads the device inside
 * `LUMICS_COMPANY_ID` and refuses unless `device.company` is that company. A
 * device resolved from anywhere else is therefore refused by the server rather
 * than served, and a case built on such an id would fail for the pin's reason
 * while appearing to report a metric-contract violation. {@link pinnedCompanyDevices}
 * is the only sanctioned source of a device id in this directory: it reads the
 * configured company's own device list, so ownership holds by construction.
 *
 * **READ-ONLY, without exception.** Every call this suite makes is a GET. It
 * never touches `GET /me/token`, `POST /me/token` or `POST /me/token/revoke` —
 * the first two mint credentials and the third would revoke the operator's own
 * working token mid-run (spec §11.2–§11.4).
 *
 * **Configuration comes from the process environment and nowhere else.** The
 * server no longer reads a `.env` file (`tests/security/dotenv-not-loaded.test.ts`
 * records why), and neither does vitest, so the variables have to be exported or
 * passed on the command line. `loadConfig` also validates them: since the TLS
 * requirement landed, `LUMICS_BASE_URL` must be `https:` off loopback, and
 * `LUMICS_LOG_LEVEL` and `LUMICS_TRANSPORT` are checked too. {@link api} turns
 * that failure into one sentence naming the run, rather than a bare zod dump from
 * inside whichever test happened to touch the client first.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it, type TestContext } from 'vitest';
import { expectArray, LumicsClient } from '../../src/api/client.js';
import { devicesPath } from '../../src/api/paths.js';
import { loadConfig, type LumicsConfig } from '../../src/config.js';
import type { Device } from '../../src/domain/index.js';

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/** `LUMICS_CONTRACT_TESTS` is the opt-in `vitest.config.ts` keys off. */
export const ENABLED = process.env.LUMICS_CONTRACT_TESTS !== undefined;

export const HAS_TOKEN =
  typeof process.env.LUMICS_TOKEN === 'string' && process.env.LUMICS_TOKEN.trim().length > 0;

export const HAS_COMPANY =
  typeof process.env.LUMICS_COMPANY_ID === 'string' &&
  /^[0-9a-fA-F]{24}$/.test(process.env.LUMICS_COMPANY_ID.trim());

/** Every suite in this directory is `describe.skipIf(!RUNNABLE)`. */
export const RUNNABLE = ENABLED && HAS_TOKEN && HAS_COMPANY;

/**
 * One client per test file, not one per test.
 *
 * `LumicsClient` owns the concurrency semaphore (`DEFAULT_MAX_CONCURRENCY`), so a
 * fresh client per test would let the file issue an unbounded burst against a
 * live production monitoring system. Sharing one keeps the whole file inside a
 * single permit pool. Built lazily so an unconfigured run skips at describe time
 * rather than throwing during module import.
 */
let cached: { readonly client: LumicsClient; readonly config: LumicsConfig } | undefined;

export function api(): { readonly client: LumicsClient; readonly config: LumicsConfig } {
  cached ??= (() => {
    const config = loadConfigForRun();
    return { client: new LumicsClient(config), config };
  })();
  return cached;
}

/**
 * `loadConfig`, with the failure explained in terms of the contract run.
 *
 * The environment this suite is handed goes through the same validation as a real
 * server start, which is the point — a run configured in a way the server would
 * refuse is measuring nothing. But the failure arrives lazily, inside the first
 * test or `beforeAll` that touches the client, where a raw multi-line
 * configuration error reads like a suite bug. The commonest causes are now
 * validation rather than absence: `LUMICS_BASE_URL` must be `https:` unless the
 * host is loopback (`BASE_URL_REQUIRES_TLS`), `LUMICS_LOG_LEVEL` must be one of
 * the five levels, and `LUMICS_TRANSPORT=http` is refused outright in 0.1.0.
 *
 * `loadConfig`'s message names variables and never values, so it is safe to
 * re-emit. No request has been made at this point and no assumption has been
 * checked, which is what the added sentence says.
 */
function loadConfigForRun(): LumicsConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the contract run's environment is not a configuration this server would start with, so NOTHING was verified against the live API and no request was made. ` +
        `Fix the environment and re-run: LUMICS_CONTRACT_TESTS=1 npm run test:contract. ` +
        `Note that no .env file is read — export the variables, or pass them on the command line.\n\n${detail}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Device ids, which the company pin constrains
// ---------------------------------------------------------------------------

/**
 * Device records from the **configured company's own list** (spec §7.1).
 *
 * The single sanctioned source of a device id in this directory, for the reason
 * in point 4 of the file comment: `src/tools/metrics.ts` now resolves a device's
 * owner with a company-scoped read before it will fetch any metric, so an id from
 * any other origin is refused by this server before the metric endpoint is ever
 * reached. Reading the list the pin itself trusts keeps that from being an
 * accident of which fixture a test picked.
 *
 * Raw records, not a projection: the `company` field the pin depends on is exactly
 * what the callers here need to inspect, and a `fields` projection is a tool-layer
 * concern that does not exist at this level.
 *
 * `limit` is small by default — a contract check needs one or two devices, not an
 * inventory.
 */
export async function pinnedCompanyDevices(limit = 3): Promise<readonly Device[]> {
  const { client, config } = api();
  return expectArray<Device>(
    await client.get(devicesPath(config.companyId), { query: { limit } }),
    'GET devices for the configured company',
  );
}

/**
 * A 24-hex identifier that belongs to nobody, for probing what the API does with
 * an id it has never seen.
 *
 * Generated per call rather than written down, because a literal in this
 * directory would be a tenant value if it ever collided and a magic constant
 * either way. Twelve random bytes make a collision with a real ObjectId
 * effectively impossible, and every caller has to handle the accepted outcome
 * anyway — that is what makes the case an observation rather than a guess.
 */
export function syntheticObjectId(): string {
  return randomBytes(12).toString('hex');
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

export type EvidenceKind = 'asserted' | 'observed' | 'unverified';

export interface EvidenceEntry {
  readonly kind: EvidenceKind;
  /** Spec section, e.g. `12.0`, so a finding can be traced to a documented claim. */
  readonly spec: string;
  /** The documented assumption in one line. */
  readonly claim: string;
  /** What was seen, or why the assumption could not be exercised. */
  readonly detail: string;
}

const ledger: EvidenceEntry[] = [];

/** A documented assumption this run actually checked and found to hold. */
export function recordAsserted(spec: string, claim: string, detail: string): void {
  ledger.push({ kind: 'asserted', spec, claim, detail });
}

/**
 * Behaviour the docs do not pin down, recorded rather than guessed at.
 *
 * An observation is not a pass — it is a measurement. The caller still asserts
 * that the call resolved within the documented envelope of possibilities; what
 * goes here is the part the spec leaves open.
 */
export function recordObserved(spec: string, claim: string, detail: string): void {
  ledger.push({ kind: 'observed', spec, claim, detail });
}

/**
 * Abandon a test because the tenant cannot exercise the assumption.
 *
 * Throws (via `ctx.skip`), so the case is reported as **skipped with a reason**
 * rather than as a pass. Use this and never a bare `return`: a sparse tenant must
 * not be able to turn "not checked" into "checked and fine".
 */
export function unverifiable(ctx: TestContext, spec: string, claim: string, reason: string): never {
  ledger.push({ kind: 'unverified', spec, claim, detail: reason });
  return ctx.skip(`NOT VERIFIED (spec ${spec}): ${claim} — ${reason}`);
}

/**
 * Print the ledger for one test file.
 *
 * stderr, never stdout: `no-console` is an error repository-wide and the habit of
 * writing to fd 1 is the one this codebase is organised against (CLAUDE.md).
 * Silent when the suite did not run, so both skip paths stay clean.
 */
export function reportEvidence(title: string): void {
  if (!RUNNABLE || ledger.length === 0) {
    return;
  }

  const lines: string[] = ['', `=== CONTRACT EVIDENCE: ${title} ===`];
  for (const kind of ['asserted', 'observed', 'unverified'] as const) {
    const entries = ledger.filter((entry) => entry.kind === kind);
    lines.push(`${kind.toUpperCase()} (${String(entries.length)}):`);
    if (entries.length === 0) {
      lines.push('  none');
    }
    for (const entry of entries) {
      lines.push(`  [spec ${entry.spec}] ${entry.claim}`);
      lines.push(`      ${entry.detail}`);
    }
  }
  lines.push(
    'UNVERIFIED entries are assumptions this run could not exercise, not assumptions that held.',
    '',
  );
  process.stderr.write(`${lines.join('\n')}\n`);
}

/** Once per module instance; vitest isolates files, so once per file in practice. */
let announcedMissingCredentials = false;

/**
 * Tell the operator, in the run output, that an opted-in run verified nothing.
 *
 * The per-file explanation case asserts the fact, but a passing assertion prints
 * nothing: the run would summarise as "3 passed, 61 skipped", and "skipped" alone
 * does not distinguish a deliberate `npm test` from a release gate that quietly
 * did not execute. Kept to three lines because each contract file runs in its own
 * worker and therefore prints its own copy.
 */
function announceMissingCredentials(): void {
  if (announcedMissingCredentials) {
    return;
  }
  announcedMissingCredentials = true;
  process.stderr.write(
    '\n=== CONTRACT SUITE NOT RUN: no credentials ===\n' +
      'LUMICS_CONTRACT_TESTS is set but LUMICS_TOKEN and/or LUMICS_COMPANY_ID are missing from the process\n' +
      'environment, so every case here is SKIPPED and nothing was checked against the live API — not a pass.\n' +
      'No .env file is read. Run: LUMICS_TOKEN=... LUMICS_COMPANY_ID=... npm run test:contract\n\n',
  );
}

/**
 * The suite every contract file declares for the case where it did **not** run.
 *
 * A contract file that is skipped in its entirety shows up as a bare "skipped"
 * line, which reads the same whether the operator forgot a credential or
 * deliberately ran `npm test`. This makes the reason explicit in the run output
 * of every file, and it is the only assertion in this directory that is expected
 * to execute without a token.
 */
export function declareSkipExplanation(label: string): void {
  describe.skipIf(RUNNABLE)(`${label}: contract tests skipped`, () => {
    it('explains why rather than passing silently', () => {
      if (!ENABLED) {
        expect(process.env.LUMICS_CONTRACT_TESTS).toBeUndefined();
        return;
      }
      // Opted in, and still not runnable. This assertion passes, and a passing
      // assertion prints nothing — so the run would summarise as "3 passed, N
      // skipped" and an operator who believed they had just executed the release
      // gate would be reading the output of a suite that made no request at all.
      // Said once per process, on stderr, for the same reason the ledger goes
      // there.
      announceMissingCredentials();
      expect(
        HAS_TOKEN && HAS_COMPANY,
        `LUMICS_CONTRACT_TESTS is set but LUMICS_TOKEN and/or LUMICS_COMPANY_ID (a 24-character hex id) are missing from the process environment, so ${label} was NOT validated against a live tenant. No .env file is read — export both variables, or pass them on the command line: LUMICS_TOKEN=... LUMICS_COMPANY_ID=... npm run test:contract. LUMICS_COMPANY_ID is required, not optional, because the device-scoped metric tools are withheld entirely without it and their company pin has nothing to pin to.`,
      ).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Call outcomes
// ---------------------------------------------------------------------------

/**
 * spec §3 is explicit that its table is the *only* documented status set. A
 * status outside it is drift worth failing on, which is what makes an
 * "either outcome is informative" test a real assertion rather than a tautology.
 */
export const DOCUMENTED_STATUSES: readonly number[] = [
  200, 304, 400, 401, 403, 404, 409, 423, 429, 500,
];

export type CallOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** `undefined` for a transport failure, which is not an API answer at all. */
      readonly status: number | undefined;
      readonly code: string;
    };

/**
 * Run a GET and classify the result instead of throwing.
 *
 * Only for cases where *both* outcomes are legitimate contract information (does
 * the API reject an out-of-enum value, or ignore it?). Never use it to soften a
 * test that should fail.
 */
export async function attempt<T>(call: Promise<T>): Promise<CallOutcome<T>> {
  try {
    return { ok: true, value: await call };
  } catch (error) {
    const status = readNumber(error, 'status');
    const code = readString(error, 'code') ?? 'unknown';
    return { ok: false, status, code };
  }
}

/** `"HTTP 400 (bad_request)"` or `"transport failure (timeout)"`, for a report line. */
export function describeOutcome(outcome: CallOutcome<unknown>): string {
  if (outcome.ok) {
    return 'accepted (HTTP 2xx)';
  }
  return outcome.status === undefined
    ? `no API answer — transport failure (${outcome.code})`
    : `rejected with HTTP ${String(outcome.status)} (${outcome.code})`;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Shape inspection — structure only, never tenant values
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The 24-hex ObjectId shape every Lumics identifier has (spec preamble). */
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function isObjectIdShaped(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

/**
 * Describe a value for the evidence report without disclosing it.
 *
 * Numbers and booleans are printed (a bucket size or a count identifies nobody);
 * strings are reduced to a length, because a string field is where a hostname,
 * an address or a device name lives. {@link describeVocabulary} is the deliberate
 * exception for fields whose whole value space the spec enumerates.
 */
export function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'absent';
  }
  if (Array.isArray(value)) {
    return `array[${String(value.length)}]`;
  }
  if (isRecord(value)) {
    return `object{${Object.keys(value).sort().join(',')}}`;
  }
  if (typeof value === 'string') {
    const length = value.length;
    return isObjectIdShaped(value) ? 'objectId-shaped string' : `string(${String(length)})`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${value.toString()}`;
  }
  // A function or a symbol in a JSON response body would itself be the finding.
  return typeof value;
}

/**
 * Print a string only when it is one the spec enumerates, otherwise describe it.
 *
 * Used for envelope `type` (`standard` | `minMaxAvg` | `summed`, spec §12.1–12.3)
 * and similar closed vocabularies: the value carries contract information and no
 * tenant information. Anything outside the documented set is itself the finding,
 * and is reported as unexpected rather than echoed.
 */
export function describeVocabulary(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string') {
    return describeValue(value);
  }
  return allowed.includes(value)
    ? `"${value}"`
    : `UNDOCUMENTED value, ${describeValue(value)} (documented: ${allowed.join(' | ')})`;
}

/** Sorted top-level keys, which are schema rather than tenant data. */
export function keysOf(value: unknown): readonly string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

/** The identifier key a resource actually carried (spec §4.2 records both). */
export function identityKeys(resource: unknown): readonly string[] {
  if (!isRecord(resource)) {
    return [];
  }
  return ['id', '_id'].filter((key) => typeof resource[key] === 'string');
}
