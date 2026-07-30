/**
 * Domain types for the Lumics resources this server exposes.
 *
 * Two deliberate decisions shape every type here.
 *
 * **1. Every resource carries an index signature.** spec §4.2 documents response
 * *examples*, not schemas, and spec §14 records twelve places where the vendor's
 * documentation is internally inconsistent. Closing these types would mean
 * dropping fields a real tenant returns. So each interface names the fields the
 * spec documents and admits the rest, and tool output is a projection of what
 * the API actually sent rather than a re-serialisation of what we expected.
 *
 * **2. Identifier fields are optional and doubled.** spec §4.2: "Object identity
 * keys are inconsistent in examples: reads/updates of collectors, devices,
 * ipgroup list, ipsubnet list and ipaddress list return `id`; ipgroup single
 * read, ipgroup/ipsubnet/ipaddress create-update-delete payloads and component
 * reads return `_id`." Both are therefore declared optional, and
 * {@link resourceId} is the one place that picks whichever arrived.
 *
 * These types are advisory: the client does not validate responses against them
 * (there is no published schema to validate against, and a mismatch should
 * surface as visible drift, not a thrown error). They exist to make tool code
 * legible and to catch our own mistakes at compile time.
 */

import type {
  IP_ADDRESS_STATES,
  IP_GROUP_TYPES,
  METRIC_INTERVALS,
  METRIC_SUM_PROPERTIES,
} from '../constants.js';

/** A 24-character hex MongoDB ObjectId. Nominal, not enforced by the type system. */
export type ObjectId = string;

/** Fields present on essentially every Lumics document. */
export interface LumicsResource {
  /** Present on collector, device, ipsubnet, ipgroup-list and ipaddress-list reads. */
  readonly id?: ObjectId;
  /** Present on component reads and on create/update/delete payloads. */
  readonly _id?: ObjectId;
  readonly company?: ObjectId;
  readonly adminGroup?: ObjectId | null;
  readonly createdAt?: string;
  readonly createdBy?: ObjectId;
  readonly updatedAt?: string;
  readonly updatedBy?: ObjectId;
  readonly [key: string]: unknown;
}

/**
 * Read whichever identifier field the API supplied. Prefer `id`, fall back to
 * `_id`. Returns `undefined` rather than throwing: a missing id is data worth
 * reporting, not a reason to fail a whole list.
 */
export function resourceId(resource: LumicsResource | null | undefined): ObjectId | undefined {
  if (resource === null || resource === undefined) {
    return undefined;
  }
  if (typeof resource.id === 'string') {
    return resource.id;
  }
  if (typeof resource._id === 'string') {
    return resource._id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Envelopes — spec §4.2
// ---------------------------------------------------------------------------

/** `PATCH` single and `PUT` return `{ updated: {...} }`; batch `PATCH` an array. */
export interface UpdatedEnvelope<T> {
  readonly updated: T;
}

/** `DELETE` returns `{ deleted: {...} }`. */
export interface DeletedEnvelope<T> {
  readonly deleted: T;
}

// ---------------------------------------------------------------------------
// Collector — spec §5
// ---------------------------------------------------------------------------

export interface CollectorOsConfig {
  readonly ntpServers?: readonly string[];
  readonly [key: string]: unknown;
}

export interface Collector extends LumicsResource {
  readonly name?: string;
  readonly description?: string;
  readonly location?: string;
  readonly ipAddress?: string;
  readonly version?: string;
  /** A date when a restart is pending, or `false` when it is not (spec §5.3). */
  readonly needsRestart?: string | false;
  readonly osConfig?: CollectorOsConfig;
  readonly user?: ObjectId;
}

// ---------------------------------------------------------------------------
// Component — spec §6
// ---------------------------------------------------------------------------

export interface Component extends LumicsResource {
  /** Mongoose discriminator, e.g. `"pingtcp.Port"` (spec §6.1). */
  readonly __t?: string;
  readonly __v?: number;
  readonly device?: ObjectId;
  readonly index?: string;
  readonly isMonitored?: boolean;
  readonly name?: string;
}

/** spec §6.4: `{ id: "<module>_<group>_<type>", module, group, type }`. */
export interface ComponentType {
  readonly id: string;
  readonly module: string;
  readonly group: string;
  readonly type: string;
}

/** spec §6.5 device definition. `schema` values may be strings or objects. */
export interface DeviceDefinitionComponent {
  readonly includes?: readonly unknown[];
  readonly filePath?: string;
  readonly data?: {
    readonly enabled?: boolean;
    readonly modelName?: string;
    readonly itemType?: string;
    readonly componentAlias?: string;
    readonly isDefaultMonitored?: boolean;
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly nameProperty?: string;
    readonly componentManagement?: {
      readonly title?: string;
      readonly displayProp?: string;
      readonly canManage?: boolean;
      readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Device — spec §7
// ---------------------------------------------------------------------------

/** spec §7.1: a custom-property assignment. `value` is genuinely untyped. */
export interface CustomPropertyValue {
  readonly customProperty?: ObjectId;
  readonly value?: unknown;
}

/**
 * A device module instance. The map *key* need not equal `module`
 * (spec §7.1: `modules.deviceConfigs` has `module: "snapshots"`), so consumers
 * must read `module` rather than assuming the key.
 */
export interface DeviceModule {
  readonly module?: string;
  readonly enabled?: boolean;
  readonly primary?: boolean;
  readonly lastDiscovery?: string | null;
  readonly [key: string]: unknown;
}

export interface Device extends LumicsResource {
  readonly name?: string;
  readonly description?: string;
  readonly location?: string;
  readonly ipAddress?: string;
  readonly collector?: ObjectId;
  /** No enumeration is documented; examples show `default` and `switch`. */
  readonly deviceType?: string;
  readonly model?: string;
  readonly version?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly maintenanceMode?: boolean;
  /** Examples show `disable-polling`; no enumeration is documented. */
  readonly maintenanceType?: string;
  readonly customProperties?: readonly CustomPropertyValue[];
  readonly modules?: Readonly<Record<string, DeviceModule>>;
}

// ---------------------------------------------------------------------------
// IPAM — spec §8, §9, §10
// ---------------------------------------------------------------------------

export type IpAddressState = (typeof IP_ADDRESS_STATES)[number];
export type IpGroupType = (typeof IP_GROUP_TYPES)[number];

export interface IpScanStatusChange {
  readonly newStatus?: 'up' | 'down';
  readonly time?: string;
}

export interface IpScanHistory {
  readonly firstUp?: string;
  readonly lastScan?: string;
  readonly lastStatus?: 'up' | 'down';
  readonly statusChanges?: readonly IpScanStatusChange[];
  readonly [key: string]: unknown;
}

export interface IpAddress extends LumicsResource {
  readonly ipAddress?: string;
  readonly ipSubnet?: ObjectId;
  readonly name?: string;
  readonly dnsName?: string;
  readonly macAddress?: string;
  readonly nat?: string;
  readonly description?: string;
  readonly note?: string;
  /** Documented values are {@link IpAddressState}; typed wider because spec §8 documents no enum. */
  readonly state?: string;
  readonly scanHistory?: IpScanHistory;
}

export interface IpGroup extends LumicsResource {
  readonly name?: string;
  readonly description?: string;
  /** Documented values are {@link IpGroupType}; typed wider because spec §9.3 documents no enum. */
  readonly type?: string;
  readonly parent?: ObjectId | null;
}

export interface IpSubnet extends LumicsResource {
  readonly network?: string;
  readonly netmask?: string;
  readonly cidr?: number;
  readonly description?: string;
  readonly vlan?: string;
  readonly vrf?: string;
  readonly component?: ObjectId;
  readonly collector?: ObjectId;
  readonly ipamDiscoveryRule?: ObjectId;
  readonly excludeFromScheduledScan?: boolean;
  readonly scanNetworkAndBroadcast?: boolean;
  readonly lastScan?: string;
  readonly scanProgress?: number;
  readonly addressCount?: number;
  readonly usedCount?: number;
  readonly parent?: ObjectId | null;
  readonly customProperties?: readonly CustomPropertyValue[];
}

// ---------------------------------------------------------------------------
// Me / tokens — spec §11
// ---------------------------------------------------------------------------

export interface MeCompany {
  readonly id?: ObjectId;
  readonly name?: string;
  readonly timezone?: string;
  readonly isActive?: boolean;
  readonly [key: string]: unknown;
}

export interface Me {
  readonly id?: ObjectId;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  /** Example value `"user"`; no enumeration documented. */
  readonly role?: string;
  readonly adminGroup?: ObjectId | null;
  readonly company?: MeCompany;
  readonly [key: string]: unknown;
}

/** spec §11.4. */
export interface RevokeTokensResponse {
  readonly message?: string;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Metrics — spec §12
// ---------------------------------------------------------------------------

export type MetricInterval = (typeof METRIC_INTERVALS)[number];
export type MetricSumProperty = (typeof METRIC_SUM_PROPERTIES)[number];

/**
 * `stats` is a two-level map: type bucket → property → value. The leaf is a
 * number, a string, a `{status, text}` object, or a `{min,max,avg}` or `{sum}`
 * rollup depending on the aggregation mode (spec §12.1, §12.2, §12.3).
 */
export type MetricStats = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * One metric row. `_id` is an ObjectId for `type: "standard"` results and an
 * integer bucket index for aggregated ones (spec §12.2) — the vendor overloads
 * the field, so the type does too.
 */
export interface MetricDataPoint {
  readonly _id?: ObjectId | number;
  readonly item?: ObjectId;
  readonly type?: string;
  readonly timeMs?: number;
  readonly count?: number;
  readonly countAggDocs?: number;
  readonly parentId?: ObjectId;
  readonly parentName?: string;
  readonly stats?: MetricStats;
  readonly [key: string]: unknown;
}

/** Timing and effective-window metadata every metric envelope carries. */
export interface MetricEnvelopeMeta {
  readonly preQueryMs?: number;
  readonly queryMs?: number;
  readonly combineMs?: number;
  readonly timeInterval?: number;
  readonly timeIncrement?: number;
  /** Effective window, which may differ from the request when `alignTimeRange`. */
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly from?: string;
  readonly to?: string;
  /** Aggregation mode actually used: `standard`, `minMaxAvg` or `summed`. */
  readonly type?: string;
  readonly components?: number;
  readonly [key: string]: unknown;
}

/** spec §12.1–§12.3: `{ data: [...], <meta> }`. */
export interface MetricSeriesResponse extends MetricEnvelopeMeta {
  readonly data?: readonly MetricDataPoint[];
}

/** spec §12.4: `data` is an **object** keyed by item class (e.g. `devices`). */
export interface MetricSummariesResponse extends MetricEnvelopeMeta {
  readonly data?: Readonly<Record<string, readonly MetricSummaryItem[]>>;
  readonly count?: number;
}

export interface MetricSummaryItem {
  readonly _id?: ObjectId;
  readonly name?: string;
  readonly parents?: readonly unknown[];
  readonly stats?: MetricStats;
  readonly [key: string]: unknown;
}
