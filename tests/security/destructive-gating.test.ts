/**
 * SECURITY CONTROL: destructive and admin operations are gated twice.
 *
 * The environment flags (`LUMICS_ENABLE_BATCH_UPDATE`,
 * `LUMICS_ENABLE_TOKEN_REVOCATION`) are the real control: a human sets them out
 * of band and no prompt can change them. The `confirm` argument is a prompt-level
 * speed bump that makes the intent explicit in the transcript. Both are asserted
 * here, and the `confirm` cases additionally assert that the injected fetch was
 * never called — a gate that fires after the request has gone out is not a gate.
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '../../src/server.js';
import { makeConfig, TEST_DEVICE_ID } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { jsonResponse, recordFetch, type FetchRecorder } from '../helpers/fetch.js';

/** Names and minimal valid arguments for every tool that requires confirmation. */
const CONFIRMING_TOOLS: readonly {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly flag?: 'batchUpdate' | 'tokenRevocation';
}[] = [
  { name: 'lumics_delete_collector', args: { collectorId: '2'.repeat(24) } },
  { name: 'lumics_delete_device', args: { deviceId: TEST_DEVICE_ID } },
  { name: 'lumics_delete_ipsubnet', args: { ipSubnetId: '3'.repeat(24) } },
  {
    name: 'lumics_delete_ipaddress',
    args: { ipSubnetId: '3'.repeat(24), ipAddressId: '4'.repeat(24) },
  },
  { name: 'lumics_delete_ipgroup', args: { ipGroupId: '5'.repeat(24) } },
  {
    name: 'lumics_batch_update_devices',
    args: { deviceIds: [TEST_DEVICE_ID], enabled: false },
    flag: 'batchUpdate',
  },
  { name: 'lumics_revoke_tokens', args: {}, flag: 'tokenRevocation' },
];

function permissiveConfig() {
  return makeConfig({ features: { batchUpdate: true, tokenRevocation: true } });
}

function stubFetch(): FetchRecorder {
  // Any successful envelope; the point is whether it is reached at all.
  return recordFetch(jsonResponse({ deleted: { id: 'x' }, updated: { id: 'x' } }));
}

describe('feature-flag gating: the flags are the real control', () => {
  it('lumics_batch_update_devices is absent unless LUMICS_ENABLE_BATCH_UPDATE is set', async () => {
    const off = await connect(makeConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    const on = await connect(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: false } }),
      {
        clientOptions: { fetchImpl: stubFetch().fetchImpl },
      },
    );
    try {
      expect(off.tool('lumics_batch_update_devices')).toBeUndefined();
      expect(on.tool('lumics_batch_update_devices')).toBeDefined();
    } finally {
      await off.close();
      await on.close();
    }
  });

  it('lumics_revoke_tokens is absent unless LUMICS_ENABLE_TOKEN_REVOCATION is set', async () => {
    const off = await connect(makeConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    const on = await connect(
      makeConfig({ features: { batchUpdate: false, tokenRevocation: true } }),
      {
        clientOptions: { fetchImpl: stubFetch().fetchImpl },
      },
    );
    try {
      expect(off.tool('lumics_revoke_tokens')).toBeUndefined();
      expect(on.tool('lumics_revoke_tokens')).toBeDefined();
    } finally {
      await off.close();
      await on.close();
    }
  });

  it('one flag does not enable the other', async () => {
    const harness = await connect(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: false } }),
      { clientOptions: { fetchImpl: stubFetch().fetchImpl } },
    );
    try {
      expect(harness.tool('lumics_batch_update_devices')).toBeDefined();
      expect(harness.tool('lumics_revoke_tokens')).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it.each(['lumics_batch_update_devices', 'lumics_revoke_tokens'])(
    'calling the ungated %s issues no HTTP request at all',
    async (name) => {
      const fetcher = stubFetch();
      const harness = await connect(makeConfig(), {
        clientOptions: { fetchImpl: fetcher.fetchImpl },
      });
      try {
        const called = await harness.call(name, { confirm: true, deviceIds: [TEST_DEVICE_ID] });
        expect(called.isError).toBe(true);
        expect(fetcher.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it('the tools the flags gate are the only flagged tools, so nothing else can be default-enabled by accident', () => {
    expect(
      allToolDefinitions()
        .filter((definition) => definition.featureFlag !== undefined)
        .map((definition) => `${definition.name}:${String(definition.featureFlag)}`),
    ).toEqual(['lumics_batch_update_devices:batchUpdate', 'lumics_revoke_tokens:tokenRevocation']);
  });
});

describe('every destructive or admin tool requires confirm in its JSON Schema', () => {
  it('declares confirm as a required property with const true', async () => {
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    try {
      for (const { name } of CONFIRMING_TOOLS) {
        const tool = harness.tool(name);
        expect(tool, `${name} is not registered`).toBeDefined();

        const schema = tool?.inputSchema as {
          required?: string[];
          properties?: Record<string, { const?: unknown; type?: string }>;
        };
        expect(schema.required, `${name} must require confirm`).toContain('confirm');
        // `const: true` means `confirm: false` is a schema violation, not a value
        // the handler has to interpret.
        expect(schema.properties?.confirm?.const).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it('no read, create or update tool declares confirm', async () => {
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    try {
      const confirming = new Set(CONFIRMING_TOOLS.map((entry) => entry.name));
      for (const tool of harness.tools) {
        if (confirming.has(tool.name)) {
          continue;
        }
        const schema = tool.inputSchema as { properties?: Record<string, unknown> };
        expect(
          Object.hasOwn(schema.properties ?? {}, 'confirm'),
          `${tool.name} should not declare confirm`,
        ).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it('the set of confirming tools matches the set classified admin or destructive', () => {
    expect(
      allToolDefinitions()
        .filter(
          (definition) =>
            definition.operation === 'admin' || definition.operation === 'destructive',
        )
        .map((definition) => definition.name)
        .sort(),
    ).toEqual([...CONFIRMING_TOOLS.map((entry) => entry.name)].sort());
  });
});

describe('a call without confirm fails BEFORE any HTTP request is attempted', () => {
  it.each(CONFIRMING_TOOLS.map((entry) => [entry.name, entry] as const))(
    '%s refuses when confirm is omitted, and issues no request',
    async (_name, entry: (typeof CONFIRMING_TOOLS)[number]) => {
      const fetcher = stubFetch();
      const harness = await connect(permissiveConfig(), {
        clientOptions: { fetchImpl: fetcher.fetchImpl },
      });
      try {
        const called = await harness.call(entry.name, entry.args);
        expect(called.isError).toBe(true);
        // The whole point: nothing left the process.
        expect(fetcher.calls, `${entry.name} issued a request without confirm`).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it.each(CONFIRMING_TOOLS.map((entry) => [entry.name, entry] as const))(
    '%s refuses when confirm is false, and issues no request',
    async (_name, entry: (typeof CONFIRMING_TOOLS)[number]) => {
      const fetcher = stubFetch();
      const harness = await connect(permissiveConfig(), {
        clientOptions: { fetchImpl: fetcher.fetchImpl },
      });
      try {
        const called = await harness.call(entry.name, { ...entry.args, confirm: false });
        expect(called.isError).toBe(true);
        expect(fetcher.calls).toHaveLength(0);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ['the string "true"', 'true'],
    ['1', 1],
    ['null', null],
  ])('rejects a confirm of %s as not being exactly true', async (_label, value) => {
    const fetcher = stubFetch();
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      const called = await harness.call('lumics_delete_device', {
        deviceId: TEST_DEVICE_ID,
        confirm: value,
      });
      expect(called.isError).toBe(true);
      expect(fetcher.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('proceeds when confirm is exactly true', async () => {
    const fetcher = stubFetch();
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      const called = await harness.call('lumics_delete_device', {
        deviceId: TEST_DEVICE_ID,
        confirm: true,
      });
      expect(called.isError).toBeUndefined();
      expect(fetcher.calls).toHaveLength(1);
      expect(fetcher.only().method).toBe('DELETE');
    } finally {
      await harness.close();
    }
  });
});

describe('descriptions state the impact, as Article IX requires', () => {
  it('every confirming tool says what it changes and that it needs confirm', async () => {
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    try {
      for (const { name } of CONFIRMING_TOOLS) {
        const description = harness.tool(name)?.description ?? '';
        expect(description, `${name} does not mention confirm`).toContain('confirm: true');
        expect(description, `${name} does not warn about the live tenant`).toMatch(
          /live Lumics tenant/,
        );
      }
    } finally {
      await harness.close();
    }
  });

  it('token revocation says it revokes the credential this server is using', async () => {
    const harness = await connect(permissiveConfig(), {
      clientOptions: { fetchImpl: stubFetch().fetchImpl },
    });
    try {
      const description = harness.tool('lumics_revoke_tokens')?.description ?? '';
      expect(description).toMatch(/every JWT token ever issued/i);
      expect(description).toMatch(/includes the token this server is currently using/i);
      expect(description).toMatch(/no way to revoke a single token/i);
      expect(description).toMatch(/no undo/i);
    } finally {
      await harness.close();
    }
  });

  it('the token-minting endpoints of spec section 11.2 and 11.3 are not exposed as tools', () => {
    // Both return live credential material in the response body; exposing either
    // would put a credential into a conversation transcript by design.
    const names = allToolDefinitions().map((definition) => definition.name);
    for (const name of names) {
      expect(name).not.toMatch(/create_token|get_token|mint_token|issue_token/);
    }
    expect(names).not.toContain('lumics_get_me_token');
  });
});
