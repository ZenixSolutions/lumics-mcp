/**
 * Reusable zod fragments for tool input schemas.
 *
 * Two reasons this is a shared module rather than per-tool literals:
 *
 *  - **Consistency of description text.** `standards/ai-interface-standard.md`
 *    and RFC-001 D5 make the tool surface the public contract. A model that
 *    learns "id" means "24-character hex" from one tool should not have to
 *    relearn it from the next.
 *  - **Validation that actually validates.** The prototype accepted any string
 *    as an IP address and any string as an id. Here an ObjectId must match
 *    24 hex characters and an IP address must parse as one, so malformed input
 *    fails locally with a useful message instead of costing a 400 round trip.
 *
 * zod 4 notes for contributors: `z.record()` takes **two** arguments
 * (`z.record(keyType, valueType)`), error customisation uses the `error` option
 * or a bare string, and `z.ipv4()` / `z.ipv6()` are first-class.
 */

import { z } from 'zod';
import {
  DEFAULT_LIST_LIMIT,
  IP_ADDRESS_STATES,
  IP_GROUP_TYPES,
  MAX_LIST_LIMIT,
  METRIC_INTERVALS,
  METRIC_SUM_PROPERTIES,
  OBJECT_ID_PATTERN,
} from '../constants.js';

/** Every Lumics identifier is a 24-character hex MongoDB ObjectId. */
export const objectIdSchema = z
  .string()
  .trim()
  .regex(
    OBJECT_ID_PATTERN,
    'must be a 24-character hexadecimal Lumics id (for example 5628b8174b6cf000001bf163); names, IP addresses and numeric ids are not accepted',
  );

/** `companyId` on any tool: optional, defaulting to `LUMICS_COMPANY_ID`. */
export const companyIdSchema = objectIdSchema
  .optional()
  .describe(
    'Lumics company id (24-character hex). Omit this to use the company configured on the server, which is correct for almost every call. A value that differs from the configured company is REFUSED unless the operator has set LUMICS_ALLOW_CROSS_COMPANY, because one Lumics token can reach several tenants — so supply it only when the operator has told you cross-company access is enabled. Use lumics_get_me to discover the id.',
  );

/**
 * `limit` on a list tool.
 *
 * spec §4.3: `limit` is the *only* result-control parameter in the entire API.
 * The description says so explicitly, because a model that assumes pagination
 * exists will otherwise report a truncated list as complete.
 */
export const listLimitSchema = z
  .int()
  .min(1)
  .max(MAX_LIST_LIMIT)
  .default(DEFAULT_LIST_LIMIT)
  .describe(
    `Maximum number of records to return (1-${String(MAX_LIST_LIMIT)}, default ${String(DEFAULT_LIST_LIMIT)}). This is the ONLY result-control parameter the Lumics API offers: there is no offset, page, cursor or sort. If the response contains exactly this many records, more may exist and cannot be paged to — raise the limit or narrow the query instead.`,
  );

/** Optional top-level field projection, to keep large lists inside the budget. */
export const fieldsSchema = z
  .array(z.string().trim().min(1))
  .max(50)
  .optional()
  .describe(
    'Optional list of top-level field names to keep in the output, e.g. ["id","name","ipAddress","enabled"]. Use this on large lists to stay inside the output budget; omit it to see every field.',
  );

/**
 * An IPv4 or IPv6 address. Validated as an address, not merely as a string — a
 * hostname, a CIDR block or a range will be rejected here rather than by Lumics.
 */
export const ipAddressSchema = z
  .union([z.ipv4(), z.ipv6()])
  .describe(
    'A single IPv4 or IPv6 address, e.g. 10.20.30.40. Not a hostname, not a CIDR block, not a range.',
  );

/** Dotted-quad netmask, e.g. `255.255.255.0` (spec §10.3). */
export const netmaskSchema = z.ipv4().describe('Dotted-quad IPv4 netmask, e.g. 255.255.255.0.');

/** IEEE 802 MAC address in colon or hyphen form. */
export const macAddressSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/,
    'must be a MAC address in colon or hyphen form, e.g. 00:1a:2b:3c:4d:5e',
  );

/** spec §8: `state` on an IP address. */
export const ipAddressStateSchema = z
  .enum(IP_ADDRESS_STATES)
  .describe('Whether the address is in use ("used") or held but not in use ("reserved").');

/** spec §9.3: `type` on an IP group. */
export const ipGroupTypeSchema = z
  .enum(IP_GROUP_TYPES)
  .describe('"group" for a plain container, "supernet" for an aggregating supernet.');

/**
 * spec §12.0: `moduleType` is the polling module name, e.g. `snmp`, `ping`,
 * `netapp`. No enumeration is documented anywhere (spec §14 defect 14).
 */
export const moduleTypeSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Lumics polling module name, e.g. "snmp", "ping" or "netapp". Lumics documents no fixed list; discover valid values from a device\'s "modules" map (the module field inside it, which is not always the map key) or from lumics_list_component_types.',
  );

/**
 * spec §12.0: `itemType` is a component type string such as
 * `snmp_f5_f5pools`, or the literal `device` on the summaries endpoint.
 */
export const itemTypeSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Component type to restrict results to, e.g. "snmp_f5_f5pools" or "snmp_cisco_envmonfan". Use "device" to summarise device-level rather than component-level metrics. Discover valid values with lumics_list_component_types.',
  );

/** spec §12.0: `properties` is a comma-separated list of metric property paths. */
export const metricPropertiesSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Comma-separated metric property paths to include, e.g. "status" or "aggr-space-attributes.size-used" or "status,Integer.statusEnabledState". Narrowing this is the single most effective way to keep a metric response inside the output budget.',
  );

/** spec §12.0: `interval` overrides the rollup granularity. Exactly four values. */
export const metricIntervalSchema = z
  .enum(METRIC_INTERVALS)
  .describe(
    'Override the metric rollup granularity. One of "minute", "fiveMin", "hour", "day". Leave this unset unless you have a specific reason — Lumics picks an appropriate rollup from the time range and requested resolution.',
  );

/** spec §12.2: `sum` is a *string* naming the rollup property to sum. */
export const metricSumSchema = z
  .enum(METRIC_SUM_PROPERTIES)
  .describe(
    'Sum across components instead of averaging, using this per-component rollup property. One of "min", "max", "avg" — it is a property NAME, not a boolean. Omit it entirely to average across components.',
  );

/**
 * Time window shape shared by every metric tool.
 *
 * spec §12.0 takes `fromMs`/`toMs` in epoch milliseconds. RFC-001 D5 item 1
 * forbids making the model compute those, so tools accept ISO-8601 or a relative
 * lookback and `src/util/time.ts` converts. Spread this into a tool's schema.
 */
export const timeRangeShape = {
  lookback: z
    .string()
    .trim()
    .regex(/^\d{1,6}[mhd]$/, 'must be an integer followed by m, h or d, e.g. 15m, 6h, 7d or 30d')
    .optional()
    .describe(
      'Relative time window ending now, e.g. "15m", "6h", "7d", "30d". This is the easiest and preferred way to specify a window. Defaults to the last 1 hour, matching the Lumics default. Do not combine with "from".',
    ),
  from: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Start of the window as an ISO-8601 timestamp WITH an explicit zone, e.g. "2026-07-29T14:00:00Z" or "2026-07-29T14:00:00+02:00". The zone is required: a timestamp with a time but no zone is rejected rather than guessed at, because it would be read in the server\'s timezone and silently shift your window. A bare date "2026-07-29" is accepted and means 00:00:00Z. Use this only when you need an exact window; otherwise use "lookback". Do not combine with "lookback". You never need to compute epoch milliseconds — this server does that.',
    ),
  to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'End of the window as an ISO-8601 timestamp with an explicit zone, e.g. "2026-07-29T18:00:00Z". Defaults to now. Must not be in the future: monitoring data only exists for the past, so a future value is rejected rather than quietly reporting a window wider than the data.',
    ),
} as const;

/**
 * spec §12.0: `dataPoints` **or** `width` is required on all four metric-data
 * endpoints, and the prototype sent neither — which is why its metric tools
 * cannot reliably have worked. The default here (see `DEFAULT_METRIC_DATA_POINTS`)
 * means a model never has to know that (RFC-001 D5 item 2).
 */
export const metricDataPointsSchema = z
  .int()
  .min(1)
  .max(5_000)
  .optional()
  .describe(
    'Number of data points to return across the window. Defaults to a sensible resolution; raise it for a finer graph, lower it to shrink the response. Set this to 1 together with lastMetric=true to fetch current status only.',
  );

/** spec §12.0: `lastMetric` reduces a series to its most recent point. */
export const lastMetricSchema = z
  .boolean()
  .optional()
  .describe(
    'Return only the most recent metric matching the criteria. Use this for "what is the current status" questions — it is far cheaper than fetching a series and reading the last element.',
  );

/** spec §12.0: `isMonitored` filters out components that report nothing. */
export const isMonitoredSchema = z
  .boolean()
  .optional()
  .describe(
    'Restrict results to components Lumics is actively monitoring, which filters out empty results.',
  );

/**
 * The confirmation flag the factory injects on `admin` and `destructive` tools.
 *
 * Exported for documentation and tests only — tools must **not** declare it
 * themselves; `defineTool` adds it so it cannot be forgotten. See the comment on
 * `requiresConfirmation` in `src/tools/factory.ts` for why this is a speed bump
 * and not a control.
 */
export const confirmSchema = z
  .literal(true)
  .describe(
    'Must be exactly true to proceed. This operation changes or removes data in the live Lumics tenant. Before setting it, state to the user what will change and confirm they want it.',
  );

/** Assert an ObjectId outside a zod schema, e.g. on a config-derived default. */
export function isObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}
