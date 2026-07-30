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
  METRIC_PROPERTY_TYPE_GROUPS,
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
 * spec §12.0: `itemType` is a component type string.
 *
 * **The spec's own examples and `lumics_list_component_types` both hand out the
 * wrong form.** The metrics API wants the *singular* component id — `snmp_common_cpu`
 * — while spec §6.4 `componenttypes` returns *plural* aliases (`snmp_common_cpus`),
 * and 213 of the 246 values it returns are rejected here with
 * `400 Unknown component <value>`. The correct id is constructible from spec §6.5
 * (`lumics_get_device_definition_components`): the module and group segments of
 * `filePath` joined to the singular `data.itemType` with underscores, so
 * `/components/snmp/common/Cpu.yml` plus `itemType: "cpu"` gives `snmp_common_cpu`.
 * A §12.1 response row's own `type` field also carries the correct id.
 *
 * The description says all of this because a model has no other way to find out:
 * the failure is a 400 with a message that names the value but not the rule, and
 * `itemType` is validated *before* `properties`, so a wrong `itemType` masks a
 * `properties` problem entirely.
 */
export const itemTypeSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Component type id to restrict results to. It must be the SINGULAR component id the metrics API uses — "snmp_common_cpu", not "snmp_common_cpus" — or the literal "device" for device-level rather than component-level metrics. Do NOT take this value from lumics_list_component_types: that endpoint returns PLURAL aliases and most of them are rejected here with 400 "Unknown component" (e.g. "snmp_common_cpus", "cpus" and "cpu" all fail where "snmp_common_cpu" succeeds). Build the id from lumics_get_device_definition_components instead: take the module and group from an entry\'s "filePath" (/components/snmp/common/Cpu.yml gives snmp and common) and the singular "data.itemType" (cpu), and join the three with underscores — snmp_common_cpu. The "type" field on a row returned by lumics_get_company_metrics or lumics_get_device_metrics is also a correct id, so one unfiltered call is a way to discover them. Note that Lumics validates itemType BEFORE properties: a wrong value here returns 400 "Unknown component <value>" and hides any problem with your properties, so fix itemType first.',
  );

/**
 * The `<TypeGroup>.<metric>` shape a metric property path has to have.
 *
 * Written as prose once because it appears in the schema error, in the property
 * descriptions, and in the runtime disclosure in `./metrics.ts` — three places
 * that must not drift apart.
 */
export const METRIC_PROPERTY_SYNTAX =
  'Each entry must be written as "<TypeGroup>.<metric>" with no spaces, e.g. "Calculated.cpu", "TimeTicks.sysUpTime" or "Calculated.cpu,Calculated.mem". Type groups seen on live tenants are ' +
  METRIC_PROPERTY_TYPE_GROUPS.join(', ') +
  ' (there is no "Counter" or "Gauge" group). Use lumics_get_metric_summary to enumerate the legal names for a module: in its response, the outer keys of an item\'s "stats" are the type groups and the inner keys are the metric names, so join them with a dot.';

/**
 * True when at least one comma-separated entry looks like `Group.metric`.
 *
 * Deliberately the weakest check that still catches the measured trap. A bare
 * name — `properties=cpu` — is not rejected by Lumics: it answers **200** with the
 * full row count and every `stats` object empty, which reads as "this metric has
 * no data" and is the single most dangerous behaviour on this API. Requiring
 * *every* entry to carry a dot would be stronger, but nothing has established that
 * no bare name is ever legal, so a value that pairs a dotted entry with a bare one
 * is allowed through and left to the runtime disclosure in `./metrics.ts` to
 * report. What is rejected is the case with no dotted entry at all, which has been
 * measured to produce nothing but empty stats.
 */
function hasQualifiedProperty(value: string): boolean {
  return value.split(',').some((entry) => {
    const trimmed = entry.trim();
    const dot = trimmed.indexOf('.');
    return dot > 0 && dot < trimmed.length - 1;
  });
}

/**
 * spec §12.0 `properties` on the four metric-data endpoints (§12.1–§12.3).
 *
 * **Required, though the spec lists it optional.** All four answer
 * `400 {"error":"Must supply required component metrics as properties parameter"}`
 * without it, so every metric call this server made was failing. It is required
 * here rather than defaulted because there is no metric name that is right for
 * every module, and inventing one would answer a question nobody asked.
 *
 * The 400 gate upstream only checks that the parameter is present and non-empty —
 * never that its value means anything — hence {@link hasQualifiedProperty}.
 */
export const metricPropertiesSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    hasQualifiedProperty,
    `must name at least one metric as "<TypeGroup>.<metric>". A bare name like "cpu" is NOT rejected by Lumics: it answers 200 with the full row count and empty stats on every row, which reads as "no data exists" when in fact nothing was asked for. ${METRIC_PROPERTY_SYNTAX}`,
  )
  .describe(
    `REQUIRED. Comma-separated metric property paths to read. ${METRIC_PROPERTY_SYNTAX} Omitting this returns 400 "Must supply required component metrics as properties parameter" — the Lumics documentation calls it optional and is wrong. An unrecognised name is NOT an error either: Lumics answers 200 with rows whose "stats" are empty, so a misspelled property looks exactly like a metric with no data. This server detects that case and says so, but getting the name right first is cheaper. Narrowing this is also the single most effective way to keep a metric response inside the output budget.`,
  );

/**
 * spec §12.4 `properties`, which is a different parameter wearing the same name.
 *
 * Optional here, and it acts as a **filter** rather than as a projection: supplying
 * it on a live tenant emptied a response that was otherwise full. So it is offered,
 * but the description tells the caller to start without it — and
 * `getMetricSummary` discloses it as the first suspect when the result is empty.
 */
export const metricSummaryPropertiesSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    hasQualifiedProperty,
    `must name at least one metric as "<TypeGroup>.<metric>". ${METRIC_PROPERTY_SYNTAX}`,
  )
  .describe(
    `Optional metric property filter, comma-separated. ${METRIC_PROPERTY_SYNTAX} On THIS endpoint it behaves as a FILTER, not as a projection: supplying it has been observed to empty a response that was otherwise full, so start WITHOUT it — the unfiltered response is also how you discover which property names exist, and it is the only enumeration path this API has.`,
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
