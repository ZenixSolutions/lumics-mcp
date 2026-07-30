/**
 * Metric tools — all five endpoints of spec §12.
 *
 * Built on the pattern established by `./devices.ts`; read that first. What is
 * specific to metrics, and what the prototype got wrong, is the parameter
 * surface, so that is what this comment is about.
 *
 * **The prototype exposed an untyped `query` object passthrough** and told the
 * model to ask the *user* to open browser dev tools to discover parameter names.
 * That is not an API contract, it is an invitation to guess. spec §12.0 documents
 * every parameter these endpoints take; all of them are typed below, and the four
 * that are withheld are withheld for a stated reason.
 *
 * Four facts from spec §12 shape every tool here, each of them a prototype defect:
 *
 *  1. **`dataPoints` or `width` is REQUIRED** on the four metric-data endpoints,
 *     and `width` wins if both are sent. The prototype sent neither, so its metric
 *     tools cannot reliably have worked at all. Per RFC-001 D5 item 2 this server
 *     always sends a resolution, defaulting to `DEFAULT_METRIC_DATA_POINTS`, and
 *     says so in every tool description and in the output notes.
 *  2. **`sum` is a string enum (`min` | `max` | `avg`), not a boolean.** The
 *     prototype typed it boolean, which makes every summarize call malformed.
 *     Its meaning is "which property to use when summing the data for each
 *     component": presence switches the cross-component reduction from average to
 *     sum, and the value picks the per-component rollup property that feeds it.
 *  3. **The window is `fromMs`/`toMs` in epoch milliseconds**, defaulting to one
 *     hour ago and now. Raw epoch integers are never exposed to a model
 *     (RFC-001 D5 item 1): tools take `lookback`/`from`/`to` via the shared
 *     `timeRangeShape` and `../util/time.js` does the conversion.
 *  4. **`interval` is an enum of exactly four values** — `minute`, `fiveMin`,
 *     `hour`, `day` — and is optional because Lumics chooses one from the range
 *     and the requested resolution when it is omitted.
 *
 * Two deliberate reductions of the documented surface:
 *
 *  - **`componentQuery` and `filters` are not exposed, at all, anywhere.** They
 *    accept raw Mongo query expressions (spec §12.0). Handing a language model a
 *    raw database query language is a NoSQL injection and unbounded-query surface.
 *    This is an owner-approved capability reduction recorded in
 *    **ADR-002 decision 3** (and RFC-001 D6 / open question 2), not an oversight —
 *    the typed `itemType`, `isMonitored` and `properties` arguments cover the
 *    documented use cases. Do not add them back here; that needs a superseding ADR
 *    and an explicit opt-in flag.
 *  - **`width` is not exposed.** It is a pixel-width proxy for the same quantity
 *    as `dataPoints` ("the width of the graph in pixels, used to infer the number
 *    of data points"), it silently overrides `dataPoints` when both are sent, and a
 *    model has no graph. Two arguments that mean one thing, one of which wins
 *    invisibly, is a way to be wrong; `dataPoints` alone is the honest surface.
 *
 * Note also that `limit` (how many result rows come back, spec §4.3) and
 * `dataPoints` (the time resolution of a series) are different parameters that are
 * easy to conflate. They are kept separate here, and their descriptions say which
 * is which.
 */

import { z } from 'zod';
import { isAbsentBody, type QueryParams } from '../api/client.js';
import { LumicsApiError } from '../api/errors.js';
import {
  companyMetricsPath,
  companyMetricsSummarizePath,
  deviceItemMetricsPath,
  deviceMetricsPath,
  metricSummariesPath,
} from '../api/paths.js';
import {
  DEFAULT_METRIC_DATA_POINTS,
  MAX_LIST_LIMIT,
  METRIC_MIN_INTERVALS_DEFAULT,
} from '../constants.js';
import type { MetricDataPoint, MetricEnvelopeMeta, MetricSummaryItem } from '../domain/index.js';
import { fitKeyedArraysToBudget, projectFields } from '../presentation/format.js';
import { describeSpan, resolveTimeRange, type TimeRange } from '../util/time.js';
import { defineTool, result, type LumicsToolDefinition } from './factory.js';
import {
  companyIdSchema,
  fieldsSchema,
  isMonitoredSchema,
  itemTypeSchema,
  lastMetricSchema,
  metricDataPointsSchema,
  metricIntervalSchema,
  metricPropertiesSchema,
  metricSumSchema,
  moduleTypeSchema,
  objectIdSchema,
  timeRangeShape,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Parameter fragments that exist only on metric endpoints
// ---------------------------------------------------------------------------

/** spec §12.0 `aggregate`: "Enable/disable on-the-fly aggregation of results". */
const aggregateSchema = z
  .boolean()
  .optional()
  .describe(
    'Enable on-the-fly aggregation of results, so the points returned are rollups computed to match the requested number of data points rather than raw samples. Leave unset unless a series comes back larger or noisier than you need.',
  );

/** spec §12.0 `alignTimeRange`: snaps the window to natural boundaries. */
const alignTimeRangeSchema = z
  .boolean()
  .optional()
  .describe(
    'Snap the time range to natural boundaries (hour, day, month) before querying. Useful when comparing buckets between calls, but note that Lumics then returns data for the snapped window, which will differ from the window you asked for — the response notes state the effective window.',
  );

/** spec §12.0 `minIntervals`: rollup-eligibility threshold, default 40. */
const minIntervalsSchema = z
  .int()
  .min(1)
  .max(10_000)
  .optional()
  .describe(
    `How many intervals must fall inside the time range for a given metric rollup collection to be eligible. Lumics defaults this to ${String(METRIC_MIN_INTERVALS_DEFAULT)}. Lowering it lets Lumics use a coarser rollup over a short window, which is how the vendor's own summarize example gets buckets out of a ten-hour range. Leave unset unless a query returns nothing you expected.`,
  );

/**
 * `limit` on a metric endpoint (spec §12.0: "Maximum number of results to
 * return").
 *
 * **No default, unlike the list tools.** `limit` is optional upstream, and a
 * default would be this server capping a *time series* on the model's behalf:
 * a 24-hour window at the default resolution across 40 components is ~2,400
 * rows, so a cap of 100 would return four per cent of them, cut in an order
 * Lumics does not document — across time as well as across components. An
 * incomplete inventory looks incomplete; a series with holes looks like data.
 * The cap also cannot be escaped by asking for more, because the maximum is
 * 1,000. So nothing is sent unless the caller asks for it, and the output budget
 * — which sheds from the end and says how many rows it shed — does the shaping
 * instead. It shares `MAX_LIST_LIMIT` and the no-pagination caveat with
 * `listLimitSchema` in `./schemas.ts` but deliberately not its `.default()`.
 */
const metricLimitSchema = z
  .int()
  .min(1)
  .max(MAX_LIST_LIMIT)
  .optional()
  .describe(
    `Optional cap on the number of metric ROWS Lumics returns (1-${String(MAX_LIST_LIMIT)}). This is a result-count cap, NOT the time resolution — resolution is "dataPoints". Leave it unset unless you specifically want a cap: this server sends no limit by default, so Lumics returns every matching row and any shortening happens in the output budget, which drops rows from the END of the response and reports how many. Setting it is usually the wrong tool for a large response, because a metric result has one row per component per time bucket and Lumics applies the cap in an undocumented order, so a cap can cut across TIME as well as across components and leave a series with holes that look like real gaps. Narrow with itemType, properties, a shorter window or lastMetric instead. There is no offset, page or cursor, so capped rows cannot be paged to.`,
  );

/**
 * Resolution and rollup controls, shared by the four metric-data endpoints
 * (spec §12.0). `width` is absent by design — see the module comment.
 */
const metricResolutionShape = {
  dataPoints: metricDataPointsSchema,
  interval: metricIntervalSchema.optional(),
  minIntervals: minIntervalsSchema,
  aggregate: aggregateSchema,
  alignTimeRange: alignTimeRangeSchema,
} as const;

/**
 * Result-selection controls shared by the four metric-data endpoints.
 * `componentQuery` and `filters` are absent by design — ADR-002 decision 3.
 */
const metricSelectionShape = {
  properties: metricPropertiesSchema.optional(),
  lastMetric: lastMetricSchema,
  isMonitored: isMonitoredSchema,
  limit: metricLimitSchema,
} as const;

// ---------------------------------------------------------------------------
// Shared request construction
// ---------------------------------------------------------------------------

/**
 * The subset of a tool's arguments that maps onto spec §12.0 query parameters.
 * Every field is optional so one builder serves all four data endpoints; the
 * ones an endpoint does not document are simply never present.
 */
interface MetricQueryArgs {
  readonly lookback?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly dataPoints?: number | undefined;
  readonly interval?: string | undefined;
  readonly minIntervals?: number | undefined;
  readonly aggregate?: boolean | undefined;
  readonly alignTimeRange?: boolean | undefined;
  readonly properties?: string | undefined;
  readonly lastMetric?: boolean | undefined;
  readonly isMonitored?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly itemType?: string | undefined;
  readonly sum?: string | undefined;
}

interface MetricRequest {
  readonly query: QueryParams;
  readonly range: TimeRange;
  readonly dataPoints: number;
  /** True when the caller sent no resolution and this server supplied one. */
  readonly dataPointsDefaulted: boolean;
  /** The row cap the caller asked for, or `undefined` when none was sent. */
  readonly limit: number | undefined;
}

/**
 * Turn tool arguments into the documented query surface.
 *
 * Two pieces of logic worth naming, and they pull in opposite directions on
 * purpose:
 *
 *  - `dataPoints` is **always** sent. spec §12.0 makes `dataPoints` or `width`
 *    required and a model has no way to know that, so omitting it would turn a
 *    reasonable call into a 400 (RFC-001 D5 item 2).
 *  - `limit` is **only** sent when the caller supplied one. It is optional
 *    upstream, and supplying one on the model's behalf silently truncates a time
 *    series (see {@link metricLimitSchema}).
 */
function buildMetricRequest(args: MetricQueryArgs): MetricRequest {
  const range = resolveTimeRange({
    from: args.from,
    to: args.to,
    lookback: args.lookback,
  });
  const dataPoints = args.dataPoints ?? DEFAULT_METRIC_DATA_POINTS;

  return {
    range,
    dataPoints,
    dataPointsDefaulted: args.dataPoints === undefined,
    limit: args.limit,
    query: {
      // spec §12.0: epoch milliseconds, produced by ../util/time.js so the model
      // never computes them.
      fromMs: range.fromMs,
      toMs: range.toMs,
      dataPoints,
      interval: args.interval,
      minIntervals: args.minIntervals,
      aggregate: args.aggregate,
      alignTimeRange: args.alignTimeRange,
      properties: args.properties,
      lastMetric: args.lastMetric,
      isMonitored: args.isMonitored,
      limit: args.limit,
      itemType: args.itemType,
      sum: args.sum,
    },
  };
}

/**
 * Why an empty metric result is empty.
 *
 *  - `none` — Lumics sent an envelope with a `data` array. An empty array here is
 *    a real, positive answer: nothing was measured in the window. Nothing to
 *    disclose, exactly as a list tool stays silent on a genuine `[]`.
 *  - `body` — no response body at all (a 204 or an empty 200), which
 *    `src/api/client.ts` maps to `null`. There is no series in that; the emptiness
 *    is ours, not the estate's.
 *  - `data` — an envelope arrived but its documented `data` field was absent or
 *    `null`. Same conclusion as `body`: nothing licenses "no measurements exist".
 */
type SeriesAbsence = 'none' | 'body' | 'data';

interface MetricSeriesResult {
  readonly points: readonly MetricDataPoint[];
  readonly meta: MetricEnvelopeMeta;
  readonly absence: SeriesAbsence;
}

/**
 * Unwrap `{ data: [ ... ], <meta> }` (spec §12.1–§12.3).
 *
 * The envelope's metadata is not discarded: the effective window, the rollup size
 * and the aggregation mode Lumics actually used are reported as notes, because
 * `alignTimeRange` and rollup selection mean the window you get is not always the
 * window you asked for, and a series read as if it were the requested window is
 * quietly wrong.
 *
 * Neither is the *reason* the series is empty discarded — see {@link SeriesAbsence}
 * and {@link absentSeriesNote}. An absent body and an empty series are the same
 * `[]` here and the API gives no way to tell them apart afterwards, so the
 * distinction has to be carried out of this function or it is lost.
 */
function unwrapMetricSeries(response: unknown, operation: string): MetricSeriesResult {
  if (isAbsentBody(response)) {
    return { points: [], meta: {}, absence: 'body' };
  }
  if (!isRecord(response)) {
    throw LumicsApiError.invalidResponse(
      operation,
      'a metric envelope object with a "data" array was documented (spec section 12.1) but the body was not an object',
    );
  }

  const { data, ...meta } = response;
  if (data === undefined || data === null) {
    return { points: [], meta, absence: 'data' };
  }
  if (!Array.isArray(data)) {
    throw LumicsApiError.invalidResponse(
      operation,
      'the metric envelope\'s "data" field was documented as an array (spec section 12.1) but was not one',
    );
  }
  return { points: data as readonly MetricDataPoint[], meta, absence: 'none' };
}

/**
 * Unwrap `{ data: { devices: [ ... ] }, count, <meta> }` (spec §12.4).
 *
 * This endpoint's `data` is an **object keyed by item class**, not an array like
 * the other four. `devices` is the only key the vendor documents; others are
 * presumed to exist for component item types but none are named, so the keys are
 * read rather than assumed.
 */
function unwrapMetricSummaries(
  response: unknown,
  operation: string,
): {
  readonly classes: Readonly<Record<string, readonly MetricSummaryItem[]>>;
  readonly count: number | undefined;
  readonly meta: MetricEnvelopeMeta;
  readonly absence: SeriesAbsence;
} {
  if (isAbsentBody(response)) {
    return { classes: {}, count: undefined, meta: {}, absence: 'body' };
  }
  if (!isRecord(response)) {
    throw LumicsApiError.invalidResponse(
      operation,
      'a metric summary envelope object was documented (spec section 12.4) but the body was not an object',
    );
  }

  const { data, count, ...meta } = response;
  const classes: Record<string, readonly MetricSummaryItem[]> = {};
  const absence: SeriesAbsence = data === undefined || data === null ? 'data' : 'none';

  if (data !== undefined && data !== null) {
    if (!isRecord(data)) {
      throw LumicsApiError.invalidResponse(
        operation,
        'the summary envelope\'s "data" field was documented as an object keyed by item class, e.g. {"devices": [...]} (spec section 12.4), but was not an object',
      );
    }
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        classes[key] = value as readonly MetricSummaryItem[];
      }
    }
  }

  return {
    classes,
    count: typeof count === 'number' ? count : undefined,
    meta,
    absence,
  };
}

/**
 * The disclosure an empty metric result owes its caller when the emptiness came
 * from the transport rather than from the estate.
 *
 * This is deliberately **not** `ABSENT_BODY_LIST_NOTE` (`src/api/client.ts`), for the same reason
 * {@link metricRowCapNote} is not the list truncation note: an empty list reads as
 * "no records", but an empty *series* reads as "this device reported nothing in
 * that window" — a load-bearing operational claim about monitoring, and one a
 * model will state with confidence. So the wording names the specific wrong
 * conclusions (silent device, unmonitored, down) rather than a record count.
 *
 * Returns `undefined` for `none`, including for a present-but-empty `data: []`.
 * That case is a genuine answer and gets no note, matching how the list tools stay
 * silent on a real empty array.
 */
function absentSeriesNote(
  absence: SeriesAbsence,
  subject: 'series' | 'summaries',
): string | undefined {
  if (absence === 'none') {
    return undefined;
  }

  const cause =
    absence === 'body'
      ? 'Lumics returned no response body at all for this metric read — an empty 200 or a 204 — rather than the documented metric envelope'
      : 'Lumics returned a metric envelope whose documented "data" field was absent or null, rather than the documented set of results';

  const shape =
    subject === 'series'
      ? 'The series below is empty because there was nothing to unwrap, NOT because the components you asked about reported no measurements in this window.'
      : 'The summary below is empty because there was nothing to unwrap, NOT because no device or component matched this module, itemType and window.';

  return (
    `NOTE ON AN EMPTY RESULT: ${cause}. ${shape} Those are different facts and the Lumics API does not ` +
    'distinguish them (spec section 4.2 documents a body for every operation). This server reports zero rows ' +
    'because there is nothing else it can do. Do NOT tell the user that this device, component or company is ' +
    'reporting no metrics, is unmonitored, is idle, or is down on the strength of this response, and do not read ' +
    'the emptiness as a gap in the monitoring data: re-run the call, and if it is still empty verify in the ' +
    'Lumics UI before reporting anything about what was or was not measured.'
  );
}

/** One note covering the requested window, the resolution sent, and what came back. */
function metricSeriesNotes(request: MetricRequest, series: MetricSeriesResult): string[] {
  const { meta } = series;
  const requested =
    `WINDOW AND RESOLUTION: requested ${formatIso(request.range.fromMs)} to ` +
    `${formatIso(request.range.toMs)} (${describeSpan(request.range.toMs - request.range.fromMs)}) at ` +
    `dataPoints=${String(request.dataPoints)}` +
    (request.dataPointsDefaulted
      ? " — this server's default, because the Lumics API requires either dataPoints or width and rejects a metric call with neither. Pass dataPoints yourself for a finer or coarser series."
      : '.');

  // The absence disclosure leads, because it is the one note that changes what
  // the rest of the response means.
  const absent = absentSeriesNote(series.absence, 'series');
  const notes = absent === undefined ? [] : [absent];
  notes.push(requested, metricRowCapNote(request.limit));

  const effective = describeEffectiveWindow(meta);
  if (effective !== undefined) {
    notes.push(effective);
  }
  return notes;
}

/**
 * What shortened the rows, and along which dimension.
 *
 * This is deliberately not the list-completeness wording. A metric response is
 * one row per component per time bucket, so losing rows is losing points out of a
 * *series*: the resulting shape still looks like a valid time series, which is
 * why it has to be described as a series problem rather than as an inventory that
 * "may have more records".
 */
function metricRowCapNote(limit: number | undefined): string {
  if (limit === undefined) {
    return (
      'ROW COUNT: no result cap was sent to Lumics — the API\'s "limit" parameter is optional here and this server ' +
      'does not supply one, so Lumics returned every row that matched. If the response below was still shortened, ' +
      "it was shortened by this server's output budget, which drops rows from the END of the order Lumics returned " +
      'and says so in a separate truncation note. A series shortened that way is missing its TAIL, not scattered ' +
      'points: read the remaining points as covering only part of the requested window.'
    );
  }
  return (
    `ROW COUNT: you asked for at most ${String(limit)} row(s) and Lumics applied that cap. A metric result carries ` +
    'one row per component per time bucket and Lumics documents no ordering for these rows, so this cap can cut ' +
    'across TIME as well as across components: the series below may have holes that look like real gaps in the ' +
    'monitoring data, and a component may appear for only part of the window. There is no offset, page or cursor, ' +
    'so the omitted rows cannot be fetched. Do not read a gap as a missing measurement. To shrink a response ' +
    'without mutilating the series, narrow "properties" or "itemType", use a shorter window, or set lastMetric ' +
    'true for current values only — and drop this limit.'
  );
}

/** What Lumics actually served, which `alignTimeRange` and rollups can change. */
function describeEffectiveWindow(meta: MetricEnvelopeMeta): string | undefined {
  const from = meta.from ?? (typeof meta.fromMs === 'number' ? formatIso(meta.fromMs) : undefined);
  const to = meta.to ?? (typeof meta.toMs === 'number' ? formatIso(meta.toMs) : undefined);

  const details: string[] = [];
  if (from !== undefined && to !== undefined) {
    details.push(`covers ${from} to ${to}`);
  }
  if (typeof meta.timeIncrement === 'number') {
    details.push(`one bucket per ${String(meta.timeIncrement)} ms`);
  }
  if (typeof meta.type === 'string') {
    details.push(`aggregation mode "${meta.type}"`);
  }
  if (typeof meta.components === 'number') {
    details.push(`${String(meta.components)} component(s) aggregated`);
  }

  if (details.length === 0) {
    return undefined;
  }
  return `EFFECTIVE RESULT: Lumics reports the returned data ${details.join(', ')}. Where this differs from the requested window, the effective window is the one the data describes.`;
}

function formatIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// spec §12.1 — company metrics, per item
// ---------------------------------------------------------------------------

/**
 * spec §12.1 `GET /metrics/companies/:companyId/modules/:moduleType`.
 * Full shared query set, without `sum`.
 */
const getCompanyMetrics = defineTool({
  name: 'lumics_get_company_metrics',
  title: 'Get company metrics per item',
  operation: 'read',
  description:
    'Get metrics for every monitored component of one polling module across a whole Lumics company, returning a separate row per item per time bucket with its stats. Use this to answer "what does X look like across the estate" — for example the status of every F5 pool, or CPU on every switch. Two settings make the difference between a usable answer and a wall of numbers: set "properties" to just the metric paths you care about, and set lastMetric true when you want current values rather than a time series. The window defaults to the last 1 hour. A resolution is always sent because the Lumics API requires one; it defaults to 60 data points across the window unless you pass dataPoints. For a total or an average across components rather than a row per component, use lumics_summarize_company_metrics; for one device, use lumics_get_device_metrics.',
  inputSchema: {
    moduleType: moduleTypeSchema,
    companyId: companyIdSchema,
    itemType: itemTypeSchema.optional(),
    ...timeRangeShape,
    ...metricResolutionShape,
    ...metricSelectionShape,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const request = buildMetricRequest(args);
    const operation = `GET company metrics ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      companyMetricsPath(companyId, args.moduleType),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    return result(series.points, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: metricSeriesNotes(request, series),
    });
  },
});

// ---------------------------------------------------------------------------
// spec §12.2 — company metrics, aggregated into time buckets
// ---------------------------------------------------------------------------

/**
 * spec §12.2 `GET /metrics/companies/:companyId/modules/:moduleType/summarize`.
 * The shared set **plus `sum`** — the one parameter unique to this endpoint.
 */
const summarizeCompanyMetrics = defineTool({
  name: 'lumics_summarize_company_metrics',
  title: 'Summarize company metrics into time buckets',
  operation: 'read',
  description:
    'Aggregate one polling module\'s metrics across ALL matching components in a company into time buckets, giving one row per bucket rather than one row per component. Without "sum" the metrics are averaged across components; with "sum" they are added up, and the value of "sum" chooses which per-component rollup property ("min", "max" or "avg") feeds that total. Use this for estate-wide trends and totals — total aggregate space used, average CPU over the day. Each bucket also carries how many samples and component-documents it covers, and buckets with no data are omitted entirely rather than returned as zero, so do not read a gap as a zero. The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. If a short window returns nothing, lower minIntervals. For a row per component instead, use lumics_get_company_metrics. This tool CANNOT rank or identify individual devices or components: every row it returns is a time bucket covering all of them at once, and no device name or id appears in the output. If the question is "which devices are highest", "top N devices" or anything else that needs a per-device answer, use lumics_get_metric_summary instead, which returns one row per item and supports sortBy and topN. Note the confusable name: this tool summarises over TIME, lumics_get_metric_summary summarises over ITEMS.',
  inputSchema: {
    moduleType: moduleTypeSchema,
    companyId: companyIdSchema,
    itemType: itemTypeSchema.optional(),
    // spec §12.2: `sum` is a STRING naming a rollup property, not a boolean.
    sum: metricSumSchema.optional(),
    ...timeRangeShape,
    ...metricResolutionShape,
    ...metricSelectionShape,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const request = buildMetricRequest(args);
    const operation = `GET company metrics summarize ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      companyMetricsSummarizePath(companyId, args.moduleType),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    const notes = metricSeriesNotes(request, series);
    notes.push(
      args.sum === undefined
        ? 'AGGREGATION: no "sum" was requested, so each bucket below is the AVERAGE across components, not a total.'
        : `AGGREGATION: values below are SUMMED across components using each component's "${args.sum}" rollup property, so a bucket is a total and not an average.`,
    );

    return result(series.points, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes,
    });
  },
});

// ---------------------------------------------------------------------------
// spec §12.3 — device metrics
// ---------------------------------------------------------------------------

/**
 * spec §12.3 `GET /metrics/devices/:id/modules/:moduleType`.
 *
 * Full shared set without `sum`, including `itemType` — the vendor's own example
 * passes `itemType: "snmp_cisco_envmonfan"` here. There is no company in this
 * path, so no `companyId` argument: the device id alone identifies the scope.
 */
const getDeviceMetrics = defineTool({
  name: 'lumics_get_device_metrics',
  title: 'Get metrics for one device',
  operation: 'read',
  description:
    'Get metrics for the components of a single device — every fan, interface, pool or volume the named module polls on it — returning a row per component per time bucket. This is the tool for "how is this device doing": pair it with lastMetric true and a narrow "properties" list for a current-status readout, or leave lastMetric unset for a series over the window. Restrict to one kind of component with itemType when a device has many. The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. For one specific component, or for the device\'s own device-level metrics, use lumics_get_device_item_metrics.',
  inputSchema: {
    deviceId: objectIdSchema.describe('Lumics device id. Get it from lumics_list_devices.'),
    moduleType: moduleTypeSchema,
    itemType: itemTypeSchema.optional(),
    ...timeRangeShape,
    ...metricResolutionShape,
    ...metricSelectionShape,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const request = buildMetricRequest(args);
    const operation = `GET device ${args.deviceId} metrics ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      deviceMetricsPath(args.deviceId, args.moduleType),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    return result(series.points, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: metricSeriesNotes(request, series),
    });
  },
});

/**
 * spec §12.3 `GET /metrics/devices/:id/modules/:moduleType/:item`.
 *
 * Reduced query set: `componentQuery`, `filters` and `itemType` are not
 * documented here and are not offered — they are meaningless when the item is
 * already named. (`componentQuery` and `filters` are withheld everywhere anyway;
 * see ADR-002 decision 3 and the module comment.)
 */
const getDeviceItemMetrics = defineTool({
  name: 'lumics_get_device_item_metrics',
  title: 'Get metrics for one item',
  operation: 'read',
  description:
    "Get metrics for exactly one item on a device: pass the device's own id as itemId for device-level metrics such as CPU, memory or uptime, or a component id for one interface, fan, pool or volume. This is the narrowest and cheapest metric read, and the right one for charting a single series or checking one thing. Results are returned as time buckets, typically carrying min, max and avg per property along with the owning device's id and name. The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. Unlike the other metric tools this one takes no itemType, because the item is already identified.",
  inputSchema: {
    deviceId: objectIdSchema.describe('Lumics device id that owns the item.'),
    moduleType: moduleTypeSchema,
    itemId: objectIdSchema.describe(
      "Id of the item to read. Pass the device's own id for device-level metrics, or a component id (from lumics_list_components) for one component.",
    ),
    ...timeRangeShape,
    ...metricResolutionShape,
    ...metricSelectionShape,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const request = buildMetricRequest(args);
    const operation = `GET device ${args.deviceId} item ${args.itemId} metrics ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      deviceItemMetricsPath(args.deviceId, args.moduleType, args.itemId),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    return result(series.points, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: metricSeriesNotes(request, series),
    });
  },
});

// ---------------------------------------------------------------------------
// spec §12.4 — cross-device metric summaries, ranked client-side
// ---------------------------------------------------------------------------

/**
 * Sort direction for the client-side ranking. `desc` is the default because the
 * question this endpoint exists to answer is "which are the worst/biggest".
 */
const sortDirectionSchema = z
  .enum(['desc', 'asc'])
  .default('desc')
  .describe(
    'Direction for the local sort: "desc" (default) puts the largest values first, which is what a "top N" question usually means; "asc" puts the smallest first.',
  );

/**
 * spec §12.4 `GET /:context/:contextId/metrics/summaries/:moduleType`.
 *
 * **A completely different, much smaller surface.** Only `itemType`,
 * `properties`, `fromMs` and `toMs` are documented. There is no `dataPoints`, no
 * `width`, no `interval`, no `aggregate`, no `alignTimeRange`, no `minIntervals`,
 * no `isMonitored`, no `lastMetric`, no `sum` — and, despite the endpoint's own
 * description advertising "top X lists of devices", **no `limit`** either.
 *
 * So none of those are offered. Offering a parameter the endpoint ignores would
 * teach a model a false model of the API and produce answers it believes were
 * filtered when they were not.
 *
 * `topN`/`sortBy` are therefore implemented as a **client-side** ranking over the
 * full response (RFC-001 D5 item 4), and both the ranking and the absence of any
 * server-side limit are disclosed in the output notes. The alternative — leaving
 * the model to sort a large JSON blob in its head — is how a "top 10" list ends
 * up containing an eleventh device that was never checked.
 */
const getMetricSummary = defineTool({
  name: 'lumics_get_metric_summary',
  title: 'Summarize metrics across devices',
  operation: 'read',
  description:
    'Summarize one metric module across every device or component in a company that reports it, giving one row per item with its averaged and peak values over the window — the tool for "which devices have the highest CPU" or "what is memory doing estate-wide". Pass itemType "device" for device-level summaries, or a component type for component-level ones, and narrow "properties" to the metric paths you need. This endpoint has a much smaller parameter surface than the other metric tools: it accepts no resolution, interval, isMonitored, lastMetric or limit parameter of any kind, so Lumics always returns the entire matching set. The topN and sortBy arguments are therefore applied by this server AFTER fetching everything, not by Lumics, and the response says so. The window defaults to the last 1 hour. Note the confusable name: this tool summarises over ITEMS and returns no time series — one row per device or component, with values already reduced over the whole window. For an estate-wide total or average plotted over time, one row per time bucket and no per-item detail, use lumics_summarize_company_metrics instead.',
  inputSchema: {
    moduleType: moduleTypeSchema,
    companyId: companyIdSchema,
    itemType: itemTypeSchema.optional(),
    properties: metricPropertiesSchema.optional(),
    ...timeRangeShape,
    // Local ranking only. spec §12.4 documents no limit, top, sort or order
    // parameter on this endpoint, so nothing below is sent to Lumics.
    sortBy: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Dot-separated path to the numeric value to rank by, resolved inside each item\'s "stats" — for example "Calculated.cpu.avg", "Calculated.mem.max" or "aggr-space-attributes.size-used.avg". Read one unranked response first to see which paths exist. Sorting is performed by this server, not by Lumics. Items with no numeric value at this path are listed last and their number is reported.',
      ),
    sortDirection: sortDirectionSchema,
    topN: z
      .int()
      .min(1)
      .max(1_000)
      .optional()
      .describe(
        'Keep only this many items after the local sort. This is a client-side trim of a full response, not a server-side limit — Lumics fetched and returned everything either way. Combine it with sortBy, otherwise it just keeps the first N items in whatever order Lumics happened to return, which is not a documented ordering.',
      ),
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const range = resolveTimeRange({
      from: args.from,
      to: args.to,
      lookback: args.lookback,
    });
    const operation = `GET metric summaries ${args.moduleType}`;

    const response = await context.client.get<unknown>(
      metricSummariesPath(companyId, args.moduleType),
      {
        // spec §12.4: these four query parameters and no others.
        query: {
          fromMs: range.fromMs,
          toMs: range.toMs,
          itemType: args.itemType,
          properties: args.properties,
        },
      },
    );

    const { classes, count, meta, absence } = unwrapMetricSummaries(response, operation);
    const classNames = Object.keys(classes);

    // Leads for the same reason it leads on a series: it changes what everything
    // below it means. This endpoint's empty answer is a keyed `{}`, which reads
    // even more like a result than an empty array does.
    const absent = absentSeriesNote(absence, 'summaries');
    const notes: string[] = absent === undefined ? [] : [absent];

    // One disclosure note rather than five: every fact below is required
    // (RFC-001 D5 items 3 and 4), but each separate note costs the model tokens
    // it could be spending on the data.
    notes.push(
      `WINDOW: ${formatIso(range.fromMs)} to ${formatIso(range.toMs)} (${describeSpan(range.toMs - range.fromMs)}).` +
        ' NO SERVER-SIDE LIMIT OR PAGINATION: the Lumics metrics/summaries endpoint accepts no limit, top-N, sort or pagination parameter at all, so Lumics returned every item that matched and what follows is that full response.' +
        ' Narrowing itemType, properties or the window is the only way to make it smaller.' +
        (count === undefined
          ? ''
          : ` Lumics reported count=${String(count)} item(s) summarised; if fewer appear below they were removed by this server's topN trim or by the output budget, not by the API.`),
    );

    const effective = describeEffectiveWindow(meta);
    if (effective !== undefined) {
      notes.push(effective);
    }

    const rankedClasses: Record<string, readonly MetricSummaryItem[]> = {};
    for (const className of classNames) {
      const items = classes[className] ?? [];
      const ranked = rankSummaryItems(items, args.sortBy, args.sortDirection, args.topN);
      rankedClasses[className] = ranked.items;
      if (ranked.notes.length > 0) {
        notes.push(`LOCAL RANKING of "${className}": ${ranked.notes.join(' ')}`);
      }
    }

    // Zero classes with a `data` object actually present is a real response, not
    // an error: spec §12.4's `data` can be empty when nothing matched. It took
    // the keyed-object branch and returned a bare `{}`, which reads as a result
    // rather than as an absence, so it is called out explicitly.
    //
    // The `absence !== 'none'` guard is the whole point of this fix: when no body
    // or no `data` arrived, "nothing matched this module, itemType and window" is
    // a claim about the estate that this response does not support, and
    // `absentSeriesNote` above has already said the opposite.
    if (classNames.length === 0) {
      if (absence === 'none') {
        notes.push(
          'NO ITEMS: the Lumics response contained no item-class arrays at all — its "data" object was present but ' +
            'empty — so nothing matched this module, itemType and window. This is not an error and not a truncation. ' +
            'Check the moduleType and itemType against lumics_list_component_types (itemType "device" for ' +
            'device-level summaries), and widen the window; a module that is configured but has not polled inside the ' +
            'window returns nothing here.',
        );
      }
      return result({}, { notes });
    }

    // spec §12.4 keys `data` by item class and documents only "devices". Return
    // the array directly in the single-class case so field projection and
    // budget-driven shedding operate per item; keep the vendor's keyed object
    // when there is more than one class, since flattening would lose which
    // class each item belongs to.
    const firstClass = classNames[0];
    if (classNames.length === 1 && firstClass !== undefined) {
      notes.push(
        `The items below are the "${firstClass}" array of the Lumics response's "data" object.`,
      );
      return result(rankedClasses[firstClass] ?? [], {
        fields: args.fields,
        notes,
      });
    }

    // Multi-class. `shapeToolOutput` can only shed items from a payload whose top
    // level is an array, so a keyed object would be hard-truncated into JSON that
    // does not parse — while the disclosure told the caller to "re-run with a
    // fields projection", which this branch used to discard. Both halves are
    // fixed here: the projection is applied per class, and the shedding is done
    // per class before the payload leaves the handler.
    const projectedClasses: Record<string, readonly unknown[]> = {};
    for (const className of classNames) {
      projectedClasses[className] = projectFields(
        rankedClasses[className] ?? [],
        args.fields,
      ) as readonly unknown[];
    }

    const fitted = fitKeyedArraysToBudget(projectedClasses, context.config.maxOutputChars);
    if (fitted.dropped > 0) {
      notes.push(
        `NOTE ON TRUNCATION: this response holds ${String(classNames.length)} item classes (${classNames.join(', ')}) ` +
          `and exceeded the ${String(context.config.maxOutputChars)}-character output budget, so ` +
          `${String(fitted.dropped)} of ${String(fitted.total)} item(s) were dropped — each class was cut to at most ` +
          `${String(fitted.perKeyCap)} item(s), taken from the start of the order shown. The dropped items exist; ` +
          'they are simply not here, and no ranking you asked for was applied across classes. Narrow "properties" ' +
          'or "itemType" (which also reduces this to a single class), pass a smaller "fields" projection, use topN, ' +
          'or ask the operator to raise LUMICS_MAX_OUTPUT_CHARS.',
      );
    }

    // Deliberately no requestedLimit: this endpoint takes no limit, so the
    // list-completeness disclosure would be describing a parameter we never sent.
    // No `fields` either — the projection has already been applied per class.
    return result(fitted.value, { notes });
  },
});

/**
 * Sort and trim summary items in our own layer.
 *
 * Items with no numeric value at `sortBy` are always placed last regardless of
 * direction, and counted in a note: with `asc` they would otherwise occupy the
 * top of a "lowest N" list purely by being unmeasured.
 */
function rankSummaryItems(
  items: readonly MetricSummaryItem[],
  sortBy: string | undefined,
  direction: 'desc' | 'asc',
  topN: number | undefined,
): { readonly items: readonly MetricSummaryItem[]; readonly notes: readonly string[] } {
  const notes: string[] = [];
  let ordered = items;

  if (sortBy !== undefined) {
    const keyed = items.map((item) => ({ item, value: readNumericPath(item, sortBy) }));
    const missing = keyed.filter((entry) => entry.value === undefined).length;

    ordered = [...keyed]
      .sort((left, right) => {
        if (left.value === undefined) {
          return right.value === undefined ? 0 : 1;
        }
        if (right.value === undefined) {
          return -1;
        }
        return direction === 'desc' ? right.value - left.value : left.value - right.value;
      })
      .map((entry) => entry.item);

    notes.push(
      `Sorted by THIS SERVER on "${sortBy}" ${direction === 'desc' ? 'descending (largest first)' : 'ascending (smallest first)'} after retrieving the full result set; the Lumics API did not perform this ranking and offers no parameter to ask it to.`,
    );
    if (missing > 0) {
      notes.push(
        `${String(missing)} of ${String(items.length)} item(s) had no numeric value at "${sortBy}" and are listed last, unranked; check the path against an unsorted response before reading the order as meaningful.`,
      );
    }
  }

  if (topN !== undefined && ordered.length > topN) {
    notes.push(
      sortBy === undefined
        ? `Trimmed by THIS SERVER to the first ${String(topN)} of ${String(ordered.length)} item(s) in the order Lumics happened to return them; that order is not documented or meaningful, so pass sortBy to make this a real top-${String(topN)}.`
        : `Trimmed by THIS SERVER to the top ${String(topN)} of ${String(ordered.length)} item(s) after the local sort; the other ${String(ordered.length - topN)} were fetched but are not shown.`,
    );
    ordered = ordered.slice(0, topN);
  }

  return { items: ordered, notes };
}

/**
 * Resolve a dot-separated path to a number on a summary item.
 *
 * Tries the item itself first (so `stats.Calculated.cpu.avg` works) and then
 * inside `stats` (so the shorter `Calculated.cpu.avg` does too). Only a number is
 * accepted — sorting on a string or a `{status,text}` object would produce an
 * order nobody asked for. A metric property whose own name contains a dot cannot
 * be addressed this way; that is a known limitation of the path syntax, not a
 * silent failure, because an unresolvable path is reported in the notes.
 */
function readNumericPath(item: MetricSummaryItem, path: string): number | undefined {
  const segments = path.split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return undefined;
  }

  const direct = walkPath(item, segments);
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }

  const stats = item.stats;
  if (stats === undefined) {
    return undefined;
  }
  const nested = walkPath(stats, segments);
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : undefined;
}

function walkPath(source: unknown, segments: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** All five metric endpoints of spec §12, in spec order. */
export const metricTools: readonly LumicsToolDefinition[] = [
  getCompanyMetrics,
  summarizeCompanyMetrics,
  getDeviceMetrics,
  getDeviceItemMetrics,
  getMetricSummary,
];

export default metricTools;
