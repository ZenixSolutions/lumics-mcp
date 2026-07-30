/**
 * Device tools — spec §7, all seven endpoints.
 *
 * Each case drives the real registered tool and asserts the exact request the
 * injected fetch saw. The assertions that matter most are the ones the prototype
 * got wrong: PATCH/PUT unwrap `{updated}`, DELETE unwraps `{deleted}`, `company`
 * is repeated in the create body as spec §7.3 requires, and `limit` is the only
 * result-control parameter that ever appears.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LIST_FIELDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_OUTPUT_CHARS,
  MAX_LIST_LIMIT,
} from '../../src/constants.js';
import {
  makeConfig,
  TEST_COLLECTOR_ID,
  TEST_COMPANY_ID,
  TEST_DEVICE_ID,
} from '../helpers/config.js';
import { recordFetch, type FetchRecorder } from '../helpers/fetch.js';
import { connect, firstText } from '../helpers/mcp.js';
import {
  exchange,
  expectNoFabricatedPagination,
  expectNoFabricatedQueryParams,
  failingExchange,
} from '../helpers/tools.js';

const DEVICES = `/companies/${TEST_COMPANY_ID}/devices`;
const DEVICE = `${DEVICES}/${TEST_DEVICE_ID}`;

const SAMPLE_DEVICE = {
  id: TEST_DEVICE_ID,
  name: 'core-sw-01',
  ipAddress: '10.20.30.40',
  deviceType: 'switch',
  enabled: true,
  modules: { ping: { module: 'ping' } },
};

/**
 * A device with every field the spec §7.1 example documents, at realistic sizes:
 * roughly 1.9 kB of compact JSON, most of it the `modules` polling map.
 *
 * Finding B2 lives here. `DEFAULT_LIST_LIMIT` is 100 and
 * `DEFAULT_MAX_OUTPUT_CHARS` is 25,000, so a hundred of these records is ~190 kB
 * against a 25 kB budget: the default call asked Lumics for a hundred devices and
 * could only show thirteen, then attached both "re-run with a higher limit" and
 * "re-run with a smaller limit".
 */
function fullDevice(index: number): Record<string, unknown> {
  const pad = String(index).padStart(6, '0');
  return {
    createdAt: '2024-03-11T09:12:44.101Z',
    createdBy: '5628b8174b6cf000001bf163',
    updatedAt: '2026-07-28T21:04:02.988Z',
    updatedBy: '5628b8174b6cf000001bf163',
    version: '15.2(7)E4',
    model: 'WS-C3850-48P',
    deviceType: 'switch',
    location: 'Datacentre 2 / Row F / Rack 14',
    description: 'Access switch for floor 3 east wing',
    name: `edge-switch-${pad}.corp.example.net`,
    collector: TEST_COLLECTOR_ID,
    ipAddress: `10.44.${String(Math.floor(index / 250))}.${String(index % 250)}`,
    company: TEST_COMPANY_ID,
    adminGroup: null,
    priority: 0,
    maintenanceType: 'disable-polling',
    maintenanceMode: false,
    enabled: true,
    customProperties: [
      { customProperty: '5628b8174b6cf000001bf171', value: 'CI-000123' },
      { customProperty: '5628b8174b6cf000001bf172', value: 'owner@example.net' },
    ],
    id: `5628b8174b6cf0000${pad}a`,
    modules: {
      snmp: {
        module: 'snmp',
        snmpVersion: '2c',
        credential: '5628b8174b6cf000001bf180',
        enabled: true,
        primary: true,
        name: `edge-switch-${pad}`,
        description: 'Cisco IOS switch',
        location: 'Rack 14',
        sysObjectID: '1.3.6.1.4.1.9.1.2494',
        lastDiscovery: '2026-07-29T02:14:41.000Z',
        useIfXTable: true,
      },
      ping: {
        module: 'ping',
        intervalMs: 60_000,
        timeoutMs: 2_000,
        packetSize: 56,
        packetCount: 3,
        advancedOptions: false,
        enabled: true,
        primary: false,
        lastDiscovery: '2026-07-29T02:14:41.000Z',
      },
      deviceConfigs: {
        module: 'snapshots',
        credential: '5628b8174b6cf000001bf181',
        enableCredential: '5628b8174b6cf000001bf182',
        enabled: true,
        snapshotItems: [
          {
            _id: '5628b8174b6cf000001bf190',
            snapshotType: 'startup',
            enabled: true,
            arguments: {
              dashboardVisible: 'true',
              eventsEnabled: 'true',
              captureTimeout: '60',
              initialPromptTimeout: '10',
              telnetPort: '23',
              protocol: 'ssh',
              interval: '86400',
            },
          },
          {
            _id: '5628b8174b6cf000001bf191',
            snapshotType: 'running',
            enabled: true,
            arguments: {
              dashboardVisible: 'true',
              eventsEnabled: 'true',
              captureTimeout: '60',
              initialPromptTimeout: '10',
              telnetPort: '23',
              protocol: 'ssh',
              interval: '3600',
            },
          },
        ],
      },
    },
  };
}

const FULL_TENANT = Array.from({ length: DEFAULT_LIST_LIMIT }, (_unused, index) =>
  fullDevice(index + 1),
);

describe('the default list_devices call is satisfiable (finding B2)', () => {
  it('the unprojected records really do overflow the default budget many times over', () => {
    // Guards the premise. If Lumics records ever get small enough that this fails,
    // the default projection can be revisited.
    expect(JSON.stringify(FULL_TENANT).length).toBeGreaterThan(DEFAULT_MAX_OUTPUT_CHARS * 5);
  });

  it('delivers all 100 devices on a default call instead of 13', async () => {
    const { payload, text } = await exchange('lumics_list_devices', {}, FULL_TENANT);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload as unknown[]).toHaveLength(DEFAULT_LIST_LIMIT);
    // Nothing was shed, so no truncation disclosure is owed.
    expect(text).not.toContain('NOTE ON TRUNCATION:');
    expect(text).not.toContain('items were dropped');
  });

  it('discloses the projection, names the fields, and says how to override it', async () => {
    const { notes } = await exchange('lumics_list_devices', {}, FULL_TENANT);
    expect(notes).toContain('FIELD PROJECTION APPLIED BY THIS SERVER');
    for (const field of DEFAULT_DEVICE_LIST_FIELDS) {
      expect(notes).toContain(field);
    }
    // It must not let a model read a field projection as a filtered inventory.
    expect(notes).toContain('Nothing was filtered out of the device LIST');
    expect(notes).toContain('modules');
    expect(notes).toContain('lumics_get_device');
  });

  it('keeps exactly the default fields and no others', async () => {
    const { payload } = await exchange('lumics_list_devices', {}, [fullDevice(1)]);
    const first = (payload as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(Object.keys(first)).toEqual([...DEFAULT_DEVICE_LIST_FIELDS]);
  });

  it('never emits both "higher limit" and "smaller limit" advice in one response', async () => {
    // The pathological case that produced the contradiction: whole records, at the
    // limit, well over budget.
    const { text } = await exchange('lumics_list_devices', { fields: [] }, FULL_TENANT);
    expect(text).toContain('NOTE ON TRUNCATION:');
    expect(text).toContain('NOTE ON COMPLETENESS:');
    expect(text).not.toContain('re-run with a higher limit');
    expect(text).toContain('A higher limit will NOT help');
  });

  it('lets an explicit projection override the default', async () => {
    const { payload } = await exchange('lumics_list_devices', { fields: ['id', 'location'] }, [
      fullDevice(1),
    ]);
    expect(Object.keys((payload as Record<string, unknown>[])[0] as object)).toEqual([
      'id',
      'location',
    ]);
  });

  it('lets an empty projection ask for whole records, and says nothing about projecting', async () => {
    const { payload, notes } = await exchange('lumics_list_devices', { fields: [] }, [
      fullDevice(1),
    ]);
    expect((payload as Record<string, unknown>[])[0]).toHaveProperty('modules');
    expect(notes).not.toContain('FIELD PROJECTION APPLIED BY THIS SERVER');
  });
});

describe('lumics_list_devices (spec section 7.1)', () => {
  it('GETs the devices collection with the default limit', async () => {
    const { call } = await exchange('lumics_list_devices', {}, [SAMPLE_DEVICE]);
    expect(call.method).toBe('GET');
    expect(call.path).toBe(DEVICES);
    expect(call.query).toEqual({ limit: String(DEFAULT_LIST_LIMIT) });
    expect(call.body).toBeUndefined();
  });

  it('sends an explicit limit', async () => {
    const { call } = await exchange('lumics_list_devices', { limit: 5 }, []);
    expect(call.query.limit).toBe('5');
  });

  it('sends limit as the ONLY result-control parameter', async () => {
    const { call } = await exchange('lumics_list_devices', { limit: 5 }, []);
    expect(Object.keys(call.query)).toEqual(['limit']);
    expectNoFabricatedQueryParams(call);
  });

  it('uses an explicit companyId in the path when one is supplied', async () => {
    const other = 'a'.repeat(24);
    // A company other than the configured one needs the operator's flag now
    // (finding H5); the refusal itself is asserted in tests/security.
    const { call } = await exchange('lumics_list_devices', { companyId: other }, [], {
      config: makeConfig({ allowCrossCompany: true }),
    });
    expect(call.path).toBe(`/companies/${other}/devices`);
  });

  it('returns the bare array unwrapped, with no envelope invented', async () => {
    // `fields: []` opts out of the default projection and asks for whole records.
    const { payload } = await exchange('lumics_list_devices', { fields: [] }, [SAMPLE_DEVICE]);
    expect(payload).toEqual([SAMPLE_DEVICE]);
  });

  it('discloses possible truncation when the count equals the limit', async () => {
    const three = [SAMPLE_DEVICE, SAMPLE_DEVICE, SAMPLE_DEVICE];
    const { notes, text } = await exchange('lumics_list_devices', { limit: 3 }, three);
    expect(notes).toContain('NOTE ON COMPLETENESS:');
    expect(notes).toContain('no pagination mechanism whatsoever');
    expectNoFabricatedPagination(text);
  });

  it('stays silent about completeness when fewer results came back', async () => {
    const { notes } = await exchange('lumics_list_devices', { limit: 3, fields: [] }, [
      SAMPLE_DEVICE,
    ]);
    expect(notes).toBe('');
  });

  it('applies a fields projection', async () => {
    const { payload } = await exchange('lumics_list_devices', { fields: ['id', 'name'] }, [
      SAMPLE_DEVICE,
    ]);
    expect(payload).toEqual([{ id: TEST_DEVICE_ID, name: 'core-sw-01' }]);
  });

  it.each([0, -1, MAX_LIST_LIMIT + 1, 1.5])('rejects a limit of %s locally', async (limit) => {
    const { calls } = await failingExchange('lumics_list_devices', { limit });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-array list body as documented drift', async () => {
    const { text } = await failingExchange('lumics_list_devices', {}, { devices: [] });
    expect(text).toContain('invalid_response');
    expect(text).toContain('bare JSON array was documented');
  });
});

describe('lumics_get_device (spec section 7.2)', () => {
  it('GETs one device with no query parameters', async () => {
    const { call, payload } = await exchange(
      'lumics_get_device',
      { deviceId: TEST_DEVICE_ID },
      SAMPLE_DEVICE,
    );
    expect(call.method).toBe('GET');
    expect(call.path).toBe(DEVICE);
    expect(Object.keys(call.query)).toEqual([]);
    expect(payload).toEqual(SAMPLE_DEVICE);
  });

  it('never sets requestedLimit, so a single object carries no completeness note', async () => {
    const { notes } = await exchange(
      'lumics_get_device',
      { deviceId: TEST_DEVICE_ID },
      SAMPLE_DEVICE,
    );
    expect(notes).not.toContain('NOTE ON COMPLETENESS');
  });

  it('rejects a device id that is not a 24-hex ObjectId', async () => {
    const { calls, text } = await failingExchange('lumics_get_device', { deviceId: 'core-sw-01' });
    expect(calls).toHaveLength(0);
    expect(text).toMatch(/24-character hexadecimal|Invalid/);
  });
});

describe('lumics_create_device (spec section 7.3)', () => {
  const args = {
    name: 'new-host',
    ipAddress: '10.1.2.3',
    collector: TEST_COLLECTOR_ID,
    deviceType: 'default',
  };

  it('POSTs to the collection with all five documented body fields', async () => {
    const { call } = await exchange('lumics_create_device', args, SAMPLE_DEVICE);
    expect(call.method).toBe('POST');
    expect(call.path).toBe(DEVICES);
    // spec §7.3: `company` is required in the BODY as well as in the path, which
    // the prototype omitted.
    expect(call.body).toEqual({
      company: TEST_COMPANY_ID,
      name: 'new-host',
      ipAddress: '10.1.2.3',
      collector: TEST_COLLECTOR_ID,
      deviceType: 'default',
    });
  });

  it('fills company from the resolved company rather than asking twice', async () => {
    const other = 'b'.repeat(24);
    const { call } = await exchange(
      'lumics_create_device',
      { ...args, companyId: other },
      SAMPLE_DEVICE,
      { config: makeConfig({ allowCrossCompany: true }) },
    );
    expect((call.body as Record<string, unknown>).company).toBe(other);
    expect(call.path).toBe(`/companies/${other}/devices`);
  });

  it('never accepts a companyId in the body position', async () => {
    const { call } = await exchange('lumics_create_device', args, SAMPLE_DEVICE);
    expect(Object.hasOwn(call.body as object, 'companyId')).toBe(false);
  });

  it.each([
    ['a hostname instead of an IP', { ...args, ipAddress: 'host.example.com' }],
    ['a CIDR block', { ...args, ipAddress: '10.1.2.0/24' }],
    ['a range', { ...args, ipAddress: '10.1.2.3-10.1.2.9' }],
    ['a non-ObjectId collector', { ...args, collector: 'dc1-collector' }],
    ['an empty name', { ...args, name: '' }],
  ])('rejects %s before spending a request', async (_label, badArgs) => {
    const { calls } = await failingExchange('lumics_create_device', badArgs);
    expect(calls).toHaveLength(0);
  });

  it('accepts an IPv6 management address', async () => {
    const { call } = await exchange(
      'lumics_create_device',
      { ...args, ipAddress: '2001:db8::1' },
      SAMPLE_DEVICE,
    );
    expect((call.body as Record<string, unknown>).ipAddress).toBe('2001:db8::1');
  });
});

describe('lumics_update_device (spec section 7.5)', () => {
  it('PATCHes with a flat body that repeats the id, per the documented example', async () => {
    const { call, payload } = await exchange(
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, maintenanceMode: true },
      { updated: SAMPLE_DEVICE },
    );
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(DEVICE);
    expect(call.body).toEqual({ id: TEST_DEVICE_ID, maintenanceMode: true });
    // spec §4.2: the `{updated}` envelope is unwrapped so a write returns the
    // same shape as the equivalent read.
    expect(payload).toEqual(SAMPLE_DEVICE);
  });

  it('sends only the fields the caller actually set', async () => {
    const { call } = await exchange(
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, enabled: false, priority: 3 },
      { updated: SAMPLE_DEVICE },
    );
    expect(call.body).toEqual({ id: TEST_DEVICE_ID, enabled: false, priority: 3 });
  });

  it('never sends companyId as a body field, which would move the device between tenants', async () => {
    const { call } = await exchange(
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, companyId: TEST_COMPANY_ID, name: 'renamed' },
      { updated: SAMPLE_DEVICE },
    );
    expect(Object.keys(call.body as object).sort()).toEqual(['id', 'name']);
  });

  it('refuses a no-field PATCH rather than reporting a no-op as success', async () => {
    const { calls, text } = await failingExchange('lumics_update_device', {
      deviceId: TEST_DEVICE_ID,
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('No fields to update were supplied');
    // The message lists what is settable, so the model can retry correctly.
    expect(text).toContain('maintenanceMode');
  });

  it('reports a missing updated envelope as drift rather than returning the raw body', async () => {
    const { text } = await failingExchange(
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, enabled: false },
      SAMPLE_DEVICE,
    );
    expect(text).toContain('invalid_response');
    expect(text).toContain('"updated" envelope');
  });

  /**
   * Finding H3. `{updated: null}` used to unwrap to `null` and be returned as a
   * successful result whose entire payload was the literal text `null`. The
   * envelope key was checked; what it held was not.
   */
  it('reports an empty updated envelope as drift instead of answering "null"', async () => {
    const { text } = await failingExchange(
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, enabled: false },
      { updated: null },
    );
    expect(text).toContain('invalid_response');
    expect(text).not.toMatch(/\bnull\s*$/);
    expect(text).toContain('This is not the same as "the record does not exist"');
  });

  it.each([
    ['a priority above the documented range', { priority: 11 }],
    ['a negative priority', { priority: -1 }],
    ['a non-IP ipAddress', { ipAddress: 'nope' }],
    ['a non-ObjectId collector', { collector: 'nope' }],
  ])('rejects %s locally', async (_label, patch) => {
    const { calls } = await failingExchange('lumics_update_device', {
      deviceId: TEST_DEVICE_ID,
      ...patch,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('lumics_update_device_last_discovery (spec section 7.4)', () => {
  it('PUTs to the module lastDiscovery path with an ISO-8601 body', async () => {
    const { call, payload } = await exchange(
      'lumics_update_device_last_discovery',
      { deviceId: TEST_DEVICE_ID, module: 'snmp', date: '2026-07-29T14:14:41.000Z' },
      { updated: SAMPLE_DEVICE },
    );
    expect(call.method).toBe('PUT');
    expect(call.path).toBe(`${DEVICE}/modules/snmp/lastDiscovery`);
    expect(call.body).toEqual({ date: '2026-07-29T14:14:41.000Z' });
    expect(payload).toEqual(SAMPLE_DEVICE);
  });

  it('normalises a parseable date to ISO-8601 UTC', async () => {
    const { call } = await exchange(
      'lumics_update_device_last_discovery',
      { deviceId: TEST_DEVICE_ID, module: 'ping', date: '2026-07-29' },
      { updated: SAMPLE_DEVICE },
    );
    expect((call.body as Record<string, unknown>).date).toBe('2026-07-29T00:00:00.000Z');
  });

  it('encodes a module key that is not a bare word', async () => {
    const { call } = await exchange(
      'lumics_update_device_last_discovery',
      { deviceId: TEST_DEVICE_ID, module: 'device Configs', date: '2026-07-29T00:00:00Z' },
      { updated: SAMPLE_DEVICE },
    );
    expect(call.url.pathname).toContain('/modules/device%20Configs/');
  });

  it('rejects an unparseable date locally, with the expected form in the message', async () => {
    const { calls, text } = await failingExchange('lumics_update_device_last_discovery', {
      deviceId: TEST_DEVICE_ID,
      module: 'snmp',
      date: 'yesterday',
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('is not an ISO-8601 timestamp with an explicit UTC offset');
  });

  /**
   * Finding M7 applied to a WRITE. `Date.parse` used to read a naive timestamp in
   * the server's local timezone, so `2026-07-29T14:14:41` was persisted to Lumics
   * as 21:14Z on a US-Pacific host — a discovery time shifted by the offset of a
   * machine the user never sees.
   */
  it('refuses a date with no zone rather than writing a locally-shifted timestamp', async () => {
    const { calls, text } = await failingExchange('lumics_update_device_last_discovery', {
      deviceId: TEST_DEVICE_ID,
      module: 'snmp',
      date: '2026-07-29T14:14:41',
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('explicit UTC offset');
  });

  it('accepts an offset form and normalises it to UTC before writing', async () => {
    const { call } = await exchange(
      'lumics_update_device_last_discovery',
      { deviceId: TEST_DEVICE_ID, module: 'snmp', date: '2026-07-29T16:14:41+02:00' },
      { updated: SAMPLE_DEVICE },
    );
    expect((call.body as Record<string, unknown>).date).toBe('2026-07-29T14:14:41.000Z');
  });
});

describe('lumics_batch_update_devices (spec section 7.6)', () => {
  const enabled = { features: { batchUpdate: true, tokenRevocation: false } };
  const config = makeConfig(enabled);
  const secondId = 'c'.repeat(24);

  it('PATCHes the comma-delimited batch path with a flat body', async () => {
    const { call } = await exchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID, secondId], maintenanceMode: true, confirm: true },
      { updated: [SAMPLE_DEVICE, SAMPLE_DEVICE] },
      { config },
    );
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`${DEVICES}/${TEST_DEVICE_ID},${secondId}/batch`);
    // spec §7.6: the documented body field is `device` but the example is flat.
    expect(call.body).toEqual({ maintenanceMode: true });
  });

  it('unwraps the array inside the updated envelope', async () => {
    const { payload } = await exchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID], enabled: false, confirm: true },
      { updated: [SAMPLE_DEVICE] },
      { config },
    );
    expect(payload).toEqual([SAMPLE_DEVICE]);
  });

  it('reports how many records came back against how many ids were sent', async () => {
    const { notes } = await exchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID, secondId], enabled: false, confirm: true },
      { updated: [SAMPLE_DEVICE] },
      { config },
    );
    expect(notes).toContain('Applied 1 field change(s) to 2 device(s)');
    expect(notes).toContain('Lumics returned 1 updated record(s)');
    expect(notes).toContain('some ids did not match a device in this company');
  });

  /**
   * Finding M4. spec §7.6 documents `{updated: [...]}`, but the envelope was
   * never checked to hold an array, and the note fell back to a count of zero for
   * anything else. Lumics returning the singular shape produced "Lumics returned
   * 0 updated record(s); if that count is lower than the number of ids you sent,
   * some ids did not match" printed directly above a record that plainly did
   * match — a bulk change reported as having failed entirely, in a result marked
   * successful. The count is not something to guess at: it is drift, and it is
   * reported as drift.
   */
  it('reports a non-array batch envelope as drift instead of guessing a count', async () => {
    const { text } = await failingExchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID], enabled: false, confirm: true },
      { updated: SAMPLE_DEVICE },
      { config },
    );
    expect(text).toContain('invalid_response');
    expect(text).not.toContain('0 updated record(s)');
    // Nor may it claim the ids matched nothing.
    expect(text).not.toContain('some ids did not match');
  });

  it('reports an empty batch envelope as drift rather than a successful no-op', async () => {
    const { text } = await failingExchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID], enabled: false, confirm: true },
      { updated: null },
      { config },
    );
    expect(text).toContain('invalid_response');
    expect(text).toMatch(/may already have been applied/);
  });

  it('refuses a no-field batch, which would change nothing across every id', async () => {
    const { calls, text } = await failingExchange(
      'lumics_batch_update_devices',
      { deviceIds: [TEST_DEVICE_ID], confirm: true },
      {},
      { config },
    );
    expect(calls).toHaveLength(0);
    expect(text).toContain('would change nothing');
  });

  it.each([
    ['an empty id list', []],
    ['more than 200 ids', Array.from({ length: 201 }, () => TEST_DEVICE_ID)],
    ['a non-ObjectId id', ['not-an-object-id']],
  ])('rejects %s locally', async (_label, deviceIds) => {
    const { calls } = await failingExchange(
      'lumics_batch_update_devices',
      { deviceIds, enabled: false, confirm: true },
      {},
      { config },
    );
    expect(calls).toHaveLength(0);
  });
});

describe('lumics_delete_device (spec section 7.7)', () => {
  it('DELETEs the device and unwraps the deleted envelope', async () => {
    const { call, payload, notes } = await exchange(
      'lumics_delete_device',
      { deviceId: TEST_DEVICE_ID, confirm: true },
      { deleted: SAMPLE_DEVICE },
    );
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(DEVICE);
    expect(call.body).toBeUndefined();
    expect(payload).toEqual(SAMPLE_DEVICE);
    expect(notes).toContain('permanently deleted');
  });

  it('reports a missing deleted envelope as drift', async () => {
    const { text } = await failingExchange(
      'lumics_delete_device',
      { deviceId: TEST_DEVICE_ID, confirm: true },
      { updated: SAMPLE_DEVICE },
    );
    expect(text).toContain('"deleted" envelope');
  });

  /**
   * Finding H3, at its sharpest. `{deleted: null}` used to produce a successful
   * result reading "The device below has been permanently deleted from Lumics."
   * followed by the literal text `null` — a factual claim that a record was
   * destroyed, with nothing to show for it, from a body a *read* is not even
   * allowed to interpret as an empty record.
   */
  it('never asserts a permanent deletion from an empty deleted envelope', async () => {
    const { text } = await failingExchange(
      'lumics_delete_device',
      { deviceId: TEST_DEVICE_ID, confirm: true },
      { deleted: null },
    );
    expect(text).toContain('invalid_response');
    expect(text).not.toContain('permanently deleted');
    expect(text).not.toMatch(/\bnull\s*$/);
    // The delete may well have landed; the model is sent to look, not told the
    // record is gone and not told to try again.
    expect(text).toMatch(/may already have been applied/);
  });

  it('rejects an array in the deleted envelope of a single delete', async () => {
    const { text } = await failingExchange(
      'lumics_delete_device',
      { deviceId: TEST_DEVICE_ID, confirm: true },
      { deleted: [SAMPLE_DEVICE] },
    );
    expect(text).toContain('invalid_response');
    expect(text).not.toContain('permanently deleted');
  });
});

/**
 * Finding H2 end to end: a write whose response body dies mid-transfer. The
 * client makes exactly one attempt on purpose, so the guidance the model reads
 * must not be "retry the call".
 */
describe('a device write whose response body never finishes arriving', () => {
  /** A 200 whose body stream fails partway through, the way a reset connection does. */
  function truncatedBodyFetch(): FetchRecorder {
    return recordFetch(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () =>
            Promise.reject(new TypeError('terminated', { cause: new Error('ECONNRESET') })),
        }) as unknown as Response,
    );
  }

  it.each([
    [
      'lumics_create_device',
      {
        name: 'core-sw-02',
        ipAddress: '10.20.30.41',
        collector: TEST_COLLECTOR_ID,
        deviceType: 'switch',
      },
    ],
    ['lumics_update_device', { deviceId: TEST_DEVICE_ID, enabled: false }],
    ['lumics_delete_device', { deviceId: TEST_DEVICE_ID, confirm: true }],
  ])('%s is attempted once and the model is told to verify, not to retry', async (tool, args) => {
    const fetcher = truncatedBodyFetch();
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: () => Promise.resolve() },
    });
    try {
      const called = await harness.call(tool, args);
      const text = firstText(called);

      expect(called.isError).toBe(true);
      expect(fetcher.calls).toHaveLength(1);
      expect(text).toMatch(/may already have been applied/);
      expect(text).not.toMatch(/retry the call/i);
    } finally {
      await harness.close();
    }
  });
});

describe('no device tool ever fabricates pagination', () => {
  it.each([
    ['lumics_list_devices', {}, [SAMPLE_DEVICE, SAMPLE_DEVICE]],
    ['lumics_get_device', { deviceId: TEST_DEVICE_ID }, SAMPLE_DEVICE],
    [
      'lumics_update_device',
      { deviceId: TEST_DEVICE_ID, enabled: false },
      { updated: SAMPLE_DEVICE },
    ],
    [
      'lumics_delete_device',
      { deviceId: TEST_DEVICE_ID, confirm: true },
      { deleted: SAMPLE_DEVICE },
    ],
  ])('%s', async (tool, args, response) => {
    const { text, call } = await exchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});
