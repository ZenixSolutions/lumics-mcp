/**
 * Typed path builders. **The only place in this server that constructs a Lumics
 * URL path.**
 *
 * The prototype interpolated caller-supplied strings straight into template
 * literals, which is a path-traversal hole: an `id` of `../../me/token` walks
 * out of the intended resource. RFC-001 D6 requires `encodeURIComponent` on
 * every interpolated segment, enforced by test. Centralising it here means no
 * call site *can* forget — `src/api/client.ts` only accepts a path, and every
 * path in the spec has a builder below.
 *
 * v0.1 emits the literal `companies` for `:context` and never `admingroups` or
 * `system` (RFC-001 open question 3, owner-approved). Builders therefore take a
 * `companyId` rather than a `context`/`contextId` pair, which also removes a
 * whole class of malformed-URL mistakes the prototype made.
 *
 * Path spellings follow spec §15 exactly, including the IPAM singular/plural
 * asymmetry confirmed real in the vendor's route definitions (spec §13 Q1).
 */

import { CONTEXT_COMPANIES } from '../constants.js';
import { LumicsInputError } from './errors.js';

/**
 * Encode one path segment.
 *
 * `encodeURIComponent` escapes `/`, `.` is left alone (harmless inside a
 * segment) but a segment that is *entirely* dots would still traverse, so those
 * are rejected outright rather than encoded. An empty segment is rejected too:
 * it collapses `/a//b` into a different route.
 */
function seg(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LumicsInputError(`${name} must be a non-empty string; received an empty value.`);
  }
  if (/^\.+$/.test(value)) {
    throw new LumicsInputError(
      `${name} must not be a relative path segment (received "${value}"). Supply a real identifier.`,
    );
  }
  return encodeURIComponent(value);
}

/** Encode a comma-delimited id list, escaping each id but keeping the commas. */
function segList(values: readonly string[], name: string): string {
  if (values.length === 0) {
    throw new LumicsInputError(`${name} must contain at least one id.`);
  }
  return values.map((value) => seg(value, name)).join(',');
}

/** `:context` is always the literal `companies` in v0.1; `:contextId` is encoded. */
function companyContext(companyId: string): string {
  return `/${CONTEXT_COMPANIES}/${seg(companyId, 'companyId')}`;
}

// ---------------------------------------------------------------------------
// Collector — spec §5
// ---------------------------------------------------------------------------

/** spec §5.1 `GET /:context/:contextId/collectors`, §5.3 `POST`. */
export function collectorsPath(companyId: string): string {
  return `${companyContext(companyId)}/collectors`;
}

/** spec §5.2 `GET`, §5.4 `PATCH`, §5.5 `DELETE` on `/collectors/:id`. */
export function collectorPath(companyId: string, collectorId: string): string {
  return `${collectorsPath(companyId)}/${seg(collectorId, 'collectorId')}`;
}

// ---------------------------------------------------------------------------
// Component — spec §6
// ---------------------------------------------------------------------------

/**
 * spec §6.1 `GET /:context/:contextId/component/:component/`.
 * The trailing slash is in the vendor's documented template and is preserved.
 */
export function componentsPath(companyId: string, componentType: string): string {
  return `${companyContext(companyId)}/component/${seg(componentType, 'componentType')}/`;
}

/** spec §6.2 `GET /:context/:contextId/component/:component/:id`. */
export function componentPath(
  companyId: string,
  componentType: string,
  componentId: string,
): string {
  return `${companyContext(companyId)}/component/${seg(componentType, 'componentType')}/${seg(
    componentId,
    'componentId',
  )}`;
}

/**
 * spec §6.3 `PATCH /companies/:companyId/component/:component/:id`.
 * Company-scoped only — there is no `:context` variant of the component update,
 * so this shares a shape with {@link componentPath} by coincidence, not by rule.
 */
export function componentUpdatePath(
  companyId: string,
  componentType: string,
  componentId: string,
): string {
  return componentPath(companyId, componentType, componentId);
}

/**
 * spec §6.4 `GET /:context/:contextId/componenttypes/`.
 * The documented `component` path parameter does not exist in the template
 * (spec §14 defect 2) and is not accepted here.
 */
export function componentTypesPath(companyId: string): string {
  return `${companyContext(companyId)}/componenttypes/`;
}

/**
 * spec §6.5 `GET /system/deviceDefinitions/components`.
 * The one genuinely system-scoped route: a literal `system` segment and no
 * contextId (spec §13 Q2). Takes no parameters, so nothing to encode.
 */
export function deviceDefinitionComponentsPath(): string {
  return '/system/deviceDefinitions/components';
}

// ---------------------------------------------------------------------------
// Device — spec §7
// ---------------------------------------------------------------------------

/** spec §7.1 `GET /:context/:contextId/devices`, §7.3 `POST` (`companies` only). */
export function devicesPath(companyId: string): string {
  return `${companyContext(companyId)}/devices`;
}

/** spec §7.2 `GET`, §7.5 `PATCH`, §7.7 `DELETE` on `/devices/:id`. */
export function devicePath(companyId: string, deviceId: string): string {
  return `${devicesPath(companyId)}/${seg(deviceId, 'deviceId')}`;
}

/** spec §7.4 `PUT /:context/:contextId/devices/:id/modules/:module/lastDiscovery`. */
export function deviceModuleLastDiscoveryPath(
  companyId: string,
  deviceId: string,
  moduleName: string,
): string {
  return `${devicePath(companyId, deviceId)}/modules/${seg(moduleName, 'moduleName')}/lastDiscovery`;
}

/**
 * spec §7.6 `PATCH /:context/:contextId/devices/:ids/batch`.
 * `:ids` is "a string of comma delimited IDs"; each id is encoded individually
 * so a malicious id cannot inject a path separator while the commas the route
 * needs survive.
 */
export function devicesBatchPath(companyId: string, deviceIds: readonly string[]): string {
  return `${companyContext(companyId)}/devices/${segList(deviceIds, 'deviceIds')}/batch`;
}

// ---------------------------------------------------------------------------
// IPAM — spec §8, §9, §10
// ---------------------------------------------------------------------------
//
// spec §13 Q1: the ipaddress routes use SINGULAR `/ipsubnet/` for the two reads
// and PLURAL `/ipsubnets/` for POST/PATCH/DELETE. This is confirmed present in
// the vendor's own route definitions (the generated doc slugs encode it), not a
// prose typo. Do not "fix" it — the correct spelling differs per verb.

/** spec §8.1 `GET /companies/:company/ipsubnet/:ipSubnet/ipaddresses` (singular). */
export function ipAddressesReadPath(companyId: string, ipSubnetId: string): string {
  return `/${CONTEXT_COMPANIES}/${seg(companyId, 'companyId')}/ipsubnet/${seg(
    ipSubnetId,
    'ipSubnetId',
  )}/ipaddresses`;
}

/** spec §8.2 `GET /companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id` (singular). */
export function ipAddressReadPath(
  companyId: string,
  ipSubnetId: string,
  ipAddressId: string,
): string {
  return `${ipAddressesReadPath(companyId, ipSubnetId)}/${seg(ipAddressId, 'ipAddressId')}`;
}

/** spec §8.3 `POST /companies/:company/ipsubnets/:ipSubnet/ipaddresses` (plural). */
export function ipAddressesWritePath(companyId: string, ipSubnetId: string): string {
  return `${ipSubnetPath(companyId, ipSubnetId)}/ipaddresses`;
}

/** spec §8.4 `PATCH`, §8.5 `DELETE` on `/ipsubnets/:ipSubnet/ipaddresses/:id` (plural). */
export function ipAddressWritePath(
  companyId: string,
  ipSubnetId: string,
  ipAddressId: string,
): string {
  return `${ipAddressesWritePath(companyId, ipSubnetId)}/${seg(ipAddressId, 'ipAddressId')}`;
}

/** spec §9.1 `GET /companies/:company/ipgroups`, §9.3 `POST`. */
export function ipGroupsPath(companyId: string): string {
  return `/${CONTEXT_COMPANIES}/${seg(companyId, 'companyId')}/ipgroups`;
}

/** spec §9.2 `GET`, §9.4 `PATCH`, §9.5 `DELETE` on `/ipgroups/:id`. */
export function ipGroupPath(companyId: string, ipGroupId: string): string {
  return `${ipGroupsPath(companyId)}/${seg(ipGroupId, 'ipGroupId')}`;
}

/** spec §10.1 `GET /companies/:company/ipsubnets`, §10.3 `POST`. */
export function ipSubnetsPath(companyId: string): string {
  return `/${CONTEXT_COMPANIES}/${seg(companyId, 'companyId')}/ipsubnets`;
}

/** spec §10.2 `GET`, §10.4 `PATCH`, §10.5 `DELETE` on `/ipsubnets/:id`. */
export function ipSubnetPath(companyId: string, ipSubnetId: string): string {
  return `${ipSubnetsPath(companyId)}/${seg(ipSubnetId, 'ipSubnetId')}`;
}

// ---------------------------------------------------------------------------
// Me / tokens — spec §11
// ---------------------------------------------------------------------------

/** spec §11.1 `GET /me`. */
export function mePath(): string {
  return '/me';
}

/*
 * There is deliberately NO builder for `/me/token` (spec §11.2 `GET`, §11.3
 * `POST`). Both mint a JWT and return it in the response body, and ADR-002
 * decision 4 says they must never be exposed. An exported, unused path builder
 * for a credential-minting endpoint, sitting in a module every tool imports, is
 * an attractive nuisance: the next contributor who needs "a token endpoint"
 * finds a ready-made one and no longer has to make the decision the ADR already
 * made. Operators mint tokens out of band, as the README describes.
 */

/** spec §11.4 `POST /me/token/revoke` — revokes EVERY token on the account. */
export function meTokenRevokePath(): string {
  return '/me/token/revoke';
}

// ---------------------------------------------------------------------------
// Metrics — spec §12
// ---------------------------------------------------------------------------

/** spec §12.1 `GET /metrics/companies/:companyId/modules/:moduleType`. */
export function companyMetricsPath(companyId: string, moduleType: string): string {
  return `/metrics/${CONTEXT_COMPANIES}/${seg(companyId, 'companyId')}/modules/${seg(moduleType, 'moduleType')}`;
}

/** spec §12.2 `GET /metrics/companies/:companyId/modules/:moduleType/summarize`. */
export function companyMetricsSummarizePath(companyId: string, moduleType: string): string {
  return `${companyMetricsPath(companyId, moduleType)}/summarize`;
}

/** spec §12.3 `GET /metrics/devices/:id/modules/:moduleType`. */
export function deviceMetricsPath(deviceId: string, moduleType: string): string {
  return `/metrics/devices/${seg(deviceId, 'deviceId')}/modules/${seg(moduleType, 'moduleType')}`;
}

/**
 * spec §12.3 `GET /metrics/devices/:id/modules/:moduleType/:item`.
 * `:item` is a device id for device-level metrics or a component id otherwise.
 */
export function deviceItemMetricsPath(
  deviceId: string,
  moduleType: string,
  itemId: string,
): string {
  return `${deviceMetricsPath(deviceId, moduleType)}/${seg(itemId, 'itemId')}`;
}

/** spec §12.4 `GET /:context/:contextId/metrics/summaries/:moduleType`. */
export function metricSummariesPath(companyId: string, moduleType: string): string {
  return `${companyContext(companyId)}/metrics/summaries/${seg(moduleType, 'moduleType')}`;
}
