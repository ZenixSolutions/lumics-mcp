/**
 * The tool factory — `src/tools/factory.ts`.
 *
 * Everything cross-cutting lives here once: annotations derived from the
 * operation classification, the `confirm` guard, the read-only defence in depth,
 * error mapping, output shaping, and registration gating. A defect in this file
 * is a defect in all 37 tools at once, which is why it gets its own file.
 *
 * The `defineTool` cases go through `registerOne`, which hands back the raw
 * handler. That deliberately bypasses the MCP SDK's argument validation, so the
 * factory's own guards are what is under test rather than zod's.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LumicsClient } from '../../src/api/client.js';
import { LumicsApiError, LumicsInputError } from '../../src/api/errors.js';
import {
  annotationsFor,
  createToolContext,
  defineTool,
  registerTools,
  requiresConfirmation,
  result,
  type LumicsToolDefinition,
  type ToolContext,
  type ToolOperation,
} from '../../src/tools/factory.js';
import { companyIdSchema, isObjectId, objectIdSchema } from '../../src/tools/schemas.js';
import { makeConfig, TEST_COMPANY_ID } from '../helpers/config.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';
import { firstText, recordingServer, registerOne } from '../helpers/mcp.js';
import type { LumicsConfig } from '../../src/config.js';

const ALL_OPERATIONS: readonly ToolOperation[] = [
  'read',
  'create',
  'update',
  'admin',
  'destructive',
];

function makeContext(config: LumicsConfig = makeConfig()): {
  context: ToolContext;
  calls: ReturnType<typeof recordFetch>['calls'];
} {
  const fetcher = recordFetch(jsonResponse({ ok: true }));
  const client = new LumicsClient(config, { fetchImpl: fetcher.fetchImpl });
  return { context: createToolContext(client, config), calls: fetcher.calls };
}

describe('annotationsFor derives every annotation from the classification', () => {
  it.each([
    ['read', { readOnlyHint: true, destructiveHint: false, idempotentHint: true }],
    ['create', { readOnlyHint: false, destructiveHint: false, idempotentHint: false }],
    ['update', { readOnlyHint: false, destructiveHint: false, idempotentHint: true }],
    ['admin', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
    ['destructive', { readOnlyHint: false, destructiveHint: true, idempotentHint: false }],
  ] as const)('%s', (operation, expected) => {
    expect(annotationsFor(operation, 'Title')).toEqual({
      title: 'Title',
      openWorldHint: true,
      ...expected,
    });
  });

  it('marks every operation openWorld, because every tool talks to a live tenant', () => {
    for (const operation of ALL_OPERATIONS) {
      expect(annotationsFor(operation, 'T').openWorldHint).toBe(true);
    }
  });

  it('never marks a non-read operation readOnly — the prototype did', () => {
    for (const operation of ALL_OPERATIONS.filter((candidate) => candidate !== 'read')) {
      expect(annotationsFor(operation, 'T').readOnlyHint).toBe(false);
    }
  });
});

describe('requiresConfirmation', () => {
  it.each([
    ['read', false],
    ['create', false],
    ['update', false],
    ['admin', true],
    ['destructive', true],
  ] as const)('%s requires confirmation: %s', (operation, expected) => {
    expect(requiresConfirmation(operation)).toBe(expected);
  });
});

describe('result()', () => {
  it('carries the data and every optional disclosure field', () => {
    expect(result([1], { requestedLimit: 5, fields: ['id'], notes: ['n'] })).toEqual({
      data: [1],
      requestedLimit: 5,
      fields: ['id'],
      notes: ['n'],
    });
  });

  it('defaults to data only, with no requestedLimit invented', () => {
    expect(result({ id: 'a' })).toEqual({ data: { id: 'a' } });
    expect(Object.hasOwn(result({ id: 'a' }), 'requestedLimit')).toBe(false);
  });
});

describe('createToolContext resolveCompanyId', () => {
  it('accepts an explicit id equal to the configured one', () => {
    const { context } = makeContext();
    expect(context.resolveCompanyId(TEST_COMPANY_ID)).toBe(TEST_COMPANY_ID);
  });

  /**
   * Finding H5, second half. `resolveCompanyId` accepted any 24-hex id and
   * validated only that it was non-empty, so on an MSP token a model could call
   * `lumics_delete_ipsubnet {companyId: <other tenant>}` and succeed against a
   * company nobody configured and nobody named in the approval prompt.
   */
  it('refuses an explicit companyId that is not the configured company', () => {
    const other = 'a'.repeat(24);
    const { context } = makeContext();

    expect(() => context.resolveCompanyId(other)).toThrow(LumicsInputError);
    expect(() => context.resolveCompanyId(other)).toThrow(/LUMICS_ALLOW_CROSS_COMPANY/);
    // The refusal names both companies so the model can explain what happened.
    expect(() => context.resolveCompanyId(other)).toThrow(new RegExp(other));
    expect(() => context.resolveCompanyId(other)).toThrow(new RegExp(TEST_COMPANY_ID));
    // Classified as an operator-set prohibition, not a bad argument to retry.
    try {
      context.resolveCompanyId(other);
      throw new Error('expected a refusal');
    } catch (thrown) {
      expect((thrown as LumicsInputError).code).toBe('not_permitted');
    }
  });

  it('honours a different companyId only once the operator sets the flag', () => {
    const other = 'a'.repeat(24);
    const { context } = makeContext(makeConfig({ allowCrossCompany: true }));
    expect(context.resolveCompanyId(other)).toBe(other);
  });

  it('accepts any explicit companyId when no company is configured, which is the bootstrap case', () => {
    const other = 'a'.repeat(24);
    const { context } = makeContext(makeConfig({ companyId: '' }));
    expect(context.resolveCompanyId(other)).toBe(other);
  });

  it('falls back to LUMICS_COMPANY_ID', () => {
    const { context } = makeContext();
    expect(context.resolveCompanyId()).toBe(TEST_COMPANY_ID);
  });

  it('fails with actionable advice when neither is available', () => {
    const { context } = makeContext(makeConfig({ companyId: '' }));
    expect(() => context.resolveCompanyId()).toThrow(LumicsInputError);
    expect(() => context.resolveCompanyId()).toThrow(/lumics_get_me/);
    expect(() => context.resolveCompanyId()).toThrow(/LUMICS_COMPANY_ID/);
    // And it tells the operator what to do: set the variable and restart.
    expect(() => context.resolveCompanyId()).toThrow(/restart/);
  });
});

describe('defineTool: schema and description assembly', () => {
  const base = {
    name: 'lumics_test',
    title: 'Test',
    description: 'Does a thing.',
    inputSchema: { value: z.string() },
    handler: () => Promise.resolve(result({ ok: true })),
  } as const;

  it('injects confirm into the schema of an admin or destructive tool', () => {
    for (const operation of ['admin', 'destructive'] as const) {
      const { context } = makeContext();
      const registered = registerOne(defineTool({ ...base, operation }), context);
      expect(Object.keys(registered.config.inputSchema as object)).toContain('confirm');
    }
  });

  it('does not inject confirm into a read, create or update tool', () => {
    for (const operation of ['read', 'create', 'update'] as const) {
      const { context } = makeContext();
      const registered = registerOne(defineTool({ ...base, operation }), context);
      expect(Object.keys(registered.config.inputSchema as object)).not.toContain('confirm');
    }
  });

  it('does not mutate the declared inputSchema when injecting confirm', () => {
    const declared = { value: z.string() };
    const { context } = makeContext();
    registerOne(defineTool({ ...base, operation: 'destructive', inputSchema: declared }), context);
    expect(Object.keys(declared)).toEqual(['value']);
  });

  it('appends the confirmation caveat to an admin description', () => {
    const { context } = makeContext();
    const registered = registerOne(defineTool({ ...base, operation: 'admin' }), context);
    expect(registered.config.description).toContain('Does a thing.');
    expect(registered.config.description).toContain('requires confirm: true');
    expect(registered.config.description).toMatch(/classified as admin/);
  });

  /**
   * Finding H5. This warning used to end "(company <LUMICS_COMPANY_ID>)" — a fixed
   * string decided at registration time, while the company actually written to is
   * decided per call by an optional `companyId` argument. On an MSP token the
   * description therefore named company A while the write landed in company B, and
   * because clients render descriptions in their approval prompts, the misstatement
   * reached the human being asked to approve it.
   */
  it('warns about live writes WITHOUT asserting a company it cannot guarantee', () => {
    for (const operation of ['create', 'update', 'admin', 'destructive'] as const) {
      const { context } = makeContext();
      const registered = registerOne(defineTool({ ...base, operation }), context);
      const description = registered.config.description ?? '';

      expect(description).toContain('cannot be undone by this server');
      // No company id anywhere in the description, in any form.
      expect(description).not.toContain(TEST_COMPANY_ID);
      expect(description).not.toMatch(/company [0-9a-fA-F]{24}/);
      // It states the rule instead: configured by default, overridable per call.
      expect(description).toContain('LUMICS_COMPANY_ID');
      expect(description).toContain('companyId');
      expect(description).toMatch(/overrides/);
    }
  });

  it('says so plainly when the operator has enabled cross-company writes', () => {
    const { context } = makeContext(makeConfig({ allowCrossCompany: true }));
    const registered = registerOne(defineTool({ ...base, operation: 'update' }), context);
    expect(registered.config.description).toContain('LUMICS_ALLOW_CROSS_COMPANY');
    expect(registered.config.description).toMatch(/WILL be honoured/);

    const { context: pinned } = makeContext();
    const pinnedTool = registerOne(defineTool({ ...base, operation: 'update' }), pinned);
    expect(pinnedTool.config.description).not.toContain('LUMICS_ALLOW_CROSS_COMPANY');
  });

  it('leaves a read description free of write warnings', () => {
    const { context } = makeContext();
    const registered = registerOne(defineTool({ ...base, operation: 'read' }), context);
    expect(registered.config.description).toBe('Does a thing.');
  });

  it('puts the tool purpose first, so a client tool picker shows it first', () => {
    const { context } = makeContext();
    const registered = registerOne(defineTool({ ...base, operation: 'destructive' }), context);
    expect(registered.config.description?.startsWith('Does a thing.')).toBe(true);
  });
});

describe('defineTool: the confirm guard', () => {
  const destructive = defineTool({
    name: 'lumics_test_delete',
    title: 'Delete',
    description: 'Deletes.',
    operation: 'destructive',
    inputSchema: {},
    async handler(_args, context) {
      await context.client.delete('/devices/x');
      return result({ deleted: true });
    },
  });

  it.each([
    ['omitted', {}],
    ['false', { confirm: false }],
    ['the string "true"', { confirm: 'true' }],
    ['1', { confirm: 1 }],
    ['null', { confirm: null }],
  ])('refuses when confirm is %s, before any HTTP request is attempted', async (_label, args) => {
    const { context, calls } = makeContext();
    const registered = registerOne(destructive, context);

    const called = await registered.handler(args);
    expect(called.isError).toBe(true);
    expect(firstText(called)).toContain('not_permitted');
    expect(firstText(called)).toContain('will not run without confirm: true');
    // The gate must be checked before the request, not after.
    expect(calls).toHaveLength(0);
  });

  it('proceeds when confirm is exactly true, and strips it from the handler arguments', async () => {
    const seen: unknown[] = [];
    const tool = defineTool({
      name: 'lumics_test_confirm',
      title: 'T',
      description: 'd',
      operation: 'admin',
      inputSchema: { value: z.string() },
      handler: (args) => {
        seen.push(args);
        return Promise.resolve(result({ ok: true }));
      },
    });
    const { context } = makeContext();
    const registered = registerOne(tool, context);

    const called = await registered.handler({ confirm: true, value: 'x' });
    expect(called.isError).toBeUndefined();
    // `confirm` is the factory's concern; the handler must never see it.
    expect(seen).toEqual([{ value: 'x' }]);
  });

  it('never asks a read tool for confirmation', async () => {
    const tool = defineTool({
      name: 'lumics_test_read',
      title: 'T',
      description: 'd',
      operation: 'read',
      inputSchema: {},
      handler: () => Promise.resolve(result({ ok: true })),
    });
    const { context } = makeContext();
    const called = await registerOne(tool, context).handler({});
    expect(called.isError).toBeUndefined();
  });
});

describe('defineTool: LUMICS_READ_ONLY defence in depth', () => {
  it.each(['create', 'update', 'admin', 'destructive'] as const)(
    'refuses a %s tool at call time even if registration somehow let it through',
    async (operation) => {
      const tool = defineTool({
        name: 'lumics_test_write',
        title: 'T',
        description: 'd',
        operation,
        inputSchema: {},
        async handler(_args, context) {
          await context.client.post('/devices', { body: {} });
          return result({ ok: true });
        },
      });
      const { context, calls } = makeContext(makeConfig({ readOnly: true }));
      // Bypass `registerTools`' filter deliberately: this asserts the second layer.
      const called = await registerOne(tool, context).handler({ confirm: true });

      expect(called.isError).toBe(true);
      expect(firstText(called)).toContain('not_permitted');
      expect(firstText(called)).toContain('LUMICS_READ_ONLY');
      expect(firstText(called)).toMatch(/cannot be overridden from here/);
      expect(calls).toHaveLength(0);
    },
  );

  it('still allows a read tool under LUMICS_READ_ONLY', async () => {
    const tool = defineTool({
      name: 'lumics_test_read',
      title: 'T',
      description: 'd',
      operation: 'read',
      inputSchema: {},
      handler: () => Promise.resolve(result({ ok: true })),
    });
    const { context } = makeContext(makeConfig({ readOnly: true }));
    const called = await registerOne(tool, context).handler({});
    expect(called.isError).toBeUndefined();
  });
});

describe('defineTool: output and error shaping', () => {
  function toolReturning(output: Parameters<typeof result>[0], extra = {}): LumicsToolDefinition {
    return defineTool({
      name: 'lumics_test_out',
      title: 'T',
      description: 'd',
      operation: 'read',
      inputSchema: {},
      handler: () => Promise.resolve(result(output, extra)),
    });
  }

  it('returns exactly one text block and no structuredContent (RFC-001 D5 item 8)', async () => {
    const { context } = makeContext();
    const called = await registerOne(toolReturning([{ id: 'a' }]), context).handler({});
    expect(called.content).toHaveLength(1);
    expect(called.content[0]?.type).toBe('text');
    expect(called.structuredContent).toBeUndefined();
  });

  it('never double-serialises: the text is the JSON, not a JSON string of a JSON string', async () => {
    const { context } = makeContext();
    const text = firstText(await registerOne(toolReturning([{ id: 'a' }]), context).handler({}));
    expect(text).toBe('[{"id":"a"}]');
    expect(text.startsWith('"')).toBe(false);
  });

  it('passes requestedLimit through so the completeness disclosure can fire', async () => {
    const { context } = makeContext();
    const tool = toolReturning([{ id: 1 }, { id: 2 }], { requestedLimit: 2 });
    const text = firstText(await registerOne(tool, context).handler({}));
    expect(text).toContain('NOTE ON COMPLETENESS:');
  });

  it('applies the field projection the handler asked for', async () => {
    const { context } = makeContext();
    const tool = toolReturning([{ id: 1, drop: 2 }], { fields: ['id'] });
    expect(firstText(await registerOne(tool, context).handler({}))).toBe('[{"id":1}]');
  });

  it('honours LUMICS_MAX_OUTPUT_CHARS and discloses the truncation', async () => {
    const { context } = makeContext(makeConfig({ maxOutputChars: 1_000 }));
    const items = Array.from({ length: 100 }, (_unused, index) => ({
      id: index,
      blob: 'x'.repeat(100),
    }));
    const text = firstText(await registerOne(toolReturning(items), context).handler({}));
    expect(text).toContain('NOTE ON TRUNCATION:');
    expect(text).toContain('items were dropped');
  });

  it('maps a LumicsApiError from the handler to an isError result with its code', async () => {
    const tool = defineTool({
      name: 'lumics_test_fail',
      title: 'T',
      description: 'd',
      operation: 'read',
      inputSchema: {},
      handler: () =>
        Promise.reject(LumicsApiError.fromStatus(404, { operation: 'GET /devices/x' })),
    });
    const { context } = makeContext();
    const called = await registerOne(tool, context).handler({});
    expect(called.isError).toBe(true);
    expect(firstText(called)).toMatch(/^not_found: /);
    expect(firstText(called)).toContain('404');
  });

  it('maps an unexpected throw to unknown_error rather than crashing the server', async () => {
    const tool = defineTool({
      name: 'lumics_test_boom',
      title: 'T',
      description: 'd',
      operation: 'read',
      inputSchema: {},
      handler: () => {
        throw new TypeError('undefined is not a function');
      },
    });
    const { context } = makeContext();
    const called = await registerOne(tool, context).handler({});
    expect(called.isError).toBe(true);
    expect(firstText(called)).toMatch(/^unknown_error: /);
    expect(firstText(called)).toContain('defect in lumics-mcp');
  });

  it('treats a null argument object as empty rather than throwing', async () => {
    const { context } = makeContext();
    const called = await registerOne(toolReturning({ ok: true }), context).handler(null);
    expect(called.isError).toBeUndefined();
  });
});

describe('registerTools gating', () => {
  function tool(
    name: string,
    operation: ToolOperation,
    featureFlag?: 'batchUpdate' | 'tokenRevocation',
  ): LumicsToolDefinition {
    return defineTool({
      name,
      title: name,
      description: 'd',
      operation,
      inputSchema: {},
      ...(featureFlag === undefined ? {} : { featureFlag }),
      handler: () => Promise.resolve(result({ ok: true })),
    });
  }

  const definitions = [
    tool('lumics_a_read', 'read'),
    tool('lumics_b_create', 'create'),
    tool('lumics_c_update', 'update'),
    tool('lumics_d_destructive', 'destructive'),
    tool('lumics_e_batch', 'admin', 'batchUpdate'),
    tool('lumics_f_revoke', 'admin', 'tokenRevocation'),
  ];

  it('registers everything a permissive config allows', () => {
    const { server, tools } = recordingServer();
    const { context } = makeContext(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: true } }),
    );
    const summary = registerTools(server, context, definitions);

    expect(summary.registered).toHaveLength(6);
    expect(summary.skippedReadOnly).toEqual([]);
    expect(summary.skippedFeatureFlag).toEqual([]);
    expect(tools.map((entry) => entry.name)).toEqual(summary.registered);
  });

  it('skips flagged tools by default and reports which', () => {
    const { server, tools } = recordingServer();
    const { context } = makeContext();
    const summary = registerTools(server, context, definitions);

    expect(summary.skippedFeatureFlag).toEqual(['lumics_e_batch', 'lumics_f_revoke']);
    expect(tools.map((entry) => entry.name)).not.toContain('lumics_e_batch');
    expect(tools.map((entry) => entry.name)).not.toContain('lumics_f_revoke');
  });

  it('gates each flag independently', () => {
    const { server } = recordingServer();
    const { context } = makeContext(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: false } }),
    );
    const summary = registerTools(server, context, definitions);
    expect(summary.registered).toContain('lumics_e_batch');
    expect(summary.skippedFeatureFlag).toEqual(['lumics_f_revoke']);
  });

  it('under LUMICS_READ_ONLY registers only read tools, and never calls register on the rest', () => {
    const { server, tools } = recordingServer();
    const { context } = makeContext(
      makeConfig({ readOnly: true, features: { batchUpdate: true, tokenRevocation: true } }),
    );
    const summary = registerTools(server, context, definitions);

    expect(summary.registered).toEqual(['lumics_a_read']);
    expect(summary.skippedReadOnly).toEqual([
      'lumics_b_create',
      'lumics_c_update',
      'lumics_d_destructive',
      'lumics_e_batch',
      'lumics_f_revoke',
    ]);
    // Registration-time filtering, not a runtime refusal: the tool never exists.
    expect(tools).toHaveLength(1);
  });

  it('rejects a duplicate tool name rather than letting one shadow the other', () => {
    const { server } = recordingServer();
    const { context } = makeContext();
    expect(() =>
      registerTools(server, context, [tool('lumics_dup', 'read'), tool('lumics_dup', 'update')]),
    ).toThrow(/Duplicate tool name "lumics_dup"/);
  });

  it('detects a duplicate even when read-only skipping is in play', () => {
    const { server } = recordingServer();
    const { context } = makeContext(makeConfig({ readOnly: true }));
    expect(() =>
      registerTools(server, context, [tool('lumics_dup', 'update'), tool('lumics_dup', 'update')]),
    ).toThrow(/Duplicate tool name/);
  });

  /**
   * Finding H6. With `LUMICS_COMPANY_ID` optional, a company-scoped tool has
   * nothing to scope to, so it is withheld from the tool LIST rather than left to
   * fail on every call — the same registration-time filtering `LUMICS_READ_ONLY`
   * uses, for the same reason: a tool the model cannot see is a tool it cannot
   * spend a turn discovering is unusable.
   */
  describe('when LUMICS_COMPANY_ID is not set', () => {
    function companyScopedTool(name: string): LumicsToolDefinition {
      return defineTool({
        name,
        title: name,
        description: 'd',
        operation: 'read',
        inputSchema: { companyId: companyIdSchema },
        handler: () => Promise.resolve(result({ ok: true })),
      });
    }

    it('derives requiresCompany from the presence of a companyId argument', () => {
      expect(companyScopedTool('lumics_scoped').requiresCompany).toBe(true);
      expect(tool('lumics_unscoped', 'read').requiresCompany).toBe(false);
    });

    it('honours an explicit requiresCompany override', () => {
      const explicit = defineTool({
        name: 'lumics_explicit',
        title: 'T',
        description: 'd',
        operation: 'read',
        inputSchema: {},
        requiresCompany: true,
        handler: () => Promise.resolve(result({ ok: true })),
      });
      expect(explicit.requiresCompany).toBe(true);
    });

    it('withholds company-scoped tools and keeps the rest', () => {
      const { server, tools } = recordingServer();
      const { context } = makeContext(makeConfig({ companyId: '' }));
      const summary = registerTools(server, context, [
        companyScopedTool('lumics_list_things'),
        tool('lumics_get_me', 'read'),
      ]);

      expect(summary.registered).toEqual(['lumics_get_me']);
      expect(summary.skippedNoCompany).toEqual(['lumics_list_things']);
      expect(tools.map((registered) => registered.name)).toEqual(['lumics_get_me']);
    });

    it('registers company-scoped tools again as soon as a company is configured', () => {
      const { server } = recordingServer();
      const { context } = makeContext();
      const summary = registerTools(server, context, [companyScopedTool('lumics_list_things')]);
      expect(summary.registered).toEqual(['lumics_list_things']);
      expect(summary.skippedNoCompany).toEqual([]);
    });
  });

  it('handles an empty definition list', () => {
    const { server } = recordingServer();
    const { context } = makeContext();
    expect(registerTools(server, context, [])).toEqual({
      registered: [],
      skippedReadOnly: [],
      skippedFeatureFlag: [],
      skippedNoCompany: [],
    });
  });
});

describe('isObjectId (src/tools/schemas.ts)', () => {
  it.each([
    ['24 lowercase hex', '5628b8174b6cf000001bf163', true],
    ['24 uppercase hex', '5628B8174B6CF000001BF163', true],
    ['24 zeros', '0'.repeat(24), true],
    ['23 characters', '0'.repeat(23), false],
    ['25 characters', '0'.repeat(25), false],
    ['non-hex characters', 'z'.repeat(24), false],
    ['a name', 'core-sw-01', false],
    ['an IP address', '10.20.30.40', false],
    ['a traversal attempt', '../../me/token', false],
    ['empty', '', false],
    ['leading whitespace', ` ${'0'.repeat(24)}`, false],
  ])('%s -> %s', (_label, value, expected) => {
    expect(isObjectId(value)).toBe(expected);
  });

  it('agrees with the zod schema used on every tool argument', () => {
    for (const value of ['5628b8174b6cf000001bf163', 'nope', '0'.repeat(24), '0'.repeat(23)]) {
      expect(isObjectId(value)).toBe(objectIdSchema.safeParse(value).success);
    }
  });
});
