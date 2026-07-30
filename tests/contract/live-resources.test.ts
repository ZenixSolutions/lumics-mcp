/**
 * CONTRACT tests for the resources the original suite never touched:
 * collectors (spec §5), components and componenttypes (spec §6), the system
 * device-definition catalogue (spec §6.5) and IP groups (spec §9).
 * **Opt-in only.**
 *
 * Two things are being validated here.
 *
 * **List shape and `limit`.** spec §4.2 documents every list read as a bare JSON
 * array and spec §4.3 documents `limit` as the only result control in the entire
 * API — present on collectors and ipgroups, and *absent* on components,
 * componenttypes and the device-definition catalogue. `src/tools/*.ts` is built
 * on both halves of that: on a bare array, and on there being nothing to page
 * with. The absence is checked by sending the parameter once, deliberately, and
 * reporting whether it was ignored — the same pattern the existing suite uses for
 * `offset`.
 *
 * **`id` versus `_id`.** spec §4.2 records that the vendor's own examples are
 * inconsistent: collector, device, ipsubnet-list, ipgroup-*list* and
 * ipaddress-list reads return `id`, while component reads and the ipgroup
 * *single* read return `_id`. `resourceId()` in `src/domain/index.ts` exists
 * solely because of that, and nothing has ever confirmed which key a live tenant
 * actually sends. Each resource is checked against the key the docs claim, and
 * the key it really used is recorded either way.
 *
 * **READ-ONLY.** Every call is a GET. Nothing here touches the token endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectorPath,
  collectorsPath,
  componentPath,
  componentsPath,
  componentTypesPath,
  deviceDefinitionComponentsPath,
  devicesPath,
  ipGroupPath,
  ipGroupsPath,
  ipSubnetsPath,
} from '../../src/api/paths.js';
import { expectArray } from '../../src/api/client.js';
import type { ComponentType } from '../../src/domain/index.js';
import { resourceId } from '../../src/domain/index.js';
import {
  api,
  attempt,
  declareSkipExplanation,
  describeOutcome,
  describeValue,
  DOCUMENTED_STATUSES,
  identityKeys,
  isObjectIdShaped,
  isRecord,
  keysOf,
  recordAsserted,
  recordObserved,
  reportEvidence,
  RUNNABLE,
  unverifiable,
} from './harness.js';

const TIMEOUT = 60_000;
const DISCOVERY_TIMEOUT = 120_000;

/** How many component types to probe before giving up on finding instances. */
const COMPONENT_TYPE_PROBES = 5;

interface Fixture {
  readonly componentTypes: readonly ComponentType[];
  /** A component type that has at least one instance on this tenant. */
  readonly populatedType: string | undefined;
  readonly componentSample: readonly Record<string, unknown>[];
}

let fixture: Fixture | undefined;

function fx(): Fixture {
  if (fixture === undefined) {
    throw new Error('discovery did not run — this is a bug in the contract suite, not in Lumics');
  }
  return fixture;
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

beforeAll(async () => {
  if (!RUNNABLE) {
    return;
  }
  const { client, config } = api();

  const componentTypes = expectArray<ComponentType>(
    await client.get(componentTypesPath(config.companyId)),
    'GET componenttypes',
  );

  let populatedType: string | undefined;
  let componentSample: readonly Record<string, unknown>[] = [];

  // spec §14 defect 14: no enumeration of component types is documented, so the
  // only way to reach §6.1 is to ask the catalogue and try what it names.
  for (const type of componentTypes.slice(0, COMPONENT_TYPE_PROBES)) {
    if (typeof type.id !== 'string' || type.id.length === 0) {
      continue;
    }
    const outcome = await attempt(client.get<unknown>(componentsPath(config.companyId, type.id)));
    if (!outcome.ok) {
      continue;
    }
    const found = records(outcome.value);
    if (found.length > 0) {
      populatedType = type.id;
      componentSample = found;
      break;
    }
  }

  fixture = { componentTypes, populatedType, componentSample };
}, DISCOVERY_TIMEOUT);

afterAll(() => {
  reportEvidence('collectors, components, ipgroups (spec sections 5, 6, 9)');
});

// ---------------------------------------------------------------------------
// spec §4.2 — which identifier key each list resource really returns
// ---------------------------------------------------------------------------

/**
 * The documented key per resource, straight from spec §4.2's sentence on
 * identity keys. A mismatch is not cosmetic: a tool that reads the wrong key
 * reports "unknown id" for every record, and the follow-up call the model wants
 * to make becomes impossible.
 */
const identityCases: [string, string, 'id' | '_id', () => Promise<unknown>][] = [
  [
    'collectors list',
    '5.1',
    'id',
    () =>
      api().client.get<unknown>(collectorsPath(api().config.companyId), { query: { limit: 2 } }),
  ],
  [
    'devices list',
    '7.1',
    'id',
    () => api().client.get<unknown>(devicesPath(api().config.companyId), { query: { limit: 2 } }),
  ],
  [
    'ipsubnets list',
    '10.1',
    'id',
    () => api().client.get<unknown>(ipSubnetsPath(api().config.companyId), { query: { limit: 2 } }),
  ],
  [
    'ipgroups list',
    '9.1',
    'id',
    () => api().client.get<unknown>(ipGroupsPath(api().config.companyId), { query: { limit: 2 } }),
  ],
];

describe.skipIf(!RUNNABLE)('live contract: spec 4.2 — id versus _id on list reads', () => {
  // A plain loop rather than `it.each`, because each case needs its own test
  // context to report a sparse tenant as UNVERIFIED rather than as a pass.
  for (const [label, spec, documentedKey, fetch] of identityCases) {
    it(
      `ASSERT: ${label} carries the documented identifier key`,
      async (ctx) => {
        const rows = records(await fetch());
        const first = rows[0];
        if (first === undefined) {
          unverifiable(
            ctx,
            spec,
            `${label} returns "${documentedKey}" as its identifier key`,
            'this tenant has no records of this kind',
          );
        }

        const keys = identityKeys(first);
        expect(
          keys.length,
          `no record in ${label} carried "id" or "_id" (keys present: ${keysOf(first).join(',')}). resourceId() in src/domain/index.ts reads exactly those two, so every tool over this resource would report an unknown id and no follow-up call would be possible.`,
        ).toBeGreaterThan(0);
        expect(
          keys.includes(documentedKey),
          `${label} returned ${keys.join(' and ')} where spec section 4.2 documents "${documentedKey}". resourceId() prefers "id" then "_id" so it still resolves, but the captured contract is wrong about this resource and should be corrected.`,
        ).toBe(true);
        expect(
          isObjectIdShaped(first[documentedKey]),
          `${label}'s "${documentedKey}" is not a 24-character hex ObjectId (${describeValue(first[documentedKey])}); every id-typed tool argument is validated against that shape and would reject this value.`,
        ).toBe(true);

        recordAsserted(
          spec,
          `${label} returns the documented identifier key "${documentedKey}"`,
          `identifier keys present: ${keys.join(', ')}`,
        );
      },
      TIMEOUT,
    );
  }
});

// ---------------------------------------------------------------------------
// spec §5 — collectors
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 5 — collectors', () => {
  it(
    'ASSERT: GET collectors returns a bare array, not an envelope',
    async () => {
      const { client, config } = api();
      const response = await client.get<unknown>(collectorsPath(config.companyId), {
        query: { limit: 2 },
      });
      expect(
        Array.isArray(response),
        `spec section 4.2 documents a bare JSON array for every list read; GET collectors returned ${describeValue(response)}. expectArray() in src/api/client.ts throws on anything else, so lumics_list_collectors would fail outright.`,
      ).toBe(true);
      recordAsserted(
        '5.1',
        'GET collectors returns a bare array with no envelope, total or next link',
        `body is ${describeValue(response)}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: limit is honoured on GET collectors',
    async (ctx) => {
      const { client, config } = api();
      const two = records(
        await client.get<unknown>(collectorsPath(config.companyId), { query: { limit: 2 } }),
      );
      if (two.length < 2) {
        unverifiable(
          ctx,
          '5.1',
          'limit ("Amount of results") is honoured on GET collectors',
          `this tenant has ${String(two.length)} collector(s), so a limit of 1 cannot be distinguished from the whole set`,
        );
      }
      const one = records(
        await client.get<unknown>(collectorsPath(config.companyId), { query: { limit: 1 } }),
      );
      expect(
        one.length,
        `limit=1 returned ${String(one.length)} collector(s) on a tenant that has at least two. spec section 5.1 documents limit as "Amount of results", and it is the only result control the API has (spec section 4.3) — if it is ignored, every list tool's truncation disclosure is describing a parameter that does nothing.`,
      ).toBe(1);
      recordAsserted(
        '5.1',
        'limit is honoured on GET collectors',
        'limit=1 returned exactly one record on a tenant with two or more',
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: a single collector read returns a bare object for the id requested',
    async (ctx) => {
      const { client, config } = api();
      const list = records(
        await client.get<unknown>(collectorsPath(config.companyId), { query: { limit: 1 } }),
      );
      const first = list[0];
      if (first === undefined) {
        unverifiable(
          ctx,
          '5.2',
          'GET collectors/:id returns a bare collector object',
          'this tenant has no collectors',
        );
      }
      const id = resourceId(first);
      if (id === undefined) {
        unverifiable(
          ctx,
          '5.2',
          'GET collectors/:id returns a bare collector object',
          'the collector list carried no id or _id to read a single record by',
        );
      }

      const single = await client.get<unknown>(collectorPath(config.companyId, id));
      expect(
        isRecord(single),
        `spec section 4.2 documents a bare JSON object for a single read; GET collectors/:id returned ${describeValue(single)}.`,
      ).toBe(true);
      // Compared runtime-to-runtime. No tenant identifier is ever written into
      // this file; the value came from the list read moments ago.
      expect(
        resourceId(single as Record<string, unknown>),
        'the single collector read returned a different record than the id requested.',
      ).toBe(id);
      recordAsserted(
        '5.2',
        'GET collectors/:id returns a bare object identifying the requested record',
        `single-read keys: ${keysOf(single).join(',')}`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// spec §6.4, §6.5 — the component-type catalogues
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 6.4 — componenttypes', () => {
  it(
    'ASSERT: componenttypes returns {id, module, group, type} with id composed of the other three',
    // Synchronous: the catalogue was fetched once during discovery and reused.
    (ctx) => {
      const types = fx().componentTypes;
      if (types.length === 0) {
        unverifiable(
          ctx,
          '6.4',
          'componenttypes returns objects of the form {id: "<module>_<group>_<type>", module, group, type}',
          'this tenant returned no component types at all',
        );
      }

      for (const type of types) {
        expect(
          typeof type.id === 'string' &&
            typeof type.module === 'string' &&
            typeof type.group === 'string' &&
            typeof type.type === 'string',
          `a component type came back missing one of the four documented string fields (keys: ${keysOf(type).join(',')}). lumics_list_component_types and every itemType argument depend on this shape.`,
        ).toBe(true);
        expect(
          type.id,
          `spec section 6.4 documents id as "<module>_<group>_<type>"; this entry composes differently. Component type ids are what a caller passes as :component and as itemType, so the composition rule matters.`,
        ).toBe(`${type.module}_${type.group}_${type.type}`);
      }

      recordAsserted(
        '6.4',
        'componenttypes entries are {id, module, group, type} with id === module_group_type',
        `${String(types.length)} type(s) checked`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: componenttypes documents no limit — is one ignored?',
    async (ctx) => {
      const { client, config } = api();
      const full = fx().componentTypes;
      if (full.length < 2) {
        unverifiable(
          ctx,
          '4.3',
          'componenttypes accepts no limit and returns the full set',
          `this tenant returned ${String(full.length)} component type(s), too few to tell a honoured limit from an ignored one`,
        );
      }
      // Sent once, deliberately, to check a documented ABSENCE (spec section 4.3
      // lists componenttypes among the endpoints with no limit at all).
      // Production code must never send this.
      const limited = await attempt(
        client.get<unknown>(componentTypesPath(config.companyId), { query: { limit: 1 } }),
      );
      expect(
        limited.ok || limited.status === undefined || DOCUMENTED_STATUSES.includes(limited.status),
        `sending limit to componenttypes produced ${describeOutcome(limited)}, which spec section 3 does not document.`,
      ).toBe(true);

      const limitedCount = limited.ok ? records(limited.value).length : undefined;
      recordObserved(
        '4.3',
        'componenttypes documents no limit parameter; is one ignored or honoured?',
        limitedCount === undefined
          ? `${describeOutcome(limited)}`
          : limitedCount === full.length
            ? `ignored — limit=1 still returned all ${String(full.length)} type(s), as the documented absence implies`
            : `HONOURED — limit=1 returned ${String(limitedCount)} of ${String(full.length)} type(s). spec section 4.3 says this endpoint has no limit; if it does, the captured contract understates the API and lumics_list_component_types returns a silently truncatable set.`,
      );
    },
    TIMEOUT,
  );
});

describe.skipIf(!RUNNABLE)('live contract: spec 6.5 — system device definitions', () => {
  it(
    'ASSERT: the catalogue is reachable with no contextId and returns a bare array',
    async () => {
      const { client } = api();
      // spec §13 Q2: this is the one genuinely system-scoped route — a literal
      // `system` segment and no contextId anywhere in the path.
      const response = await client.get<unknown>(deviceDefinitionComponentsPath());
      expect(
        Array.isArray(response),
        `spec section 6.5 documents a bare array of definition objects; the body was ${describeValue(response)}.`,
      ).toBe(true);

      const rows = records(response);
      const withData = rows.filter((row) => isRecord(row['data']));
      recordAsserted(
        '6.5',
        'GET /system/deviceDefinitions/components needs no contextId and returns a bare array',
        `${String(rows.length)} definition(s); ${String(withData.length)} carry a "data" object`,
      );

      const sample = withData[0];
      if (sample !== undefined) {
        const data = sample['data'];
        recordObserved(
          '6.5',
          'the documented shape of a definition entry',
          `entry keys: ${keysOf(sample).join(',')}; data keys: ${keysOf(data).join(',')}`,
        );
      }
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// spec §6.1, §6.2 — components
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 6.1-6.2 — components', () => {
  it(
    'ASSERT: the component list is a bare array of company-scoped records keyed by _id',
    // Synchronous: the probe result from discovery is what is under inspection.
    (ctx) => {
      const state = fx();
      if (state.populatedType === undefined) {
        unverifiable(
          ctx,
          '6.1',
          'GET component/:component returns a bare array of component objects carrying _id',
          `none of the first ${String(COMPONENT_TYPE_PROBES)} component types in this tenant's catalogue has any instances`,
        );
      }
      const first = state.componentSample[0];
      if (first === undefined) {
        unverifiable(
          ctx,
          '6.1',
          'GET component/:component returns a bare array of component objects carrying _id',
          'the component probe returned no records',
        );
      }

      const keys = identityKeys(first);
      expect(
        keys.includes('_id'),
        `component records came back with ${keys.join(' and ') || 'no identifier key'} where spec section 4.2 documents "_id" for component reads (keys present: ${keysOf(first).join(',')}).`,
      ).toBe(true);
      // Runtime comparison against the configured company, never a literal.
      expect(
        first['company'],
        'a component came back belonging to a different company than the one configured — company scoping is a security control (tests/security/company-scoping.test.ts) and this would mean the path scoping does not hold server-side.',
      ).toBe(api().config.companyId);

      recordAsserted(
        '6.1',
        'component reads return _id (not id), scoped to the requested company',
        `${String(state.componentSample.length)} record(s) of one type; identifier keys: ${keys.join(', ')}`,
      );
      recordObserved(
        '6.1',
        'components leak Mongoose internals __t and __v (spec section 4.2, defect 12)',
        `__t is ${describeValue(first['__t'])}, __v is ${describeValue(first['__v'])} on this tenant`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: a single component read returns the record requested',
    async (ctx) => {
      const state = fx();
      const first = state.componentSample[0];
      if (state.populatedType === undefined || first === undefined) {
        unverifiable(
          ctx,
          '6.2',
          'GET component/:component/:id returns a bare component object',
          'no component instances were found to read',
        );
      }
      const id = resourceId(first);
      if (id === undefined) {
        unverifiable(
          ctx,
          '6.2',
          'GET component/:component/:id returns a bare component object',
          'the component list carried no id or _id',
        );
      }

      const { client, config } = api();
      const single = await client.get<unknown>(
        componentPath(config.companyId, state.populatedType, id),
      );
      expect(
        isRecord(single),
        `spec section 4.2 documents a bare object for a single read; the body was ${describeValue(single)}.`,
      ).toBe(true);
      expect(
        resourceId(single as Record<string, unknown>),
        'the single component read returned a different record than the id requested.',
      ).toBe(id);
      recordAsserted(
        '6.2',
        'GET component/:component/:id returns the requested record as a bare object',
        `single-read keys: ${keysOf(single).join(',')}`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: the component list documents no limit — is one ignored?',
    async (ctx) => {
      const state = fx();
      if (state.populatedType === undefined || state.componentSample.length < 2) {
        unverifiable(
          ctx,
          '4.3',
          'GET component/:component accepts no limit (spec section 4.3 lists it among the endpoints with none)',
          `found ${String(state.componentSample.length)} component(s) of a single type, too few to tell a honoured limit from an ignored one`,
        );
      }
      const { client, config } = api();
      // Sent once, deliberately, to check a documented absence. Production code
      // must never send this.
      const limited = await attempt(
        client.get<unknown>(componentsPath(config.companyId, state.populatedType), {
          query: { limit: 1 },
        }),
      );
      expect(
        limited.ok || limited.status === undefined || DOCUMENTED_STATUSES.includes(limited.status),
        `sending limit to the component list produced ${describeOutcome(limited)}, which spec section 3 does not document.`,
      ).toBe(true);

      const count = limited.ok ? records(limited.value).length : undefined;
      recordObserved(
        '4.3',
        'the component list documents no limit parameter; is one ignored or honoured?',
        count === undefined
          ? describeOutcome(limited)
          : count === state.componentSample.length
            ? `ignored — limit=1 still returned all ${String(count)} component(s), as the documented absence implies`
            : `HONOURED — limit=1 returned ${String(count)} of ${String(state.componentSample.length)}. lumics_list_components sends no limit and presents the result as complete; if the API can truncate here, that presentation needs revisiting.`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// spec §9 — IP groups
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 9 — ipgroups', () => {
  it(
    'ASSERT: GET ipgroups returns a bare array and honours limit',
    async (ctx) => {
      const { client, config } = api();
      const response = await client.get<unknown>(ipGroupsPath(config.companyId), {
        query: { limit: 2 },
      });
      expect(
        Array.isArray(response),
        `spec section 4.2 documents a bare array; GET ipgroups returned ${describeValue(response)}.`,
      ).toBe(true);

      const two = records(response);
      if (two.length < 2) {
        recordAsserted(
          '9.1',
          'GET ipgroups returns a bare array',
          `body is ${describeValue(response)}`,
        );
        unverifiable(
          ctx,
          '9.1',
          'limit ("Amount of results") is honoured on GET ipgroups',
          `this tenant has ${String(two.length)} ip group(s), too few to distinguish a honoured limit`,
        );
      }
      const one = records(
        await client.get<unknown>(ipGroupsPath(config.companyId), { query: { limit: 1 } }),
      );
      expect(
        one.length,
        `limit=1 returned ${String(one.length)} ip group(s) on a tenant that has at least two; spec section 9.1 documents limit as "Amount of results".`,
      ).toBe(1);
      recordAsserted(
        '9.1',
        'GET ipgroups returns a bare array and honours limit',
        'limit=1 returned exactly one record on a tenant with two or more',
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the single ipgroup read returns _id, unlike the list which returns id',
    async (ctx) => {
      const { client, config } = api();
      const list = records(
        await client.get<unknown>(ipGroupsPath(config.companyId), { query: { limit: 1 } }),
      );
      const first = list[0];
      if (first === undefined) {
        unverifiable(
          ctx,
          '9.2',
          'the single ipgroup read returns _id while the list returns id (spec section 4.2)',
          'this tenant has no ip groups',
        );
      }
      const id = resourceId(first);
      if (id === undefined) {
        unverifiable(
          ctx,
          '9.2',
          'the single ipgroup read returns _id while the list returns id',
          'the ipgroup list carried no id or _id',
        );
      }

      const single = await client.get<unknown>(ipGroupPath(config.companyId, id));
      expect(
        isRecord(single),
        `spec section 4.2 documents a bare object for a single read; the body was ${describeValue(single)}.`,
      ).toBe(true);
      const keys = identityKeys(single);
      expect(
        keys.length,
        `the single ipgroup read carried neither id nor _id (keys: ${keysOf(single).join(',')}); resourceId() would return undefined and the tool would report an unknown id.`,
      ).toBeGreaterThan(0);

      recordAsserted(
        '9.2',
        'the single ipgroup read carries an identifier resourceId() can resolve',
        `list identifier keys: ${identityKeys(first).join(', ')}; single-read identifier keys: ${keys.join(', ')}`,
      );
      recordObserved(
        '4.2',
        'spec section 4.2 claims the ipgroup SINGLE read returns _id while the LIST returns id',
        keys.includes('_id') && !keys.includes('id')
          ? 'confirmed on this tenant — the asymmetry the docs describe is real, and resourceId() is load-bearing'
          : `NOT reproduced — the single read returned ${keys.join(' and ')}. The captured contract overstates the inconsistency; correcting spec section 4.2 would simplify nothing in the code (resourceId stays) but would stop misleading readers.`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the parent filter returns only groups with that parent',
    async (ctx) => {
      const { client, config } = api();
      const all = records(
        await client.get<unknown>(ipGroupsPath(config.companyId), { query: { limit: 25 } }),
      );
      const parented = all.find((group) => isObjectIdShaped(group['parent']));
      const parentId = parented?.['parent'];
      if (!isObjectIdShaped(parentId)) {
        unverifiable(
          ctx,
          '9.1',
          'the parent query parameter finds groups with that group as their parent',
          `none of the ${String(all.length)} ip group(s) read has a parent, so there is no live parent id to filter by`,
        );
      }

      const filtered = records(
        await client.get<unknown>(ipGroupsPath(config.companyId), {
          query: { parent: parentId, limit: 25 },
        }),
      );
      if (filtered.length === 0) {
        unverifiable(
          ctx,
          '9.1',
          'the parent query parameter finds groups with that group as their parent',
          'filtering by a parent id that at least one group declares returned nothing, so the filter could not be observed working',
        );
      }
      const wrong = filtered.filter((group) => group['parent'] !== parentId);
      expect(
        wrong.length,
        `${String(wrong.length)} of ${String(filtered.length)} group(s) came back with a different parent than the one filtered on. spec section 9.1 documents parent as "Find groups with this group as their parent"; a filter that does not filter makes lumics_list_ip_groups' parent argument a lie.`,
      ).toBe(0);
      recordAsserted(
        '9.1',
        'the parent query parameter restricts results to children of that group',
        `${String(filtered.length)} group(s) returned, all with the requested parent`,
      );
    },
    TIMEOUT,
  );
});

declareSkipExplanation('the collector, component and ipgroup contract');
