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
  DEFAULT_LIST_LIMIT,
  DEFAULT_METRIC_DATA_POINTS,
  METRIC_INTERVALS,
  METRIC_SUM_PROPERTIES,
} from '../../src/constants.js';
import {
  makeConfig,
  TEST_COMPANY_ID,
  TEST_COMPONENT_ID,
  TEST_DEVICE_ID,
} from '../helpers/config.js';
import {
  jsonResponse,
  recordFetch,
  type FetchRecorder,
  type RecordedCall,
} from '../helpers/fetch.js';
import { connect, notesOf, payloadOf } from '../helpers/mcp.js';
import { expectNoFabricatedPagination, expectNoFabricatedQueryParams } from '../helpers/tools.js';
import type { LumicsConfig } from '../../src/config.js';

const C = TEST_COMPANY_ID;
const HOUR_MS = 3_600_000;

const SERIES = {
  data: [{ time: 1_785_000_000_000, stats: { status: { avg: 1 } } }],
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
    args: { moduleType: 'snmp' },
    path: `/metrics/companies/${C}/modules/snmp`,
  },
  {
    tool: 'lumics_summarize_company_metrics',
    args: { moduleType: 'snmp' },
    path: `/metrics/companies/${C}/modules/snmp/summarize`,
  },
  {
    tool: 'lumics_get_device_metrics',
    args: { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
    path: `/metrics/devices/${TEST_DEVICE_ID}/modules/snmp`,
  },
  {
    tool: 'lumics_get_device_item_metrics',
    args: { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', itemId: TEST_COMPONENT_ID },
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
      { moduleType: 'snmp', width: 1_920 },
      SERIES,
    );
    expect(call.url.searchParams.has('width')).toBe(false);
    expect(call.query.dataPoints).toBe(String(DEFAULT_METRIC_DATA_POINTS));
  });

  it.each([0, -1, 5_001, 1.5])('rejects a dataPoints of %s locally', async (dataPoints) => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
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
      { moduleType: 'snmp', sum },
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
      sum,
    });
    expect(calls).toHaveLength(0);
  });

  it('omits sum entirely when it was not asked for, and says the result is an AVERAGE', async () => {
    const { call, notes } = await metricExchange(
      'lumics_summarize_company_metrics',
      { moduleType: 'snmp' },
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
      { moduleType: 'snmp', lookback: '6h' },
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
      { moduleType: 'snmp' },
      SERIES,
    );
    expect(Number(call.query.toMs) - Number(call.query.fromMs)).toBe(HOUR_MS);
    expect(notes).toContain('1 hour(s)');
  });

  it('converts an ISO-8601 from/to pair, so a model never computes epoch ms', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', from: '2026-07-28T00:00:00Z', to: '2026-07-29T00:00:00Z' },
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
        properties: 'status,Integer.statusEnabledState',
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
      properties: 'status,Integer.statusEnabledState',
      lastMetric: 'true',
      isMonitored: 'true',
      limit: '25',
      dataPoints: '30',
    });
  });

  it('omits every optional parameter the caller did not set', async () => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp' },
      SERIES,
    );
    // Only the three the server always sends: the window and the resolution.
    // `limit` is NOT among them — see the metric-row-cap block below.
    expect(Object.keys(call.query).sort()).toEqual(['dataPoints', 'fromMs', 'toMs']);
    expect(call.query.limit).toBeUndefined();
  });

  it.each(METRIC_INTERVALS)('accepts the documented interval %s', async (interval) => {
    const { call } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp', interval },
      SERIES,
    );
    expect(call.query.interval).toBe(interval);
  });

  it('rejects an undocumented interval', async () => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
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
      from: '2026-07-28T00:00:00Z',
      lookback: '6h',
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('not both');
  });

  it('rejects a garbage lookback at the schema, before the time layer sees it', async () => {
    const { calls } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
      lookback: 'last week',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a reversed window', async () => {
    const { calls, text } = await failingMetricExchange('lumics_get_company_metrics', {
      moduleType: 'snmp',
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
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
      SERIES,
    );
    expect(payload).toEqual(SERIES.data);
  });

  it('reports the window Lumics actually served, which alignTimeRange can change', async () => {
    const { notes } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', alignTimeRange: true },
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
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
      { data: [], fromMs: Date.UTC(2026, 6, 29, 11), toMs: Date.UTC(2026, 6, 29, 12) },
    );
    expect(notes).toContain('covers 2026-07-29T11:00:00.000Z to 2026-07-29T12:00:00.000Z');
  });

  it('omits the effective-window note when the envelope carries no metadata', async () => {
    const { notes } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
      { data: [] },
    );
    expect(notes).toContain('WINDOW AND RESOLUTION:');
    expect(notes).not.toContain('EFFECTIVE RESULT:');
  });

  it('treats an absent body as an empty series rather than failing', async () => {
    const { payload } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
      null,
    );
    expect(payload).toEqual([]);
  });

  it('treats a missing data key as an empty series', async () => {
    const { payload } = await metricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
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
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
      response,
    );
    expect(text).toContain('invalid_response');
  });

  it('surfaces a non-array data field as drift', async () => {
    const { text } = await failingMetricExchange(
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
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
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', itemId: TEST_DEVICE_ID },
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
      { moduleType: 'snmp' },
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
      { moduleType: 'snmp', limit: 25 },
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
        stats: { status: { avg: index, blob: 'x'.repeat(80) } },
      })),
    };
    const { text } = await metricExchange(
      'lumics_get_company_metrics',
      { moduleType: 'snmp' },
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
