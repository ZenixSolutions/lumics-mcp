/**
 * Time-window handling — `src/util/time.ts`.
 *
 * spec §12.0 takes `fromMs`/`toMs` as epoch **milliseconds**. The two failure
 * modes worth locking down are the ones a model actually produces: a
 * seconds-vs-milliseconds mix-up (which would silently query 1970) and a
 * reversed or absurdly wide range (which would silently return the wrong data,
 * or nothing, with no indication why).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { LumicsInputError } from '../../src/api/errors.js';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_RANGE_MS,
  MIN_EPOCH_MS,
  DEFAULT_LOOKBACK,
} from '../../src/constants.js';
import {
  describeSpan,
  parseLookbackMs,
  resolveTimeRange,
  toEpochMs,
  validateTimeRange,
} from '../../src/util/time.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A fixed "now" so no test depends on the wall clock. 2026-07-29T12:00:00Z. */
const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);

describe('parseLookbackMs', () => {
  it.each([
    ['15m', 15 * MINUTE],
    ['6h', 6 * HOUR],
    ['7d', 7 * DAY],
    ['30d', 30 * DAY],
    ['1m', MINUTE],
    ['366d', MAX_RANGE_MS],
  ])('parses %s as %i ms', (input, expected) => {
    expect(parseLookbackMs(input)).toBe(expected);
  });

  it.each([
    ['6H', 6 * HOUR],
    [' 7d ', 7 * DAY],
    ['30D', 30 * DAY],
  ])('normalises case and whitespace: %s', (input, expected) => {
    expect(parseLookbackMs(input)).toBe(expected);
  });

  it.each([
    ['garbage', 'unparseable word'],
    ['', 'empty string'],
    ['6', 'missing unit'],
    ['h', 'missing amount'],
    ['6w', 'unsupported unit w'],
    ['6s', 'unsupported unit s'],
    ['-6h', 'negative amount'],
    ['1.5h', 'fractional amount'],
    ['last week', 'natural language'],
    ['P7D', 'ISO-8601 duration'],
    ['1234567d', 'more digits than the pattern allows'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseLookbackMs(input)).toThrow(LumicsInputError);
    expect(() => parseLookbackMs(input)).toThrow(
      /not a recognised relative window|greater than zero/,
    );
  });

  it('rejects a zero-width window rather than returning an empty range', () => {
    expect(() => parseLookbackMs('0h')).toThrow(/greater than zero/);
  });

  it('rejects a span wider than the configured maximum and names the cap', () => {
    expect(() => parseLookbackMs('367d')).toThrow(LumicsInputError);
    expect(() => parseLookbackMs('367d')).toThrow(/exceeds the 366 day\(s\) maximum/);
  });
});

describe('toEpochMs', () => {
  it('converts an ISO-8601 timestamp', () => {
    expect(toEpochMs('2026-07-29T14:00:00Z', 'from')).toBe(Date.UTC(2026, 6, 29, 14, 0, 0));
  });

  it('accepts an all-digit string as epoch milliseconds rather than a year', () => {
    expect(toEpochMs(String(NOW), 'from')).toBe(NOW);
  });

  it('accepts a number that is already epoch milliseconds', () => {
    expect(toEpochMs(NOW, 'to')).toBe(NOW);
  });

  it('rejects epoch SECONDS passed where milliseconds are expected', () => {
    const seconds = Math.floor(NOW / 1000);
    expect(() => toEpochMs(seconds, 'from')).toThrow(LumicsInputError);
    expect(() => toEpochMs(seconds, 'from')).toThrow(/almost certainly epoch \*seconds\*/);
    // The advice must be actionable: say what to do, not just what is wrong.
    expect(() => toEpochMs(seconds, 'from')).toThrow(/multiply by 1000/);
  });

  it('rejects epoch seconds supplied as a digit string too', () => {
    expect(() => toEpochMs(String(Math.floor(NOW / 1000)), 'to')).toThrow(/epoch \*seconds\*/);
  });

  it('accepts the first millisecond the plausibility floor allows', () => {
    expect(toEpochMs(MIN_EPOCH_MS, 'from')).toBe(MIN_EPOCH_MS);
    expect(() => toEpochMs(MIN_EPOCH_MS - 1, 'from')).toThrow(/epoch \*seconds\*/);
  });

  it.each([
    ['', /must not be empty/],
    ['   ', /must not be empty/],
    ['not a date', /is not an ISO-8601 timestamp with an explicit UTC offset/],
    ['2026-13-45T99:99:99Z', /not a real instant/],
  ])('rejects the string %j', (input, matcher) => {
    expect(() => toEpochMs(input, 'from')).toThrow(matcher);
  });

  it.each([
    [Number.NaN, /finite number/],
    [Number.POSITIVE_INFINITY, /finite number/],
    [NOW + 0.5, /whole number of epoch milliseconds/],
  ])('rejects the number %s', (input, matcher) => {
    expect(() => toEpochMs(input, 'to')).toThrow(matcher);
  });

  it('names the offending field in the message', () => {
    expect(() => toEpochMs('nope', 'to')).toThrow(/^to "nope"/);
  });
});

/**
 * Finding M7. `Date.parse` reads a naive timestamp in the process's LOCAL
 * timezone while reading a bare date as UTC — two adjacent input forms on two
 * different clocks in the same argument. Models routinely drop the `Z`, so the
 * window shifted silently by the server's offset and the response notes reported
 * the shifted window, making the wrong answer internally consistent.
 *
 * `TZ` is set per case rather than relying on the runner's timezone, because a
 * suite that happens to run in UTC would pass either way.
 */
describe('toEpochMs requires an explicit zone on any timestamp carrying a time', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it.each([
    ['2026-07-29T14:00:00', 'seconds, no zone'],
    ['2026-07-29T14:00', 'minutes, no zone'],
    ['2026-07-29T14:00:00.500', 'milliseconds, no zone'],
    ['2026-07-29 14:00:00Z', 'space separator instead of T'],
  ])('rejects %j (%s) rather than reading it in the server timezone', (input) => {
    expect(() => toEpochMs(input, 'from')).toThrow(LumicsInputError);
    expect(() => toEpochMs(input, 'from')).toThrow(/explicit UTC offset/);
    // The message must name the fix, not just the fault.
    expect(() => toEpochMs(input, 'from')).toThrow(/2026-07-29T14:00:00Z/);
    // And it must say what would otherwise have happened.
    expect(() => toEpochMs(input, 'from')).toThrow(/local timezone/);
  });

  it.each([
    ['2026-07-29T14:00:00Z', Date.UTC(2026, 6, 29, 14, 0, 0)],
    ['2026-07-29t14:00:00z', Date.UTC(2026, 6, 29, 14, 0, 0)],
    ['2026-07-29T14:00Z', Date.UTC(2026, 6, 29, 14, 0, 0)],
    ['2026-07-29T14:00:00.250Z', Date.UTC(2026, 6, 29, 14, 0, 0, 250)],
    ['2026-07-29T14:00:00+02:00', Date.UTC(2026, 6, 29, 12, 0, 0)],
    ['2026-07-29T14:00:00-0700', Date.UTC(2026, 6, 29, 21, 0, 0)],
  ])('accepts %j as %i', (input, expected) => {
    expect(toEpochMs(input, 'from')).toBe(expected);
  });

  it('reads a bare date as UTC midnight, and does so in every timezone', () => {
    const expected = Date.UTC(2026, 6, 29, 0, 0, 0);
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      expect(toEpochMs('2026-07-29', 'from')).toBe(expected);
    }
  });

  it('is timezone-independent: the same input yields the same instant everywhere', () => {
    const results = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].map((tz) => {
      process.env.TZ = tz;
      return {
        zoned: toEpochMs('2026-07-29T14:00:00Z', 'from'),
        dateOnly: toEpochMs('2026-07-29', 'from'),
      };
    });
    expect(new Set(results.map((r) => r.zoned)).size).toBe(1);
    expect(new Set(results.map((r) => r.dateOnly)).size).toBe(1);
    // The two forms sit on the same clock: 14:00Z is 14 hours after 00:00Z.
    expect((results[0] as { zoned: number }).zoned).toBe(
      (results[0] as { dateOnly: number }).dateOnly + 14 * HOUR,
    );
  });

  it.each([
    ['July 29 2026 14:00', 'a prose date Date.parse would have accepted'],
    ['2026/07/29', 'slash-separated, non-ISO'],
    ['2026-07-29T14:00:00+2:00', 'a malformed offset'],
    ['29-07-2026T14:00:00Z', 'day-first ordering'],
  ])('rejects %j (%s)', (input) => {
    expect(() => toEpochMs(input, 'from')).toThrow(LumicsInputError);
  });
});

/**
 * A shape-valid but calendar-invalid timestamp used to roll over silently.
 * `Date.parse('2026-02-31T00:00:00Z')` is 2026-03-03, so a caller who asked for
 * February 31st got a March window — and the window note then reported
 * "requested 2026-03-03", which makes the wrong answer internally consistent.
 * The comment on `assertParsed` claimed such a value "still lands here"; it did
 * not, because `Date.parse` never returns NaN for it.
 */
describe('toEpochMs rejects a calendar-invalid date instead of rolling it over', () => {
  it.each([
    ['2026-02-31T00:00:00Z', 'February 31st'],
    ['2026-02-30', 'February 30th, date-only'],
    ['2025-02-29', 'February 29th of a non-leap year'],
    ['2026-04-31T12:00:00+02:00', 'April 31st behind an offset'],
    ['2026-06-31T00:00:00Z', 'June 31st'],
    ['2026-09-31', 'September 31st'],
  ])('rejects %j (%s)', (input) => {
    expect(() => toEpochMs(input, 'from')).toThrow(LumicsInputError);
    expect(() => toEpochMs(input, 'from')).toThrow(/not a real calendar date/);
  });

  it('names the date it would otherwise have silently returned', () => {
    expect(() => toEpochMs('2026-02-31T00:00:00Z', 'from')).toThrow(/2026-03-03/);
    expect(() => toEpochMs('2026-02-31T00:00:00Z', 'from')).toThrow(/^from "2026-02-31T00:00:00Z"/);
  });

  it('still accepts every real date, including a leap day and a month end', () => {
    expect(toEpochMs('2024-02-29T00:00:00Z', 'from')).toBe(Date.UTC(2024, 1, 29));
    expect(toEpochMs('2024-02-29', 'from')).toBe(Date.UTC(2024, 1, 29));
    expect(toEpochMs('2026-02-28T23:59:59Z', 'from')).toBe(Date.UTC(2026, 1, 28, 23, 59, 59));
    expect(toEpochMs('2026-04-30T12:00:00+02:00', 'from')).toBe(Date.UTC(2026, 3, 30, 10));
    expect(toEpochMs('2026-12-31T23:59:59.999Z', 'from')).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 59, 999),
    );
  });

  it('refuses the whole window rather than reporting a shifted one', () => {
    expect(() =>
      resolveTimeRange({ from: '2026-02-31T00:00:00Z', to: '2026-03-05T00:00:00Z' }, NOW),
    ).toThrow(/not a real calendar date/);
  });
});

describe('resolveTimeRange', () => {
  it('defaults to the API-documented window of one hour ago to now', () => {
    expect(resolveTimeRange({}, NOW)).toEqual({ fromMs: NOW - HOUR, toMs: NOW });
    // The default must match spec §12.0's own default, expressed as a lookback.
    expect(parseLookbackMs(DEFAULT_LOOKBACK)).toBe(HOUR);
  });

  it('defaults with no argument at all', () => {
    expect(resolveTimeRange(undefined, NOW)).toEqual({ fromMs: NOW - HOUR, toMs: NOW });
  });

  it('applies a lookback ending now', () => {
    expect(resolveTimeRange({ lookback: '6h' }, NOW)).toEqual({
      fromMs: NOW - 6 * HOUR,
      toMs: NOW,
    });
  });

  it('applies a lookback ending at an explicit "to"', () => {
    const to = '2026-07-29T10:00:00Z';
    const toMs = Date.parse(to);
    expect(resolveTimeRange({ lookback: '15m', to }, NOW)).toEqual({
      fromMs: toMs - 15 * MINUTE,
      toMs,
    });
  });

  it('uses explicit from and to verbatim', () => {
    expect(
      resolveTimeRange({ from: '2026-07-28T00:00:00Z', to: '2026-07-29T00:00:00Z' }, NOW),
    ).toEqual({
      fromMs: Date.UTC(2026, 6, 28),
      toMs: Date.UTC(2026, 6, 29),
    });
  });

  it('rejects from and lookback together instead of guessing which was meant', () => {
    expect(() => resolveTimeRange({ from: '2026-07-28T00:00:00Z', lookback: '6h' }, NOW)).toThrow(
      LumicsInputError,
    );
    expect(() => resolveTimeRange({ from: '2026-07-28T00:00:00Z', lookback: '6h' }, NOW)).toThrow(
      /not both/,
    );
  });

  it('rejects a reversed window', () => {
    expect(() =>
      resolveTimeRange({ from: '2026-07-29T00:00:00Z', to: '2026-07-28T00:00:00Z' }, NOW),
    ).toThrow(/empty or reversed/);
  });

  it('rejects a zero-width window', () => {
    const same = '2026-07-29T00:00:00Z';
    expect(() => resolveTimeRange({ from: same, to: same }, NOW)).toThrow(/empty or reversed/);
  });

  it('rejects a from in the future beyond the clock-skew tolerance', () => {
    const fromMs = NOW + MAX_FUTURE_SKEW_MS + 1;
    expect(() =>
      resolveTimeRange({ from: String(fromMs), to: String(fromMs + HOUR) }, NOW),
    ).toThrow(/is in the future/);
  });

  it('tolerates a from inside the clock-skew window', () => {
    const fromMs = NOW + MAX_FUTURE_SKEW_MS - HOUR;
    expect(resolveTimeRange({ from: String(fromMs), to: String(fromMs + HOUR) }, NOW)).toEqual({
      fromMs,
      toMs: fromMs + HOUR,
    });
  });

  /**
   * Finding L4. `from` was checked against the future and `to` was not, so
   * `from = now - 1h, to = now + 120d` was accepted: Lumics has no data past now,
   * so the answer is one hour of samples, but the window note reported a
   * four-month span and the model would describe it as four months of monitoring.
   */
  it('rejects a to in the future, symmetrically with from', () => {
    const toMs = NOW + 120 * DAY;
    expect(() => resolveTimeRange({ from: String(NOW - HOUR), to: String(toMs) }, NOW)).toThrow(
      LumicsInputError,
    );
    expect(() => resolveTimeRange({ from: String(NOW - HOUR), to: String(toMs) }, NOW)).toThrow(
      /to \(.*\) is in the future/,
    );
  });

  it('rejects a future to just past the clock-skew tolerance', () => {
    const toMs = NOW + MAX_FUTURE_SKEW_MS + 1;
    expect(() => resolveTimeRange({ from: String(NOW - HOUR), to: String(toMs) }, NOW)).toThrow(
      /is in the future/,
    );
  });

  it('tolerates a to inside the clock-skew window, for a client whose clock is fast', () => {
    const toMs = NOW + MAX_FUTURE_SKEW_MS - HOUR;
    expect(resolveTimeRange({ from: String(NOW - HOUR), to: String(toMs) }, NOW)).toEqual({
      fromMs: NOW - HOUR,
      toMs,
    });
  });

  it('rejects a span wider than the cap and explains why no-pagination makes it worse', () => {
    const toMs = NOW;
    const fromMs = NOW - MAX_RANGE_MS - 1;
    expect(() => resolveTimeRange({ from: String(fromMs), to: String(toMs) }, NOW)).toThrow(
      /exceeds the 366 day\(s\) maximum/,
    );
    expect(() => resolveTimeRange({ from: String(fromMs), to: String(toMs) }, NOW)).toThrow(
      /no pagination/,
    );
  });
});

describe('validateTimeRange', () => {
  it('returns the range unchanged when it is sound', () => {
    const range = { fromMs: NOW - HOUR, toMs: NOW };
    expect(validateTimeRange(range, NOW)).toEqual(range);
  });

  it('accepts exactly the maximum span', () => {
    const range = { fromMs: NOW - MAX_RANGE_MS, toMs: NOW };
    expect(validateTimeRange(range, NOW)).toEqual(range);
  });

  it('rejects epoch seconds in either bound', () => {
    expect(() => validateTimeRange({ fromMs: 1_700_000, toMs: NOW }, NOW)).toThrow(
      /fromMs \(1700000\)/,
    );
    expect(() => validateTimeRange({ fromMs: NOW - HOUR, toMs: 1_700_000 }, NOW)).toThrow(
      /toMs \(1700000\)/,
    );
  });
});

describe('describeSpan', () => {
  it.each([
    [45 * MINUTE, '45 minute(s)'],
    [6 * HOUR, '6 hour(s)'],
    [366 * DAY, '366 day(s)'],
    [MINUTE, '1 minute(s)'],
    [HOUR - 1, '60 minute(s)'],
    [90 * MINUTE, '1.5 hour(s)'],
    [0, '0 minute(s)'],
  ])('formats %i ms as %s', (spanMs, expected) => {
    expect(describeSpan(spanMs)).toBe(expected);
  });
});
