/**
 * Partial and absent responses, end to end through the real registered tools.
 *
 * This file exists because of one failure mode, and it is the one this codebase is
 * organised against: **a short answer that looks like a complete one.**
 *
 * Two distinct cases, deliberately treated differently:
 *
 *  - **The body transfer failed** (a mid-stream reset, or the abort signal firing
 *    while the body was still arriving). This used to be swallowed by
 *    `.catch(() => '')` in `src/api/client.ts` and reported as an empty success:
 *    `lumics_list_devices` answered `isError: false, text: "[]"` and
 *    `lumics_get_device` answered `isError: false, text: "null"`. The model was
 *    told the tenant monitors zero devices, with no error and no disclosure, and
 *    because it classified as success it was never retried either. It must be an
 *    error result now.
 *  - **The body was legitimately absent** (a 204, or an empty 200). That is a real
 *    shape spec §4.2 does not document but the API produces, so a list still
 *    reports zero records — with a note saying "Lumics sent no body" is not the
 *    same claim as "the collection is empty". A single read has no such reading and
 *    raises `invalid_response`.
 *
 * The metric tools (spec §12) are the third case, and the sharpest one: an absent
 * body there produces an empty *series*, which reads as "this device reported no
 * measurements in that window" — a claim about the estate rather than about a
 * record count. They disclose it in their own wording, distinct from the list note,
 * and stay silent when Lumics genuinely sent an empty series.
 */

import { describe, expect, it } from 'vitest';
import { ABSENT_BODY_LIST_NOTE } from '../../src/api/client.js';
import {
  makeConfig,
  TEST_COLLECTOR_ID,
  TEST_COMPANY_ID,
  TEST_COMPONENT_ID,
  TEST_DEVICE_ID,
  TEST_SUBNET_ID,
} from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';

/** A 200 whose body stream fails partway through, the way a reset connection does. */
function truncatedBodyFetch(): ReturnType<typeof recordFetch> {
  return recordFetch(
    () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        // 45 bytes arrived, then the transfer died.
        text: () => Promise.reject(new TypeError('terminated', { cause: new Error('ECONNRESET') })),
      }) as unknown as Response,
  );
}

/** A response with no body at all: the 204 the API emits in practice. */
function emptyBodyFetch(status: number): ReturnType<typeof recordFetch> {
  return recordFetch(() => new Response(null, { status }));
}

/**
 * The two device-scoped metric tools (spec §12.3) resolve the device's owning
 * company with a company-scoped device read before they read any metrics, so the
 * cross-company pin covers a metric path that carries no company segment. That
 * read has to succeed for the degraded metric response under test to be reached,
 * so this wrapper answers it with a device in the configured company and hands
 * everything else to `respond`. The pin itself is asserted in
 * `tests/security/company-scoping.test.ts`.
 */
function metricFetch(respond: () => Response): ReturnType<typeof recordFetch> {
  return recordFetch((call) =>
    call.path === `/companies/${TEST_COMPANY_ID}/devices/${TEST_DEVICE_ID}`
      ? jsonResponse({ id: TEST_DEVICE_ID, company: TEST_COMPANY_ID })
      : respond(),
  );
}

/** An absent body (204 or empty 200) on the metric read, ownership read intact. */
function emptyMetricBodyFetch(status: number): ReturnType<typeof recordFetch> {
  return metricFetch(() => new Response(null, { status }));
}

async function callWith(
  fetcher: ReturnType<typeof recordFetch>,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ readonly isError: boolean; readonly text: string; readonly calls: number }> {
  const harness = await connect(makeConfig(), {
    clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: () => Promise.resolve() },
  });
  try {
    const called = await harness.call(tool, args);
    const block = called.content[0];
    return {
      isError: called.isError === true,
      text: block?.type === 'text' ? block.text : '',
      calls: fetcher.calls.length,
    };
  } finally {
    await harness.close();
  }
}

const READS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['lumics_list_devices', {}],
  ['lumics_get_device', { deviceId: TEST_DEVICE_ID }],
  ['lumics_list_collectors', {}],
  ['lumics_get_collector', { collectorId: TEST_COLLECTOR_ID }],
  ['lumics_list_ipsubnets', {}],
  ['lumics_get_ipsubnet', { ipSubnetId: TEST_SUBNET_ID }],
  ['lumics_get_me', {}],
];

describe('a failed body read is never reported as an empty success (finding B1)', () => {
  it.each(READS)('%s reports an error rather than fabricating a result', async (tool, args) => {
    const called = await callWith(truncatedBodyFetch(), tool, args);

    expect(called.isError).toBe(true);
    // Specifically NOT the two answers this used to give.
    expect(called.text).not.toBe('[]');
    expect(called.text).not.toBe('null');
    expect(called.text).toMatch(/^network_error: /);
    expect(called.text).toContain('did not arrive completely');
  });

  it('retried the read before giving up, because a GET that failed changed nothing', async () => {
    const fetcher = truncatedBodyFetch();
    const called = await callWith(fetcher, 'lumics_list_devices');
    expect(called.isError).toBe(true);
    expect(called.calls).toBeGreaterThan(1);
  });

  it('says nothing that could be read as "the tenant has no devices"', async () => {
    const called = await callWith(truncatedBodyFetch(), 'lumics_list_devices');
    expect(called.text).not.toMatch(/\[\s*\]/);
    expect(called.text).toContain('truncated');
  });
});

describe('an absent body is reported honestly, not as a confirmed count (finding L3)', () => {
  it.each([204, 200])(
    'a %i with no body gives a list of zero records WITH a note',
    async (status) => {
      const called = await callWith(emptyBodyFetch(status), 'lumics_list_devices');

      expect(called.isError).toBe(false);
      expect(called.text).toContain('[]');
      expect(called.text).toContain(ABSENT_BODY_LIST_NOTE);
    },
  );

  it('the note distinguishes an absent body from an empty collection', async () => {
    const called = await callWith(emptyBodyFetch(204), 'lumics_list_devices');
    expect(called.text).toContain('no response body at all');
    expect(called.text).toContain('the collection is empty');
    expect(called.text).toMatch(/verify in the Lumics UI/);
  });

  it.each([
    ['lumics_list_collectors', {}],
    ['lumics_list_ipsubnets', {}],
    ['lumics_list_ipgroups', {}],
    ['lumics_list_ipaddresses', { ipSubnetId: TEST_SUBNET_ID }],
    ['lumics_list_component_types', {}],
    ['lumics_list_components', { componentType: 'cisco_ast_devices' }],
  ])('%s discloses it too', async (tool, args) => {
    const called = await callWith(emptyBodyFetch(204), tool, args);
    expect(called.isError).toBe(false);
    expect(called.text).toContain(ABSENT_BODY_LIST_NOTE);
  });

  it('stays silent when the API genuinely returned an empty array', async () => {
    const fetcher = recordFetch(
      () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const called = await callWith(fetcher, 'lumics_list_devices');
    expect(called.isError).toBe(false);
    expect(called.text).not.toContain('no response body at all');
  });

  it.each([
    ['lumics_get_device', { deviceId: TEST_DEVICE_ID }],
    ['lumics_get_collector', { collectorId: TEST_COLLECTOR_ID }],
    ['lumics_get_ipsubnet', { ipSubnetId: TEST_SUBNET_ID }],
    ['lumics_get_me', {}],
  ])('%s raises invalid_response rather than answering null', async (tool, args) => {
    const called = await callWith(emptyBodyFetch(204), tool, args);

    expect(called.isError).toBe(true);
    expect(called.text).toMatch(/^invalid_response: /);
    expect(called.text).toContain('carried no body at all');
    // The distinction that keeps a model from reporting a deletion that never
    // happened: an absent record is a 404, not an empty 200.
    expect(called.text).toContain('404');
  });

  it('does not claim the company id is wrong when a single read comes back empty', async () => {
    const called = await callWith(emptyBodyFetch(204), 'lumics_get_device', {
      deviceId: TEST_DEVICE_ID,
    });
    expect(called.text).not.toContain(TEST_COMPANY_ID);
  });
});

// ---------------------------------------------------------------------------
// The metric tools, spec §12 — where an empty result is a claim about the estate
// ---------------------------------------------------------------------------

/** The four series endpoints (§12.1–§12.3) plus the summaries endpoint (§12.4). */
const METRIC_READS: readonly (readonly [string, Record<string, unknown>])[] = [
  ['lumics_get_company_metrics', { moduleType: 'snmp' }],
  ['lumics_summarize_company_metrics', { moduleType: 'snmp' }],
  ['lumics_get_device_metrics', { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' }],
  [
    'lumics_get_device_item_metrics',
    { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', itemId: TEST_COMPONENT_ID },
  ],
  ['lumics_get_metric_summary', { moduleType: 'snmp' }],
];

/** The phrase that marks the metric absence disclosure, whatever its subject. */
const ABSENT_METRIC_MARKER = 'NOTE ON AN EMPTY RESULT:';

describe('a metric read discloses an absent body instead of reporting an empty series', () => {
  it.each(METRIC_READS)('%s discloses it', async (tool, args) => {
    const called = await callWith(emptyMetricBodyFetch(204), tool, args);

    expect(called.isError).toBe(false);
    expect(called.text).toContain(ABSENT_METRIC_MARKER);
    expect(called.text).toContain('no response body at all');
  });

  it.each(METRIC_READS)(
    '%s names the conclusions the response does not support',
    async (tool, args) => {
      const called = await callWith(emptyMetricBodyFetch(200), tool, args);

      // "Lumics sent nothing" must not be readable as "the device is silent".
      expect(called.text).toMatch(/NOT because/);
      expect(called.text).toContain('is unmonitored');
      expect(called.text).toMatch(/verify in the\s+Lumics UI|verify in the Lumics UI/);
    },
  );

  it('uses series wording, not the list-completeness wording', async () => {
    const called = await callWith(emptyMetricBodyFetch(204), 'lumics_get_device_metrics', {
      deviceId: TEST_DEVICE_ID,
      moduleType: 'snmp',
    });
    // The list note talks about records in a collection, which is the wrong
    // reading of an empty series — see metricRowCapNote for the same distinction.
    expect(called.text).not.toContain(ABSENT_BODY_LIST_NOTE);
    expect(called.text).not.toContain('the collection is empty');
    expect(called.text).toContain('reported no measurements in this window');
  });

  it('stays silent when Lumics genuinely returned an empty series', async () => {
    const called = await callWith(
      metricFetch(() => jsonResponse({ data: [], from: '2026-07-29T11:00:00.000Z' })),
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
    );

    expect(called.isError).toBe(false);
    expect(called.text).toContain('[]');
    expect(called.text).not.toContain(ABSENT_METRIC_MARKER);
    expect(called.text).not.toContain('no response body at all');
  });

  it('discloses an envelope whose documented "data" field never arrived', async () => {
    const called = await callWith(
      metricFetch(() => jsonResponse({ from: '2026-07-29T11:00:00.000Z', components: 12 })),
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
    );

    expect(called.isError).toBe(false);
    expect(called.text).toContain(ABSENT_METRIC_MARKER);
    expect(called.text).toContain('"data" field was absent or null');
    // The body did arrive, so it must not claim otherwise.
    expect(called.text).not.toContain('no response body at all');
  });

  it('the three empty outcomes are distinguishable from each other', async () => {
    const args = { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' };
    const absentBody = await callWith(emptyMetricBodyFetch(204), 'lumics_get_device_metrics', args);
    const absentData = await callWith(
      metricFetch(() => jsonResponse({ from: '2026-07-29T11:00:00.000Z' })),
      'lumics_get_device_metrics',
      args,
    );
    const emptySeries = await callWith(
      metricFetch(() => jsonResponse({ data: [] })),
      'lumics_get_device_metrics',
      args,
    );

    const texts = [absentBody.text, absentData.text, emptySeries.text];
    expect(new Set(texts).size).toBe(3);
    expect(absentBody.text).toContain('no response body at all');
    expect(absentData.text).toContain('"data" field was absent or null');
    expect(emptySeries.text).not.toContain(ABSENT_METRIC_MARKER);
  });
});

describe('the summaries endpoint (spec section 12.4) separates absence from "nothing matched"', () => {
  it('does not claim nothing matched when no body arrived', async () => {
    const called = await callWith(emptyMetricBodyFetch(204), 'lumics_get_metric_summary', {
      moduleType: 'snmp',
    });

    expect(called.isError).toBe(false);
    expect(called.text).toContain(ABSENT_METRIC_MARKER);
    expect(called.text).toContain('NOT because no device or component matched');
    // The old note asserted the estate had nothing to show. It did not know that.
    expect(called.text).not.toContain('NO ITEMS:');
  });

  it('still says "nothing matched" when Lumics sent a present but empty data object', async () => {
    const called = await callWith(
      metricFetch(() => jsonResponse({ data: {}, count: 0 })),
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
    );

    expect(called.isError).toBe(false);
    expect(called.text).toContain('NO ITEMS:');
    expect(called.text).toContain('present but empty');
    expect(called.text).not.toContain(ABSENT_METRIC_MARKER);
  });

  it('discloses a summaries envelope with no "data" field at all', async () => {
    const called = await callWith(
      metricFetch(() => jsonResponse({ count: 0 })),
      'lumics_get_metric_summary',
      { moduleType: 'snmp' },
    );

    expect(called.text).toContain(ABSENT_METRIC_MARKER);
    expect(called.text).toContain('"data" field was absent or null');
    expect(called.text).not.toContain('NO ITEMS:');
  });
});
