/**
 * SECURITY CONTROL: `LUMICS_READ_ONLY=1` filters at REGISTRATION time.
 *
 * The distinction matters and is the whole point of the control. A tool that is
 * absent from `tools/list` is a tool the model cannot be talked into trying; a
 * tool that is present but refuses is a negotiation. RFC-001 D6 and CLAUDE.md
 * both require the former, so every assertion here goes through a real
 * `tools/list` over an in-memory transport rather than inspecting the definition
 * arrays.
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '../../src/server.js';
import { makeConfig } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';

const READ_ONLY_TOOL_COUNT = 20;
const DEFAULT_TOOL_COUNT = 37;

/** All 39 declared tools; two are behind feature flags. */
const DECLARED_TOOL_COUNT = 39;

function harnessOptions() {
  return { clientOptions: { fetchImpl: recordFetch(jsonResponse([])).fetchImpl } };
}

describe('LUMICS_READ_ONLY registration filtering', () => {
  it('registers exactly the 20 read tools and nothing else', async () => {
    const harness = await connect(makeConfig({ readOnly: true }), harnessOptions());
    try {
      expect(harness.tools).toHaveLength(READ_ONLY_TOOL_COUNT);
    } finally {
      await harness.close();
    }
  });

  it('registers 37 tools by default, so read-only really does remove 17', async () => {
    const harness = await connect(makeConfig(), harnessOptions());
    try {
      expect(harness.tools).toHaveLength(DEFAULT_TOOL_COUNT);
    } finally {
      await harness.close();
    }
  });

  it('leaves no tool without readOnlyHint in the read-only tool list', async () => {
    const harness = await connect(makeConfig({ readOnly: true }), harnessOptions());
    try {
      for (const tool of harness.tools) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} survived the read-only filter`).toBe(
          true,
        );
        expect(tool.annotations?.destructiveHint, `${tool.name} is marked destructive`).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it('removes every non-read tool the default configuration exposes', async () => {
    const permissive = await connect(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: true } }),
      harnessOptions(),
    );
    const restricted = await connect(
      makeConfig({ readOnly: true, features: { batchUpdate: true, tokenRevocation: true } }),
      harnessOptions(),
    );

    try {
      const writeTools = permissive.tools
        .filter((tool) => tool.annotations?.readOnlyHint !== true)
        .map((tool) => tool.name);
      // Sanity: there really are write tools to remove.
      expect(writeTools.length).toBe(DECLARED_TOOL_COUNT - READ_ONLY_TOOL_COUNT);

      const visible = new Set(restricted.tools.map((tool) => tool.name));
      for (const name of writeTools) {
        expect(
          visible.has(name),
          `${name} must be absent from tools/list under LUMICS_READ_ONLY`,
        ).toBe(false);
      }
    } finally {
      await permissive.close();
      await restricted.close();
    }
  });

  it('the read-only surface is absent, not merely refusing — calling it is an unknown tool', async () => {
    const fetcher = recordFetch(jsonResponse({ deleted: { id: 'x' } }));
    const harness = await connect(makeConfig({ readOnly: true }), {
      clientOptions: { fetchImpl: fetcher.fetchImpl },
    });
    try {
      expect(harness.tool('lumics_delete_device')).toBeUndefined();

      const called = await harness.call('lumics_delete_device', {
        deviceId: '1'.repeat(24),
        confirm: true,
      });
      expect(called.isError).toBe(true);
      // The protocol-level rejection wording differs by SDK version; what
      // matters is that no request was issued.
      expect(fetcher.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('feature flags cannot re-admit a write tool under read-only', async () => {
    const harness = await connect(
      makeConfig({ readOnly: true, features: { batchUpdate: true, tokenRevocation: true } }),
      harnessOptions(),
    );
    try {
      expect(harness.tool('lumics_batch_update_devices')).toBeUndefined();
      expect(harness.tool('lumics_revoke_tokens')).toBeUndefined();
      expect(harness.tools).toHaveLength(READ_ONLY_TOOL_COUNT);
    } finally {
      await harness.close();
    }
  });
});

describe('operation classification is complete and consistent', () => {
  it('every declared tool carries one of the five classifications', () => {
    const valid = new Set(['read', 'create', 'update', 'admin', 'destructive']);
    for (const definition of allToolDefinitions()) {
      expect(valid.has(definition.operation), `${definition.name} has no classification`).toBe(
        true,
      );
    }
  });

  it('declares 39 tools, of which exactly 2 are behind feature flags', () => {
    const definitions = allToolDefinitions();
    expect(definitions).toHaveLength(DECLARED_TOOL_COUNT);
    expect(
      definitions.filter((entry) => entry.featureFlag !== undefined).map((e) => e.name),
    ).toEqual(['lumics_batch_update_devices', 'lumics_revoke_tokens']);
  });

  it('exactly 20 declared tools are classified read', () => {
    expect(
      allToolDefinitions().filter((definition) => definition.operation === 'read'),
    ).toHaveLength(READ_ONLY_TOOL_COUNT);
  });

  it('every tool name carries the lumics_ prefix and is unique', () => {
    const names = allToolDefinitions().map((definition) => definition.name);
    for (const name of names) {
      expect(name).toMatch(/^lumics_[a-z0-9_]+$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('annotations in tools/list agree with the classification for every registered tool', async () => {
    const harness = await connect(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: true } }),
      harnessOptions(),
    );
    try {
      const byName = new Map(allToolDefinitions().map((entry) => [entry.name, entry.operation]));
      for (const tool of harness.tools) {
        const operation = byName.get(tool.name);
        expect(operation, `${tool.name} is not in allToolDefinitions()`).toBeDefined();
        expect(tool.annotations?.readOnlyHint).toBe(operation === 'read');
        expect(tool.annotations?.destructiveHint).toBe(
          operation === 'admin' || operation === 'destructive',
        );
        expect(tool.annotations?.openWorldHint).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });
});
