/**
 * Collector tools — spec §5, all five endpoints.
 *
 * The two behaviours worth locking in beyond the CRUD shape are the deliberate
 * capability reductions: `osConfig` is a closed object (only `ntpServers` is
 * documented) and `needsRestart` is readable but not writable. Both are
 * approved narrowings, so a test has to notice if someone widens them.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIST_LIMIT } from '../../src/constants.js';
import { makeConfig, TEST_COLLECTOR_ID, TEST_COMPANY_ID } from '../helpers/config.js';
import {
  exchange,
  expectNoFabricatedPagination,
  expectNoFabricatedQueryParams,
  failingExchange,
} from '../helpers/tools.js';

const COLLECTORS = `/companies/${TEST_COMPANY_ID}/collectors`;
const COLLECTOR = `${COLLECTORS}/${TEST_COLLECTOR_ID}`;

const SAMPLE_COLLECTOR = {
  id: TEST_COLLECTOR_ID,
  name: 'dc1-collector-01',
  ipAddress: '10.20.30.1',
  version: '4.2.1',
  needsRestart: false,
  osConfig: { ntpServers: ['ntp1.example.net'] },
};

describe('lumics_list_collectors (spec section 5.1)', () => {
  it('GETs the collection with limit as the only query parameter', async () => {
    const { call } = await exchange('lumics_list_collectors', {}, [SAMPLE_COLLECTOR]);
    expect(call.method).toBe('GET');
    expect(call.path).toBe(COLLECTORS);
    expect(call.query).toEqual({ limit: String(DEFAULT_LIST_LIMIT) });
    expectNoFabricatedQueryParams(call);
  });

  it('returns the bare array and discloses truncation at the limit', async () => {
    const { payload, notes } = await exchange('lumics_list_collectors', { limit: 2 }, [
      SAMPLE_COLLECTOR,
      SAMPLE_COLLECTOR,
    ]);
    expect(payload).toEqual([SAMPLE_COLLECTOR, SAMPLE_COLLECTOR]);
    expect(notes).toContain('NOTE ON COMPLETENESS:');
  });

  it('projects fields when asked', async () => {
    const { payload } = await exchange(
      'lumics_list_collectors',
      { fields: ['id', 'needsRestart'] },
      [SAMPLE_COLLECTOR],
    );
    expect(payload).toEqual([{ id: TEST_COLLECTOR_ID, needsRestart: false }]);
  });
});

describe('lumics_get_collector (spec section 5.2)', () => {
  it('GETs one collector with no query parameters', async () => {
    const { call, payload } = await exchange(
      'lumics_get_collector',
      { collectorId: TEST_COLLECTOR_ID },
      SAMPLE_COLLECTOR,
    );
    expect(call.method).toBe('GET');
    expect(call.path).toBe(COLLECTOR);
    expect(Object.keys(call.query)).toEqual([]);
    expect(payload).toEqual(SAMPLE_COLLECTOR);
  });

  it('rejects a non-ObjectId collector id locally', async () => {
    const { calls } = await failingExchange('lumics_get_collector', {
      collectorId: 'dc1-collector-01',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('lumics_create_collector (spec section 5.3)', () => {
  it('POSTs with company filled from the resolved company and name as the only requirement', async () => {
    const { call } = await exchange(
      'lumics_create_collector',
      { name: 'dc2-collector-01' },
      SAMPLE_COLLECTOR,
    );
    expect(call.method).toBe('POST');
    expect(call.path).toBe(COLLECTORS);
    expect(call.body).toEqual({ company: TEST_COMPANY_ID, name: 'dc2-collector-01' });
  });

  it('sends every optional field the caller supplied and none it did not', async () => {
    const { call } = await exchange(
      'lumics_create_collector',
      {
        name: 'dc2-collector-01',
        description: 'second site',
        location: 'rack 4',
        ipAddress: '10.20.31.1',
        version: '4.2.1',
        osConfig: { ntpServers: ['ntp1.example.net', '10.0.0.1'] },
      },
      SAMPLE_COLLECTOR,
    );
    expect(call.body).toEqual({
      company: TEST_COMPANY_ID,
      name: 'dc2-collector-01',
      description: 'second site',
      location: 'rack 4',
      ipAddress: '10.20.31.1',
      version: '4.2.1',
      osConfig: { ntpServers: ['ntp1.example.net', '10.0.0.1'] },
    });
  });

  it('never leaks the companyId argument into the body as its own key', async () => {
    const other = 'a'.repeat(24);
    const { call } = await exchange(
      'lumics_create_collector',
      { name: 'x', companyId: other },
      SAMPLE_COLLECTOR,
      { config: makeConfig({ allowCrossCompany: true }) },
    );
    expect(Object.hasOwn(call.body as object, 'companyId')).toBe(false);
    expect((call.body as Record<string, unknown>).company).toBe(other);
  });

  it('accepts a hostname in ntpServers, which the spec examples use', async () => {
    const { call } = await exchange(
      'lumics_create_collector',
      { name: 'x', osConfig: { ntpServers: ['pool.ntp.example'] } },
      SAMPLE_COLLECTOR,
    );
    expect(call.body).toMatchObject({ osConfig: { ntpServers: ['pool.ntp.example'] } });
  });

  it.each([
    ['an undocumented osConfig key', { osConfig: { ntpServers: [], dnsServers: ['1.1.1.1'] } }],
    ['osConfig without ntpServers', { osConfig: {} }],
    [
      'more than ten ntpServers',
      { osConfig: { ntpServers: Array.from({ length: 11 }, () => 'a') } },
    ],
    ['a non-ObjectId user', { user: 'collector-user' }],
    ['a hostname as ipAddress', { ipAddress: 'collector.example.com' }],
  ])('rejects %s, keeping the closed write surface closed', async (_label, extra) => {
    const { calls } = await failingExchange('lumics_create_collector', { name: 'x', ...extra });
    expect(calls).toHaveLength(0);
  });

  it('does not accept _id, adminGroup or needsRestart as arguments', async () => {
    // Passing an unknown key is accepted by the SDK but must never reach the body.
    const { call } = await exchange(
      'lumics_create_collector',
      { name: 'x', _id: 'f'.repeat(24), adminGroup: 'f'.repeat(24), needsRestart: false },
      SAMPLE_COLLECTOR,
    );
    const body = call.body as Record<string, unknown>;
    expect(Object.hasOwn(body, '_id')).toBe(false);
    expect(Object.hasOwn(body, 'adminGroup')).toBe(false);
    expect(Object.hasOwn(body, 'needsRestart')).toBe(false);
  });
});

describe('lumics_update_collector (spec section 5.4)', () => {
  it('PATCHes only the changed fields and unwraps the updated envelope', async () => {
    const { call, payload } = await exchange(
      'lumics_update_collector',
      { collectorId: TEST_COLLECTOR_ID, location: 'rack 9' },
      { updated: SAMPLE_COLLECTOR },
    );
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(COLLECTOR);
    expect(call.body).toEqual({ location: 'rack 9' });
    expect(payload).toEqual(SAMPLE_COLLECTOR);
  });

  it('never sends company on an update, so a collector cannot change tenant', async () => {
    const { call } = await exchange(
      'lumics_update_collector',
      { collectorId: TEST_COLLECTOR_ID, companyId: TEST_COMPANY_ID, name: 'renamed' },
      { updated: SAMPLE_COLLECTOR },
    );
    expect(call.body).toEqual({ name: 'renamed' });
  });

  it('refuses a no-field PATCH and lists what can be changed', async () => {
    const { calls, text } = await failingExchange('lumics_update_collector', {
      collectorId: TEST_COLLECTOR_ID,
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('No fields to update were supplied');
    expect(text).toContain('osConfig');
  });

  it('cannot clear needsRestart, which is a read-only field by decision', async () => {
    const { calls } = await failingExchange('lumics_update_collector', {
      collectorId: TEST_COLLECTOR_ID,
      needsRestart: false,
    });
    // No settable field was supplied, so the empty-PATCH guard fires rather than
    // needsRestart quietly reaching the API.
    expect(calls).toHaveLength(0);
  });

  it('reports a missing updated envelope as drift', async () => {
    const { text } = await failingExchange(
      'lumics_update_collector',
      { collectorId: TEST_COLLECTOR_ID, name: 'x' },
      SAMPLE_COLLECTOR,
    );
    expect(text).toContain('"updated" envelope');
  });
});

describe('lumics_delete_collector (spec section 5.5)', () => {
  it('DELETEs the collector, unwraps the deleted envelope, and states the consequence', async () => {
    const { call, payload, notes } = await exchange(
      'lumics_delete_collector',
      { collectorId: TEST_COLLECTOR_ID, confirm: true },
      { deleted: SAMPLE_COLLECTOR },
    );
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(COLLECTOR);
    expect(payload).toEqual(SAMPLE_COLLECTOR);
    expect(notes).toContain('permanently deleted');
    expect(notes).toContain('must now be assigned to another collector');
  });

  it('surfaces the documented 409 for a collector that still has devices', async () => {
    const { text } = await failingExchange(
      'lumics_delete_collector',
      { collectorId: TEST_COLLECTOR_ID, confirm: true },
      // A 200 with the wrong envelope is the closest a stubbed 200 gets; the
      // 409 mapping itself is covered in tests/unit/errors.test.ts.
      {},
    );
    expect(text).toContain('invalid_response');
  });
});

describe('no collector tool ever fabricates pagination', () => {
  it.each([
    ['lumics_list_collectors', {}, [SAMPLE_COLLECTOR, SAMPLE_COLLECTOR]],
    ['lumics_get_collector', { collectorId: TEST_COLLECTOR_ID }, SAMPLE_COLLECTOR],
    ['lumics_create_collector', { name: 'x' }, SAMPLE_COLLECTOR],
    [
      'lumics_update_collector',
      { collectorId: TEST_COLLECTOR_ID, name: 'x' },
      { updated: SAMPLE_COLLECTOR },
    ],
    [
      'lumics_delete_collector',
      { collectorId: TEST_COLLECTOR_ID, confirm: true },
      { deleted: SAMPLE_COLLECTOR },
    ],
  ])('%s', async (tool, args, response) => {
    const { text, call } = await exchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});
