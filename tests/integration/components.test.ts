/**
 * Component tools — spec §6, all five endpoints.
 *
 * The specific risk in this module is the three endpoints that accept **no
 * `limit` at all** (spec §4.3). With no `limit` there is nothing to pass as
 * `requestedLimit`, so the factory's "you got exactly your limit, so more may
 * exist" disclosure cannot fire — and silence would read as completeness. Each of
 * those tools therefore has to emit its own no-limit disclosure, and must NOT set
 * `requestedLimit`. Both halves are asserted: the note is present, and no
 * completeness note appears even when the response is exactly as long as the
 * default limit would have been.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIST_LIMIT } from '../../src/constants.js';
import { TEST_COMPANY_ID, TEST_COMPONENT_ID } from '../helpers/config.js';
import {
  exchange,
  expectNoFabricatedPagination,
  expectNoFabricatedQueryParams,
  failingExchange,
} from '../helpers/tools.js';

const C = TEST_COMPANY_ID;
const TYPE = 'cisco_ast_devices';

const SAMPLE_COMPONENT = {
  _id: TEST_COMPONENT_ID,
  device: '1'.repeat(24),
  name: 'GigabitEthernet1/0/1',
  index: 1,
  isMonitored: true,
  __t: 'pingtcp.Port',
  __v: 0,
};
const SAMPLE_TYPE = { id: TYPE, module: 'cisco', group: 'ast', type: 'devices' };
const SAMPLE_DEFINITION = { filePath: '/defs/cisco.json', data: { modelName: 'CiscoAst' } };

/** The tools whose Lumics endpoint accepts no limit of any kind. */
const NO_LIMIT_TOOLS: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly response: unknown[];
  readonly endpoint: string;
}[] = [
  {
    tool: 'lumics_list_components',
    args: { componentType: TYPE },
    response: [SAMPLE_COMPONENT],
    endpoint: 'GET /companies/:companyId/component/:component/',
  },
  {
    tool: 'lumics_list_component_types',
    args: {},
    response: [SAMPLE_TYPE],
    endpoint: 'GET /companies/:companyId/componenttypes/',
  },
  {
    tool: 'lumics_get_device_definition_components',
    args: {},
    response: [SAMPLE_DEFINITION],
    endpoint: 'GET /system/deviceDefinitions/components',
  },
];

describe('endpoints with no limit emit their own completeness disclosure', () => {
  it.each(NO_LIMIT_TOOLS.map((entry) => [entry.tool, entry] as const))(
    '%s discloses that the endpoint accepts no limit or pagination parameter',
    async (_name, entry: (typeof NO_LIMIT_TOOLS)[number]) => {
      const { notes } = await exchange(entry.tool, entry.args, entry.response);
      expect(notes).toContain('NOTE ON COMPLETENESS:');
      expect(notes).toContain(entry.endpoint);
      expect(notes).toContain('accepts NO limit, offset, page, cursor or sort parameter at all');
      expect(notes).toContain('no mechanism to ask for more');
      expect(notes).toContain('what you see is what Lumics sent');
    },
  );

  it.each(NO_LIMIT_TOOLS.map((entry) => [entry.tool, entry] as const))(
    '%s sends no limit query parameter, because the endpoint has none',
    async (_name, entry: (typeof NO_LIMIT_TOOLS)[number]) => {
      const { call } = await exchange(entry.tool, entry.args, entry.response);
      expect(call.url.searchParams.has('limit')).toBe(false);
      expect(Object.keys(call.query)).toEqual([]);
      expectNoFabricatedQueryParams(call);
    },
  );

  it.each(NO_LIMIT_TOOLS.map((entry) => [entry.tool, entry] as const))(
    '%s declares no limit argument, so a model cannot be misled into passing one',
    async (_name, entry: (typeof NO_LIMIT_TOOLS)[number]) => {
      // Passing `limit` anyway must not reach the wire.
      const { call } = await exchange(entry.tool, { ...entry.args, limit: 10 }, entry.response);
      expect(call.url.searchParams.has('limit')).toBe(false);
    },
  );

  it.each(NO_LIMIT_TOOLS.map((entry) => [entry.tool, entry] as const))(
    '%s never sets requestedLimit, so the wrong disclosure cannot fire',
    async (_name, entry: (typeof NO_LIMIT_TOOLS)[number]) => {
      // Exactly as many records as the default limit would have allowed. If
      // `requestedLimit` were being set, the "equals the requested limit" note
      // would appear here — and it must not, because no limit was ever sent.
      const many = Array.from({ length: DEFAULT_LIST_LIMIT }, () => entry.response[0]);
      const { notes } = await exchange(entry.tool, entry.args, many);
      expect(notes).not.toContain('equals the requested limit');
      expect(notes).not.toContain('re-run with a higher limit');
    },
  );
});

describe('lumics_list_components (spec section 6.1)', () => {
  it('GETs the singular component path with its trailing slash preserved', async () => {
    const { call, payload } = await exchange('lumics_list_components', { componentType: TYPE }, [
      SAMPLE_COMPONENT,
    ]);
    expect(call.method).toBe('GET');
    expect(call.path).toBe(`/companies/${C}/component/${TYPE}/`);
    expect(call.url.pathname.endsWith('/')).toBe(true);
    expect(payload).toEqual([SAMPLE_COMPONENT]);
  });

  it('keeps the Mongoose _id, __t and __v fields rather than rewriting them', async () => {
    const { payload } = await exchange('lumics_list_components', { componentType: TYPE }, [
      SAMPLE_COMPONENT,
    ]);
    const first = (payload as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(first._id).toBe(TEST_COMPONENT_ID);
    expect(first.__t).toBe('pingtcp.Port');
    expect(first.__v).toBe(0);
    expect(Object.hasOwn(first, 'id')).toBe(false);
  });

  it('projects fields when asked, keeping the no-limit note', async () => {
    const { payload, notes } = await exchange(
      'lumics_list_components',
      { componentType: TYPE, fields: ['_id', 'name'] },
      [SAMPLE_COMPONENT],
    );
    expect(payload).toEqual([{ _id: TEST_COMPONENT_ID, name: 'GigabitEthernet1/0/1' }]);
    expect(notes).toContain('NOTE ON COMPLETENESS:');
  });

  it.each([
    ['an empty componentType', ''],
    ['a componentType over 128 characters', 'a'.repeat(129)],
  ])('rejects %s locally', async (_label, componentType) => {
    const { calls } = await failingExchange('lumics_list_components', { componentType });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a non-array body as documented drift', async () => {
    const { text } = await failingExchange(
      'lumics_list_components',
      { componentType: TYPE },
      { components: [] },
    );
    expect(text).toContain('bare JSON array was documented');
  });
});

describe('lumics_get_component (spec section 6.2)', () => {
  it('GETs the type and id as two encoded segments, with no query parameters', async () => {
    const { call, payload } = await exchange(
      'lumics_get_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID },
      SAMPLE_COMPONENT,
    );
    expect(call.path).toBe(`/companies/${C}/component/${TYPE}/${TEST_COMPONENT_ID}`);
    expect(Object.keys(call.query)).toEqual([]);
    expect(payload).toEqual(SAMPLE_COMPONENT);
  });

  it('carries no no-limit note, because a single read has nothing to truncate', async () => {
    const { notes } = await exchange(
      'lumics_get_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID },
      SAMPLE_COMPONENT,
    );
    expect(notes).toBe('');
  });

  it('rejects a component id that is not a 24-hex ObjectId', async () => {
    const { calls } = await failingExchange('lumics_get_component', {
      componentType: TYPE,
      componentId: 'GigabitEthernet1/0/1',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('lumics_update_component (spec section 6.3)', () => {
  it('PATCHes only name and company, the two fields the documented example sets', async () => {
    const { call, payload } = await exchange(
      'lumics_update_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID, name: 'uplink-to-core' },
      { updated: { ...SAMPLE_COMPONENT, name: 'uplink-to-core' } },
    );
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`/companies/${C}/component/${TYPE}/${TEST_COMPONENT_ID}`);
    expect(call.body).toEqual({ name: 'uplink-to-core', company: C });
    expect(payload).toMatchObject({ name: 'uplink-to-core' });
  });

  it('cannot re-parent, re-type or move a component between tenants', async () => {
    // The prototype exposed a free-form `changes` object here. Passing those keys
    // must have no effect on the body.
    const { call } = await exchange(
      'lumics_update_component',
      {
        componentType: TYPE,
        componentId: TEST_COMPONENT_ID,
        name: 'renamed',
        device: 'f'.repeat(24),
        __t: 'other.Type',
        isMonitored: false,
      },
      { updated: SAMPLE_COMPONENT },
    );
    expect(Object.keys(call.body as object).sort()).toEqual(['company', 'name']);
  });

  it('reads the updated id back through _id, which is what components carry', async () => {
    const { notes } = await exchange(
      'lumics_update_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID, name: 'renamed' },
      { updated: SAMPLE_COMPONENT },
    );
    expect(notes).toContain(`Component ${TEST_COMPONENT_ID} was renamed`);
    expect(notes).toContain('No other field was changed');
  });

  it('falls back to the requested id when the response carries none', async () => {
    const { notes } = await exchange(
      'lumics_update_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID, name: 'renamed' },
      { updated: { name: 'renamed' } },
    );
    expect(notes).toContain(`Component ${TEST_COMPONENT_ID} was renamed`);
  });

  it('requires a name: there is no other documented writable field', async () => {
    const { calls } = await failingExchange('lumics_update_component', {
      componentType: TYPE,
      componentId: TEST_COMPONENT_ID,
    });
    expect(calls).toHaveLength(0);
  });

  it('reports a missing updated envelope as drift', async () => {
    const { text } = await failingExchange(
      'lumics_update_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID, name: 'x' },
      SAMPLE_COMPONENT,
    );
    expect(text).toContain('"updated" envelope');
  });
});

describe('lumics_list_component_types (spec section 6.4)', () => {
  it('GETs the componenttypes path with its trailing slash and no component parameter', async () => {
    const { call, payload } = await exchange('lumics_list_component_types', {}, [SAMPLE_TYPE]);
    expect(call.path).toBe(`/companies/${C}/componenttypes/`);
    // spec §14 defect 2: the documented `component` path parameter does not exist
    // in the template, so nothing is appended.
    expect(call.path).not.toContain(TYPE);
    expect(payload).toEqual([SAMPLE_TYPE]);
  });
});

describe('lumics_get_device_definition_components (spec section 6.5)', () => {
  it('GETs the system-scoped path and takes no companyId at all', async () => {
    const { call } = await exchange('lumics_get_device_definition_components', {}, [
      SAMPLE_DEFINITION,
    ]);
    expect(call.path).toBe('/system/deviceDefinitions/components');
    expect(call.path).not.toContain('companies');
    expect(Object.keys(call.query)).toEqual([]);
  });

  it('ignores a companyId even if one is passed, since the route has no context', async () => {
    const { call } = await exchange(
      'lumics_get_device_definition_components',
      { companyId: 'a'.repeat(24) },
      [SAMPLE_DEFINITION],
    );
    expect(call.path).toBe('/system/deviceDefinitions/components');
  });
});

describe('no component tool ever fabricates pagination', () => {
  it.each([
    ['lumics_list_components', { componentType: TYPE }, [SAMPLE_COMPONENT]],
    [
      'lumics_get_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID },
      SAMPLE_COMPONENT,
    ],
    [
      'lumics_update_component',
      { componentType: TYPE, componentId: TEST_COMPONENT_ID, name: 'x' },
      { updated: SAMPLE_COMPONENT },
    ],
    ['lumics_list_component_types', {}, [SAMPLE_TYPE]],
    ['lumics_get_device_definition_components', {}, [SAMPLE_DEFINITION]],
  ])('%s', async (tool, args, response) => {
    const { text, call } = await exchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});
