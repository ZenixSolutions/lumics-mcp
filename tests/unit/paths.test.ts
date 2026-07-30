/**
 * Path builders — `src/api/paths.ts`.
 *
 * Two things are locked in here.
 *
 * **1. The exact spelling of every path in spec §15**, including the IPAM
 * singular/plural asymmetry (`/ipsubnet/` on reads, `/ipsubnets/` on writes,
 * spec §13 Q1). That asymmetry looks like a bug and is not; a test is the only
 * thing standing between it and a well-meaning normalisation.
 *
 * **2. That no caller-supplied segment can escape its position.** The prototype
 * interpolated ids straight into template literals, so an id of `../../me/token`
 * walked out of the resource and onto the token endpoint. Every builder is
 * exercised with that input in every parameter position; the encoded form must
 * appear and the traversal must not.
 *
 * The hostile-input table is generated from a list of `(builder, arity)` pairs
 * rather than written out per case, so a new builder added without a test shows
 * up as a missing entry rather than as silent coverage.
 */

import { describe, expect, it } from 'vitest';
import { LumicsInputError } from '../../src/api/errors.js';
import * as paths from '../../src/api/paths.js';
import {
  TEST_ADDRESS_ID,
  TEST_COLLECTOR_ID,
  TEST_COMPANY_ID,
  TEST_COMPONENT_ID,
  TEST_DEVICE_ID,
  TEST_GROUP_ID,
  TEST_SUBNET_ID,
} from '../helpers/config.js';

const C = TEST_COMPANY_ID;

describe('path spellings match spec section 15', () => {
  it.each([
    // spec §5 — collectors
    ['collectorsPath', paths.collectorsPath(C), `/companies/${C}/collectors`],
    [
      'collectorPath',
      paths.collectorPath(C, TEST_COLLECTOR_ID),
      `/companies/${C}/collectors/${TEST_COLLECTOR_ID}`,
    ],

    // spec §6 — components. Singular `component`, trailing slash preserved.
    [
      'componentsPath',
      paths.componentsPath(C, 'cisco_ast_devices'),
      `/companies/${C}/component/cisco_ast_devices/`,
    ],
    [
      'componentPath',
      paths.componentPath(C, 'cisco_ast_devices', TEST_COMPONENT_ID),
      `/companies/${C}/component/cisco_ast_devices/${TEST_COMPONENT_ID}`,
    ],
    [
      'componentUpdatePath',
      paths.componentUpdatePath(C, 'cisco_ast_devices', TEST_COMPONENT_ID),
      `/companies/${C}/component/cisco_ast_devices/${TEST_COMPONENT_ID}`,
    ],
    ['componentTypesPath', paths.componentTypesPath(C), `/companies/${C}/componenttypes/`],
    [
      'deviceDefinitionComponentsPath',
      paths.deviceDefinitionComponentsPath(),
      '/system/deviceDefinitions/components',
    ],

    // spec §7 — devices
    ['devicesPath', paths.devicesPath(C), `/companies/${C}/devices`],
    [
      'devicePath',
      paths.devicePath(C, TEST_DEVICE_ID),
      `/companies/${C}/devices/${TEST_DEVICE_ID}`,
    ],
    [
      'deviceModuleLastDiscoveryPath',
      paths.deviceModuleLastDiscoveryPath(C, TEST_DEVICE_ID, 'snmp'),
      `/companies/${C}/devices/${TEST_DEVICE_ID}/modules/snmp/lastDiscovery`,
    ],
    [
      'devicesBatchPath',
      paths.devicesBatchPath(C, [TEST_DEVICE_ID, TEST_COLLECTOR_ID]),
      `/companies/${C}/devices/${TEST_DEVICE_ID},${TEST_COLLECTOR_ID}/batch`,
    ],

    // spec §8 — IP addresses. SINGULAR on reads, PLURAL on writes (spec §13 Q1).
    [
      'ipAddressesReadPath',
      paths.ipAddressesReadPath(C, TEST_SUBNET_ID),
      `/companies/${C}/ipsubnet/${TEST_SUBNET_ID}/ipaddresses`,
    ],
    [
      'ipAddressReadPath',
      paths.ipAddressReadPath(C, TEST_SUBNET_ID, TEST_ADDRESS_ID),
      `/companies/${C}/ipsubnet/${TEST_SUBNET_ID}/ipaddresses/${TEST_ADDRESS_ID}`,
    ],
    [
      'ipAddressesWritePath',
      paths.ipAddressesWritePath(C, TEST_SUBNET_ID),
      `/companies/${C}/ipsubnets/${TEST_SUBNET_ID}/ipaddresses`,
    ],
    [
      'ipAddressWritePath',
      paths.ipAddressWritePath(C, TEST_SUBNET_ID, TEST_ADDRESS_ID),
      `/companies/${C}/ipsubnets/${TEST_SUBNET_ID}/ipaddresses/${TEST_ADDRESS_ID}`,
    ],

    // spec §9, §10 — groups and subnets
    ['ipGroupsPath', paths.ipGroupsPath(C), `/companies/${C}/ipgroups`],
    [
      'ipGroupPath',
      paths.ipGroupPath(C, TEST_GROUP_ID),
      `/companies/${C}/ipgroups/${TEST_GROUP_ID}`,
    ],
    ['ipSubnetsPath', paths.ipSubnetsPath(C), `/companies/${C}/ipsubnets`],
    [
      'ipSubnetPath',
      paths.ipSubnetPath(C, TEST_SUBNET_ID),
      `/companies/${C}/ipsubnets/${TEST_SUBNET_ID}`,
    ],

    // spec §11 — me
    ['mePath', paths.mePath(), '/me'],
    // No `/me/token` builder exists, deliberately — see the regression test at the
    // bottom of this file and ADR-002 decision 4.
    ['meTokenRevokePath', paths.meTokenRevokePath(), '/me/token/revoke'],

    // spec §12 — metrics
    [
      'companyMetricsPath',
      paths.companyMetricsPath(C, 'snmp'),
      `/metrics/companies/${C}/modules/snmp`,
    ],
    [
      'companyMetricsSummarizePath',
      paths.companyMetricsSummarizePath(C, 'snmp'),
      `/metrics/companies/${C}/modules/snmp/summarize`,
    ],
    [
      'deviceMetricsPath',
      paths.deviceMetricsPath(TEST_DEVICE_ID, 'snmp'),
      `/metrics/devices/${TEST_DEVICE_ID}/modules/snmp`,
    ],
    [
      'deviceItemMetricsPath',
      paths.deviceItemMetricsPath(TEST_DEVICE_ID, 'snmp', TEST_COMPONENT_ID),
      `/metrics/devices/${TEST_DEVICE_ID}/modules/snmp/${TEST_COMPONENT_ID}`,
    ],
    [
      'metricSummariesPath',
      paths.metricSummariesPath(C, 'snmp'),
      `/companies/${C}/metrics/summaries/snmp`,
    ],
  ])('%s produces the documented path', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('never emits a context other than the literal "companies" (RFC-001 open question 3)', () => {
    const everyPath = [
      paths.collectorsPath(C),
      paths.componentsPath(C, 'x'),
      paths.componentTypesPath(C),
      paths.devicesPath(C),
      paths.ipAddressesReadPath(C, TEST_SUBNET_ID),
      paths.ipAddressesWritePath(C, TEST_SUBNET_ID),
      paths.ipGroupsPath(C),
      paths.ipSubnetsPath(C),
      paths.companyMetricsPath(C, 'x'),
      paths.metricSummariesPath(C, 'x'),
    ];
    for (const path of everyPath) {
      expect(path).not.toContain('admingroups');
    }
    // `system` appears in exactly one route, which is genuinely system-scoped.
    expect(paths.deviceDefinitionComponentsPath()).toBe('/system/deviceDefinitions/components');
    for (const path of everyPath) {
      expect(path).not.toContain('/system/');
    }
  });
});

/**
 * The IPAM asymmetry gets its own test with its own name, so a failure message
 * says what the intent was rather than just "path mismatch".
 */
describe('IPAM ipsubnet/ipsubnets asymmetry (spec section 13 Q1) is intentional', () => {
  it('address READS use the singular /ipsubnet/ segment', () => {
    expect(paths.ipAddressesReadPath(C, TEST_SUBNET_ID)).toContain(`/ipsubnet/${TEST_SUBNET_ID}/`);
    expect(paths.ipAddressesReadPath(C, TEST_SUBNET_ID)).not.toContain('/ipsubnets/');
    expect(paths.ipAddressReadPath(C, TEST_SUBNET_ID, TEST_ADDRESS_ID)).toContain('/ipsubnet/');
    expect(paths.ipAddressReadPath(C, TEST_SUBNET_ID, TEST_ADDRESS_ID)).not.toContain(
      '/ipsubnets/',
    );
  });

  it('address WRITES use the plural /ipsubnets/ segment', () => {
    expect(paths.ipAddressesWritePath(C, TEST_SUBNET_ID)).toContain(
      `/ipsubnets/${TEST_SUBNET_ID}/`,
    );
    expect(paths.ipAddressWritePath(C, TEST_SUBNET_ID, TEST_ADDRESS_ID)).toContain('/ipsubnets/');
  });

  it('the subnet resource itself is always plural', () => {
    expect(paths.ipSubnetsPath(C)).toMatch(/\/ipsubnets$/);
    expect(paths.ipSubnetPath(C, TEST_SUBNET_ID)).toMatch(/\/ipsubnets\/[0-9a-f]{24}$/);
  });
});

/**
 * A builder plus enough argument slots to drive it, so the hostile-input table
 * below can substitute a malicious value into each position in turn.
 */
type Builder = (...args: string[]) => string;
interface BuilderSpec {
  readonly name: string;
  readonly build: Builder;
  /** Benign values for each positional argument. */
  readonly args: readonly string[];
}

const BUILDERS: readonly BuilderSpec[] = [
  { name: 'collectorsPath', build: paths.collectorsPath, args: [C] },
  { name: 'collectorPath', build: paths.collectorPath, args: [C, TEST_COLLECTOR_ID] },
  { name: 'componentsPath', build: paths.componentsPath, args: [C, 'cisco_ast_devices'] },
  {
    name: 'componentPath',
    build: paths.componentPath,
    args: [C, 'cisco_ast_devices', TEST_COMPONENT_ID],
  },
  {
    name: 'componentUpdatePath',
    build: paths.componentUpdatePath,
    args: [C, 'cisco_ast_devices', TEST_COMPONENT_ID],
  },
  { name: 'componentTypesPath', build: paths.componentTypesPath, args: [C] },
  { name: 'devicesPath', build: paths.devicesPath, args: [C] },
  { name: 'devicePath', build: paths.devicePath, args: [C, TEST_DEVICE_ID] },
  {
    name: 'deviceModuleLastDiscoveryPath',
    build: paths.deviceModuleLastDiscoveryPath,
    args: [C, TEST_DEVICE_ID, 'snmp'],
  },
  {
    name: 'ipAddressesReadPath',
    build: paths.ipAddressesReadPath,
    args: [C, TEST_SUBNET_ID],
  },
  {
    name: 'ipAddressReadPath',
    build: paths.ipAddressReadPath,
    args: [C, TEST_SUBNET_ID, TEST_ADDRESS_ID],
  },
  {
    name: 'ipAddressesWritePath',
    build: paths.ipAddressesWritePath,
    args: [C, TEST_SUBNET_ID],
  },
  {
    name: 'ipAddressWritePath',
    build: paths.ipAddressWritePath,
    args: [C, TEST_SUBNET_ID, TEST_ADDRESS_ID],
  },
  { name: 'ipGroupsPath', build: paths.ipGroupsPath, args: [C] },
  { name: 'ipGroupPath', build: paths.ipGroupPath, args: [C, TEST_GROUP_ID] },
  { name: 'ipSubnetsPath', build: paths.ipSubnetsPath, args: [C] },
  { name: 'ipSubnetPath', build: paths.ipSubnetPath, args: [C, TEST_SUBNET_ID] },
  { name: 'companyMetricsPath', build: paths.companyMetricsPath, args: [C, 'snmp'] },
  {
    name: 'companyMetricsSummarizePath',
    build: paths.companyMetricsSummarizePath,
    args: [C, 'snmp'],
  },
  {
    name: 'deviceMetricsPath',
    build: paths.deviceMetricsPath,
    args: [TEST_DEVICE_ID, 'snmp'],
  },
  {
    name: 'deviceItemMetricsPath',
    build: paths.deviceItemMetricsPath,
    args: [TEST_DEVICE_ID, 'snmp', TEST_COMPONENT_ID],
  },
  { name: 'metricSummariesPath', build: paths.metricSummariesPath, args: [C, 'snmp'] },
];

/** Every builder that takes at least one caller-supplied segment. */
const PARAMETERISED = BUILDERS.flatMap((spec) =>
  spec.args.map((_arg, index) => ({ spec, index }) as const),
);

/**
 * Inputs that must never reach the wire in raw form. Each entry is the raw
 * value and the encoded form the builder must emit instead.
 */
const HOSTILE: readonly { readonly raw: string; readonly encoded: string }[] = [
  { raw: '../../me/token', encoded: '..%2F..%2Fme%2Ftoken' },
  { raw: '../../../me/token/revoke', encoded: '..%2F..%2F..%2Fme%2Ftoken%2Frevoke' },
  // Not the literal `/me`: several legitimate paths contain `/metrics`, so a
  // substring check on `/me` would be a false positive rather than a leak.
  { raw: '/absolute', encoded: '%2Fabsolute' },
  { raw: 'a/b', encoded: 'a%2Fb' },
  { raw: 'x?limit=9999', encoded: 'x%3Flimit%3D9999' },
  { raw: 'x#frag', encoded: 'x%23frag' },
  { raw: 'x&y=1', encoded: 'x%26y%3D1' },
  { raw: '%2e%2e%2fme', encoded: '%252e%252e%252fme' },
  { raw: 'a b', encoded: 'a%20b' },
  { raw: 'ünïcode', encoded: '%C3%BCn%C3%AFcode' },
];

describe('every path builder percent-encodes every caller-supplied segment', () => {
  const cases = PARAMETERISED.flatMap(({ spec, index }) =>
    HOSTILE.map((hostile) => [spec.name, index, hostile.raw, hostile.encoded, spec] as const),
  );

  it.each(cases)('%s argument %i encodes %j', (_name, index, raw, encoded, spec: BuilderSpec) => {
    const args = [...spec.args];
    args[index] = raw;
    const path = spec.build(...args);

    expect(path).toContain(encoded);
    // The raw form must be gone: if `..%2F` were emitted as `../` the segment
    // would traverse, and if `?` survived it would become a query parameter.
    expect(path).not.toContain(raw);
  });

  it('a hostile deviceId cannot reach the /me/token endpoint', () => {
    const path = paths.devicePath(C, '../../me/token');
    expect(path).toBe(`/companies/${C}/devices/..%2F..%2Fme%2Ftoken`);
    // The property that matters: resolving this against a base URL still lands
    // inside /devices/, because %2F is not a path separator.
    const url = new URL(`https://lumics.invalid/api/v1${path}`);
    expect(url.pathname).toBe(`/api/v1/companies/${C}/devices/..%2F..%2Fme%2Ftoken`);
    expect(url.pathname).not.toMatch(/\/me\/token/);
    expect(url.pathname.endsWith('/me/token')).toBe(false);
  });

  it('a hostile componentType cannot escape the component collection', () => {
    const path = paths.componentsPath(C, '../../../me');
    expect(path).toBe(`/companies/${C}/component/..%2F..%2F..%2Fme/`);
    expect(new URL(`https://lumics.invalid/api/v1${path}`).pathname).toContain('/component/');
  });

  it('a hostile batch id list keeps the commas the route needs but escapes each id', () => {
    const path = paths.devicesBatchPath(C, [TEST_DEVICE_ID, '../../me/token']);
    expect(path).toBe(`/companies/${C}/devices/${TEST_DEVICE_ID},..%2F..%2Fme%2Ftoken/batch`);
    expect(path).toMatch(/\/batch$/);
  });

  it('a batch id list cannot smuggle a separator through the join', () => {
    const path = paths.devicesBatchPath(C, ['a,b/c']);
    expect(path).toBe(`/companies/${C}/devices/a%2Cb%2Fc/batch`);
  });
});

describe('path builders reject segments that encoding cannot make safe', () => {
  it.each([
    ['.', 'a single dot resolves to the current segment'],
    ['..', 'a double dot resolves to the parent'],
    ['...', 'any all-dots segment'],
    ['....', 'any all-dots segment'],
  ])('rejects the segment %j (%s)', (value) => {
    expect(() => paths.devicePath(C, value)).toThrow(LumicsInputError);
    expect(() => paths.devicePath(C, value)).toThrow(/must not be a relative path segment/);
  });

  it('rejects an empty segment, which would collapse two path separators', () => {
    expect(() => paths.devicePath(C, '')).toThrow(LumicsInputError);
    expect(() => paths.devicePath(C, '')).toThrow(/must be a non-empty string/);
    expect(() => paths.devicePath('', TEST_DEVICE_ID)).toThrow(/companyId/);
  });

  it('names the offending parameter so the model can fix the right argument', () => {
    expect(() => paths.ipAddressReadPath(C, '', TEST_ADDRESS_ID)).toThrow(/ipSubnetId/);
    expect(() => paths.ipAddressReadPath(C, TEST_SUBNET_ID, '')).toThrow(/ipAddressId/);
    expect(() => paths.componentPath(C, '', TEST_COMPONENT_ID)).toThrow(/componentType/);
    expect(() => paths.deviceItemMetricsPath(TEST_DEVICE_ID, 'snmp', '')).toThrow(/itemId/);
    expect(() => paths.companyMetricsPath(C, '')).toThrow(/moduleType/);
    expect(() => paths.deviceModuleLastDiscoveryPath(C, TEST_DEVICE_ID, '')).toThrow(/moduleName/);
    expect(() => paths.collectorPath(C, '')).toThrow(/collectorId/);
    expect(() => paths.ipGroupPath(C, '')).toThrow(/ipGroupId/);
  });

  it('rejects an empty batch id list rather than building /devices//batch', () => {
    expect(() => paths.devicesBatchPath(C, [])).toThrow(LumicsInputError);
    expect(() => paths.devicesBatchPath(C, [])).toThrow(/at least one id/);
  });

  it('rejects a dot-only id inside a batch list', () => {
    expect(() => paths.devicesBatchPath(C, [TEST_DEVICE_ID, '..'])).toThrow(
      /must not be a relative path segment/,
    );
  });
});

/**
 * Finding R5. `meTokenPath()` was exported and unused, and `TokenResponse` existed
 * in `src/domain/` "for completeness", both for the one endpoint pair ADR-002
 * decision 4 says must never be exposed — `GET /me/token` and `POST /me/token`
 * mint a JWT and return it in the body.
 *
 * An unused credential-minting path builder in a module every tool imports is an
 * attractive nuisance: the next contributor who needs "a token endpoint" finds a
 * ready-made one and never has to make the decision the ADR already made. Both are
 * deleted, and this test is what keeps them deleted.
 */
describe('no builder or type exists for the credential-minting endpoints', () => {
  it('exports no path builder that resolves to /me/token', () => {
    const builders = Object.entries(paths).filter(
      (entry): entry is [string, () => string] => typeof entry[1] === 'function',
    );
    expect(builders.length).toBeGreaterThan(10);

    for (const [name, builder] of builders) {
      expect(name, 'no export may be named after the token endpoint').not.toBe('meTokenPath');
      if (builder.length === 0) {
        // Zero-argument builders are the context-free ones; none may produce the
        // token path. `/me/token/revoke` is a different endpoint and is allowed.
        expect(builder(), `${name} must not build the token-minting path`).not.toBe('/me/token');
      }
    }
  });

  it('keeps the revoke path, which IS exposed behind its own flag', () => {
    expect(paths.meTokenRevokePath()).toBe('/me/token/revoke');
  });

  it('exports no TokenResponse type from the domain module', async () => {
    const domain = await import('../../src/domain/index.js');
    expect(Object.keys(domain)).not.toContain('TokenResponse');
  });
});
