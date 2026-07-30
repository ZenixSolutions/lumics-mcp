/**
 * CONTRACT tests for the metric endpoints (spec §12). **Opt-in only.**
 *
 * This is the part of the contract with the most at stake. RFC-001 records that
 * the prototype's metric layer "cannot reliably have worked": it sent no
 * resolution parameter at all, and it typed `sum` as a boolean. This server's
 * metric tools are built on four assumptions taken from the vendor's written
 * documentation and never once executed:
 *
 *  1. `dataPoints` is accepted, and actually changes the series you get back.
 *     `src/tools/metrics.ts` **always** sends it, because spec §12.0 says either
 *     `dataPoints` or `width` is required. If that is wrong in either direction —
 *     ignored, or rejected — every metric tool is affected.
 *  2. `sum` is the string enum `min | max | avg`, not a boolean (spec §12.2).
 *  3. `interval` is exactly `minute | fiveMin | hour | day` (spec §12.0).
 *  4. `fromMs`/`toMs` are epoch **milliseconds**, defaulting to one hour ago and
 *     now (spec §12.0), which is what `src/util/time.ts` exists to produce.
 *
 * Plus two envelope shapes the tool layer unwraps differently: §12.1–§12.3 return
 * `{data: [...]}`, §12.4 returns `{data: {devices: [...]}, count: n}`.
 *
 * **READ-ONLY.** Every call here is a GET. Nothing touches the token endpoints.
 *
 * **Cost.** These hit a live production monitoring system, so windows are one
 * hour (24 hours only where the test needs enough buckets to compare), and
 * `dataPoints` is 2–48. Discovery is bounded to a handful of probes and its
 * results are reused. One `LumicsClient` is shared for the whole file so the
 * concurrency semaphore actually bounds the run.
 *
 * A failure here is a **documentation defect to report** (CLAUDE.md), not a
 * licence to change `src/`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companyMetricsPath,
  companyMetricsSummarizePath,
  deviceItemMetricsPath,
  deviceMetricsPath,
  devicesPath,
  componentTypesPath,
  metricSummariesPath,
} from '../../src/api/paths.js';
import { expectArray } from '../../src/api/client.js';
import type { ComponentType, Device } from '../../src/domain/index.js';
import { resourceId } from '../../src/domain/index.js';
import {
  api,
  attempt,
  declareSkipExplanation,
  describeOutcome,
  describeValue,
  describeVocabulary,
  DOCUMENTED_STATUSES,
  isRecord,
  keysOf,
  recordAsserted,
  recordObserved,
  reportEvidence,
  RUNNABLE,
  unverifiable,
} from './harness.js';

/** Live calls plus client-side retry; the 5s default would flake on latency. */
const TIMEOUT = 60_000;
const DISCOVERY_TIMEOUT = 120_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Deliberately tiny: this is a contract check, not a data pull. */
const SMALL_DATA_POINTS = 6;
/** The pair the bucket-count comparison uses. */
const COARSE_DATA_POINTS = 2;
const FINE_DATA_POINTS = 48;

/** spec §12.0. Sent verbatim; the enum is the thing under test. */
const DOCUMENTED_INTERVALS = ['minute', 'fiveMin', 'hour', 'day'] as const;
/** spec §12.2. */
const DOCUMENTED_SUMS = ['min', 'max', 'avg'] as const;
/** spec §12.1–§12.3 envelope `type` values seen in the vendor's examples. */
const DOCUMENTED_ENVELOPE_TYPES = ['standard', 'minMaxAvg', 'summed'];

/**
 * Fallback module name. `snmp` is not invented: it is the module the vendor's own
 * §12.1 and §12.3 examples use. Only reached when `componenttypes` is empty and
 * no device declares a module, in which case the acceptance tests still have
 * something valid-looking to send and the data-dependent ones go UNVERIFIED.
 */
const FALLBACK_MODULE = 'snmp';

interface Fixture {
  /** Module used for company-scoped calls (§12.1, §12.2, §12.4). */
  readonly moduleType: string;
  /** True when a plain call to §12.1 for {@link moduleType} returned 2xx. */
  readonly controlOk: boolean;
  /** Modules probed, so an UNVERIFIED entry can say what was tried. */
  readonly probedModules: readonly string[];
  /** Rows the probe returned, reused as the baseline by several tests. */
  readonly baselineRows: readonly Record<string, unknown>[];
  /** `data[].type` seen in the probe — a real, live component type string. */
  readonly itemType: string | undefined;
  /** A `group.property` path present in the probe's `stats` (spec §12.0). */
  readonly propertyPath: string | undefined;
  /** A device that reports {@link deviceModuleType}, for §12.3. */
  readonly deviceId: string | undefined;
  readonly deviceModuleType: string | undefined;
}

let fixture: Fixture | undefined;

/** Non-null accessor so tests do not each repeat the undefined check. */
function fx(): Fixture {
  if (fixture === undefined) {
    throw new Error('discovery did not run — this is a bug in the contract suite, not in Lumics');
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined>;

/** A one-hour window ending now, in epoch ms — the API's own default span. */
function hourWindow(): { fromMs: number; toMs: number } {
  const toMs = Date.now();
  return { fromMs: toMs - HOUR_MS, toMs };
}

function companySeries(query: Query): Promise<unknown> {
  const { client, config } = api();
  return client.get<unknown>(companyMetricsPath(config.companyId, fx().moduleType), { query });
}

function companySummarize(query: Query): Promise<unknown> {
  const { client, config } = api();
  return client.get<unknown>(companyMetricsSummarizePath(config.companyId, fx().moduleType), {
    query,
  });
}

function summaries(query: Query): Promise<unknown> {
  const { client, config } = api();
  return client.get<unknown>(metricSummariesPath(config.companyId, fx().moduleType), { query });
}

/** `{data, ...meta}` split the way `src/tools/metrics.ts` splits it (spec §12.1). */
function envelope(response: unknown): {
  readonly data: unknown;
  readonly meta: Record<string, unknown>;
} {
  if (!isRecord(response)) {
    return { data: undefined, meta: {} };
  }
  const { data, ...meta } = response;
  return { data, meta };
}

function rowsOf(response: unknown): readonly Record<string, unknown>[] {
  const { data } = envelope(response);
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function numberFrom(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Flatten `stats` into the `group.property` paths spec §12.0 uses. */
function statPaths(row: Record<string, unknown>): readonly string[] {
  const stats = row['stats'];
  if (!isRecord(stats)) {
    return [];
  }
  const paths: string[] = [];
  for (const [group, properties] of Object.entries(stats)) {
    if (isRecord(properties)) {
      for (const property of Object.keys(properties)) {
        paths.push(`${group}.${property}`);
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Find a module that actually reports data, plus a device that does.
 *
 * spec §14 defect 14: no enumeration of `moduleType` or component `itemType` is
 * documented anywhere, so both have to be discovered from `componenttypes` and
 * from the devices' own `modules` maps. Probing is bounded — at most four
 * company-level probes and three device probes, each a one-hour window at
 * `lastMetric=true`, which is the cheapest shape of metric request there is.
 */
async function discover(): Promise<Fixture> {
  const { client, config } = api();
  const window = hourWindow();

  const types = expectArray<ComponentType>(
    await client.get(componentTypesPath(config.companyId)),
    'GET componenttypes',
  );
  const modules = [...new Set(types.map((type) => type.module).filter(isNonEmptyString))];
  const candidates = (modules.length > 0 ? modules : [FALLBACK_MODULE]).slice(0, 4);

  let moduleType = candidates[0] ?? FALLBACK_MODULE;
  let controlOk = false;
  let baselineRows: readonly Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    const outcome = await attempt(
      client.get<unknown>(companyMetricsPath(config.companyId, candidate), {
        query: { ...window, dataPoints: SMALL_DATA_POINTS, lastMetric: true },
      }),
    );
    if (!outcome.ok) {
      continue;
    }
    const rows = rowsOf(outcome.value);
    if (!controlOk) {
      // First module that answers at all becomes the control, even with no rows:
      // the acceptance tests only need a module the API is willing to serve.
      moduleType = candidate;
      controlOk = true;
    }
    if (rows.length > 0) {
      moduleType = candidate;
      baselineRows = rows;
      break;
    }
  }

  const firstRow = baselineRows[0];
  const itemType =
    firstRow !== undefined && isNonEmptyString(firstRow['type']) ? firstRow['type'] : undefined;
  const propertyPath = firstRow === undefined ? undefined : statPaths(firstRow)[0];

  const devices = expectArray<Device>(
    await client.get(devicesPath(config.companyId), { query: { limit: 3 } }),
    'GET devices',
  );

  let deviceId: string | undefined;
  let deviceModuleType: string | undefined;

  for (const device of devices) {
    const id = resourceId(device);
    const deviceModules = deviceModuleNames(device);
    if (id === undefined || deviceModules.length === 0) {
      continue;
    }
    const candidate = deviceModules[0];
    if (candidate === undefined) {
      continue;
    }
    deviceId ??= id;
    deviceModuleType ??= candidate;

    const outcome = await attempt(
      client.get<unknown>(deviceMetricsPath(id, candidate), {
        query: { ...window, dataPoints: SMALL_DATA_POINTS, lastMetric: true },
      }),
    );
    if (outcome.ok && rowsOf(outcome.value).length > 0) {
      deviceId = id;
      deviceModuleType = candidate;
      break;
    }
  }

  return {
    moduleType,
    controlOk,
    probedModules: candidates,
    baselineRows,
    itemType,
    propertyPath,
    deviceId,
    deviceModuleType,
  };
}

/**
 * spec §7.1: `modules` is a map whose *key* need not equal the module name, so
 * the `module` field is read rather than the key.
 */
function deviceModuleNames(device: Device): readonly string[] {
  const modules = device.modules;
  if (!isRecord(modules)) {
    return [];
  }
  const names: string[] = [];
  for (const value of Object.values(modules)) {
    if (isRecord(value) && isNonEmptyString(value['module'])) {
      names.push(value['module']);
    }
  }
  return [...new Set(names)];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

beforeAll(async () => {
  if (!RUNNABLE) {
    return;
  }
  fixture = await discover();
}, DISCOVERY_TIMEOUT);

afterAll(() => {
  reportEvidence('metric endpoints (spec section 12)');
});

// ---------------------------------------------------------------------------
// Assumption 1 — dataPoints (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — dataPoints', () => {
  it(
    'ASSERT: dataPoints is accepted on the company metric endpoint',
    async (ctx) => {
      const state = fx();
      if (!state.controlOk) {
        unverifiable(
          ctx,
          '12.0',
          'dataPoints is an accepted query parameter on the metric-data endpoints',
          `no metric module answered at all (probed: ${state.probedModules.join(', ')}), so a rejection could not be attributed to dataPoints rather than to the module name`,
        );
      }
      const outcome = await attempt(
        companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS }),
      );
      expect(
        outcome.ok,
        `dataPoints=${String(SMALL_DATA_POINTS)} was ${describeOutcome(outcome)}. spec section 12.0 documents dataPoints as one of the two accepted resolution parameters, and src/tools/metrics.ts sends it on EVERY metric call — if it is rejected, every metric tool is broken. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'dataPoints is an accepted query parameter on the metric-data endpoints',
        `module "${state.moduleType}" accepted dataPoints=${String(SMALL_DATA_POINTS)}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: dataPoints changes the number of buckets returned',
    async (ctx) => {
      const state = fx();
      const toMs = Date.now();
      const window = { fromMs: toMs - DAY_MS, toMs };
      const shared = { ...window, aggregate: true, itemType: state.itemType };

      const coarse = await companySummarize({ ...shared, dataPoints: COARSE_DATA_POINTS });
      const fine = await companySummarize({ ...shared, dataPoints: FINE_DATA_POINTS });

      const coarseRows = rowsOf(coarse).length;
      const fineRows = rowsOf(fine).length;
      const coarseIncrement = numberFrom(envelope(coarse).meta, 'timeIncrement');
      const fineIncrement = numberFrom(envelope(fine).meta, 'timeIncrement');
      const detail =
        `dataPoints=${String(COARSE_DATA_POINTS)} -> ${String(coarseRows)} bucket(s), timeIncrement ${describeValue(coarseIncrement)}; ` +
        `dataPoints=${String(FINE_DATA_POINTS)} -> ${String(fineRows)} bucket(s), timeIncrement ${describeValue(fineIncrement)} (24h window, module "${state.moduleType}")`;

      // A finer request that yields no more buckets than the coarse request asked
      // for cannot distinguish "dataPoints ignored" from "this tenant has almost
      // no history in the window". Say so rather than pass.
      if (fineRows <= COARSE_DATA_POINTS && coarseIncrement === fineIncrement) {
        unverifiable(
          ctx,
          '12.0',
          'dataPoints influences the number of buckets returned',
          `${detail} — too few buckets exist in this window to tell influence from absent data`,
        );
      }

      expect(
        fineRows > coarseRows || coarseIncrement !== fineIncrement,
        `dataPoints appears to be IGNORED: ${detail}. spec section 12.0 documents it as the resolution control ("the number of data points to return"). If this is real, every metric tool returns a series at a resolution nobody chose. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'dataPoints influences the returned resolution (bucket count and/or timeIncrement)',
        detail,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: what happens when neither dataPoints nor width is sent',
    async () => {
      const state = fx();
      const outcome = await attempt(companySeries(hourWindow()));

      // The assertion is real: spec section 3 is explicit that its table is the
      // only documented status set, so an undocumented status is drift.
      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `omitting both resolution parameters produced ${describeOutcome(outcome)}, which spec section 3 does not document.`,
      ).toBe(true);

      recordObserved(
        '12.0',
        'spec says "Either dataPoints or width must be set" — is a call with neither actually rejected?',
        `${describeOutcome(outcome)} (module "${state.moduleType}"). ${
          outcome.ok
            ? "The API served the call, so this server's always-send-a-resolution behaviour (RFC-001 D5 item 2) is helpful rather than load-bearing."
            : 'The requirement is real: a metric call with no resolution fails, and the default in src/tools/metrics.ts is what keeps model-issued calls working.'
        }`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 2 — sum (spec §12.2)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.2 — sum is a string enum, not a boolean', () => {
  it.each([...DOCUMENTED_SUMS])(
    'ASSERT: summarize accepts sum="%s"',
    async (sum) => {
      const outcome = await attempt(
        companySummarize({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, sum }),
      );
      expect(
        outcome.ok,
        `sum="${sum}" was ${describeOutcome(outcome)}. spec section 12.2 documents sum as a string naming which per-component rollup property feeds the cross-component total, with values min, max or avg. RFC-001 records that the prototype typed this as a boolean and was malformed on every summarize call; if the string form is rejected too, the parameter is not what the docs say and must be reported.`,
      ).toBe(true);
      recordAsserted(
        '12.2',
        'sum accepts the documented string values min | max | avg',
        `sum="${sum}" accepted`,
      );
    },
    TIMEOUT,
  );

  it(
    "OBSERVE: how the API treats a boolean-ish sum (the prototype's bug)",
    async () => {
      // Sent once, deliberately, to characterise the failure the prototype would
      // have produced. Production code must never send this.
      const outcome = await attempt(
        companySummarize({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, sum: true }),
      );
      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `sum=true produced ${describeOutcome(outcome)}, which spec section 3 does not document.`,
      ).toBe(true);
      recordObserved(
        '12.2',
        'sum is documented as a string; what does a boolean value do?',
        `sum=true was ${describeOutcome(outcome)}. ${
          outcome.ok
            ? "Accepted — so the prototype's boolean sum produced a SILENTLY wrong aggregation rather than an error, which is the worse failure mode and worth stating in the release notes."
            : "Rejected — so the prototype's boolean sum failed loudly."
        }`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: whether the envelope reports a different aggregation mode with sum',
    async (ctx) => {
      const withoutSum = await companySummarize({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
      });
      const withSum = await companySummarize({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        sum: 'max',
      });

      const plain = envelope(withoutSum).meta['type'];
      const summed = envelope(withSum).meta['type'];
      if (plain === undefined && summed === undefined) {
        unverifiable(
          ctx,
          '12.2',
          'presence of sum switches the cross-component reduction from average to sum',
          'neither response carried the envelope "type" field the vendor examples show, so the mode cannot be read',
        );
      }
      recordObserved(
        '12.2',
        'presence of sum switches the reduction from average to sum (vendor example shows type "summed")',
        `without sum: type ${describeVocabulary(plain, DOCUMENTED_ENVELOPE_TYPES)}; with sum=max: type ${describeVocabulary(summed, DOCUMENTED_ENVELOPE_TYPES)}`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 3 — interval (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — the interval enum', () => {
  it.each([...DOCUMENTED_INTERVALS])(
    'ASSERT: interval="%s" is accepted',
    async (interval) => {
      const outcome = await attempt(
        companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, interval }),
      );
      expect(
        outcome.ok,
        `interval="${interval}" was ${describeOutcome(outcome)}. spec section 12.0 documents exactly four valid options — minute, fiveMin, hour, day — and src/constants.ts METRIC_INTERVALS mirrors them. A rejection means the enum in the docs is wrong; report it.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'interval accepts the documented values minute | fiveMin | hour | day',
        `interval="${interval}" accepted`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: whether an out-of-enum interval is rejected or silently ignored',
    async () => {
      const window = hourWindow();
      // "tenMin" is not in the documented enum. Sent once to establish which of
      // the two failure modes applies; the difference matters because a silently
      // ignored interval returns a series at a resolution the caller did not ask
      // for and cannot detect.
      const baseline = await attempt(
        companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, interval: 'hour' }),
      );
      const bogus = await attempt(
        companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, interval: 'tenMin' }),
      );

      expect(
        bogus.ok || bogus.status === undefined || DOCUMENTED_STATUSES.includes(bogus.status),
        `interval="tenMin" produced ${describeOutcome(bogus)}, which spec section 3 does not document.`,
      ).toBe(true);

      const baselineIncrement = baseline.ok
        ? numberFrom(envelope(baseline.value).meta, 'timeIncrement')
        : undefined;
      const bogusIncrement = bogus.ok
        ? numberFrom(envelope(bogus.value).meta, 'timeIncrement')
        : undefined;

      recordObserved(
        '12.0',
        'the docs list four interval values but do not say what an unrecognised one does',
        `interval="tenMin" was ${describeOutcome(bogus)}; timeIncrement ${describeValue(bogusIncrement)} versus ${describeValue(baselineIncrement)} for interval="hour". ${
          bogus.ok
            ? 'Accepted, so an unrecognised interval does NOT fail loudly — a typo in an interval yields a silently different resolution.'
            : 'Rejected, so an unrecognised interval fails fast.'
        }`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 4 — the fromMs/toMs window (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — fromMs/toMs are epoch milliseconds', () => {
  it(
    'ASSERT: the echoed window proves the values were read as milliseconds, not seconds',
    async (ctx) => {
      const window = hourWindow();
      const response = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const meta = envelope(response).meta;
      const echoedFromMs = numberFrom(meta, 'fromMs');
      const echoedFrom = meta['from'];

      if (echoedFromMs === undefined || typeof echoedFrom !== 'string') {
        unverifiable(
          ctx,
          '12.0',
          'fromMs/toMs are epoch milliseconds',
          `the response carried no numeric fromMs and/or no ISO "from" to compare (meta keys: ${keysOf(meta).join(',')})`,
        );
      }

      const parsed = Date.parse(echoedFrom);
      expect(
        Number.isNaN(parsed),
        'the envelope\'s "from" was not a parseable ISO-8601 timestamp (spec section 12.1 documents one).',
      ).toBe(false);

      // The envelope is self-consistent: `from` is the ISO rendering of `fromMs`.
      expect(
        parsed,
        'the envelope\'s ISO "from" does not correspond to its own numeric "fromMs" — the two disagree, which makes the reported window untrustworthy.',
      ).toBe(echoedFromMs);

      // The unit claim. Had the API read our integer as epoch *seconds*, the
      // echoed instant would land in 1970, roughly 55 years away. A day of
      // tolerance leaves room for rollup snapping without weakening the check.
      expect(
        Math.abs(parsed - window.fromMs) <= DAY_MS,
        `the window we requested came back as ${new Date(parsed).toISOString()}, which is more than a day from what was sent. spec section 12.0 documents fromMs/toMs as epoch MILLISECONDS; a value near 1970 would mean the API reads them as seconds and src/util/time.ts is producing the wrong unit on every metric call.`,
      ).toBe(true);

      recordAsserted(
        '12.0',
        'fromMs/toMs are interpreted as epoch milliseconds and echoed consistently as ISO instants',
        `requested a 1h window; envelope echoed an instant within a day of it and its ISO "from" matched its own fromMs`,
      );
      recordObserved(
        '12.0',
        'whether the echoed window is the requested window or an adjusted one',
        echoedFromMs === window.fromMs
          ? 'echoed fromMs equals the requested value exactly (no adjustment without alignTimeRange)'
          : `echoed fromMs differs from the requested value by ${String(echoedFromMs - window.fromMs)} ms even though alignTimeRange was not sent — the effective window is not the requested one`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: returned data falls inside the effective window',
    async (ctx) => {
      const window = hourWindow();
      const response = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const meta = envelope(response).meta;
      const rows = rowsOf(response);
      const timestamps = rows
        .map((row) => numberFrom(row, 'timeMs'))
        .filter((value): value is number => value !== undefined);

      if (timestamps.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'the requested fromMs/toMs window is honoured by the returned data',
          `module "${fx().moduleType}" returned ${String(rows.length)} row(s) with no numeric timeMs over the last hour, so there is nothing to place inside the window`,
        );
      }

      const from = numberFrom(meta, 'fromMs') ?? window.fromMs;
      const to = numberFrom(meta, 'toMs') ?? window.toMs;
      // A bucket is stamped at one of its edges, so one bucket of slack is the
      // honest tolerance. Never less than a minute — the finest documented rollup.
      const slack = Math.max(numberFrom(meta, 'timeIncrement') ?? 0, 60_000);
      const outside = timestamps.filter((value) => value < from - slack || value > to + slack);

      expect(
        outside.length,
        `${String(outside.length)} of ${String(timestamps.length)} returned point(s) fall outside the effective window Lumics itself reported, allowing one bucket (${String(slack)} ms) of slack. spec section 12.0 documents fromMs/toMs as the time-range control; if data outside the window comes back, every windowed answer this server gives is wider than it claims. Report this.`,
      ).toBe(0);

      recordAsserted(
        '12.0',
        'data returned falls inside the requested/effective fromMs..toMs window',
        `${String(timestamps.length)} timestamped point(s) checked against the echoed window with ${String(slack)} ms slack`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: omitting fromMs/toMs yields the documented one-hour default',
    async (ctx) => {
      const before = Date.now();
      const response = await companySeries({ dataPoints: SMALL_DATA_POINTS });
      const after = Date.now();
      const meta = envelope(response).meta;
      const from = numberFrom(meta, 'fromMs');
      const to = numberFrom(meta, 'toMs');

      if (from === undefined || to === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'fromMs defaults to one hour ago and toMs to now',
          `the response echoed no numeric window (meta keys: ${keysOf(meta).join(',')}), so the default cannot be read`,
        );
      }

      const span = to - from;
      expect(
        Math.abs(span - HOUR_MS) <= 120_000,
        `the default window spans ${String(span)} ms, not the documented one hour (${String(HOUR_MS)} ms). spec section 12.0: "Defaults to one hour ago if not specified". src/util/time.ts DEFAULT_LOOKBACK mirrors that hour, so a different server-side default means this server's stated window and the data disagree.`,
      ).toBe(true);
      expect(
        to >= before - 120_000 && to <= after + 120_000,
        `the default toMs (${new Date(to).toISOString()}) is not "the current time" as spec section 12.0 documents.`,
      ).toBe(true);

      recordAsserted(
        '12.0',
        'omitting fromMs/toMs yields a one-hour window ending now',
        `echoed span ${String(span)} ms, within 2 minutes of the documented 3600000 ms`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 5 — envelope shapes (spec §12.1–§12.4)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.1-12.4 — response envelopes', () => {
  it(
    'ASSERT: the company metric endpoint returns {data: [...]} (spec 12.1)',
    async () => {
      const response = await companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS });
      assertSeriesEnvelope(response, '12.1', 'company metrics');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: summarize returns {data: [...]} (spec 12.2)',
    async () => {
      const response = await companySummarize({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS });
      assertSeriesEnvelope(response, '12.2', 'company metrics summarize');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the device metric endpoint returns {data: [...]} (spec 12.3)',
    async (ctx) => {
      const state = fx();
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'GET /metrics/devices/:id/modules/:moduleType returns {data: [...]}',
          'no device on this tenant declares a polling module, so the endpoint cannot be called meaningfully',
        );
      }
      const { client } = api();
      const response = await client.get<unknown>(
        deviceMetricsPath(state.deviceId, state.deviceModuleType),
        { query: { ...hourWindow(), dataPoints: SMALL_DATA_POINTS } },
      );
      assertSeriesEnvelope(response, '12.3', 'device metrics');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the single-item device endpoint returns {data: [...]} (spec 12.3)',
    async (ctx) => {
      const state = fx();
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'GET /metrics/devices/:id/modules/:moduleType/:item returns {data: [...]}',
          'no device on this tenant declares a polling module',
        );
      }
      // spec §12.3: ":item — Item ID (device ID or component ID)". The device's
      // own id is the documented way to ask for device-level metrics.
      const { client } = api();
      const outcome = await attempt(
        client.get<unknown>(
          deviceItemMetricsPath(state.deviceId, state.deviceModuleType, state.deviceId),
          { query: { ...hourWindow(), dataPoints: SMALL_DATA_POINTS } },
        ),
      );
      expect(
        outcome.ok,
        `passing the device's own id as :item was ${describeOutcome(outcome)}. spec section 12.3 documents ":item — Item ID (device ID or component ID)"; if a device id is not accepted there, lumics_get_device_item_metrics cannot serve device-level metrics at all.`,
      ).toBe(true);
      if (outcome.ok) {
        assertSeriesEnvelope(outcome.value, '12.3', 'device item metrics');
      }
    },
    TIMEOUT,
  );

  it(
    'ASSERT: metrics/summaries returns {data: {<class>: [...]}, count} (spec 12.4)',
    async (ctx) => {
      const response = await summaries({ ...hourWindow(), itemType: 'device' });
      const { data, meta } = envelope(response);

      expect(isRecord(response), 'spec section 12.4 documents an object envelope').toBe(true);
      expect(
        Array.isArray(data),
        'spec section 12.4 documents "data" as an OBJECT keyed by item class, not an array. src/tools/metrics.ts unwrapMetricSummaries relies on that difference from sections 12.1-12.3; if data is an array here the two unwrappers are the wrong way round.',
      ).toBe(false);

      // An absent `data` would satisfy "not an array" without demonstrating
      // anything about the documented object shape, so it is reported as
      // unverified rather than counted as evidence. src/tools/metrics.ts does
      // tolerate an absent data (it yields zero classes), which is why this is
      // not a failure.
      if (data === undefined || data === null) {
        recordObserved(
          '12.4',
          'the envelope this endpoint returned when nothing matched',
          `no "data" field at all; envelope keys: ${keysOf(meta).join(',')}`,
        );
        unverifiable(
          ctx,
          '12.4',
          'metrics/summaries returns {data: {<class>: [...]}, count: n}',
          'the response carried no "data" field, so the object-keyed shape the tool layer unwraps could not be observed',
        );
      }
      expect(
        isRecord(data),
        `spec section 12.4 documents "data" as an object; this response carried ${describeValue(data)}.`,
      ).toBe(true);

      const classes = keysOf(data);
      for (const className of classes) {
        expect(
          Array.isArray((data as Record<string, unknown>)[className]),
          `the "${className}" entry of the summaries "data" object is not an array; src/tools/metrics.ts only collects array-valued entries and would silently drop this class.`,
        ).toBe(true);
      }

      recordAsserted(
        '12.4',
        'metrics/summaries returns an object-keyed data envelope, unlike sections 12.1-12.3',
        `data is ${describeValue(data)}; count is ${describeValue(meta['count'])}; envelope keys: ${keysOf(meta).join(',')}`,
      );
      recordObserved(
        '12.4',
        'the docs name only "devices" as a data key and speculate that others exist for component item types',
        classes.length === 0
          ? 'this tenant returned no item-class keys at all for itemType="device" in the last hour, so the key set remains undocumented AND unobserved'
          : `keys actually returned for itemType="device": ${classes.join(', ')}`,
      );
    },
    TIMEOUT,
  );
});

/** Shared assertion for the three `{data: [...]}` endpoints (spec §12.1–§12.3). */
function assertSeriesEnvelope(response: unknown, spec: string, label: string): void {
  const { data, meta } = envelope(response);
  expect(
    isRecord(response),
    `spec section ${spec} documents ${label} as an object envelope carrying "data"; the body was ${describeValue(response)}.`,
  ).toBe(true);
  expect(
    Array.isArray(data),
    `spec section ${spec} documents "data" as an ARRAY of metric rows; this response carried ${describeValue(data)}. src/tools/metrics.ts unwrapMetricSeries throws on anything else, so the tool would fail outright.`,
  ).toBe(true);
  recordAsserted(
    spec,
    `${label} returns the documented {data: [...], <meta>} envelope`,
    `data is ${describeValue(data)}; envelope meta keys: ${keysOf(meta).join(',')}; aggregation mode ${describeVocabulary(meta['type'], DOCUMENTED_ENVELOPE_TYPES)}`,
  );
}

// ---------------------------------------------------------------------------
// Assumption 6 — metrics/summaries accepts no limit (spec §12.4)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.4 — summaries has no limit parameter', () => {
  it(
    'ASSERT: sending limit is ignored rather than honoured',
    async (ctx) => {
      const window = hourWindow();
      const full = await summaries({ ...window, itemType: 'device' });
      // Sent deliberately, once, to check a documented ABSENCE. spec section 12.4
      // lists exactly four query parameters and `limit` is not among them; the
      // client-side ranking in lumics_get_metric_summary exists because of that.
      // Production code must never send this.
      const limited = await summaries({ ...window, itemType: 'device', limit: 1 });

      const fullCount = countSummaryItems(full);
      const limitedCount = countSummaryItems(limited);

      if (fullCount <= 1) {
        unverifiable(
          ctx,
          '12.4',
          'metrics/summaries ignores a limit parameter',
          `the unlimited call returned ${String(fullCount)} item(s), so a limit of 1 cannot be distinguished from no limit`,
        );
      }

      expect(
        limitedCount,
        `sending limit=1 changed the result size from ${String(fullCount)} to ${String(limitedCount)} — so metrics/summaries DOES honour a limit, which spec section 12.4 does not document. lumics_get_metric_summary fetches the whole set and ranks client-side precisely because no server-side limit was believed to exist, and it tells the model "Lumics returned every item that matched". That disclosure would be false. Report this.`,
      ).toBe(fullCount);

      recordAsserted(
        '12.4',
        'metrics/summaries ignores a limit parameter, as the documented parameter list implies',
        `${String(fullCount)} item(s) with and without limit=1`,
      );
    },
    TIMEOUT,
  );
});

function countSummaryItems(response: unknown): number {
  const { data } = envelope(response);
  if (!isRecord(data)) {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) {
      total += value.length;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Assumption 7 — the remaining documented parameters (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — the remaining query parameters', () => {
  /**
   * Acceptance only: each parameter must not produce a 400. Attribution is sound
   * because discovery already established that a plain call to this module is
   * served, so a rejection here is the parameter's doing.
   *
   * `componentQuery` and `filters` are documented but deliberately never sent
   * anywhere in this server (ADR-002 decision 3), so they are not probed here
   * either — a contract test that exercises a withheld capability is how it
   * quietly comes back.
   */
  const acceptanceCases: [string, Query][] = [
    ['lastMetric', { lastMetric: true }],
    ['isMonitored', { isMonitored: true }],
    ['minIntervals', { minIntervals: 4 }],
    ['aggregate', { aggregate: true }],
    ['alignTimeRange', { alignTimeRange: true }],
    ['limit', { limit: 5 }],
  ];

  it.each(acceptanceCases)(
    'ASSERT: %s is accepted',
    async (name, query) => {
      const state = fx();
      const outcome = await attempt(
        companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, ...query }),
      );
      expect(
        outcome.ok,
        `${name} was ${describeOutcome(outcome)} on a module the API otherwise serves. spec section 12.0 documents it as an accepted query parameter and src/tools/metrics.ts exposes it as a tool argument; a rejection means the documented surface is wrong. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        `${name} is accepted on the metric-data endpoints`,
        `sent against module "${state.moduleType}" and served`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: itemType is accepted and restricts rows to that component type',
    async (ctx) => {
      const state = fx();
      if (state.itemType === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'itemType limits the type of component for which metrics are returned',
          `no rows with a "type" field were found for module "${state.moduleType}" (probed: ${state.probedModules.join(', ')}), so there is no live itemType to filter on`,
        );
      }
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        itemType: state.itemType,
        lastMetric: true,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'itemType limits the type of component for which metrics are returned',
          `filtering module "${state.moduleType}" by itemType "${state.itemType}" returned no rows in the last hour`,
        );
      }
      const wrong = rows.filter((row) => row['type'] !== state.itemType);
      expect(
        wrong.length,
        `${String(wrong.length)} of ${String(rows.length)} row(s) came back with a "type" other than the requested itemType "${state.itemType}". spec section 12.0 documents itemType as limiting the component type; if it does not, every itemType-scoped answer this server gives includes components the caller excluded. Report this.`,
      ).toBe(0);
      recordAsserted(
        '12.0',
        'itemType restricts returned rows to that component type',
        `${String(rows.length)} row(s) returned for itemType "${state.itemType}", all matching`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: lastMetric returns at most one point per item',
    async (ctx) => {
      const state = fx();
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        lastMetric: true,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'lastMetric limits results to the most recent metric per item',
          `module "${state.moduleType}" returned no rows in the last hour, so "most recent" cannot be checked`,
        );
      }

      const perItem = new Map<string, number>();
      for (const row of rows) {
        const item = row['item'];
        const key = typeof item === 'string' ? item : '<no item field>';
        perItem.set(key, (perItem.get(key) ?? 0) + 1);
      }
      const worst = Math.max(...perItem.values());

      expect(
        worst,
        `with lastMetric=true, one item came back with ${String(worst)} rows. spec section 12.0 documents lastMetric as limiting results "to only include the most recent metric matching the rest of the criteria", which is what lumics_get_device_metrics tells the model to use for a current-status readout. More than one row per item means that readout is a series, not a status.`,
      ).toBe(1);
      recordAsserted(
        '12.0',
        'lastMetric returns a single most-recent point per item',
        `${String(rows.length)} row(s) across ${String(perItem.size)} item(s), at most one each`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: isMonitored=true does not widen the result set',
    async (ctx) => {
      const window = hourWindow();
      const all = rowsOf(
        await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, lastMetric: true }),
      ).length;
      if (all === 0) {
        unverifiable(
          ctx,
          '12.0',
          'isMonitored limits results to monitored components',
          `module "${fx().moduleType}" returned no rows at all in the last hour, so a filter cannot be observed`,
        );
      }
      const monitored = rowsOf(
        await companySeries({
          ...window,
          dataPoints: SMALL_DATA_POINTS,
          lastMetric: true,
          isMonitored: true,
        }),
      ).length;

      expect(
        monitored <= all,
        `isMonitored=true returned MORE rows (${String(monitored)}) than the unfiltered call (${String(all)}). spec section 12.0 documents it as a restriction ("will limit the components ... to ones which are monitored"); a filter that adds rows is not the parameter the docs describe. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'isMonitored is a restriction, never a widening',
        `${String(monitored)} monitored row(s) of ${String(all)} unfiltered`,
      );
      recordObserved(
        '12.0',
        'how much isMonitored actually filters on this tenant',
        monitored === all
          ? 'identical row counts with and without isMonitored — either every component is monitored or the parameter had no effect here; this run cannot tell them apart'
          : `filtered ${String(all - monitored)} row(s) out of ${String(all)}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: properties returns the requested metric property',
    async (ctx) => {
      const state = fx();
      if (state.propertyPath === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'properties selects which metric properties appear in the results',
          `no stats paths were discovered for module "${state.moduleType}" (probed: ${state.probedModules.join(', ')}), so there is no live property path to request`,
        );
      }
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        lastMetric: true,
        properties: state.propertyPath,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'properties selects which metric properties appear in the results',
          `requesting properties="${state.propertyPath}" returned no rows`,
        );
      }
      const returned = new Set(rows.flatMap((row) => statPaths(row)));

      expect(
        returned.has(state.propertyPath),
        `properties="${state.propertyPath}" came back without that path in "stats" (paths returned: ${[...returned].join(', ') || 'none'}). spec section 12.0 documents properties as "a comma separated list of metric properties to be included in the results"; if asking for a property does not return it, every narrowed metric read this server performs loses the data the caller asked for. Report this.`,
      ).toBe(true);

      const extras = [...returned].filter((path) => path !== state.propertyPath);
      recordAsserted(
        '12.0',
        'properties returns the requested metric property path',
        `requested "${state.propertyPath}" and it was present in ${String(rows.length)} row(s)`,
      );
      recordObserved(
        '12.0',
        'whether properties EXCLUDES everything else, which the docs do not state',
        extras.length === 0
          ? 'only the requested path came back — properties is exclusive'
          : `${String(extras.length)} additional path(s) came back alongside the requested one: ${extras.join(', ')} — properties is additive/partial, so a narrowed request still carries other properties`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: what alignTimeRange and minIntervals do to the effective window',
    async () => {
      const window = hourWindow();
      const plain = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const aligned = await companySeries({
        ...window,
        dataPoints: SMALL_DATA_POINTS,
        alignTimeRange: true,
      });
      const coarseEligible = await companySeries({
        ...window,
        dataPoints: SMALL_DATA_POINTS,
        minIntervals: 4,
      });

      const plainMeta = envelope(plain).meta;
      const alignedMeta = envelope(aligned).meta;
      const coarseMeta = envelope(coarseEligible).meta;

      const plainFrom = numberFrom(plainMeta, 'fromMs');
      const alignedFrom = numberFrom(alignedMeta, 'fromMs');

      // Real assertion: whatever the snapping does, the window it reports must
      // still be a window. A reversed or zero-width effective range would make
      // every note this server prints about the effective window nonsense.
      const alignedTo = numberFrom(alignedMeta, 'toMs');
      if (alignedFrom !== undefined && alignedTo !== undefined) {
        expect(
          alignedFrom < alignedTo,
          `with alignTimeRange=true the effective window came back reversed or empty (from ${String(alignedFrom)}, to ${String(alignedTo)}).`,
        ).toBe(true);
      }

      recordObserved(
        '12.0',
        'alignTimeRange "forces time range to snap to natural time boundaries" — by how much, and does it change the window?',
        alignedFrom === undefined || plainFrom === undefined
          ? 'neither response echoed a numeric fromMs, so snapping cannot be measured'
          : alignedFrom === plainFrom
            ? 'the effective fromMs was identical with and without alignTimeRange over a one-hour window — no observable snapping at this resolution'
            : `alignTimeRange moved the effective fromMs by ${String(alignedFrom - plainFrom)} ms relative to the unaligned call`,
      );
      recordObserved(
        '12.0',
        'minIntervals (default 40) governs which rollup collection is eligible',
        `timeIncrement ${describeValue(numberFrom(coarseMeta, 'timeIncrement'))} with minIntervals=4 versus ${describeValue(numberFrom(plainMeta, 'timeIncrement'))} with the default over the same one-hour window`,
      );
    },
    TIMEOUT,
  );
});

declareSkipExplanation('the metric contract (spec section 12)');
