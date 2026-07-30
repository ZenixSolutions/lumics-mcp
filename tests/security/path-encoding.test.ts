/**
 * SECURITY CONTROL: a caller-supplied identifier cannot escape its path position.
 *
 * The prototype interpolated ids straight into template literals, so a
 * `deviceId` of `../../me/token` walked out of the devices collection and onto
 * the token endpoint. `tests/unit/paths.test.ts` proves the builders encode; this
 * file proves the property holds end to end — through the tool schema, the path
 * builder, and the URL the client would actually put on the wire.
 *
 * Two layers are asserted separately, because both matter:
 *  1. The zod schema rejects a non-ObjectId id before a path is even built.
 *  2. Where a segment is legitimately free-form (a component type, a module
 *     name), the encoding is what keeps it safe — and the URL still resolves
 *     inside the intended collection.
 */

import { describe, expect, it } from 'vitest';
import { LumicsClient } from '../../src/api/client.js';
import * as paths from '../../src/api/paths.js';
import { makeConfig, TEST_COMPANY_ID, TEST_DEVICE_ID, TEST_SUBNET_ID } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';

const TRAVERSAL = '../../me/token';

/** Tools whose id arguments are ObjectId-shaped, so traversal is rejected outright. */
const OBJECT_ID_ARGUMENTS: readonly { readonly tool: string; readonly argument: string }[] = [
  { tool: 'lumics_get_device', argument: 'deviceId' },
  { tool: 'lumics_get_collector', argument: 'collectorId' },
  { tool: 'lumics_get_ipsubnet', argument: 'ipSubnetId' },
  { tool: 'lumics_get_ipaddress', argument: 'ipSubnetId' },
  { tool: 'lumics_get_ipaddress', argument: 'ipAddressId' },
  { tool: 'lumics_get_ipgroup', argument: 'ipGroupId' },
  { tool: 'lumics_get_component', argument: 'componentId' },
  { tool: 'lumics_get_device_metrics', argument: 'deviceId' },
  { tool: 'lumics_get_device_item_metrics', argument: 'itemId' },
  { tool: 'lumics_list_ipaddresses', argument: 'ipSubnetId' },
];

/** Valid values for the other required arguments of each tool above. */
const VALID_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  lumics_get_device: { deviceId: TEST_DEVICE_ID },
  lumics_get_collector: { collectorId: '2'.repeat(24) },
  lumics_get_ipsubnet: { ipSubnetId: TEST_SUBNET_ID },
  lumics_get_ipaddress: { ipSubnetId: TEST_SUBNET_ID, ipAddressId: '4'.repeat(24) },
  lumics_get_ipgroup: { ipGroupId: '5'.repeat(24) },
  lumics_get_component: { componentType: 'cisco_ast_devices', componentId: '6'.repeat(24) },
  lumics_get_device_metrics: { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' },
  lumics_get_device_item_metrics: {
    deviceId: TEST_DEVICE_ID,
    moduleType: 'snmp',
    itemId: '6'.repeat(24),
  },
  lumics_list_ipaddresses: { ipSubnetId: TEST_SUBNET_ID },
};

describe('an ObjectId argument rejects traversal before a request is built', () => {
  it.each(OBJECT_ID_ARGUMENTS.map((entry) => [`${entry.tool}.${entry.argument}`, entry] as const))(
    '%s rejects "../../me/token"',
    async (_label, entry: (typeof OBJECT_ID_ARGUMENTS)[number]) => {
      const fetcher = recordFetch(jsonResponse({ id: 'x' }));
      const harness = await connect(makeConfig(), {
        clientOptions: { fetchImpl: fetcher.fetchImpl },
      });
      try {
        const called = await harness.call(entry.tool, {
          ...VALID_ARGS[entry.tool],
          [entry.argument]: TRAVERSAL,
        });
        expect(called.isError).toBe(true);
        // Rejected locally: no round trip, and certainly no request to /me/token.
        expect(fetcher.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it('also rejects a companyId of "../../me/token"', async () => {
    const fetcher = recordFetch(jsonResponse([]));
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      const called = await harness.call('lumics_list_devices', { companyId: TRAVERSAL });
      expect(called.isError).toBe(true);
      expect(fetcher.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

describe('a free-form segment is encoded, and the URL still lands where it should', () => {
  it.each([
    [
      'lumics_list_components componentType',
      'lumics_list_components',
      { componentType: TRAVERSAL },
      '/component/',
    ],
    [
      'lumics_get_device_metrics moduleType',
      'lumics_get_device_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: TRAVERSAL },
      '/modules/',
    ],
    [
      'lumics_get_company_metrics moduleType',
      'lumics_get_company_metrics',
      { moduleType: TRAVERSAL },
      '/metrics/companies/',
    ],
    [
      'lumics_update_device_last_discovery module',
      'lumics_update_device_last_discovery',
      { deviceId: TEST_DEVICE_ID, module: TRAVERSAL, date: '2026-07-29T00:00:00Z', confirm: true },
      '/modules/',
    ],
  ])('%s is percent-encoded on the wire', async (_label, tool, args, mustContain) => {
    const fetcher = recordFetch(jsonResponse({ data: [], updated: { id: 'x' } }));
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      await harness.call(tool, args);
      expect(fetcher.calls).toHaveLength(1);

      const { url } = fetcher.only();
      expect(url.pathname).toContain('..%2F..%2Fme%2Ftoken');
      // Still inside the intended collection, and nowhere near the token route.
      expect(url.pathname).toContain(mustContain);
      expect(url.pathname).not.toMatch(/\/me\/token(\/|$)/);
      expect(url.pathname.split('/')).not.toContain('..');
    } finally {
      await harness.close();
    }
  });

  it('an encoded segment survives URL construction without being normalised away', () => {
    const fetcher = recordFetch(jsonResponse({}));
    const client = new LumicsClient(makeConfig(), { fetchImpl: fetcher.fetchImpl });

    return client.get(paths.devicePath(TEST_COMPANY_ID, TRAVERSAL)).then(() => {
      const { url } = fetcher.only();
      // `%2F` is not a path separator, so no segment collapsing occurs.
      expect(url.pathname).toBe(
        `/api/v1/companies/${TEST_COMPANY_ID}/devices/..%2F..%2Fme%2Ftoken`,
      );
      expect(url.pathname).not.toContain('/api/v1/me/token');
    });
  });

  it('a path with a leading .. cannot climb out of the /api/v1 prefix', () => {
    const fetcher = recordFetch(jsonResponse({}));
    const client = new LumicsClient(makeConfig(), { fetchImpl: fetcher.fetchImpl });

    // Concatenation rather than `new URL(path, base)` is what preserves the
    // prefix: URL resolution would let a leading slash or `..` escape it.
    return client.get(paths.ipAddressReadPath(TEST_COMPANY_ID, TRAVERSAL, TRAVERSAL)).then(() => {
      expect(fetcher.only().url.pathname.startsWith('/api/v1/companies/')).toBe(true);
    });
  });

  it('a query-injection attempt in a path segment cannot add a query parameter', async () => {
    const fetcher = recordFetch(jsonResponse([]));
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      await harness.call('lumics_list_components', { componentType: 'x?limit=99999&admin=1' });
      const { url } = fetcher.only();
      expect(url.searchParams.get('admin')).toBeNull();
      expect(url.searchParams.get('limit')).toBeNull();
      expect(url.pathname).toContain('x%3Flimit%3D99999%26admin%3D1');
    } finally {
      await harness.close();
    }
  });

  it('a fragment-injection attempt cannot truncate the path', async () => {
    const fetcher = recordFetch(jsonResponse([]));
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      await harness.call('lumics_list_components', { componentType: 'x#/../../me' });
      const { url } = fetcher.only();
      expect(url.hash).toBe('');
      expect(url.pathname).toContain('x%23%2F..%2F..%2Fme');
    } finally {
      await harness.close();
    }
  });
});

describe('the client is the only place a URL is assembled', () => {
  it('the path handed to the client is already encoded, so nothing re-encodes it', () => {
    // Double encoding would be as much a bug as none: `%2F` must not become
    // `%252F` on the way through the client.
    const fetcher = recordFetch(jsonResponse({}));
    const client = new LumicsClient(makeConfig(), { fetchImpl: fetcher.fetchImpl });
    const path = paths.componentsPath(TEST_COMPANY_ID, 'a/b');

    expect(path).toContain('a%2Fb');
    return client.get(path).then(() => {
      expect(fetcher.only().url.pathname).toContain('a%2Fb');
      expect(fetcher.only().url.pathname).not.toContain('a%252Fb');
    });
  });
});
