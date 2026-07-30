/**
 * Metric tools — spec §12, all five endpoints.
 *
 * Three of the prototype's defects live here, and each gets an explicitly named
 * test so a regression says what broke:
 *
 *  1. **`dataPoints` (or `width`) is REQUIRED** on the four metric-data endpoints.
 *     The prototype sent neither, so its metric tools cannot reliably have worked.
 *     This server always sends a resolution and discloses when it defaulted.
 *  2. **`sum` is a string enum (`min`|`max`|`avg`), not a boolean.** The prototype
 *     typed it boolean, which makes every summarize call malformed.
 *  3. **`metrics/summaries` has a much smaller parameter surface** — exactly
 *     `fromMs`, `toMs`, `itemType`, `properties` and nothing else, including no
 *     `limit`. `topN`/`sortBy` are therefore applied locally and disclosed.
 *
 * `componentQuery` and `filters` are withheld everywhere (ADR-002 decision 3), so
 * a test asserts they never reach the wire even if a caller sends them.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPANY_METRIC_500_CORRELATED_PARAMS,
  COMPANY_METRIC_500_SERVED_PARAMS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_METRIC_DATA_POINTS,
  METRIC_INTERVALS,
  METRIC_SUMMARIZE_TIMEOUT_MS,
  METRIC_SUM_PROPERTIES,
} from '../../src/constants.js';
import {
  makeConfig,
  TEST_COMPANY_ID,
  TEST_COMPONENT_ID,
  TEST_DEVICE_ID,
} from '../helpers/config.js';
import {
  errorResponse,
  jsonResponse,
  recordFetch,
  recordSleep,
  timeoutFetch,
  type FetchRecorder,
  type RecordedCall,
} from '../helpers/fetch.js';
import { connect, notesOf, payloadOf } from '../helpers/mcp.js';
import { expectNoFabricatedPagination, expectNoFabricatedQueryParams } from '../helpers/tools.js';
import type { LumicsConfig } from '../../src/config.js';

const C = TEST_COMPANY_ID;
const HOUR_MS = 3_600_000;

/**
 * A `properties` value that is both REQUIRED (live finding 1: the four
 * metric-data endpoints answer 400 without it) and well-formed (live finding 2:
 * an ill-formed one returns 200 with empty stats). Every fixture below carries a
 * matching `Calculated.cpu` stat, so the silent-empty disclosure stays quiet
 * except in the tests that are specifically about it.
 */
const PROPS = 'Calculated.cpu';

const SERIES = {
  data: [{ time: 1_785_000_000_000, stats: { Calculated: { cpu: { avg: 1 } } } }],
  from: '2026-07-29T11:00:00.000Z',
  to: '2026-07-29T12:00:00.000Z',
  timeIncrement: 60_000,
  type: 'avg',
  components: 12,
};

/** The four endpoints that take the full shared query surface. */
const DATA_ENDPOINTS: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly path: string;
}[] = [
  {
    tool: 'lumics_get_company_metrics',
    args: { moduleType: 'snmp', properties: PROPS },
    path: `/metrics/companies/${C}/modules/snmp`,
  },
  {
    tool: 'lumics_summarize_company_metrics',
    args: { moduleType: 'snmp', properties: PROPS },
    path: `/metrics/companies/${C}/modules/snmp/summarize`,
  },
  {
    tool: 'lumics_get_device_metrics',
    args: { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
    path: `/metrics/devices/${TEST_DEVICE_ID}/modules/snmp`,
  },
  {
    tool: 'lumics_get_device_item_metrics',
    args: {
      deviceId: TEST_DEVICE_ID,
      moduleType: 'snmp',
      properties: PROPS,
      itemId: TEST_COMPONENT_ID,
    },
    path: `/metrics/devices/${TEST_DEVICE_ID}/modules/snmp/${TEST_COMPONENT_ID}`,
  },
];

/**
 * The device-scoped metric tools (spec §12.3) now resolve the device's owning
 * company with a company-scoped device read before they read any metrics, so the
 * cross-company pin covers a path that carries no company segment. That makes a
 * device metric call two requests rather than one, so these tests answer the
 * ownership read with a device in the configured company and assert against the
 * metric request itself. `tests/security/company-scoping.test.ts` asserts the pin.
 */
const OWNED_DEVICE = { id: TEST_DEVICE_ID, name: 'edge-switch-1', company: C };

interface MetricExchange {
  readonly call: RecordedCall;
  readonly calls: readonly RecordedCall[];
  readonly text: string;
  readonly payload: unknown;
  readonly notes: string;
}

/** A fetch that serves the ownership read, then the supplied metric response. */
function metricFetch(response: unknown): FetchRecorder {
  return recordFetch((call) =>
    call.path.startsWith(`/companies/${C}/devices/`)
      ? jsonResponse(OWNED_DEVICE)
      : jsonResponse(response),
  );
}

/** Like `exchange`, but tolerant of the ownership pre-read. `call` is the metric call. */
async function metricExchange(
  tool: string,
  args: Record<string, unknown>,
  response: unknown,
  options: { readonly config?: LumicsConfig } = {},
): Promise<MetricExchange> {
  const fetcher = metricFetch(response);
  const harness = await connect(options.config ?? makeConfig(), {
    clientOptions: { fetchImpl: fetcher.fetchImpl },
  });
  try {
    const called = await harness.call(tool, args);
    if (called.isError === true) {
      const block = called.content[0];
      throw new Error(
        `${tool} returned an error result: ${block?.type === 'text' ? block.text : '?'}`,
      );
    }
    const text = called.content[0]?.type === 'text' ? called.content[0].text : '';
    return {
      call: fetcher.last(),
      calls: fetcher.calls,
      text,
      payload: payloadOf(text),
      notes: notesOf(text),
    };
  } finally {
    await harness.close();
  }
}

/** The failing counterpart, with the same ownership stub. */
async function failingMetricExchange(
  tool: string,
  args: Record<string, unknown>,
  response: unknown = {},
  options: { readonly config?: LumicsConfig } = {},
): Promise<{ readonly text: string; readonly calls: readonly RecordedCall[] }> {
  const fetcher = metricFetch(response);
  const harness = await connect(options.config ?? makeConfig(), {
    clientOptions: { fetchImpl: fetcher.fetchImpl },
  });
  try {
    const called = await harness.call(tool, args);
    expect(called.isError, `${tool} was expected to fail`).toBe(true);
    const block = called.content[0];
    return { text: block?.type === 'text' ? block.text : '', calls: fetcher.calls };
  } finally {
    await harness.close();
  }
}

// ---------------------------------------------------------------------------
// Prototype defect 1: dataPoints is required and must always be sent
// ---------------------------------------------------------------------------

describe('dataPoints is sent by default on all four metric-data endpoints (spec section 12.0)', () => {
  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    '%s sends dataPoints even when the caller supplies none',
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const { call } = await metricExchange(entry.tool, entry.args, SERIES);
      expect(call.path).toBe(entry.path);
      // The API rejects a metric call with neither dataPoints nor width.
      expect(call.query.dataPoints).toBe(String(DEFAULT_METRIC_DATA_POINTS));
    },
  );

  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    "%s discloses that the resolution was this server's default",
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const { notes } = await metricExchange(entry.tool, entry.args, SERIES);
      expect(notes).toContain(`dataPoints=${String(DEFAULT_METRIC_DATA_POINTS)}`);
      expect(notes).toContain("this server's default");
      expect(notes).toContain('rejects a metric call with neither');
    },
  );

  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    '%s honours an explicit dataPoints and stops calling it a default',
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const { call, notes } = await metricExchange(
        entry.tool,
        { ...entry.args, dataPoints: 5 },
        SERIES,
      );
      expect(call.query.dataPoints).toBe('5');
      expect(notes).toContain('dataPoints=5.');
      expect(notes).not.toContain("this server's default");
    },
  );

  it('never exposes width, which would silently override dataPoints', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS, width: 1_920 },
      SERIES,
    );
    expect(call.url.searchParams.has('width')).toBe(false);
    expect(call.query.dataPoints).toBe(String(DEFAULT_METRIC_DATA_POINTS));
  });

  it.each([0, -1, 5_001, 1.5])('rejects a dataPoints of %s locally', async (dataPoints) => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      dataPoints,
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Prototype defect 2: sum is a string enum, not a boolean
// ---------------------------------------------------------------------------

describe('sum is a string enum on summarize (spec section 12.2)', () => {
  it.each(METRIC_SUM_PROPERTIES)('sends sum=%s verbatim', async (sum) => {
    const { call, notes } = await metricExchange(
      'lumics_summarize_company_metrics',
      { moduleType: 'snmp', properties: PROPS, sum },
      SERIES,
    );
    expect(call.query.sum).toBe(sum);
    expect(notes).toContain(`SUMMED across components using each component's "${sum}"`);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['the string "true"', 'true'],
    ['1', 1],
    ['an undocumented value', 'total'],
  ])('rejects a sum of %s before spending a request', async (_label, sum) => {
    const { calls } = await failingMetricExchange('lumics_summarize_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      sum,
    });
    expect(calls).toHaveLength(0);
  });

  it('omits sum entirely when it was not asked for, and says the result is an AVERAGE', async () => {
    const { call, notes } = await metricExchange(
      'lumics_summarize_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      SERIES,
    );
    expect(call.url.searchParams.has('sum')).toBe(false);
    expect(notes).toContain('no "sum" was requested');
    expect(notes).toContain('AVERAGE across components, not a total');
  });

  it('is not offered on any other metric endpoint', async () => {
    for (const entry of DATA_ENDPOINTS.filter(
      (candidate) => candidate.tool !== 'lumics_summarize_company_metrics',
    )) {
      const { call } = await metricExchange(entry.tool, { ...entry.args, sum: 'avg' }, SERIES);
      expect(call.url.searchParams.has('sum'), `${entry.tool} must not send sum`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The shared query surface
// ---------------------------------------------------------------------------

describe('the shared metric query surface maps exactly onto spec section 12.0', () => {
  it('sends fromMs and toMs as epoch milliseconds derived from a lookback', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS, lookback: '6h' },
      SERIES,
    );
    const fromMs = Number(call.query.fromMs);
    const toMs = Number(call.query.toMs);
    expect(Number.isInteger(fromMs)).toBe(true);
    expect(Number.isInteger(toMs)).toBe(true);
    expect(toMs - fromMs).toBe(6 * HOUR_MS);
    // Plausibly milliseconds, not seconds.
    expect(fromMs).toBeGreaterThan(1_600_000_000_000);
  });

  it('defaults to a one-hour window, matching the API default', async () => {
    const { call, notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      SERIES,
    );
    expect(Number(call.query.toMs) - Number(call.query.fromMs)).toBe(HOUR_MS);
    expect(notes).toContain('1 hour(s)');
  });

  it('converts an ISO-8601 from/to pair, so a model never computes epoch ms', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      {
        moduleType: 'snmp',
        properties: PROPS,
        from: '2026-07-28T00:00:00Z',
        to: '2026-07-29T00:00:00Z',
      },
      SERIES,
    );
    expect(call.query.fromMs).toBe(String(Date.UTC(2026, 6, 28)));
    expect(call.query.toMs).toBe(String(Date.UTC(2026, 6, 29)));
  });

  it('passes every documented optional parameter straight through', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      {
        moduleType: 'snmp',
        itemType: 'snmp_f5_f5pools',
        interval: 'fiveMin',
        minIntervals: 10,
        aggregate: true,
        alignTimeRange: false,
        properties: 'Calculated.cpu,TimeTicks.sysUpTime',
        lastMetric: true,
        isMonitored: true,
        limit: 25,
        dataPoints: 30,
      },
      SERIES,
    );
    expect(call.query).toMatchObject({
      itemType: 'snmp_f5_f5pools',
      interval: 'fiveMin',
      minIntervals: '10',
      aggregate: 'true',
      alignTimeRange: 'false',
      properties: 'Calculated.cpu,TimeTicks.sysUpTime',
      lastMetric: 'true',
      isMonitored: 'true',
      limit: '25',
      dataPoints: '30',
    });
  });

  it('omits every optional parameter the caller did not set', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      SERIES,
    );
    // Only the window, the resolution, and the caller's required `properties`.
    // `limit` is NOT among them — see the metric-row-cap block below.
    expect(Object.keys(call.query).sort()).toEqual(['dataPoints', 'fromMs', 'properties', 'toMs']);
    expect(call.query.limit).toBeUndefined();
  });

  it.each(METRIC_INTERVALS)('accepts the documented interval %s', async (interval) => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS, interval },
      SERIES,
    );
    expect(call.query.interval).toBe(interval);
  });

  it('rejects an undocumented interval', async () => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      interval: 'week',
    });
    expect(calls).toHaveLength(0);
  });

  it('never sends componentQuery or filters, even if a caller supplies them (ADR-002 decision 3)', async () => {
    for (const entry of DATA_ENDPOINTS) {
      const { call } = await metricExchange(
        entry.tool,
        { ...entry.args, componentQuery: '{"$where":"1"}', filters: '{"a":1}' },
        SERIES,
      );
      expect(call.url.searchParams.has('componentQuery'), entry.tool).toBe(false);
      expect(call.url.searchParams.has('filters'), entry.tool).toBe(false);
    }
  });

  it('rejects a from/lookback conflict rather than guessing', async () => {
    const { calls, text } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      from: '2026-07-28T00:00:00Z',
      lookback: '6h',
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('not both');
  });

  it('rejects a garbage lookback at the schema, before the time layer sees it', async () => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      lookback: 'last week',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a reversed window', async () => {
    const { calls, text } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
      from: '2026-07-29T00:00:00Z',
      to: '2026-07-28T00:00:00Z',
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('empty or reversed');
  });
});

// ---------------------------------------------------------------------------
// Envelope handling and the effective-window disclosure
// ---------------------------------------------------------------------------

describe('the metric envelope is unwrapped and its metadata disclosed', () => {
  it('returns the data array, not the envelope', async () => {
    const { payload } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      SERIES,
    );
    expect(payload).toEqual(SERIES.data);
  });

  it('reports the window Lumics actually served, which alignTimeRange can change', async () => {
    const { notes } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS, alignTimeRange: true },
      SERIES,
    );
    expect(notes).toContain('EFFECTIVE RESULT:');
    expect(notes).toContain('covers 2026-07-29T11:00:00.000Z to 2026-07-29T12:00:00.000Z');
    expect(notes).toContain('one bucket per 60000 ms');
    expect(notes).toContain('aggregation mode "avg"');
    expect(notes).toContain('12 component(s) aggregated');
  });

  it('reads an epoch-millisecond envelope window as well as an ISO one', async () => {
    const { notes } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      { data: [], fromMs: Date.UTC(2026, 6, 29, 11), toMs: Date.UTC(2026, 6, 29, 12) },
    );
    expect(notes).toContain('covers 2026-07-29T11:00:00.000Z to 2026-07-29T12:00:00.000Z');
  });

  it('omits the effective-window note when the envelope carries no metadata', async () => {
    const { notes } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      { data: [] },
    );
    expect(notes).toContain('WINDOW AND RESOLUTION:');
    expect(notes).not.toContain('EFFECTIVE RESULT:');
  });

  it('treats an absent body as an empty series rather than failing', async () => {
    const { payload } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      null,
    );
    expect(payload).toEqual([]);
  });

  it('treats a missing data key as an empty series', async () => {
    const { payload } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      { from: '2026-07-29T11:00:00.000Z' },
    );
    expect(payload).toEqual([]);
  });

  it.each([
    ['an array where an envelope was documented', [{ time: 1 }]],
    ['a string', 'nope'],
  ])('surfaces %s as documented drift', async (_label, response) => {
    const { text } = await failingMetricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      response,
    );
    expect(text).toContain('invalid_response');
  });

  it('surfaces a non-array data field as drift', async () => {
    const { text } = await failingMetricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS },
      { data: { nope: true } },
    );
    expect(text).toContain('documented as an array');
  });

  /**
   * The same defect class as finding B2, on the metric path this time. All four
   * series tools passed `requestedLimit`, so `listCompletenessNote` fired next to
   * `metricRowCapNote` and a single response carried "drop this limit" and
   * "re-run with a higher limit" together. `metricRowCapNote` already covers a
   * capped series honestly, and inventory framing is the wrong reading of one.
   */
  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry.args] as const))(
    '%s describes a capped series once, without inventory advice',
    async (tool, args) => {
      const { notes } = await metricExchange(
        tool,
        { ...args, limit: 3 },
        { data: [{ time: 1 }, { time: 2 }, { time: 3 }] },
      );

      expect(notes).toContain('ROW COUNT:');
      expect(notes).toContain('at most 3 row(s)');
      // The series wording tells the model to drop the limit; the inventory
      // wording tells it to raise it. They must never appear together.
      expect(notes).toContain('drop this limit');
      expect(notes).not.toContain('NOTE ON COMPLETENESS:');
      expect(notes).not.toContain('higher limit');
      expect(notes).not.toContain('complete inventory');
    },
  );
});

describe('lumics_get_device_item_metrics has a deliberately reduced surface', () => {
  it('does not send itemType, because the item is already named', async () => {
    const { call } = await metricExchange(
      'lumics_get_device_item_metrics',
      {
        deviceId: TEST_DEVICE_ID,
        moduleType: 'snmp',
        properties: PROPS,
        itemId: TEST_COMPONENT_ID,
        itemType: 'snmp_f5_f5pools',
      },
      SERIES,
    );
    expect(call.url.searchParams.has('itemType')).toBe(false);
  });

  it('takes the device id as the item id for device-level metrics', async () => {
    const { call } = await metricExchange(
      'lumics_get_device_item_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', properties: PROPS, itemId: TEST_DEVICE_ID },
      SERIES,
    );
    expect(call.path).toBe(`/metrics/devices/${TEST_DEVICE_ID}/modules/snmp/${TEST_DEVICE_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Prototype defect 3: metrics/summaries and its local ranking
// ---------------------------------------------------------------------------

/**
 * Finding B3. `metricLimitSchema` inherited `listLimitSchema`'s `.default(100)`,
 * so every metric call sent `limit=100` whether or not the caller asked for one —
 * and a metric result has one row per component per time bucket. A 24-hour query
 * at the default resolution across 40 components is ~2,400 rows; the model got
 * 100, in no documented order, cut across the TIME dimension. `MAX_LIST_LIMIT` is
 * 1,000, so "re-run with a higher limit" could never recover it either, and the
 * disclosure described an inventory-completeness problem rather than a mutilated
 * series. An incomplete inventory is obviously incomplete; a series with holes
 * looks like data.
 */
describe('metric tools never cap a series the caller did not ask to cap (finding B3)', () => {
  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry.args] as const))(
    '%s sends no limit by default',
    async (tool, args) => {
      const { call } = await metricExchange(tool, args, SERIES);
      expect(call.query.limit).toBeUndefined();
      expect(call.url.searchParams.has('limit')).toBe(false);
    },
  );

  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry.args] as const))(
    '%s sends a limit only when the caller supplied one',
    async (tool, args) => {
      const { call } = await metricExchange(tool, { ...args, limit: 25 }, SERIES);
      expect(call.query.limit).toBe('25');
    },
  );

  it('discloses that no cap was applied, and how a budget trim would differ', async () => {
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      SERIES,
    );
    expect(notes).toContain('ROW COUNT:');
    expect(notes).toContain('no result cap was sent to Lumics');
    // A budget trim drops from the END, so the loss is positional and sayable.
    expect(notes).toContain('END');
    expect(notes).toContain('missing its TAIL');
  });

  it('describes an explicit cap as SERIES truncation, not as inventory completeness', async () => {
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS, limit: 25 },
      SERIES,
    );
    expect(notes).toContain('ROW COUNT:');
    expect(notes).toContain('at most 25 row(s)');
    // The facts that make a capped series dangerous rather than merely short.
    expect(notes).toContain('across TIME');
    expect(notes).toContain('holes');
    expect(notes).toMatch(/Do not read a gap as a missing measurement/);
    // And it must not tell the model to raise the cap, which cannot help past 1,000.
    expect(notes).not.toMatch(/higher limit/);
  });

  it('the limit description warns that a cap mutilates a series, and admits no default', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
    });
    try {
      const properties = (
        harness.tool('lumics_get_company_metrics')?.inputSchema as {
          properties?: Record<string, { description?: string; default?: unknown }>;
        }
      ).properties;
      const limit = properties?.limit;
      expect(limit?.description).toContain('this server sends no limit by default');
      expect(limit?.description).toContain('across TIME');
      // No schema default, which is what used to inject the cap.
      expect(limit?.default).toBeUndefined();
      // `limit` must not be required either.
      const required = (
        harness.tool('lumics_get_company_metrics')?.inputSchema as {
          required?: string[];
        }
      ).required;
      expect(required ?? []).not.toContain('limit');
    } finally {
      await harness.close();
    }
  });

  it('still discloses a budget trim as a positional loss when one happens', async () => {
    const many = {
      data: Array.from({ length: 200 }, (_unused, index) => ({
        time: 1_785_000_000_000 + index * 60_000,
        stats: { Calculated: { cpu: { avg: index }, blob: 'x'.repeat(80) } },
      })),
    };
    const { text } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      many,
      {
        config: makeConfig({ maxOutputChars: 2_000 }),
      },
    );
    expect(text).toContain('NOTE ON TRUNCATION:');
    expect(text).toContain('items were dropped');
    // No completeness note, because no limit was sent.
    expect(text).not.toContain('equals the requested limit');
  });
});

/**
 * Finding M8. These two are the most confusable pair in the surface and were the
 * only near-neighbour pair with no cross-reference. Asked to "summarise CPU and
 * give me the top 5 devices", a model picked `lumics_summarize_company_metrics`,
 * which structurally cannot produce a per-device ranking.
 */
describe('the two confusable summary tools point at each other (finding M8)', () => {
  it('each names the other, and says what it cannot do', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
    });
    try {
      const overTime = harness.tool('lumics_summarize_company_metrics')?.description ?? '';
      const overItems = harness.tool('lumics_get_metric_summary')?.description ?? '';

      expect(overTime).toContain('lumics_get_metric_summary');
      expect(overTime).toMatch(/CANNOT rank or identify individual devices/);
      expect(overTime).toContain('top N devices');

      expect(overItems).toContain('lumics_summarize_company_metrics');
      expect(overItems).toMatch(/returns no time series/);

      // Both spell out the axis each one summarises over.
      expect(overTime).toContain('summarises over TIME');
      expect(overItems).toContain('summarises over ITEMS');
    } finally {
      await harness.close();
    }
  });
});

describe('lumics_get_metric_summary (spec section 12.4)', () => {
  const item = (name: string, cpu: number | undefined) => ({
    id: name,
    name,
    ...(cpu === undefined ? {} : { stats: { Calculated: { cpu: { avg: cpu } } } }),
  });

  const summary = (items: unknown[]) => ({
    data: { devices: items },
    count: items.length,
  });

  it('GETs the summaries path', async () => {
    const { call } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      summary([item('a', 1)]),
    );
    expect(call.method).toBe('GET');
    expect(call.path).toBe(`/companies/${C}/metrics/summaries/snmp`);
  });

  it('sends exactly fromMs and toMs when nothing else was supplied', async () => {
    const { call } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      summary([]),
    );
    expect(Object.keys(call.query).sort()).toEqual(['fromMs', 'toMs']);
  });

  it('sends exactly fromMs, toMs, itemType and properties — and nothing else', async () => {
    const { call } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', itemType: 'device', properties: 'Calculated.cpu' },
      summary([]),
    );
    expect(Object.keys(call.query).sort()).toEqual(['fromMs', 'itemType', 'properties', 'toMs']);
    expect(call.query.itemType).toBe('device');
    expect(call.query.properties).toBe('Calculated.cpu');
  });

  /**
   * Every parameter spec §12.4 does NOT document, paired with a plausible value.
   * `sortBy`/`sortDirection`/`topN` are real *tool* arguments but are applied
   * locally, so they must not appear on the wire either.
   */
  it.each([
    ['dataPoints', 60],
    ['width', 1_920],
    ['interval', 'hour'],
    ['aggregate', true],
    ['alignTimeRange', true],
    ['minIntervals', 10],
    ['isMonitored', true],
    ['lastMetric', true],
    ['sum', 'avg'],
    ['limit', 25],
    ['topN', 2],
    ['sortBy', 'Calculated.cpu.avg'],
    ['sortDirection', 'asc'],
    ['componentQuery', '{"$where":"1"}'],
    ['filters', '{"a":1}'],
  ])('never sends %s, which this endpoint does not accept', async (parameter, value) => {
    const { call } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', [parameter]: value },
      summary([item('a', 1)]),
    );
    expect(call.url.searchParams.has(parameter)).toBe(false);
    // And the request stays at the four documented parameters.
    expect(Object.keys(call.query).sort()).toEqual(['fromMs', 'toMs']);
  });

  it('discloses that the endpoint has no server-side limit or pagination at all', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      summary([item('a', 1)]),
    );
    expect(notes).toContain('NO SERVER-SIDE LIMIT OR PAGINATION');
    expect(notes).toContain('accepts no limit, top-N, sort or pagination parameter at all');
    expect(notes).toContain('Narrowing itemType, properties or the window is the only way');
    expect(notes).toContain('Lumics reported count=1');
  });

  it('ranks descending by default and says the sort was local', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg' },
      summary([item('low', 10), item('high', 90), item('mid', 50)]),
    );
    expect((payload as { name: string }[]).map((entry) => entry.name)).toEqual([
      'high',
      'mid',
      'low',
    ]);
    expect(notes).toContain('Sorted by THIS SERVER');
    expect(notes).toContain('descending (largest first)');
    expect(notes).toContain('the Lumics API did not perform this ranking');
  });

  it('ranks ascending when asked', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', sortDirection: 'asc' },
      summary([item('low', 10), item('high', 90)]),
    );
    expect((payload as { name: string }[]).map((entry) => entry.name)).toEqual(['low', 'high']);
    expect(notes).toContain('ascending (smallest first)');
  });

  it('resolves a sortBy path both directly and inside stats', async () => {
    const nested = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'stats.Calculated.cpu.avg' },
      summary([item('low', 10), item('high', 90)]),
    );
    expect((nested.payload as { name: string }[])[0]?.name).toBe('high');
  });

  it('puts unmeasured items last in BOTH directions and reports how many', async () => {
    for (const direction of ['desc', 'asc'] as const) {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', sortDirection: direction },
        summary([item('missing', undefined), item('low', 10), item('high', 90)]),
      );
      // An unmeasured item must never top a "lowest N" list purely by absence.
      expect((payload as { name: string }[]).at(-1)?.name).toBe('missing');
      expect(notes).toContain('1 of 3 item(s) had no numeric value');
      expect(notes).toContain('listed last, unranked');
    }
  });

  it('ignores a non-numeric value at the sort path rather than ordering on it', async () => {
    const { payload } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg' },
      summary([
        { name: 'stringy', stats: { Calculated: { cpu: { avg: 'high' } } } },
        item('numeric', 5),
      ]),
    );
    expect((payload as { name: string }[])[0]?.name).toBe('numeric');
  });

  it('trims to topN after the local sort and says how many were fetched but hidden', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 2 },
      summary([item('a', 10), item('b', 90), item('c', 50), item('d', 70)]),
    );
    expect((payload as { name: string }[]).map((entry) => entry.name)).toEqual(['b', 'd']);
    expect(notes).toContain('Trimmed by THIS SERVER to the top 2 of 4 item(s)');
    expect(notes).toContain('the other 2 were fetched but are not shown');
  });

  it('warns that topN without sortBy is not a real top-N', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', topN: 1 },
      summary([item('a', 10), item('b', 90)]),
    );
    expect(notes).toContain('in the order Lumics happened to return them');
    expect(notes).toContain('that order is not documented or meaningful');
    expect(notes).toContain('pass sortBy to make this a real top-1');
  });

  it('does not claim a per-class trim when only one item class came back', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 1 },
      summary([item('a', 10), item('b', 90)]),
    );
    expect(notes).toContain('Trimmed by THIS SERVER');
    expect(notes).not.toContain('applied to EACH item class');
  });

  it('does not trim when topN is larger than the result set', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', topN: 10 },
      summary([item('a', 10)]),
    );
    expect(payload).toHaveLength(1);
    expect(notes).not.toContain('Trimmed by THIS SERVER');
  });

  it('returns the single class array directly and names which key it came from', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      summary([item('a', 10)]),
    );
    expect(Array.isArray(payload)).toBe(true);
    expect(notes).toContain('the "devices" array of the Lumics response\'s "data" object');
  });

  it('keeps the vendor keyed object when more than one item class came back', async () => {
    const { payload } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      { data: { devices: [item('a', 1)], pools: [item('p', 2)] }, count: 2 },
    );
    expect(payload).toEqual({
      devices: [item('a', 1)],
      pools: [item('p', 2)],
    });
  });

  /**
   * Live contract finding: the §12.4 `data` object is not uniformly item classes.
   * A probe against a real tenant returned `{"count":0,...,"data":{"company":"<id>"}}`
   * — a scalar sitting inside `data` beside the classes. The unwrapper collected
   * only array-valued entries, so anything else vanished with nothing said, and a
   * partial view of `data` read as the whole of it.
   *
   * The fix keeps the two kinds of non-array entry apart: `company` is request
   * metadata (no rows are missing, so no alarm), while a key nobody anticipated is
   * exactly where silence is dangerous and gets an incompleteness warning.
   */
  describe('non-array entries in the "data" object are disclosed, not dropped', () => {
    const COMPANY_SCALAR = 'company-scalar-id';

    it('says nothing new when every "data" entry is an item class', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        summary([item('a', 10)]),
      );
      expect(payload).toEqual([item('a', 10)]);
      expect(notes).not.toContain('REQUEST METADATA INSIDE "data"');
      expect(notes).not.toContain('UNRECOGNISED NON-ARRAY');
    });

    it('reports a "company" scalar as request metadata without implying missing rows', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { devices: [item('a', 10)], company: COMPANY_SCALAR }, count: 1 },
      );
      // The genuine item class is still returned exactly as before.
      expect(payload).toEqual([item('a', 10)]);
      expect(notes).toContain('REQUEST METADATA INSIDE "data"');
      expect(notes).toContain(`company="${COMPANY_SCALAR}"`);
      expect(notes).toContain('NOT a class of summarised items');
      expect(notes).toContain('NO ' + 'items are missing because of it');
      // A known-metadata entry must not raise the incompleteness alarm.
      expect(notes).not.toContain('UNRECOGNISED NON-ARRAY');
      expect(notes).not.toContain('INCOMPLETE');
    });

    it('warns that the result is incomplete when an unrecognised non-array entry appears', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { devices: [item('a', 10)], surprise: 42 }, count: 1 },
      );
      expect(payload).toEqual([item('a', 10)]);
      expect(notes).toContain('UNRECOGNISED NON-ARRAY ENTRY IN "data"');
      expect(notes).toContain('surprise=42');
      expect(notes).toContain('INCOMPLETE');
      expect(notes).toContain('report it as an API-contract gap');
      expect(notes).not.toContain('REQUEST METADATA INSIDE "data"');
    });

    /**
     * The note is emitted before the JSON payload and separated from it by
     * position alone, so it must not contain `{` or `[` — a client scanning for
     * the start of the JSON would stop inside the prose. A structural value is
     * described, not dumped, and a long one cannot eat the output budget.
     */
    it('describes an unrecognised object entry without emitting JSON punctuation into the notes', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { devices: [item('a', 10)], surprise: { note: 'z'.repeat(500) } }, count: 1 },
      );
      expect(payload).toEqual([item('a', 10)]);
      expect(notes).toContain('UNRECOGNISED NON-ARRAY ENTRY IN "data"');
      expect(notes).toContain('surprise=<a non-array object with 1 key(s): note>');
      expect(notes).not.toContain('z'.repeat(20));
      expect(notes).not.toMatch(/[[\]{}]/);
    });

    it('does not quote a scalar that carries JSON punctuation into the notes', async () => {
      const { notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { devices: [item('a', 10)], surprise: '{"a":1}' }, count: 1 },
      );
      expect(notes).toContain('surprise=<a string value, not quoted here');
      expect(notes).not.toMatch(/[[\]{}]/);
    });

    it('caps a very long scalar rather than letting it eat the output budget', async () => {
      const { notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { devices: [item('a', 10)], surprise: 'y'.repeat(500) }, count: 1 },
      );
      expect(notes).toContain('(truncated)');
      expect(notes).not.toContain('y'.repeat(200));
    });

    it('does not call "data" empty when it held only a company scalar', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { company: COMPANY_SCALAR }, count: 0 },
      );
      expect(payload).toEqual({});
      expect(notes).toContain('NO ITEMS:');
      expect(notes).toContain('present and held 1 non-array entry (company)');
      expect(notes).not.toContain('present but empty');
      expect(notes).toContain(`company="${COMPANY_SCALAR}"`);
    });

    it('discloses a "data" object holding only unrecognised entries', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: { company: COMPANY_SCALAR, surprise: 'x' }, count: 0 },
      );
      expect(payload).toEqual({});
      expect(notes).toContain('UNRECOGNISED NON-ARRAY ENTRY IN "data"');
      expect(notes).toContain('surprise="x"');
      expect(notes).toContain('present and held 2 non-array entries (surprise, company)');
      expect(notes).not.toContain('present but empty');
    });

    it('still says "present but empty" for a genuinely empty "data" object', async () => {
      const { notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        { data: {}, count: 0 },
      );
      expect(notes).toContain('NO ITEMS:');
      expect(notes).toContain('present but empty');
      expect(notes).not.toContain('non-array entr');
    });

    it('keeps ranking, trimming and class counting on the genuine item classes only', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 1 },
        {
          data: {
            devices: [item('a', 10), item('b', 90)],
            pools: [item('p', 5), item('q', 50)],
            company: COMPANY_SCALAR,
          },
          count: 4,
        },
      );
      // The scalar is neither ranked, projected nor returned as a class.
      expect(payload).toEqual({ devices: [item('b', 90)], pools: [item('q', 50)] });
      // ...and it does not inflate the cross-class arithmetic.
      expect(notes).toContain('Lumics returned 2 item classes (devices, pools)');
      expect(notes).toContain('up to 2 row(s) can appear below');
      expect(notes).toContain('REQUEST METADATA INSIDE "data"');
    });

    it('applies a fields projection to the classes while still disclosing the scalar', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', fields: ['name'] },
        { data: { devices: [item('a', 10)], company: COMPANY_SCALAR }, count: 1 },
      );
      expect(payload).toEqual([{ name: 'a' }]);
      expect(notes).toContain(`company="${COMPANY_SCALAR}"`);
    });
  });

  /**
   * Finding H4. The multi-class branch dropped the caller's `fields` projection
   * (the single-class branch above passes it) and then, under a tight budget,
   * hard-truncated the keyed object into JSON that does not parse — while the
   * disclosure said "Re-run with a fields projection", which provably changed
   * nothing on that path. spec §12.4 says `data` keys other than `devices` appear
   * for component item types, so the branch is reachable.
   */
  describe('the multi-class path honours fields and sheds per class (finding H4)', () => {
    const twoClasses = (devices: unknown[], pools: unknown[]) => ({
      data: { devices, pools },
      count: devices.length + pools.length,
    });

    it('applies the fields projection inside every class', async () => {
      const { payload } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', fields: ['name'] },
        twoClasses([item('a', 1)], [item('p', 2)]),
      );
      expect(payload).toEqual({ devices: [{ name: 'a' }], pools: [{ name: 'p' }] });
    });

    it('emits JSON that parses under a budget that used to hard-truncate it', async () => {
      const bulky = (name: string) => ({
        id: name,
        name,
        stats: { Calculated: { cpu: { avg: 1, min: 0, max: 2 }, note: 'y'.repeat(200) } },
      });
      const { payload, text } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        twoClasses(
          Array.from({ length: 30 }, (_unused, index) => bulky(`d${String(index)}`)),
          Array.from({ length: 30 }, (_unused, index) => bulky(`p${String(index)}`)),
        ),
        { config: makeConfig({ maxOutputChars: 2_000 }) },
      );

      // The payload parsed at all, which it did not before.
      expect(payload).toBeTypeOf('object');
      const classes = payload as Record<string, unknown[]>;
      expect(Object.keys(classes).sort()).toEqual(['devices', 'pools']);
      // Both classes survive rather than one being sacrificed.
      expect(classes.devices?.length).toBeGreaterThan(0);
      expect(classes.pools?.length).toBeGreaterThan(0);
      expect(text).toContain('NOTE ON TRUNCATION:');
      expect(text).toContain('item(s) were dropped');
      // The old, useless advice must not reappear on this path.
      expect(text).not.toContain('may not parse');
      // This branch fits the classes itself, so it has to reserve the notes the
      // same way the shaping layer does, or the whole response blows the budget
      // and the keyed object gets hard-truncated back into unparseable JSON.
      expect(text.length).toBeLessThanOrEqual(2_000);
    });

    it('lets a fields projection actually save the payload, as the disclosure claims', async () => {
      const bulky = (name: string) => ({
        id: name,
        name,
        stats: { Calculated: { note: 'y'.repeat(300) } },
      });
      const args = { moduleType: 'snmp' };
      const response = twoClasses(
        Array.from({ length: 20 }, (_unused, index) => bulky(`d${String(index)}`)),
        Array.from({ length: 20 }, (_unused, index) => bulky(`p${String(index)}`)),
      );
      const config = makeConfig({ maxOutputChars: 2_000 });

      const unprojected = await metricExchange('lumics_get_metric_summary', args, response, {
        config,
      });
      const projected = await metricExchange(
        'lumics_get_metric_summary',
        { ...args, fields: ['name'] },
        response,
        { config },
      );

      expect(unprojected.text).toContain('NOTE ON TRUNCATION:');
      // With the projection the whole set fits, which is the point of the advice.
      expect(projected.text).not.toContain('NOTE ON TRUNCATION:');
      const classes = projected.payload as Record<string, unknown[]>;
      expect(classes.devices).toHaveLength(20);
      expect(classes.pools).toHaveLength(20);
    });

    it('says which classes are present and how many items went missing', async () => {
      const bulky = (name: string) => ({ id: name, stats: { note: 'y'.repeat(300) } });
      const { text } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        twoClasses(
          Array.from({ length: 10 }, (_unused, index) => bulky(`d${String(index)}`)),
          Array.from({ length: 10 }, (_unused, index) => bulky(`p${String(index)}`)),
        ),
        { config: makeConfig({ maxOutputChars: 1_500 }) },
      );
      expect(text).toContain('2 item classes (devices, pools)');
      expect(text).toMatch(/of 20 item\(s\) were dropped/);
      expect(text).toContain('The dropped items exist');
    });

    /**
     * `topN` is applied inside each class, so `{devices:[90,80,70],
     * interfaces:[95,85,75]}` with `topN: 2` returns four rows. That was only
     * inferable from the two LOCAL RANKING notes, and the cross-class caveat
     * lived in the truncation note, which fires only when the budget dropped
     * something.
     */
    it('states that topN was applied per item class, not globally', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 2 },
        twoClasses(
          [item('d1', 90), item('d2', 80), item('d3', 70)],
          [item('i1', 95), item('i2', 85), item('i3', 75)],
        ),
      );

      const classes = payload as Record<string, unknown[]>;
      expect(classes.devices).toHaveLength(2);
      expect(classes.pools).toHaveLength(2);
      // Four rows came back for topN: 2, and the note has to say why.
      expect(notes).toContain('applied to EACH item class');
      expect(notes).toContain('2 item classes (devices, pools)');
      expect(notes).toContain('up to 4 row(s)');
      expect(notes).not.toContain('NOTE ON TRUNCATION:');
    });

    it('states the per-class caveat even when no class was long enough to trim', async () => {
      const { notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 5 },
        twoClasses([item('d1', 90)], [item('i1', 95)]),
      );
      expect(notes).toContain('applied to EACH item class');
    });

    it('still ranks and trims per class before shedding', async () => {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 1 },
        twoClasses([item('a', 10), item('b', 90)], [item('p', 5), item('q', 50)]),
      );
      const classes = payload as Record<{ name: string }[] extends never ? never : string, unknown>;
      expect((classes.devices as { name: string }[]).map((entry) => entry.name)).toEqual(['b']);
      expect((classes.pools as { name: string }[]).map((entry) => entry.name)).toEqual(['q']);
      expect(notes).toContain('LOCAL RANKING of "devices"');
      expect(notes).toContain('LOCAL RANKING of "pools"');
    });
  });

  it('says so explicitly when Lumics returned a data object with no item classes in it', async () => {
    // Both of these carry a present `data` object, so "nothing matched" is a
    // conclusion the response actually supports.
    for (const response of [{ data: {} }, { data: { devices: 'nope' } }]) {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        response,
      );
      // Still `{}` — but no longer a bare `{}` that reads as a result.
      expect(payload).toEqual({});
      expect(notes).toContain('NO ITEMS:');
      expect(notes).toContain('not an error and not a truncation');
      expect(notes).toContain('lumics_list_component_types');
    }
  });

  it('does NOT say "nothing matched" when the body or its data field never arrived', async () => {
    // `null` is what the client returns for a 204 or an empty 200, and `{}` is an
    // envelope missing its documented `data`. Neither licenses a claim about what
    // the estate contains, so the absence is disclosed instead — see
    // tests/integration/partial-reads.test.ts for the full behaviour.
    for (const response of [null, {}]) {
      const { payload, notes } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        response,
      );
      expect(payload).toEqual({});
      expect(notes).toContain('NOTE ON AN EMPTY RESULT:');
      expect(notes).toContain('NOT because no device or component matched');
      expect(notes).not.toContain('NO ITEMS:');
    }
  });

  it('never sets requestedLimit, because no limit was ever sent', async () => {
    // Exactly the default limit's worth of items. A completeness note here would
    // be describing a parameter this endpoint does not have.
    const many = Array.from({ length: DEFAULT_LIST_LIMIT }, (_unused, index) =>
      item(`d${String(index)}`, index),
    );
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      summary(many),
    );
    expect(notes).not.toContain('equals the requested limit');
  });

  it('tolerates an absent body, a missing data key and a non-array class', async () => {
    for (const response of [null, {}, { data: {} }, { data: { devices: 'nope' } }]) {
      const { payload } = await metricExchange(
        'lumics_get_metric_summary',
        { moduleType: 'snmp' },
        response,
      );
      expect(payload).toEqual({});
    }
  });

  it('surfaces a non-object data field as documented drift', async () => {
    const { text } = await failingMetricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      { data: [{ id: 'a' }] },
    );
    expect(text).toContain('documented as an object keyed by item class');
  });

  it('surfaces a non-object body as documented drift', async () => {
    const { text } = await failingMetricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      'nope',
    );
    expect(text).toContain('summary envelope object was documented');
  });

  it('omits the count sentence when Lumics sent no count', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      { data: { devices: [item('a', 1)] } },
    );
    expect(notes).not.toContain('Lumics reported count=');
  });

  it('reports the effective window on this endpoint too, when the envelope carries one', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      {
        data: { devices: [item('a', 1)] },
        count: 1,
        from: '2026-07-29T11:00:00.000Z',
        to: '2026-07-29T12:00:00.000Z',
      },
    );
    expect(notes).toContain('EFFECTIVE RESULT:');
    expect(notes).toContain('covers 2026-07-29T11:00:00.000Z to 2026-07-29T12:00:00.000Z');
  });

  it('keeps items in a stable order when NONE of them has a value at the sort path', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.nosuchmetric.avg' },
      summary([item('a', 1), item('b', 2), item('c', 3)]),
    );
    // All three tie, so the input order survives rather than being scrambled.
    expect((payload as { name: string }[]).map((entry) => entry.name)).toEqual(['a', 'b', 'c']);
    expect(notes).toContain('3 of 3 item(s) had no numeric value');
  });

  it('treats a sortBy of only separators as unresolvable rather than throwing', async () => {
    const { payload, notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: '.' },
      summary([item('a', 1), item('b', 2)]),
    );
    expect(payload).toHaveLength(2);
    expect(notes).toContain('had no numeric value at "."');
  });

  it.each([0, 1_001, 2.5])('rejects a topN of %s locally', async (topN) => {
    const { calls } = await failingMetricExchange('lumics_get_metric_summary', {
      moduleType: 'snmp',
      topN,
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects an undocumented sortDirection', async () => {
    const { calls } = await failingMetricExchange('lumics_get_metric_summary', {
      moduleType: 'snmp',
      sortDirection: 'random',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('no metric tool ever fabricates pagination', () => {
  it.each([
    ...DATA_ENDPOINTS.map((entry) => [entry.tool, entry.args, SERIES] as const),
    [
      'lumics_get_metric_summary',
      { moduleType: 'snmp', sortBy: 'Calculated.cpu.avg', topN: 1 },
      { data: { devices: [{ id: 'a', stats: { Calculated: { cpu: { avg: 1 } } } }] }, count: 1 },
    ] as const,
  ])('%s', async (tool, args, response) => {
    const { text, call } = await metricExchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});

// ---------------------------------------------------------------------------
// Live finding 1: `properties` is REQUIRED on four of the five endpoints
// ---------------------------------------------------------------------------

/**
 * `docs/reference/lumics-api-v1.md` lists `properties` as optional on every
 * metric endpoint, having been transcribed from vendor documentation. The first
 * live contract run found otherwise: §12.1, §12.2 and both §12.3 endpoints answer
 * `400 {"error":"Must supply required component metrics as properties parameter"}`
 * without it, so every metric call this server made was failing outright.
 *
 * §12.4 is genuinely optional, and there `properties` means something else
 * entirely — a filter, not a projection — so it is deliberately left alone.
 */
describe('properties is required on the metric-data endpoints (live finding 1)', () => {
  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    '%s refuses a call with no properties, before any request is issued',
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const { properties: _dropped, ...withoutProperties } = entry.args;
      const { text, calls } = await failingMetricExchange(entry.tool, withoutProperties);

      expect(text).toContain('properties');
      // Nothing reached the wire — not even the device ownership pre-read, since
      // the schema rejects the arguments before the handler runs. A 400 round
      // trip for a parameter we know is required is a wasted turn.
      expect(calls).toHaveLength(0);
    },
  );

  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    '%s marks properties required in its published input schema',
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const harness = await connect(makeConfig(), {
        clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
      });
      try {
        const schema = harness.tool(entry.tool)?.inputSchema as {
          required?: string[];
          properties?: Record<string, { description?: string }>;
        };
        expect(schema.required ?? []).toContain('properties');
        // And the description says why, so a model does not have to learn it
        // from a 400 whose message names a parameter it thought was optional.
        expect(schema.properties?.properties?.description).toContain('REQUIRED');
        expect(schema.properties?.properties?.description).toContain(
          'Must supply required component metrics as properties parameter',
        );
      } finally {
        await harness.close();
      }
    },
  );

  it('leaves properties optional on the summaries endpoint, where it really is', async () => {
    const { call } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      { data: { devices: [] } },
    );
    expect(call.url.searchParams.has('properties')).toBe(false);

    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({ data: { devices: [] } })).fetchImpl },
    });
    try {
      const required = (
        harness.tool('lumics_get_metric_summary')?.inputSchema as {
          required?: string[];
        }
      ).required;
      expect(required ?? []).not.toContain('properties');
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Live finding 2: an invalid `properties` returns 200 with empty stats
// ---------------------------------------------------------------------------

/**
 * The most dangerous behaviour on this API, and the reason this module exists in
 * the shape it does.
 *
 * The upstream 400 gate checks only that `properties` is **present and
 * non-empty** — never that it means anything. `properties=cpu` returned 200 with
 * 658 rows and `stats: {}` on every one; `properties=bogusXYZ` returned exactly
 * the same. So a model asks for CPU, receives a clean success with no numbers in
 * it, and reports "no CPU data available" — a confident negative about a
 * customer's estate, produced by a malformed parameter.
 *
 * Two defences, tested separately here:
 *
 *  1. a schema guard that rejects a `properties` with no `Group.metric` entry at
 *     all, which is the measured form of the trap; and
 *  2. a runtime check of what came back against what was asked for, which catches
 *     the forms the schema cannot see — an unknown metric inside a real group, or
 *     a group that does not exist.
 */
describe('a properties value with no Group.metric entry is rejected locally (live finding 2)', () => {
  it.each(['cpu', 'bogusXYZ', 'cpu,mem', '.cpu', 'Calculated.'])(
    'rejects %s without spending a request',
    async (properties) => {
      const { text, calls } = await failingMetricExchange('lumics_get_company_metrics', {
        moduleType: 'snmp',
        properties,
      });
      // The error has to teach the syntax, because the API's own answer to this
      // value is a 200 that teaches nothing.
      expect(text).toContain('<TypeGroup>.<metric>');
      expect(text).toContain('Calculated.cpu');
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects it on the summaries endpoint too', async () => {
    const { calls } = await failingMetricExchange('lumics_get_metric_summary', {
      moduleType: 'snmp',
      properties: 'cpu',
    });
    expect(calls).toHaveLength(0);
  });

  it('is deliberately weak: one qualified entry is enough to let the value through', async () => {
    // No bare name has been PROVEN illegal, only measured useless, so a value
    // that pairs a qualified entry with a bare one is sent verbatim and left to
    // the runtime disclosure below. Rejecting it would be this server inventing
    // a rule the API has not stated.
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu,mem' },
      SERIES,
    );
    expect(call.query.properties).toBe('Calculated.cpu,mem');
  });
});

describe('rows that carry none of the requested properties are disclosed (live finding 2)', () => {
  /** A row shaped like a real one, with whatever `stats` the case needs. */
  const row = (stats?: unknown) => ({
    _id: '777777777777777777777777',
    item: '888888888888888888888888',
    type: 'snmp_common_cpu',
    timeMs: 1_785_000_000_000,
    ...(stats === undefined ? {} : { stats }),
  });

  const BANNER = 'PROPERTY NAMES MAY BE WRONG';

  it.each(DATA_ENDPOINTS.map((entry) => [entry.tool, entry] as const))(
    '%s says so rather than letting the result read as "no data"',
    async (_name, entry: (typeof DATA_ENDPOINTS)[number]) => {
      const { notes } = await metricExchange(
        entry.tool,
        { ...entry.args, properties: 'Calculated.cpu' },
        { data: [row({}), row({}), row({})] },
      );

      expect(notes).toContain(BANNER);
      expect(notes).toContain('THIS IS NOT A STATEMENT THAT NO DATA EXISTS');
      expect(notes).toContain('3 row(s)');
      // The three things the disclosure has to carry.
      expect(notes).toContain('<TypeGroup>.<metric>');
      expect(notes).toContain('lumics_get_metric_summary');
      expect(notes).toMatch(/Do NOT tell the user/);
      // And it must not read as a finding about the estate.
      expect(notes).toContain('does not support any of that');
    },
  );

  it('distinguishes a recognised group with an unknown metric from a group that does not exist', async () => {
    // Measured: `Rate.ifInOctets` echoed the group back empty — `{"Rate":{}}`.
    const recognised = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Rate.ifInOctets' },
      { data: [row({ Rate: {} })] },
    );
    expect(recognised.notes).toContain('the type group came back but held no such metric');
    expect(recognised.notes).not.toContain('never appeared in any row');

    // Measured: an unrecognised group produces no such key at all.
    const unrecognised = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Bogus.cpu' },
      { data: [row({ Calculated: { cpu: { avg: 3 } } })] },
    );
    expect(unrecognised.notes).toContain("its type group never appeared in any row's stats");
    expect(unrecognised.notes).not.toContain('held no such metric');
  });

  it('calls out the strongest signal: not one row carried a stats key at all', async () => {
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Bogus.cpu' },
      { data: [row(), row()] },
    );
    expect(notes).toContain('NOT ONE row carried a "stats" key at all');
  });

  it('names an unqualified entry as the exact measured form of the trap', async () => {
    // Reachable only alongside a qualified entry, which is what the schema guard
    // leaves through — so the runtime check is what catches it.
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu,cpu' },
      { data: [row({})] },
    );
    expect(notes).toContain('carries no "<TypeGroup>." prefix');
  });

  it('does not flag an unqualified entry that Lumics did answer', async () => {
    // The premise of the weak schema guard: no bare name has been PROVEN illegal.
    // If one turns up keyed inside a real group, the response is honest and this
    // server must not tell the model its own successful call was malformed.
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu,status' },
      { data: [row({ Calculated: { cpu: { avg: 1 }, status: { avg: 0 } } })] },
    );
    expect(notes).not.toContain(BANNER);
    expect(notes).not.toContain('SOME PROPERTIES RETURNED NO VALUES');
  });

  it('reports a partial miss as partial, without impugning the values that did arrive', async () => {
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu,Calculated.nosuch' },
      { data: [row({ Calculated: { cpu: { avg: 42 } } })] },
    );
    expect(notes).toContain('SOME PROPERTIES RETURNED NO VALUES');
    expect(notes).toContain('Calculated.nosuch');
    expect(notes).toContain('can be read normally');
    // The total-failure banner would overstate this.
    expect(notes).not.toContain(BANNER);
  });

  it('stays silent when every requested property resolved', async () => {
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu,Calculated.mem' },
      { data: [row({ Calculated: { cpu: { avg: 1 }, mem: { avg: 2 } } })] },
    );
    expect(notes).not.toContain(BANNER);
    expect(notes).not.toContain('SOME PROPERTIES RETURNED NO VALUES');
  });

  it('treats presence on ANY row as resolved, so a mixed estate is not a false alarm', async () => {
    // A company-wide query legitimately returns components that do not carry the
    // metric next to ones that do. Calling that a naming failure would train the
    // model to ignore the disclosure.
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu' },
      { data: [row({}), row({ Calculated: { cpu: { avg: 1 } } }), row({})] },
    );
    expect(notes).not.toContain(BANNER);
  });

  it('says nothing about property names when the series is genuinely empty', async () => {
    // No rows means no evidence either way, and `absentSeriesNote` already owns
    // the cases where the emptiness came from the transport. A "your names may be
    // wrong" note here would be a guess.
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: 'Calculated.cpu' },
      { data: [] },
    );
    expect(notes).not.toContain(BANNER);
    expect(notes).not.toContain('SOME PROPERTIES RETURNED NO VALUES');
  });

  it('bounds the note when many properties are unresolved', async () => {
    const many = Array.from({ length: 9 }, (_unused, index) => `Calculated.p${String(index)}`);
    const { notes } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', properties: many.join(',') },
      { data: [row({})] },
    );
    expect(notes).toContain('and 3 more');
  });
});

// ---------------------------------------------------------------------------
// Live finding 3: itemType is the SINGULAR component id
// ---------------------------------------------------------------------------

/**
 * `lumics_list_component_types` (spec §6.4) returns PLURAL aliases and 213 of the
 * 246 values it returns are rejected by the metrics API: `snmp_common_cpus`,
 * `cpus` and `cpu` all answer `400 Unknown component`, while `snmp_common_cpu`
 * answers 200. Every metric tool used to send the model to that endpoint for this
 * argument, which is a route to a 400 by construction.
 */
describe('itemType routes the model to the singular component id (live finding 3)', () => {
  const TOOLS_WITH_ITEM_TYPE = [
    'lumics_get_company_metrics',
    'lumics_summarize_company_metrics',
    'lumics_get_device_metrics',
    'lumics_get_metric_summary',
  ] as const;

  it.each(TOOLS_WITH_ITEM_TYPE)(
    '%s describes how to build the id, and from where',
    async (tool) => {
      const harness = await connect(makeConfig(), {
        clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
      });
      try {
        const description =
          (
            harness.tool(tool)?.inputSchema as {
              properties?: Record<string, { description?: string }>;
            }
          ).properties?.itemType?.description ?? '';

        expect(description).toContain('SINGULAR');
        expect(description).toContain('snmp_common_cpu');
        // The endpoint the id is actually constructible from (spec §6.5).
        expect(description).toContain('lumics_get_device_definition_components');
        expect(description).toContain('filePath');
        expect(description).toContain('data.itemType');
        // A bare "device" remains valid.
        expect(description).toContain('"device"');
        // And the ordering trap: a wrong itemType masks a properties problem.
        expect(description).toContain('validates itemType BEFORE properties');

        // It must no longer send the model to the plural-alias endpoint for this.
        expect(description).toContain('Do NOT take this value from lumics_list_component_types');
        expect(description).not.toContain('Discover valid values with lumics_list_component_types');
      } finally {
        await harness.close();
      }
    },
  );

  it('points at a metric response as a second discovery source', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
    });
    try {
      const description = harness.tool('lumics_get_company_metrics')?.description ?? '';
      expect(description).toContain('"type" field');
      expect(description).toContain('singular component id');
    } finally {
      await harness.close();
    }
  });

  it('the summaries "nothing matched" note no longer blames the wrong endpoint', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', itemType: 'snmp_common_cpus' },
      { data: {}, count: 0 },
    );
    expect(notes).toContain('NO ITEMS:');
    expect(notes).toContain('lumics_get_device_definition_components');
    expect(notes).toContain('SINGULAR');
    // It must not state a negative about the estate as the leading explanation.
    expect(notes).not.toContain('so nothing matched this module');
  });
});

// ---------------------------------------------------------------------------
// Live finding 4: the only property-name enumeration path is §12.4
// ---------------------------------------------------------------------------

/**
 * `/system/deviceDefinitions/components` is the inventory schema and carries no
 * metric names at all — zero hits for `Calculated` or `sysUpTime` across 386 kB.
 * The only enumeration path is this endpoint's own `stats` keys, and it has two
 * limits that a consumer who does not know them will get wrong.
 */
describe('lumics_get_metric_summary is documented as the property-name enumerator (live finding 4)', () => {
  it('says how to read legal properties values out of its response', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({ data: { devices: [] } })).fetchImpl },
    });
    try {
      const description = harness.tool('lumics_get_metric_summary')?.description ?? '';

      expect(description).toContain('data.<class>[].stats');
      expect(description).toContain('type groups');
      // The two caveats.
      expect(description).toContain('DEVICE-scoped');
      expect(description).toContain('http_endpoints');
      // And that its own `properties` is a filter, not a projection.
      expect(description).toContain('filters the result rather than projecting it');
    } finally {
      await harness.close();
    }
  });

  it('discloses the filter semantics on every call that sends properties', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', properties: 'Calculated.cpu' },
      { data: { devices: [{ id: 'a', stats: { Calculated: { cpu: { avg: 1 } } } }] }, count: 1 },
    );
    // Said even though rows came back: a filtered-but-non-empty response is the
    // more dangerous case, because it looks complete.
    expect(notes).toContain('PROPERTIES IS A FILTER HERE');
    expect(notes).toContain('narrower than');
  });

  it('names properties as the first suspect when a filtered call comes back empty', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp', properties: 'Calculated.cpu' },
      { data: {}, count: 0 },
    );
    expect(notes).toContain('MOST LIKELY CAUSE');
    expect(notes).toContain('Re-run this call with no "properties" at all');
  });

  it('stays quiet about the filter when no properties was sent', async () => {
    const { notes } = await metricExchange(
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
      { data: { devices: [] } },
    );
    expect(notes).not.toContain('PROPERTIES IS A FILTER HERE');
  });
});

// ---------------------------------------------------------------------------
// Live finding 5: /summarize needs a deadline of its own
// ---------------------------------------------------------------------------

describe('summarize gets a much larger timeout than the other metric tools (live finding 5)', () => {
  /** Record the deadline handed to `AbortSignal.timeout()` on each request. */
  function withTimeoutSpy<T>(body: () => Promise<T>): Promise<{ result: T; deadlines: number[] }> {
    const deadlines: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      deadlines.push(ms);
      return original(ms);
    };
    return body()
      .then((result) => ({ result, deadlines }))
      .finally(() => {
        AbortSignal.timeout = original;
      });
  }

  it('sends a deadline of minutes, not the configured 5 seconds', async () => {
    const { deadlines } = await withTimeoutSpy(async () =>
      metricExchange(
        'lumics_summarize_company_metrics',
        { moduleType: 'snmp', properties: PROPS },
        SERIES,
        { config: makeConfig({ timeoutMs: 5_000 }) },
      ),
    );
    // Measured: the endpoint exceeded 90 seconds without returning.
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(120_000);
  });

  it('leaves the fast metric endpoints on the configured timeout', async () => {
    const { deadlines } = await withTimeoutSpy(async () =>
      metricExchange(
        'lumics_get_company_metrics',
        { moduleType: 'snmp', properties: PROPS },
        SERIES,
        {
          config: makeConfig({ timeoutMs: 5_000 }),
        },
      ),
    );
    expect(deadlines).toEqual([5_000]);
  });

  it('never shortens a deadline an operator deliberately made longer', async () => {
    const { deadlines } = await withTimeoutSpy(async () =>
      metricExchange(
        'lumics_summarize_company_metrics',
        { moduleType: 'snmp', properties: PROPS },
        SERIES,
        { config: makeConfig({ timeoutMs: 250_000 }) },
      ),
    );
    expect(deadlines).toEqual([250_000]);
  });

  it('warns in its description that it is slow and can still time out', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
    });
    try {
      const description = harness.tool('lumics_summarize_company_metrics')?.description ?? '';
      expect(description).toContain('SLOW');
      expect(description).toContain('90 seconds');
      expect(description).toContain('can still time out');
      // And that a timeout is not evidence of an empty estate.
      expect(description).toContain('NOT evidence that there is no data');
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Live finding 5, follow-up: the deadline multiplies with the retry budget
// ---------------------------------------------------------------------------

/**
 * The deadline above and the attempt budget are two numbers that multiply.
 *
 * `/summarize` holds a three-minute deadline, a timeout on a GET is retryable,
 * and `DEFAULT_MAX_ATTEMPTS` is 3 — so before the per-request attempt cap, a
 * `/summarize` against an endpoint that never answers cost 3 x 180s ~ 9 minutes
 * before it reported anything. From inside an MCP client that is a hung server,
 * and the retries buy nothing: an endpoint that did not answer in three minutes
 * is not suffering a transient fault, and attempts two and three pay the same
 * three minutes to learn the same thing.
 *
 * These tests measure the budget rather than trusting it, and they measure it in
 * the only two units that matter — how many requests went out, and what deadline
 * each one carried. Nothing here waits: `fetchImpl` rejects the way
 * `AbortSignal.timeout()` does and `sleep` is recorded, never performed.
 */
describe('a timing-out summarize costs one deadline, not three (live finding 5, follow-up)', () => {
  interface TimeoutRun {
    readonly deadlines: number[];
    readonly calls: readonly RecordedCall[];
    readonly delays: readonly number[];
    readonly text: string;
  }

  /**
   * Drive a metric tool against a transport that always times out, recording
   * every deadline handed to `AbortSignal.timeout()`, every request, and every
   * backoff the client asked to sleep.
   */
  async function runAgainstTimeout(
    tool: string,
    args: Record<string, unknown>,
    config: LumicsConfig = makeConfig({ timeoutMs: 5_000 }),
  ): Promise<TimeoutRun> {
    const fetcher = timeoutFetch();
    const sleeper = recordSleep();
    const deadlines: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      deadlines.push(ms);
      return original(ms);
    };

    const harness = await connect(config, {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call(tool, args);
      expect(called.isError, `${tool} was expected to time out`).toBe(true);
      const block = called.content[0];
      return {
        deadlines,
        calls: fetcher.calls,
        delays: sleeper.delays,
        text: block?.type === 'text' ? block.text : '',
      };
    } finally {
      AbortSignal.timeout = original;
      await harness.close();
    }
  }

  it('makes exactly one attempt and waits one deadline, not three', async () => {
    const run = await runAgainstTimeout('lumics_summarize_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
    });

    expect(run.calls).toHaveLength(1);
    expect(run.deadlines).toEqual([METRIC_SUMMARIZE_TIMEOUT_MS]);
    // The number this test exists to hold down: total wall time the server can
    // spend before it reports the timeout. One deadline, not DEFAULT_MAX_ATTEMPTS
    // of them plus backoff between each.
    expect(run.deadlines.reduce((total, ms) => total + ms, 0)).toBe(METRIC_SUMMARIZE_TIMEOUT_MS);
    expect(run.deadlines.reduce((total, ms) => total + ms, 0)).toBeLessThan(
      METRIC_SUMMARIZE_TIMEOUT_MS * DEFAULT_MAX_ATTEMPTS,
    );
    expect(run.delays).toHaveLength(0);
  });

  it('tells the model the endpoint is slow, how long it waited, and what to try instead', async () => {
    const { text } = await runAgainstTimeout('lumics_summarize_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
    });

    // How long was actually waited, and that it was one attempt.
    expect(text).toContain(`${String(METRIC_SUMMARIZE_TIMEOUT_MS)}ms`);
    expect(text).toContain('1 attempt(s)');
    // That the endpoint is known to be slow, so this is not a surprise fault.
    expect(text).toMatch(/known to be slow/i);
    // The claim that actually protects the user: a timeout is not an absence of
    // data. A model that reads this as "no data" reports an empty estate.
    expect(text).toMatch(/NOT an empty result|not evidence/i);
    expect(text).toContain('do NOT report');
    // And the four things worth trying, including the fast endpoint.
    expect(text).toContain('itemType');
    expect(text).toContain('properties');
    expect(text).toMatch(/shorten the window/i);
    expect(text).toContain('lumics_get_company_metrics');
  });

  it('leaves a non-timeout failure alone: a 400 does not get "narrow the request" advice', async () => {
    // The enrichment is timeout-only on purpose. A malformed "properties" is a
    // 400, the request was never too large, and telling the model to shorten its
    // window would send it to fix something that is not broken.
    const fetcher = recordFetch(errorResponse(400, 'properties is malformed'));
    const sleeper = recordSleep();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call('lumics_summarize_company_metrics', {
        moduleType: 'snmp',
        properties: PROPS,
      });
      expect(called.isError).toBe(true);
      const block = called.content[0];
      const text = block?.type === 'text' ? block.text : '';

      expect(text).toContain('400');
      expect(text).not.toMatch(/known to be slow/i);
      expect(text).not.toContain('NOT AN EMPTY RESULT');
      // The cap still applies: a 400 was never retryable, so this is one call.
      expect(fetcher.calls).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('leaves the fast metric endpoints retrying a timeout exactly as before', async () => {
    const run = await runAgainstTimeout('lumics_get_company_metrics', {
      moduleType: 'snmp',
      properties: PROPS,
    });

    // Unchanged: §12.1 answers in one to two seconds, so its retries are cheap
    // and the transient faults they cover are real.
    expect(run.calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    expect(run.deadlines).toEqual([5_000, 5_000, 5_000]);
    expect(run.delays).toHaveLength(DEFAULT_MAX_ATTEMPTS - 1);
  });

  it('leaves the fast metric endpoints retrying a transient 503 exactly as before', async () => {
    const fetcher = recordFetch([errorResponse(503), jsonResponse(SERIES)]);
    const sleeper = recordSleep();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call('lumics_get_company_metrics', {
        moduleType: 'snmp',
        properties: PROPS,
      });
      expect(called.isError).not.toBe(true);
      expect(fetcher.calls).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('still honours a LUMICS_TIMEOUT_MS an operator raised above the summarize deadline', async () => {
    const run = await runAgainstTimeout(
      'lumics_summarize_company_metrics',
      { moduleType: 'snmp', properties: PROPS },
      makeConfig({ timeoutMs: 250_000 }),
    );

    // The cap bounds attempts, not the deadline: an operator who deliberately
    // raised LUMICS_TIMEOUT_MS above the summarize override still gets their
    // value, and still gets it exactly once.
    expect(run.deadlines).toEqual([250_000]);
    expect(run.calls).toHaveLength(1);
    expect(run.text).toContain('250000ms');
  });
});

// ---------------------------------------------------------------------------
// Live finding M12: the company-scoped endpoint is unreliable in practice
// ---------------------------------------------------------------------------

/**
 * spec §12.5 M12, measured 2026-07-30 across two contract runs and a manual
 * probe against a production tenant:
 *
 *  - §12.1 returned **HTTP 500** on ordinary queries carrying a valid
 *    `properties` value, and the failures tracked specific parameters while
 *    others — and a minimal query — were served. Intermittent, not dead.
 *  - §12.2 `/summarize` never returned at all.
 *  - §12.3, device-scoped, answered with populated data in one to two seconds.
 *  - The vendor's own dashboard issued 57 API calls on load, including its top-N
 *    device widgets, and never once called `/api/v1/metrics/companies/`.
 *
 * The owner's decision was to **document, not withhold**. These tests hold the
 * documentation to that: the two tools must say what was observed, with its
 * conditions, name the fallback tools, and stop short of "this is broken" — and
 * a 500 must reach the model as endpoint-aware advice rather than as a flat
 * internal error, on these two endpoints and on no others.
 */
describe('the company-scoped metric tools disclose that the endpoint is unreliable (spec section 12.5 M12)', () => {
  const COMPANY_SCOPED = [
    'lumics_get_company_metrics',
    'lumics_summarize_company_metrics',
  ] as const;
  const DEVICE_SCOPED = ['lumics_get_device_metrics', 'lumics_get_device_item_metrics'] as const;

  /** Read a tool's registered description without issuing a request. */
  async function describeTool(name: string): Promise<string> {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SERIES)).fetchImpl },
    });
    try {
      return harness.tool(name)?.description ?? '';
    } finally {
      await harness.close();
    }
  }

  it.each(COMPANY_SCOPED)('%s warns that the endpoint is unreliable in practice', async (name) => {
    const description = await describeTool(name);

    expect(description).toContain('UNRELIABLE IN PRACTICE');
    expect(description).toContain('spec section 12.5 M12');
    // Both observed failures, on both tools: a model choosing between them needs
    // to know that neither company-scoped route is dependable.
    expect(description).toContain('HTTP 500');
    expect(description).toMatch(/did not return AT ALL over 90 seconds/);
  });

  it.each(COMPANY_SCOPED)('%s names the parameters that correlated with a 500', async (name) => {
    const description = await describeTool(name);

    for (const param of COMPANY_METRIC_500_CORRELATED_PARAMS) {
      expect(description).toContain(param);
    }
    for (const param of COMPANY_METRIC_500_SERVED_PARAMS) {
      expect(description).toContain(param);
    }
  });

  it.each(COMPANY_SCOPED)(
    '%s routes the model to the device-scoped tools by name',
    async (name) => {
      const description = await describeTool(name);

      expect(description).toContain('lumics_list_devices');
      expect(description).toContain('lumics_get_device_metrics');
      expect(description).toContain('lumics_get_device_item_metrics');
      expect(description).toMatch(/one to two seconds/);
    },
  );

  it.each(COMPANY_SCOPED)('%s records the vendor UI observation', async (name) => {
    // The strongest single piece of evidence: the product that owns the API does
    // not use this route for company-wide metrics.
    const description = await describeTool(name);

    expect(description).toContain('57 API calls');
    expect(description).toContain('/api/v1/metrics/companies/');
  });

  it.each(COMPANY_SCOPED)('%s does not overstate it as simply broken', async (name) => {
    const description = await describeTool(name);

    // §12.1 served a minimal query. Saying otherwise would be as wrong as
    // saying nothing, and would push a model off a tool that still answers.
    expect(description).toContain('INTERMITTENT AND QUERY-DEPENDENT, NOT DEAD');
    expect(description).toMatch(/No cause has been established/);
  });

  it.each(DEVICE_SCOPED)(
    '%s carries no such warning — it is the endpoint that works',
    async (name) => {
      const description = await describeTool(name);
      expect(description).not.toContain('UNRELIABLE IN PRACTICE');
    },
  );

  /** A fetch that answers the device ownership pre-read and 500s everything else. */
  function serverErrorFetch(): FetchRecorder {
    return recordFetch((call) =>
      call.path.startsWith(`/companies/${C}/devices/`)
        ? jsonResponse(OWNED_DEVICE)
        : errorResponse(500, '{"error":"Sorry, an error occurred. Please try again.","code":500}'),
    );
  }

  async function failWith500(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ readonly text: string; readonly calls: readonly RecordedCall[] }> {
    const fetcher = serverErrorFetch();
    const sleeper = recordSleep();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call(tool, args);
      expect(called.isError, `${tool} was expected to fail`).toBe(true);
      const block = called.content[0];
      return { text: block?.type === 'text' ? block.text : '', calls: fetcher.calls };
    } finally {
      await harness.close();
    }
  }

  it.each([
    ['lumics_get_company_metrics', { moduleType: 'snmp', properties: PROPS }],
    ['lumics_summarize_company_metrics', { moduleType: 'snmp', properties: PROPS }],
  ] as const)(
    '%s reports a 500 as a known-unreliable endpoint, not an internal error',
    async (tool, args) => {
      const { text } = await failWith500(tool, { ...args });

      expect(text).toContain('500');
      expect(text).toMatch(/KNOWN TO BE UNRELIABLE IN PRACTICE/);
      // The generic advice this replaces is the actively misleading part: on this
      // endpoint the arguments do correlate, and there is a working alternative.
      expect(text).not.toContain('This is not a problem with your arguments');
      expect(text).toContain('lumics_list_devices');
      expect(text).toContain('lumics_get_device_metrics');
      // A 500 is not an absence of data, and must not be reported as one.
      expect(text).toMatch(/NOT evidence that this company, module or metric has no data/);
    },
  );

  it.each([
    ['lumics_get_company_metrics', { moduleType: 'snmp', properties: PROPS }],
    ['lumics_summarize_company_metrics', { moduleType: 'snmp', properties: PROPS }],
  ] as const)('%s fails fast on a 500 rather than spending attempts on it', async (tool, args) => {
    const { calls } = await failWith500(tool, { ...args });

    // One request to the metric endpoint. A 500 has never been in
    // RETRYABLE_STATUSES, and the error now says so instead of claiming the
    // server "already retried where safe".
    const metricCalls = calls.filter((call) => call.path.startsWith('/metrics/'));
    expect(metricCalls).toHaveLength(1);
  });

  it('leaves a 500 from the device-scoped endpoint on the generic guidance', async () => {
    // §12.3 is the endpoint that works. A 500 there is a genuine surprise and
    // the generic mapping is the right thing to say about it.
    const { text } = await failWith500('lumics_get_device_metrics', {
      deviceId: TEST_DEVICE_ID,
      moduleType: 'snmp',
      properties: PROPS,
    });

    expect(text).toContain('This is not a problem with your arguments');
    expect(text).not.toMatch(/KNOWN TO BE UNRELIABLE/);
  });

  it('leaves a 500 from a non-metric endpoint on the generic guidance', async () => {
    const fetcher = recordFetch(errorResponse(500));
    const sleeper = recordSleep();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call('lumics_list_devices', {});
      expect(called.isError).toBe(true);
      const block = called.content[0];
      const text = block?.type === 'text' ? block.text : '';
      expect(text).toContain('This is not a problem with your arguments');
      expect(text).not.toMatch(/KNOWN TO BE UNRELIABLE/);
    } finally {
      await harness.close();
    }
  });

  it('still retries a transient 503 on the company-scoped endpoint', async () => {
    // The fail-fast is about 500 specifically. Capping attempts on this endpoint
    // would also disable the retries that cover genuinely transient statuses,
    // which is a control this change must not weaken.
    const fetcher = recordFetch([errorResponse(503), jsonResponse(SERIES)]);
    const sleeper = recordSleep();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: sleeper.sleep },
    });
    try {
      const called = await harness.call('lumics_get_company_metrics', {
        moduleType: 'snmp',
        properties: PROPS,
      });
      expect(called.isError).not.toBe(true);
      expect(fetcher.calls).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });
});
