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
 * **READ-ONLY, without exception.** Every call this suite makes is a GET. It
 * never touches `GET /me/token`, `POST /me/token` or `POST /me/token/revoke` —
 * the first two mint credentials and the third would revoke the operator's own
 * working token mid-run (spec §11.2–§11.4).
 */

import { describe, expect, it, type TestContext } from 'vitest';
import { LumicsClient } from '../../src/api/client.js';
import { loadConfig, type LumicsConfig } from '../../src/config.js';

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
    const config = loadConfig(process.env);
    return { client: new LumicsClient(config), config };
  })();
  return cached;
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
      expect(
        HAS_TOKEN && HAS_COMPANY,
        `LUMICS_CONTRACT_TESTS is set but LUMICS_TOKEN and/or LUMICS_COMPANY_ID are missing, so ${label} was NOT validated against a live tenant`,
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
