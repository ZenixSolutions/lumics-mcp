/**
 * IPAM tools — the fifteen endpoints of spec §10 (subnets), §8 (addresses) and
 * §9 (groups).
 *
 * The single most important assertion in this file is that all five address
 * routes use the SINGULAR `/ipsubnet/` segment (MEASURED 2026-07-31). spec §13
 * Q1 documents a per-verb split — singular reads, plural writes — and states it
 * is confirmed in the vendor's route definitions. It is not: the plural is
 * unrouted for every verb. This file used to assert the split, which is how
 * 0.1.0 shipped three IPAM write tools addressing a route that does not exist,
 * with this suite green throughout. The prototype used the singular form for all
 * five calls and was right; its own documentation was what disagreed.
 *
 * `parent: null` is also asserted to survive, because it means "top level" here
 * rather than "wipe this field": IPAM's `pruneUndefined` deliberately keeps nulls
 * while the device module's deliberately drops them.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIST_LIMIT } from '../../src/constants.js';
import {
  TEST_ADDRESS_ID,
  TEST_COMPANY_ID,
  TEST_GROUP_ID,
  TEST_SUBNET_ID,
} from '../helpers/config.js';
import {
  exchange,
  expectNoFabricatedPagination,
  expectNoFabricatedQueryParams,
  failingExchange,
} from '../helpers/tools.js';

const C = TEST_COMPANY_ID;
const SUBNETS = `/companies/${C}/ipsubnets`;
const SUBNET = `${SUBNETS}/${TEST_SUBNET_ID}`;
const GROUPS = `/companies/${C}/ipgroups`;
const GROUP = `${GROUPS}/${TEST_GROUP_ID}`;

/** SINGULAR — spec §8.1/§8.2 reads. */
const ADDRESSES_READ = `/companies/${C}/ipsubnet/${TEST_SUBNET_ID}/ipaddresses`;
/** SINGULAR too — spec §8.3/§8.4/§8.5 document the plural and are wrong (MEASURED 2026-07-31). */
const ADDRESSES_WRITE = `/companies/${C}/ipsubnet/${TEST_SUBNET_ID}/ipaddresses`;

const SAMPLE_SUBNET = {
  id: TEST_SUBNET_ID,
  network: '172.27.16.0',
  netmask: '255.255.255.0',
  cidr: 24,
  addressCount: 254,
  usedCount: 31,
};
const SAMPLE_ADDRESS = {
  id: TEST_ADDRESS_ID,
  ipAddress: '172.27.16.20',
  state: 'used',
  scanHistory: { lastStatus: 'up' },
};
const SAMPLE_GROUP = { _id: TEST_GROUP_ID, name: 'Branch sites', type: 'group', parent: null };

// ---------------------------------------------------------------------------
// Route spelling. Read this block first.
// ---------------------------------------------------------------------------

describe('every IPAM address route uses the singular segment (MEASURED 2026-07-31)', () => {
  it('lumics_list_ipaddresses (READ) uses the SINGULAR /ipsubnet/ segment', async () => {
    const { call } = await exchange('lumics_list_ipaddresses', { ipSubnetId: TEST_SUBNET_ID }, [
      SAMPLE_ADDRESS,
    ]);
    expect(call.path).toBe(ADDRESSES_READ);
    expect(call.path).toContain(`/ipsubnet/${TEST_SUBNET_ID}/`);
    expect(call.path).not.toContain('/ipsubnets/');
  });

  it('lumics_get_ipaddress (READ) uses the SINGULAR /ipsubnet/ segment', async () => {
    const { call } = await exchange(
      'lumics_get_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID },
      SAMPLE_ADDRESS,
    );
    expect(call.path).toBe(`${ADDRESSES_READ}/${TEST_ADDRESS_ID}`);
    expect(call.path).not.toContain('/ipsubnets/');
  });

  it('lumics_create_ipaddress (WRITE) uses the SINGULAR /ipsubnet/ segment', async () => {
    const { call } = await exchange(
      'lumics_create_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddress: '172.27.16.20' },
      SAMPLE_ADDRESS,
    );
    expect(call.path).toBe(ADDRESSES_WRITE);
    expect(call.path).toContain(`/ipsubnet/${TEST_SUBNET_ID}/`);
    expect(call.path).not.toContain('/ipsubnets/');
  });

  it('lumics_update_ipaddress (WRITE) uses the SINGULAR /ipsubnet/ segment', async () => {
    const { call } = await exchange(
      'lumics_update_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID, state: 'reserved' },
      { updated: SAMPLE_ADDRESS },
    );
    expect(call.path).toBe(`${ADDRESSES_WRITE}/${TEST_ADDRESS_ID}`);
    expect(call.path).not.toContain('/ipsubnets/');
  });

  it('lumics_delete_ipaddress (WRITE) uses the SINGULAR /ipsubnet/ segment', async () => {
    const { call } = await exchange(
      'lumics_delete_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID, confirm: true },
      { deleted: SAMPLE_ADDRESS },
    );
    expect(call.path).toBe(`${ADDRESSES_WRITE}/${TEST_ADDRESS_ID}`);
    expect(call.path).not.toContain('/ipsubnets/');
  });

  it('the read and write spellings are identical, so a reintroduced plural would fail', () => {
    // This assertion is the inverse of the one that used to stand here, which
    // required the two to differ and thereby protected the defect.
    expect(ADDRESSES_READ).toBe(ADDRESSES_WRITE);
    expect(ADDRESSES_WRITE).not.toContain('/ipsubnets/');
  });
});

// ---------------------------------------------------------------------------
// IP Subnet — spec §10
// ---------------------------------------------------------------------------

describe('lumics_list_ipsubnets (spec section 10.1)', () => {
  it('GETs the collection with limit, and with parent only when supplied', async () => {
    const without = await exchange('lumics_list_ipsubnets', {}, [SAMPLE_SUBNET]);
    expect(without.call.path).toBe(SUBNETS);
    expect(without.call.query).toEqual({ limit: String(DEFAULT_LIST_LIMIT) });

    const withParent = await exchange(
      'lumics_list_ipsubnets',
      { parent: TEST_GROUP_ID, limit: 10 },
      [SAMPLE_SUBNET],
    );
    expect(withParent.call.query).toEqual({ limit: '10', parent: TEST_GROUP_ID });
    expectNoFabricatedQueryParams(withParent.call);
  });

  it('discloses truncation at the limit', async () => {
    const { notes } = await exchange('lumics_list_ipsubnets', { limit: 1 }, [SAMPLE_SUBNET]);
    expect(notes).toContain('NOTE ON COMPLETENESS:');
  });
});

describe('lumics_get_ipsubnet (spec section 10.2)', () => {
  it('GETs one subnet with no query parameters', async () => {
    const { call, payload } = await exchange(
      'lumics_get_ipsubnet',
      { ipSubnetId: TEST_SUBNET_ID },
      SAMPLE_SUBNET,
    );
    expect(call.path).toBe(SUBNET);
    expect(Object.keys(call.query)).toEqual([]);
    expect(payload).toEqual(SAMPLE_SUBNET);
  });
});

describe('lumics_create_ipsubnet (spec section 10.3)', () => {
  const args = { network: '172.27.16.0', netmask: '255.255.255.0', cidr: 24 };

  it('POSTs with company repeated in the body and the three required fields', async () => {
    const { call, notes } = await exchange('lumics_create_ipsubnet', args, SAMPLE_SUBNET);
    expect(call.method).toBe('POST');
    expect(call.path).toBe(SUBNETS);
    expect(call.body).toEqual({ company: C, ...args });
    expect(notes).toContain(`The new subnet's id is ${TEST_SUBNET_ID}`);
  });

  it('preserves parent: null, which means top level rather than "wipe this field"', async () => {
    const { call } = await exchange(
      'lumics_create_ipsubnet',
      { ...args, parent: null },
      SAMPLE_SUBNET,
    );
    expect(call.body).toMatchObject({ parent: null });
  });

  it('sends customProperties as the documented pair array', async () => {
    const { call } = await exchange(
      'lumics_create_ipsubnet',
      {
        ...args,
        customProperties: [{ customProperty: 'e'.repeat(24), value: 'production' }],
      },
      SAMPLE_SUBNET,
    );
    expect(call.body).toMatchObject({
      customProperties: [{ customProperty: 'e'.repeat(24), value: 'production' }],
    });
  });

  it.each([
    ['a cidr above 32', { ...args, cidr: 33 }],
    ['a negative cidr', { ...args, cidr: -1 }],
    ['a non-integer cidr', { ...args, cidr: 24.5 }],
    ['a hostname as network', { ...args, network: 'net.example.com' }],
    ['a CIDR string as network', { ...args, network: '172.27.16.0/24' }],
    ['an IPv6 netmask', { ...args, netmask: '::ffff' }],
    ['a non-ObjectId collector', { ...args, collector: 'dc1' }],
    [
      'a non-ObjectId customProperty id',
      { ...args, customProperties: [{ customProperty: 'x', value: 1 }] },
    ],
  ])(
    'rejects %s locally, because bad inventory is worse than a failed call',
    async (_label, bad) => {
      const { calls } = await failingExchange('lumics_create_ipsubnet', bad);
      expect(calls).toHaveLength(0);
    },
  );

  it('does not expose the collector-owned scan bookkeeping fields', async () => {
    const { call } = await exchange(
      'lumics_create_ipsubnet',
      {
        ...args,
        lastScan: '2026-07-29T00:00:00Z',
        usedCount: 99,
        addressCount: 254,
        scanProgress: 1,
      },
      SAMPLE_SUBNET,
    );
    const body = call.body as Record<string, unknown>;
    for (const field of ['lastScan', 'usedCount', 'addressCount', 'scanProgress']) {
      expect(Object.hasOwn(body, field), `${field} must not be writable`).toBe(false);
    }
  });
});

describe('lumics_update_ipsubnet (spec section 10.4)', () => {
  it('PATCHes only the changed fields, with every field optional per the example', async () => {
    const { call, payload } = await exchange(
      'lumics_update_ipsubnet',
      { ipSubnetId: TEST_SUBNET_ID, netmask: '255.255.254.0', cidr: 23 },
      { updated: SAMPLE_SUBNET },
    );
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(SUBNET);
    expect(call.body).toEqual({ netmask: '255.255.254.0', cidr: 23 });
    expect(payload).toEqual(SAMPLE_SUBNET);
  });

  it('sends parent: null to move a subnet to the top level', async () => {
    const { call } = await exchange(
      'lumics_update_ipsubnet',
      { ipSubnetId: TEST_SUBNET_ID, parent: null },
      { updated: SAMPLE_SUBNET },
    );
    expect(call.body).toEqual({ parent: null });
  });

  it('refuses a no-field PATCH and names every settable field', async () => {
    const { calls, text } = await failingExchange('lumics_update_ipsubnet', {
      ipSubnetId: TEST_SUBNET_ID,
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('would change nothing');
    expect(text).toContain('excludeFromScheduledScan');
  });
});

describe('lumics_delete_ipsubnet (spec section 10.5)', () => {
  it('DELETEs the subnet and states that the addresses become unreachable', async () => {
    const { call, payload, notes } = await exchange(
      'lumics_delete_ipsubnet',
      { ipSubnetId: TEST_SUBNET_ID, confirm: true },
      { deleted: SAMPLE_SUBNET },
    );
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(SUBNET);
    expect(call.body).toBeUndefined();
    expect(payload).toEqual(SAMPLE_SUBNET);
    expect(notes).toContain(`Subnet ${TEST_SUBNET_ID} has been permanently deleted`);
    expect(notes).toContain('no longer reachable');
  });

  it('reports "unknown" rather than inventing an id when the payload carries none', async () => {
    const { notes } = await exchange(
      'lumics_delete_ipsubnet',
      { ipSubnetId: TEST_SUBNET_ID, confirm: true },
      { deleted: { network: '172.27.16.0' } },
    );
    expect(notes).toContain('unknown (Lumics returned no id field)');
  });
});

// ---------------------------------------------------------------------------
// IP Address — spec §8
// ---------------------------------------------------------------------------

describe('lumics_list_ipaddresses (spec section 8.1)', () => {
  it('sends limit and has NO parent filter, which spec section 8.1 does not document', async () => {
    const { call } = await exchange(
      'lumics_list_ipaddresses',
      { ipSubnetId: TEST_SUBNET_ID, limit: 50 },
      [SAMPLE_ADDRESS],
    );
    expect(call.query).toEqual({ limit: '50' });
    expect(call.url.searchParams.has('parent')).toBe(false);
    expectNoFabricatedQueryParams(call);
  });
});

describe('lumics_create_ipaddress (spec section 8.3)', () => {
  it('POSTs with company AND ipSubnet repeated in the body', async () => {
    const { call, notes } = await exchange(
      'lumics_create_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddress: '172.27.16.20', state: 'reserved' },
      SAMPLE_ADDRESS,
    );
    // spec §8.3: both are required body fields as well as path segments.
    expect(call.body).toEqual({
      company: C,
      ipSubnet: TEST_SUBNET_ID,
      ipAddress: '172.27.16.20',
      state: 'reserved',
    });
    expect(notes).toContain(`The new IP address record's id is ${TEST_ADDRESS_ID}`);
  });

  it.each([
    ['a MAC in colon form', '00:1a:2b:3c:4d:5e'],
    ['a MAC in hyphen form', '00-1A-2B-3C-4D-5E'],
  ])('accepts %s', async (_label, macAddress) => {
    const { call } = await exchange(
      'lumics_create_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddress: '172.27.16.20', macAddress },
      SAMPLE_ADDRESS,
    );
    expect(call.body).toMatchObject({ macAddress });
  });

  it.each([
    ['a malformed MAC', { macAddress: '00:1a:2b' }],
    ['a hostname as the address', { ipAddress: 'host.example.com' }],
    ['a hostname as nat', { nat: 'nat.example.com' }],
    ['an undocumented state', { state: 'free' }],
  ])('rejects %s locally', async (_label, bad) => {
    const { calls } = await failingExchange('lumics_create_ipaddress', {
      ipSubnetId: TEST_SUBNET_ID,
      ipAddress: '172.27.16.20',
      ...bad,
    });
    expect(calls).toHaveLength(0);
  });

  it("does not expose scanHistory, which is the collector's observation record", async () => {
    const { call } = await exchange(
      'lumics_create_ipaddress',
      {
        ipSubnetId: TEST_SUBNET_ID,
        ipAddress: '172.27.16.20',
        scanHistory: { lastStatus: 'up' },
      },
      SAMPLE_ADDRESS,
    );
    expect(Object.hasOwn(call.body as object, 'scanHistory')).toBe(false);
  });
});

describe('lumics_update_ipaddress (spec section 8.4)', () => {
  it('PATCHes only the changed fields and cannot move a record between subnets', async () => {
    const { call } = await exchange(
      'lumics_update_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID, state: 'reserved', note: 'held' },
      { updated: SAMPLE_ADDRESS },
    );
    expect(call.body).toEqual({ state: 'reserved', note: 'held' });
    // `ipSubnet` is not a changeable field: re-homing by PATCH is undocumented.
    expect(Object.hasOwn(call.body as object, 'ipSubnet')).toBe(false);
  });

  it('refuses a no-field PATCH', async () => {
    const { calls, text } = await failingExchange('lumics_update_ipaddress', {
      ipSubnetId: TEST_SUBNET_ID,
      ipAddressId: TEST_ADDRESS_ID,
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('would change nothing');
  });
});

describe('lumics_delete_ipaddress (spec section 8.5)', () => {
  it('DELETEs the record and says the scan history goes with it', async () => {
    const { call, notes } = await exchange(
      'lumics_delete_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID, confirm: true },
      { deleted: SAMPLE_ADDRESS },
    );
    expect(call.method).toBe('DELETE');
    expect(notes).toContain('including its scan history');
  });
});

// ---------------------------------------------------------------------------
// IP Group — spec §9
// ---------------------------------------------------------------------------

describe('lumics_list_ipgroups (spec section 9.1)', () => {
  it('sends limit and parent', async () => {
    const { call } = await exchange('lumics_list_ipgroups', { parent: TEST_GROUP_ID, limit: 25 }, [
      SAMPLE_GROUP,
    ]);
    expect(call.path).toBe(GROUPS);
    expect(call.query).toEqual({ limit: '25', parent: TEST_GROUP_ID });
  });
});

describe('lumics_get_ipgroup (spec section 9.2)', () => {
  it('GETs one group and passes through the _id key this endpoint returns', async () => {
    const { call, payload } = await exchange(
      'lumics_get_ipgroup',
      { ipGroupId: TEST_GROUP_ID },
      SAMPLE_GROUP,
    );
    expect(call.path).toBe(GROUP);
    // spec §4.2: this read returns `_id` where the list returns `id`. Neither is
    // rewritten — the payload is passed through as it arrived.
    expect(payload).toEqual(SAMPLE_GROUP);
  });
});

describe('lumics_create_ipgroup (spec section 9.3)', () => {
  it('POSTs with company and name, and reads the id back through either key', async () => {
    const { call, notes } = await exchange(
      'lumics_create_ipgroup',
      { name: 'Branch sites' },
      SAMPLE_GROUP,
    );
    expect(call.body).toEqual({ company: C, name: 'Branch sites' });
    expect(notes).toContain(`The new group's id is ${TEST_GROUP_ID}`);
  });

  it('does not default type, because no default is documented', async () => {
    const { call } = await exchange('lumics_create_ipgroup', { name: 'x' }, SAMPLE_GROUP);
    expect(Object.hasOwn(call.body as object, 'type')).toBe(false);
  });

  it.each(['group', 'supernet'])('accepts the documented type %j', async (type) => {
    const { call } = await exchange('lumics_create_ipgroup', { name: 'x', type }, SAMPLE_GROUP);
    expect(call.body).toMatchObject({ type });
  });

  it('rejects an undocumented type', async () => {
    const { calls } = await failingExchange('lumics_create_ipgroup', { name: 'x', type: 'folder' });
    expect(calls).toHaveLength(0);
  });
});

describe('lumics_update_ipgroup (spec section 9.4)', () => {
  it('PATCHes with the id and company the documented example carries', async () => {
    const { call } = await exchange(
      'lumics_update_ipgroup',
      { ipGroupId: TEST_GROUP_ID, name: 'Renamed' },
      { updated: SAMPLE_GROUP },
    );
    expect(call.path).toBe(GROUP);
    // spec §9.4's example body includes `id` and `company`; `company` is the one
    // already in the path, so it cannot move the group between tenants.
    expect(call.body).toEqual({ id: TEST_GROUP_ID, company: C, name: 'Renamed' });
  });

  it('sends parent: null to re-parent a branch to the top level', async () => {
    const { call } = await exchange(
      'lumics_update_ipgroup',
      { ipGroupId: TEST_GROUP_ID, parent: null },
      { updated: SAMPLE_GROUP },
    );
    expect(call.body).toEqual({ id: TEST_GROUP_ID, company: C, parent: null });
  });

  it('refuses a no-field PATCH even though the body would carry id and company', async () => {
    const { calls, text } = await failingExchange('lumics_update_ipgroup', {
      ipGroupId: TEST_GROUP_ID,
    });
    expect(calls).toHaveLength(0);
    expect(text).toContain('name, description, type or parent');
  });
});

describe('lumics_delete_ipgroup (spec section 9.5)', () => {
  it('DELETEs with NO request body, despite the vendor example showing one', async () => {
    const { call, notes } = await exchange(
      'lumics_delete_ipgroup',
      { ipGroupId: TEST_GROUP_ID, confirm: true },
      { deleted: SAMPLE_GROUP },
    );
    expect(call.method).toBe('DELETE');
    expect(call.path).toBe(GROUP);
    // spec §14 defect 10: the example shows a body for a DELETE that documents no
    // body fields. None is sent.
    expect(call.rawBody).toBeUndefined();
    expect(call.headers['content-type']).toBeUndefined();
    expect(notes).toContain('does not document whether the subnets and child groups');
  });
});

describe('no IPAM tool ever fabricates pagination', () => {
  it.each([
    ['lumics_list_ipsubnets', {}, [SAMPLE_SUBNET, SAMPLE_SUBNET]],
    ['lumics_get_ipsubnet', { ipSubnetId: TEST_SUBNET_ID }, SAMPLE_SUBNET],
    ['lumics_list_ipaddresses', { ipSubnetId: TEST_SUBNET_ID }, [SAMPLE_ADDRESS]],
    [
      'lumics_get_ipaddress',
      { ipSubnetId: TEST_SUBNET_ID, ipAddressId: TEST_ADDRESS_ID },
      SAMPLE_ADDRESS,
    ],
    ['lumics_list_ipgroups', {}, [SAMPLE_GROUP]],
    ['lumics_get_ipgroup', { ipGroupId: TEST_GROUP_ID }, SAMPLE_GROUP],
    ['lumics_create_ipgroup', { name: 'x' }, SAMPLE_GROUP],
    ['lumics_update_ipgroup', { ipGroupId: TEST_GROUP_ID, name: 'x' }, { updated: SAMPLE_GROUP }],
    [
      'lumics_delete_ipgroup',
      { ipGroupId: TEST_GROUP_ID, confirm: true },
      { deleted: SAMPLE_GROUP },
    ],
  ])('%s', async (tool, args, response) => {
    const { text, call } = await exchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});
