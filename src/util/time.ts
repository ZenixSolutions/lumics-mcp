/**
 * Epoch-millisecond time windows, so a model never has to compute one.
 *
 * spec §12.0: the metric endpoints take `fromMs`/`toMs` as integer epoch
 * **milliseconds**; `fromMs` defaults to one hour ago and `toMs` to now. There is
 * no `start`, `end`, `since` or `duration` parameter. RFC-001 D5 item 1 makes
 * absorbing that our problem rather than the model's: callers pass ISO-8601
 * timestamps or a relative lookback like `15m` / `6h` / `7d` / `30d`, and this
 * module produces the pair.
 *
 * Two failure modes are guarded explicitly because they are the ones models
 * actually hit: seconds-vs-milliseconds confusion (caught by
 * {@link MIN_EPOCH_MS}) and a reversed or absurdly wide range.
 *
 * Note on layering: this imports `LumicsInputError` from the API layer purely to
 * keep one error taxonomy for the whole server. `src/api/errors.ts` is a leaf
 * module with no dependency back on `util/`, so the cycle does not exist.
 */

import { LumicsInputError } from '../api/errors.js';
import { DEFAULT_LOOKBACK, MAX_FUTURE_SKEW_MS, MAX_RANGE_MS, MIN_EPOCH_MS } from '../constants.js';

/** Resolved, validated window ready to become `fromMs`/`toMs` query parameters. */
export interface TimeRange {
  readonly fromMs: number;
  readonly toMs: number;
}

/** What a tool accepts. All three fields are optional; see {@link resolveTimeRange}. */
export interface TimeRangeInput {
  /** ISO-8601 timestamp or epoch milliseconds for the start of the window. */
  readonly from?: string | number | undefined;
  /** ISO-8601 timestamp or epoch milliseconds for the end of the window. */
  readonly to?: string | number | undefined;
  /** Relative window ending at `to` (default now), e.g. `15m`, `6h`, `7d`, `30d`. */
  readonly lookback?: string | undefined;
}

const LOOKBACK_PATTERN = /^(\d{1,6})(m|h|d)$/;

const UNIT_MS = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

type LookbackUnit = keyof typeof UNIT_MS;

function isLookbackUnit(value: string): value is LookbackUnit {
  return value === 'm' || value === 'h' || value === 'd';
}

/**
 * Accepts `<integer><unit>` with unit `m` (minutes), `h` (hours) or `d` (days)
 * and returns the span in milliseconds. Case-insensitive; surrounding
 * whitespace is tolerated because models add it.
 *
 * Rejects `0`-length spans and anything wider than {@link MAX_RANGE_MS}.
 */
export function parseLookbackMs(lookback: string): number {
  const normalised = lookback.trim().toLowerCase();
  const match = LOOKBACK_PATTERN.exec(normalised);
  if (!match) {
    throw new LumicsInputError(
      `lookback "${lookback}" is not a recognised relative window. Use an integer followed by m (minutes), h (hours) or d (days) — for example 15m, 6h, 7d or 30d.`,
    );
  }

  const amount = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;
  if (!isLookbackUnit(unit)) {
    throw new LumicsInputError(
      `lookback unit "${unit}" is not supported. Use m (minutes), h (hours) or d (days).`,
    );
  }
  const unitMs = UNIT_MS[unit];

  if (amount === 0) {
    throw new LumicsInputError(
      'lookback must be greater than zero; a zero-width window returns no data.',
    );
  }

  const spanMs = amount * unitMs;
  if (spanMs > MAX_RANGE_MS) {
    throw new LumicsInputError(
      `lookback "${lookback}" spans ${describeSpan(spanMs)}, which exceeds the ${describeSpan(MAX_RANGE_MS)} maximum this server allows. Request a narrower window.`,
    );
  }

  return spanMs;
}

/** `YYYY-MM-DD`, with no time component. Interpreted as UTC midnight. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DDTHH:MM[:SS[.sss]]` followed by a **required** zone: `Z`, `z`, or a
 * numeric offset (`+02:00`, `-0700`).
 */
const ZONED_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * Convert an ISO-8601 timestamp (or epoch milliseconds) to epoch milliseconds.
 *
 * A bare number is accepted so a caller who already has epoch ms is not forced
 * to stringify it, but it must be plausibly milliseconds: a value below
 * {@link MIN_EPOCH_MS} is rejected as a seconds-vs-milliseconds error rather
 * than silently interpreted as 1970.
 *
 * **A timestamp carrying a time must carry a zone.** `Date.parse` reads
 * `2026-07-29T14:00:00` in the *server's* local timezone while reading
 * `2026-07-29` as UTC midnight — two adjacent input forms on two different
 * clocks in the same argument. Under `TZ=America/Los_Angeles` the first form
 * silently becomes 21:00Z, the window moves seven hours, and the response notes
 * report the moved window, so the wrong answer is internally consistent and
 * nothing looks wrong. `Date.parse` is also permitted to accept non-ISO input
 * such as `July 29 2026 14:00` and `2026/07/29`, which is why the shape is
 * checked here rather than delegated.
 *
 * Two forms are accepted, and only two:
 *  - `YYYY-MM-DD` — a bare date, which means **00:00:00Z**, UTC midnight.
 *  - `YYYY-MM-DDTHH:MM[:SS[.sss]]` plus `Z` or a numeric offset.
 */
export function toEpochMs(value: string | number, field: string): number {
  if (typeof value === 'number') {
    return assertPlausibleEpochMs(value, field);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LumicsInputError(
      `${field} must not be empty. Supply an ISO-8601 timestamp such as 2026-07-29T14:00:00Z.`,
    );
  }

  // A pure-digit string is epoch ms, not a year.
  if (/^\d+$/.test(trimmed)) {
    return assertPlausibleEpochMs(Number.parseInt(trimmed, 10), field);
  }

  if (DATE_ONLY_PATTERN.test(trimmed)) {
    // Made explicit rather than relying on `Date.parse`'s date-only rule, so the
    // meaning of this form is a decision in this file and not a JavaScript
    // trivia question.
    return assertPlausibleEpochMs(assertParsed(`${trimmed}T00:00:00Z`, value, field), field);
  }

  if (!ZONED_TIMESTAMP_PATTERN.test(trimmed)) {
    throw new LumicsInputError(
      `${field} "${value}" is not an ISO-8601 timestamp with an explicit UTC offset. Use 2026-07-29T14:00:00Z, or an offset form such as 2026-07-29T14:00:00+02:00; a bare date like 2026-07-29 is also accepted and means 00:00:00Z (UTC midnight). A timestamp with a time but no zone, such as 2026-07-29T14:00:00, is REJECTED rather than guessed at: it would be read in this server's local timezone, which silently shifts your window by that timezone's offset and makes the returned data describe hours you did not ask for. The easiest alternative is a relative lookback such as 6h or 7d, which needs no timezone at all.`,
    );
  }

  return assertPlausibleEpochMs(assertParsed(trimmed, value, field), field);
}

/**
 * `Date.parse` on input whose *shape* is already validated. A shape-valid but
 * calendar-invalid value (`2026-02-31T00:00:00Z`) still lands here.
 */
function assertParsed(candidate: string, original: string, field: string): number {
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) {
    throw new LumicsInputError(
      `${field} "${original}" has the shape of an ISO-8601 timestamp but is not a real instant — check the month, day and hour values. Use a form like 2026-07-29T14:00:00Z.`,
    );
  }
  return parsed;
}

/**
 * Resolve a caller's window into `{fromMs, toMs}`.
 *
 * Precedence, chosen so the common case needs no arguments at all:
 *  1. `to` if given, otherwise now.
 *  2. `from` if given; otherwise `to - lookback`, with `lookback` defaulting to
 *     {@link DEFAULT_LOOKBACK} — which matches the API's own documented default
 *     of one hour (spec §12.0).
 *
 * Supplying `from` and `lookback` together is rejected rather than silently
 * resolved: the two disagree and guessing which the caller meant is how wrong
 * data gets reported as right.
 */
export function resolveTimeRange(input: TimeRangeInput = {}, now: number = Date.now()): TimeRange {
  if (input.from !== undefined && input.lookback !== undefined) {
    throw new LumicsInputError(
      'Specify either an explicit from/to window or a relative lookback, not both. They describe the same thing and would conflict.',
    );
  }

  const toMs = input.to === undefined ? now : toEpochMs(input.to, 'to');
  const fromMs =
    input.from === undefined
      ? toMs - parseLookbackMs(input.lookback ?? DEFAULT_LOOKBACK)
      : toEpochMs(input.from, 'from');

  return validateTimeRange({ fromMs, toMs }, now);
}

/**
 * Ordering and sanity checks, separated so it can be unit-tested directly and
 * reused by any caller that already holds epoch milliseconds.
 */
export function validateTimeRange(range: TimeRange, now: number = Date.now()): TimeRange {
  const { fromMs, toMs } = range;

  assertPlausibleEpochMs(fromMs, 'fromMs');
  assertPlausibleEpochMs(toMs, 'toMs');

  if (fromMs >= toMs) {
    throw new LumicsInputError(
      `The time window is empty or reversed: from (${new Date(fromMs).toISOString()}) must be strictly earlier than to (${new Date(toMs).toISOString()}).`,
    );
  }

  const spanMs = toMs - fromMs;
  if (spanMs > MAX_RANGE_MS) {
    throw new LumicsInputError(
      `The requested window spans ${describeSpan(spanMs)}, which exceeds the ${describeSpan(MAX_RANGE_MS)} maximum this server allows. Lumics has no pagination, so a window this wide would be silently truncated by the result limit. Request a narrower window.`,
    );
  }

  if (fromMs > now + MAX_FUTURE_SKEW_MS) {
    throw new LumicsInputError(
      `from (${new Date(fromMs).toISOString()}) is in the future. Monitoring data only exists for the past; check whether you meant a past date.`,
    );
  }

  // Checked symmetrically with `from`. Unchecked, `from = now - 1h` with
  // `to = now + 120d` was accepted: Lumics has no data past now, so the result is
  // one hour of data, but the window note reported a four-month span and the
  // model would describe an hour of samples as four months of monitoring.
  if (toMs > now + MAX_FUTURE_SKEW_MS) {
    throw new LumicsInputError(
      `to (${new Date(toMs).toISOString()}) is in the future. Monitoring data only exists for the past, so a future end date does not extend the result — it only makes the reported window wrong. Omit "to" to mean now, or give a past timestamp.`,
    );
  }

  return { fromMs, toMs };
}

/** Format a span for a message: "45 minutes", "6 hours", "366 days". */
export function describeSpan(spanMs: number): string {
  if (spanMs >= UNIT_MS.d) {
    return `${round(spanMs / UNIT_MS.d)} day(s)`;
  }
  if (spanMs >= UNIT_MS.h) {
    return `${round(spanMs / UNIT_MS.h)} hour(s)`;
  }
  return `${round(spanMs / UNIT_MS.m)} minute(s)`;
}

function assertPlausibleEpochMs(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new LumicsInputError(`${field} must be a finite number of epoch milliseconds.`);
  }
  if (!Number.isInteger(value)) {
    throw new LumicsInputError(
      `${field} must be a whole number of epoch milliseconds; received ${String(value)}.`,
    );
  }
  if (value < MIN_EPOCH_MS) {
    throw new LumicsInputError(
      `${field} (${String(value)}) is before ${new Date(MIN_EPOCH_MS).toISOString()} and is almost certainly epoch *seconds*. Lumics expects epoch milliseconds — multiply by 1000, or pass an ISO-8601 timestamp and let this server convert it.`,
    );
  }
  return value;
}

function round(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}
