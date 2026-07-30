/**
 * Which company a call lands in, and who gets to decide.
 *
 * Two findings, one surface.
 *
 * **The cross-company pin (finding H5).** `companyId` is an ordinary tool argument
 * and `resolveCompanyId` used to accept any 24-hex value, validating only that it
 * was non-empty. A Lumics token issued to an MSP user reaches every company that
 * user administers, so a model could call
 * `lumics_delete_ipsubnet {ipSubnetId, companyId: <company B>}` and succeed against
 * B — while every write tool's description asserted the write applied to company A,
 * and clients render descriptions in their approval prompts. Cross-company access
 * is an operator act now, like every other blast-radius widening in this server.
 *
 * **The optional company id (finding H6).** `LUMICS_COMPANY_ID` used to be required
 * to start, while the documented way to discover it is `lumics_get_me` — which
 * needs a running server. It is optional now, and company-scoped tools are withheld
 * from the tool LIST while it is unset rather than failing on every call.
 *
 * Both are asserted through `tools/list` and real `tools/call` requests, because
 * "absent from the tool list" and "refused at the boundary" are the actual
 * properties, not the shape of an internal helper.
 */

import { describe, expect, it } from 'vitest';
import {
  makeConfig,
  TEST_COMPANY_ID,
  TEST_COMPONENT_ID,
  TEST_DEVICE_ID,
  TEST_SUBNET_ID,
} from '../helpers/config.js';
import { errorResponse, jsonResponse, recordFetch } from '../helpers/fetch.js';
import { connect, type Harness } from '../helpers/mcp.js';
import type { LumicsConfig } from '../../src/config.js';

/** A second tenant this server was never configured for. Obviously synthetic. */
const OTHER_COMPANY = 'a'.repeat(24);

const PERMISSIVE = {
  features: { batchUpdate: true, tokenRevocation: true },
} as const;

async function harnessFor(
  config: LumicsConfig,
  response: unknown = { deleted: { id: TEST_SUBNET_ID } },
): Promise<{ readonly harness: Harness; readonly calls: ReturnType<typeof recordFetch>['calls'] }> {
  const fetcher = recordFetch(jsonResponse(response));
  const harness = await connect(config, { clientOptions: { fetchImpl: fetcher.fetchImpl } });
  return { harness, calls: fetcher.calls };
}

describe('an explicit companyId cannot silently retarget another tenant (finding H5)', () => {
  const CROSS_COMPANY_CALLS: readonly (readonly [string, Record<string, unknown>])[] = [
    // The finding's own example.
    ['lumics_delete_ipsubnet', { ipSubnetId: TEST_SUBNET_ID, confirm: true }],
    ['lumics_delete_device', { deviceId: TEST_DEVICE_ID, confirm: true }],
    ['lumics_update_device', { deviceId: TEST_DEVICE_ID, enabled: false }],
    [
      'lumics_create_device',
      {
        name: 'x',
        ipAddress: '10.0.0.1',
        collector: '2'.repeat(24),
        deviceType: 'default',
      },
    ],
    // Reads are pinned too: an MSP token reading another tenant's inventory is a
    // disclosure the operator did not configure either.
    ['lumics_list_devices', {}],
    ['lumics_get_device', { deviceId: TEST_DEVICE_ID }],
  ];

  it.each(CROSS_COMPANY_CALLS)(
    '%s refuses a companyId for another tenant, and issues no request',
    async (tool, args) => {
      const { harness, calls } = await harnessFor(makeConfig(PERMISSIVE));
      try {
        const called = await harness.call(tool, { ...args, companyId: OTHER_COMPANY });
        const text = called.content[0]?.type === 'text' ? called.content[0].text : '';

        expect(called.isError).toBe(true);
        expect(text).toMatch(/^not_permitted: /);
        expect(text).toContain('LUMICS_ALLOW_CROSS_COMPANY');
        // Nothing reached the wire, so nothing was read or written in company B.
        expect(calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it('names both companies so the model can explain what it refused to do', async () => {
    const { harness } = await harnessFor(makeConfig());
    try {
      const called = await harness.call('lumics_list_devices', { companyId: OTHER_COMPANY });
      const text = called.content[0]?.type === 'text' ? called.content[0].text : '';
      expect(text).toContain(OTHER_COMPANY);
      expect(text).toContain(TEST_COMPANY_ID);
      // And it says the decision is not the model's to make.
      expect(text).toContain('cannot be overridden from here');
    } finally {
      await harness.close();
    }
  });

  it('still allows the configured company, passed explicitly', async () => {
    const { harness, calls } = await harnessFor(makeConfig(), []);
    try {
      const called = await harness.call('lumics_list_devices', { companyId: TEST_COMPANY_ID });
      expect(called.isError).toBeUndefined();
      expect(calls[0]?.path).toBe(`/companies/${TEST_COMPANY_ID}/devices`);
    } finally {
      await harness.close();
    }
  });

  it('honours another company only once the operator sets the flag', async () => {
    const { harness, calls } = await harnessFor(makeConfig({ allowCrossCompany: true }), []);
    try {
      const called = await harness.call('lumics_list_devices', { companyId: OTHER_COMPANY });
      expect(called.isError).toBeUndefined();
      expect(calls[0]?.path).toBe(`/companies/${OTHER_COMPANY}/devices`);
    } finally {
      await harness.close();
    }
  });

  it('defaults the flag to off, like every other gate', () => {
    expect(makeConfig().allowCrossCompany).toBe(false);
  });
});

/**
 * The two device-scoped metric tools were the hole in the pin. spec §12.3's path
 * — `/metrics/devices/:id/modules/:moduleType` — carries no company segment, so
 * neither tool called `resolveCompanyId` at all and a `deviceId` belonging to
 * another tenant was read without any check. `deviceId` is exactly the kind of
 * value SECURITY.md names as untrusted: "an id a model can pick up from a
 * document… or an injected instruction sitting in a device description".
 *
 * The fix resolves the device's owning company with a company-scoped device read
 * (spec §7.2) and pins on that before the metric read is issued.
 */
describe('the pin covers the device-scoped metric tools too (finding H5, second pass)', () => {
  const DEVICE_METRIC_CALLS: readonly (readonly [string, Record<string, unknown>])[] = [
    ['lumics_get_device_metrics', { deviceId: TEST_DEVICE_ID, moduleType: 'snmp' }],
    [
      'lumics_get_device_item_metrics',
      { deviceId: TEST_DEVICE_ID, moduleType: 'snmp', itemId: TEST_COMPONENT_ID },
    ],
  ];

  /** A tenant whose device reads answer with the given owner, or nothing at all. */
  function tenant(
    owner: string | undefined,
    options: { readonly deviceStatus?: number } = {},
  ): ReturnType<typeof recordFetch> {
    return recordFetch((call) => {
      if (call.path.startsWith('/companies/')) {
        if (options.deviceStatus !== undefined) {
          return errorResponse(options.deviceStatus, 'not found');
        }
        return jsonResponse({
          id: TEST_DEVICE_ID,
          name: 'edge-switch-1',
          ...(owner === undefined ? {} : { company: owner }),
        });
      }
      return jsonResponse({ data: [{ time: 1, stats: { cpu: { avg: 1 } } }] });
    });
  }

  async function callWith(
    fetcher: ReturnType<typeof recordFetch>,
    tool: string,
    args: Record<string, unknown>,
    config = makeConfig(),
  ): Promise<{ readonly isError: boolean; readonly text: string }> {
    const harness = await connect(config, { clientOptions: { fetchImpl: fetcher.fetchImpl } });
    try {
      const called = await harness.call(tool, args);
      const block = called.content[0];
      return {
        isError: called.isError === true,
        text: block?.type === 'text' ? block.text : '',
      };
    } finally {
      await harness.close();
    }
  }

  it.each(DEVICE_METRIC_CALLS)(
    '%s refuses a device owned by another tenant, and reads no metrics',
    async (tool, args) => {
      const fetcher = tenant(OTHER_COMPANY);
      const called = await callWith(fetcher, tool, args);

      expect(called.isError).toBe(true);
      expect(called.text).toMatch(/^not_permitted: /);
      expect(called.text).toContain(OTHER_COMPANY);
      expect(called.text).toContain(TEST_COMPANY_ID);
      expect(called.text).toContain('LUMICS_ALLOW_CROSS_COMPANY');
      // The ownership read happened; the metric read did not.
      expect(fetcher.calls.map((call) => call.path)).toEqual([
        `/companies/${TEST_COMPANY_ID}/devices/${TEST_DEVICE_ID}`,
      ]);
    },
  );

  it.each(DEVICE_METRIC_CALLS)(
    '%s reads metrics for a device in the pinned company',
    async (tool, args) => {
      const fetcher = tenant(TEST_COMPANY_ID);
      const called = await callWith(fetcher, tool, args);

      expect(called.isError).toBe(false);
      expect(fetcher.calls).toHaveLength(2);
      expect(fetcher.calls[0]?.path).toBe(
        `/companies/${TEST_COMPANY_ID}/devices/${TEST_DEVICE_ID}`,
      );
      expect(fetcher.calls[1]?.path).toContain(`/metrics/devices/${TEST_DEVICE_ID}/modules/snmp`);
    },
  );

  it.each(DEVICE_METRIC_CALLS)(
    '%s refuses when the device record carries no company at all',
    async (tool, args) => {
      const fetcher = tenant(undefined);
      const called = await callWith(fetcher, tool, args);

      // Fail closed: an unverifiable owner is not a verified one.
      expect(called.isError).toBe(true);
      expect(called.text).toMatch(/^not_permitted: /);
      expect(fetcher.calls).toHaveLength(1);
    },
  );

  it.each(DEVICE_METRIC_CALLS)(
    '%s refuses when the device is not in the pinned company at all (404)',
    async (tool, args) => {
      const fetcher = tenant(OTHER_COMPANY, { deviceStatus: 404 });
      const called = await callWith(fetcher, tool, args);

      expect(called.isError).toBe(true);
      expect(called.text).toMatch(/^not_permitted: /);
      expect(called.text).toContain('LUMICS_ALLOW_CROSS_COMPANY');
      expect(fetcher.calls).toHaveLength(1);
    },
  );

  it('reports a failed ownership read as the API failure it was, not as a refusal', async () => {
    // A 403 or 500 on the pin read is not "this device belongs elsewhere"; saying
    // so would send the model looking for a company problem that does not exist.
    for (const status of [403, 500]) {
      const fetcher = tenant(TEST_COMPANY_ID, { deviceStatus: status });
      const called = await callWith(fetcher, 'lumics_get_device_metrics', {
        deviceId: TEST_DEVICE_ID,
        moduleType: 'snmp',
      });

      expect(called.isError).toBe(true);
      expect(called.text).not.toMatch(/^not_permitted: /);
      expect(called.text).toContain(String(status));
      // Still no metric read: an unverified device is never read from.
      expect(fetcher.calls.some((call) => call.path.includes('/metrics/'))).toBe(false);
    }
  });

  it.each(DEVICE_METRIC_CALLS)(
    '%s skips the ownership read entirely once the operator allows cross-company',
    async (tool, args) => {
      const fetcher = tenant(OTHER_COMPANY);
      const called = await callWith(fetcher, tool, args, makeConfig({ allowCrossCompany: true }));

      expect(called.isError).toBe(false);
      // One call, straight to the metric path: the pin the operator turned off
      // costs nothing when it is off.
      expect(fetcher.calls).toHaveLength(1);
      expect(fetcher.only().path).toContain(`/metrics/devices/${TEST_DEVICE_ID}/modules/snmp`);
    },
  );

  it('withholds both tools when there is no LUMICS_COMPANY_ID to pin to', async () => {
    const harness = await connect(makeConfig({ companyId: '' }), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({})).fetchImpl },
    });
    try {
      const names = harness.tools.map((tool) => tool.name);
      expect(names).not.toContain('lumics_get_device_metrics');
      expect(names).not.toContain('lumics_get_device_item_metrics');
    } finally {
      await harness.close();
    }
  });

  it('says in both descriptions that the device is checked against the pin', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({})).fetchImpl },
    });
    try {
      for (const name of ['lumics_get_device_metrics', 'lumics_get_device_item_metrics']) {
        const description = harness.tool(name)?.description ?? '';
        expect(description, name).toContain('LUMICS_COMPANY_ID');
      }
    } finally {
      await harness.close();
    }
  });
});

describe('no write description asserts a company it cannot guarantee (finding H5)', () => {
  it('never states a company id, on any write tool', async () => {
    const harness = await connect(makeConfig(PERMISSIVE), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({})).fetchImpl },
    });
    try {
      const writes = harness.tools.filter(
        (tool) => tool.annotations?.readOnlyHint !== true && tool.description !== undefined,
      );
      expect(writes.length).toBeGreaterThan(10);

      for (const tool of writes) {
        const description = tool.description ?? '';
        expect(description, `${tool.name} must not name a company id`).not.toContain(
          TEST_COMPANY_ID,
        );
        expect(description, `${tool.name} must not name any company id`).not.toMatch(
          /company [0-9a-fA-F]{24}/,
        );
        expect(description, `${tool.name} must still warn about live writes`).toContain(
          'cannot be undone by this server',
        );
      }
    } finally {
      await harness.close();
    }
  });
});

describe('the server starts and bootstraps without LUMICS_COMPANY_ID (finding H6)', () => {
  const unconfigured = makeConfig({ companyId: '', ...PERMISSIVE });

  async function listTools(): Promise<Harness> {
    return connect(unconfigured, {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({ id: 'x' })).fetchImpl },
    });
  }

  it('registers lumics_get_me, which is what finds the company id', async () => {
    const harness = await listTools();
    try {
      expect(harness.tool('lumics_get_me')).toBeDefined();
    } finally {
      await harness.close();
    }
  });

  it('withholds every company-scoped tool from the tool list', async () => {
    const harness = await listTools();
    try {
      const names = harness.tools.map((tool) => tool.name);
      for (const withheld of [
        'lumics_list_devices',
        'lumics_get_device',
        'lumics_create_device',
        'lumics_delete_device',
        'lumics_list_collectors',
        'lumics_list_ipsubnets',
        'lumics_delete_ipsubnet',
        'lumics_list_components',
        'lumics_get_company_metrics',
        'lumics_get_metric_summary',
      ]) {
        expect(names, `${withheld} needs a company and must not be listed`).not.toContain(withheld);
      }
    } finally {
      await harness.close();
    }
  });

  it('leaves no listed tool that declares a companyId argument', async () => {
    const harness = await listTools();
    try {
      for (const tool of harness.tools) {
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> })
          .properties;
        expect(
          Object.hasOwn(properties ?? {}, 'companyId'),
          `${tool.name} is company-scoped and must not be listed without a company`,
        ).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it('can actually call lumics_get_me, which is the whole point', async () => {
    const fetcher = recordFetch(
      jsonResponse({ id: '1'.repeat(24), company: { id: TEST_COMPANY_ID, name: 'Acme' } }),
    );
    const harness = await connect(unconfigured, {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      const called = await harness.call('lumics_get_me', {});
      expect(called.isError).toBeUndefined();
      expect(fetcher.only().path).toBe('/me');
    } finally {
      await harness.close();
    }
  });

  it("describes the real bootstrap flow in lumics_get_me's description", async () => {
    const harness = await listTools();
    try {
      const description = harness.tool('lumics_get_me')?.description ?? '';
      expect(description).toContain('LUMICS_COMPANY_ID is optional');
      expect(description).toContain('not registered at all');
      expect(description).toContain('restart the server');
      // It must not send the model down the path that no longer exists.
      expect(description).not.toMatch(/pass it as companyId\b(?!.*will not help)/);
    } finally {
      await harness.close();
    }
  });

  it('restores the full surface as soon as a company is configured', async () => {
    const harness = await connect(makeConfig(PERMISSIVE), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({})).fetchImpl },
    });
    try {
      const names = harness.tools.map((tool) => tool.name);
      expect(names).toContain('lumics_list_devices');
      expect(names).toContain('lumics_get_me');
    } finally {
      await harness.close();
    }
  });
});
