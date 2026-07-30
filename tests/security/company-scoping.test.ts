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
import { makeConfig, TEST_COMPANY_ID, TEST_DEVICE_ID, TEST_SUBNET_ID } from '../helpers/config.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';
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
