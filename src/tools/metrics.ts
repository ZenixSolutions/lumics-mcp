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
 * Three further facts come from the first live contract run against a real tenant
 * and contradict `docs/reference/lumics-api-v1.md`, which was transcribed from
 * vendor documentation that is wrong in these specific ways:
 *
 *  A. **`properties` is REQUIRED** on §12.1, §12.2 and both §12.3 endpoints, not
 *     optional as documented. Without it they answer
 *     `400 {"error":"Must supply required component metrics as properties parameter"}`,
 *     so every metric call this server made was failing. On §12.4 it stays optional
 *     and means something else — a filter, not a projection.
 *  B. **An invalid `properties` value returns HTTP 200 with empty stats.** The 400
 *     gate checks only that the parameter is present and non-empty, never that it
 *     is meaningful, so `properties=cpu` and `properties=bogusXYZ` both return the
 *     full row count with `stats: {}` on every row. A model reads that as "no CPU
 *     data available" and reports a confident negative about the estate. Nothing
 *     upstream distinguishes it from a real absence, so this module does:
 *     {@link propertyCoverageNote} inspects the returned rows against the requested
 *     paths and says plainly when rows came back carrying no requested values.
 *     `./schemas.ts` also rejects a `properties` with no `Group.metric` entry at all.
 *  C. **§12.2 `/summarize` is in a different class of slow** — over 90 seconds
 *     without returning, against one to two seconds for §12.1 and §12.3 — so it
 *     gets `METRIC_SUMMARIZE_TIMEOUT_MS` as a per-request override and says in its
 *     description that it can still time out. It also gets
 *     `METRIC_SUMMARIZE_MAX_ATTEMPTS`, because that deadline and the retry budget
 *     multiply: a timeout on a GET is retryable, so without a cap a `/summarize`
 *     that never answers cost three deadlines — nine minutes of silence — for
 *     retries that could not succeed. One attempt, and a timeout carries
 *     {@link SUMMARIZE_TIMEOUT_GUIDANCE} so the model does not read it as an empty
 *     estate.
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
import { expectObject, isAbsentBody, type QueryParams } from '../api/client.js';
import { LumicsApiError, LumicsInputError } from '../api/errors.js';
import {
  companyMetricsPath,
  companyMetricsSummarizePath,
  deviceItemMetricsPath,
  deviceMetricsPath,
  devicePath,
  metricSummariesPath,
} from '../api/paths.js';
import {
  DEFAULT_METRIC_DATA_POINTS,
  MAX_LIST_LIMIT,
  METRIC_MIN_INTERVALS_DEFAULT,
  METRIC_SUMMARIZE_MAX_ATTEMPTS,
  METRIC_SUMMARIZE_TIMEOUT_MS,
} from '../constants.js';
import type {
  Device,
  MetricDataPoint,
  MetricEnvelopeMeta,
  MetricSummaryItem,
} from '../domain/index.js';
import { budgetAfterNotes, fitKeyedArraysToBudget, projectFields } from '../presentation/format.js';
import { describeSpan, resolveTimeRange, type TimeRange } from '../util/time.js';
import { defineTool, result, type LumicsToolDefinition, type ToolContext } from './factory.js';
import {
  companyIdSchema,
  fieldsSchema,
  isMonitoredSchema,
  itemTypeSchema,
  lastMetricSchema,
  METRIC_PROPERTY_SYNTAX,
  metricDataPointsSchema,
  metricIntervalSchema,
  metricPropertiesSchema,
  metricSumSchema,
  metricSummaryPropertiesSchema,
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
 *
 * `properties` is **required**, which is the one place this shape departs from
 * the captured spec: §12.0 lists it optional and all four endpoints 400 without
 * it (see fact A in the module comment). It is required rather than defaulted
 * because no metric name is right for every module, so a default would silently
 * answer a question the caller did not ask.
 *
 * `componentQuery` and `filters` are absent by design — ADR-002 decision 3.
 */
const metricSelectionShape = {
  properties: metricPropertiesSchema,
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
  /** The `properties` value sent, kept so the response can be checked against it. */
  readonly properties: string | undefined;
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
    properties: args.properties,
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

// ---------------------------------------------------------------------------
// The 200-with-empty-stats trap (fact B in the module comment)
// ---------------------------------------------------------------------------

/**
 * What the returned rows say about one requested property path.
 *
 *  - `present` — at least one row carried a value at `<group>.<metric>` inside
 *    `stats`. The path resolved; nothing to disclose.
 *  - `group-empty` — the type group came back, but empty (`{"Rate":{}}`) or without
 *    this metric in it. That is what a *recognised* group with an *unknown* metric
 *    name produces upstream.
 *  - `group-missing` — no row carried this group under `stats` at all, which is what
 *    an *unrecognised* type group produces: the group simply never appears.
 *  - `unqualified` — the entry carried no `<Group>.` prefix. This is the exact form
 *    measured returning 658 rows with `stats: {}` on every one of them.
 *
 * The three failing states are distinguished because they need different fixes,
 * and because "the group is missing entirely" and "the group is there but empty"
 * are the only evidence available about *which half* of the name is wrong.
 */
type PropertyStatus = 'present' | 'group-empty' | 'group-missing' | 'unqualified';

interface PropertyOutcome {
  /** The entry exactly as the caller wrote it. */
  readonly raw: string;
  readonly status: PropertyStatus;
}

/** Split a `properties` value into entries, dropping empties from stray commas. */
function parseRequestedProperties(properties: string): readonly string[] {
  return properties
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The `stats` maps of the rows that carry one, in order. */
function statsOf(points: readonly MetricDataPoint[]): readonly Record<string, unknown>[] {
  const maps: Record<string, unknown>[] = [];
  for (const point of points) {
    if (isRecord(point.stats)) {
      maps.push(point.stats);
    }
  }
  return maps;
}

/**
 * Classify one requested property path against every row's `stats`.
 *
 * "Present on any row" is the bar, not "present on every row": a company-wide
 * query legitimately returns components that do not carry the metric alongside
 * ones that do, and calling that a naming failure would be its own false alarm.
 */
function classifyProperty(
  entry: string,
  stats: readonly Record<string, unknown>[],
): PropertyStatus {
  const dot = entry.indexOf('.');
  if (dot <= 0 || dot >= entry.length - 1) {
    // An unqualified name can still be *found*, if Lumics happens to key a metric
    // that way inside some group — so look before concluding.
    for (const map of stats) {
      for (const group of Object.values(map)) {
        if (isRecord(group) && group[entry] !== undefined) {
          return 'present';
        }
      }
    }
    return 'unqualified';
  }

  const group = entry.slice(0, dot);
  const metric = entry.slice(dot + 1);
  let groupSeen = false;

  for (const map of stats) {
    const bucket = map[group];
    if (bucket === undefined) {
      continue;
    }
    groupSeen = true;
    if (isRecord(bucket) && bucket[metric] !== undefined) {
      return 'present';
    }
  }

  return groupSeen ? 'group-empty' : 'group-missing';
}

/** The per-entry half of the disclosure: what each unresolved path looked like. */
function describeUnresolved(outcome: PropertyOutcome): string {
  switch (outcome.status) {
    case 'unqualified':
      return `"${outcome.raw}" carries no "<TypeGroup>." prefix — this is the exact form measured returning rows with empty stats`;
    case 'group-empty':
      return `"${outcome.raw}" — the type group came back but held no such metric, which is what a recognised group with an unknown metric name produces`;
    case 'group-missing':
      return `"${outcome.raw}" — its type group never appeared in any row's stats, which is what an unrecognised type group produces`;
    case 'present':
      return `"${outcome.raw}"`;
  }
}

/** Cap on how many unresolved entries are spelled out, so the note stays bounded. */
const MAX_UNRESOLVED_DETAILED = 6;

function listUnresolved(unresolved: readonly PropertyOutcome[]): string {
  const shown = unresolved.slice(0, MAX_UNRESOLVED_DETAILED).map(describeUnresolved).join('; ');
  const hidden = unresolved.length - MAX_UNRESOLVED_DETAILED;
  return hidden > 0 ? `${shown}; and ${String(hidden)} more` : shown;
}

/**
 * Disclose the API's silent-200 failure: rows came back, but not the values asked
 * for.
 *
 * **This is the most important disclosure in the module.** Every other empty
 * result here is empty because the transport or the estate made it so; this one is
 * empty because the *request* was malformed, and the API accepted it anyway. A
 * model that receives 658 rows of `{"stats":{}}` under a successful tool result
 * concludes "there is no CPU data for these devices" and tells the user so. That
 * is a confident negative built on a typo, and it is exactly the failure mode
 * `CLAUDE.md` is organised against.
 *
 * Returns `undefined` when there is nothing to say:
 *
 *  - **no rows at all.** A genuinely empty series makes no claim about property
 *    names — there were no stats to look in — and `absentSeriesNote` already covers
 *    the cases where the emptiness came from the transport. Saying "your property
 *    names may be wrong" over an empty array would be a guess.
 *  - **every requested path resolved somewhere.** Nothing is wrong.
 *
 * Otherwise it distinguishes total failure (nothing resolved: the response
 * establishes nothing at all about these metrics) from partial (some resolved: the
 * data present is trustworthy, the gaps are suspect).
 */
function propertyCoverageNote(
  properties: string | undefined,
  points: readonly MetricDataPoint[],
): string | undefined {
  if (properties === undefined || points.length === 0) {
    return undefined;
  }

  const entries = parseRequestedProperties(properties);
  if (entries.length === 0) {
    return undefined;
  }

  const stats = statsOf(points);
  const outcomes: PropertyOutcome[] = entries.map((raw) => ({
    raw,
    status: classifyProperty(raw, stats),
  }));
  const unresolved = outcomes.filter((outcome) => outcome.status !== 'present');
  if (unresolved.length === 0) {
    return undefined;
  }

  const rows = `${String(points.length)} row(s)`;
  const discovery = ` ${METRIC_PROPERTY_SYNTAX} Re-run this call once the names are right. Two caveats on that enumeration: it surfaces DEVICE-scoped metric names only, so a component-level name is discoverable from no endpoint at all; and its response key depends on the module ("devices" for snmp, "http_endpoints" for http), so read whichever key is present rather than assuming "devices".`;

  if (unresolved.length === entries.length) {
    const noStatsAtAll =
      stats.length === 0
        ? ' NOT ONE row carried a "stats" key at all, which is the strongest form of this signal.'
        : '';
    return (
      `PROPERTY NAMES MAY BE WRONG — THIS IS NOT A STATEMENT THAT NO DATA EXISTS: Lumics returned ${rows} for this query ` +
      `but none of them carried a value for ANY of the properties you asked for (${listUnresolved(unresolved)}).${noStatsAtAll} ` +
      'The Lumics API does not reject an unrecognised property name: it answers 200 with the full row count and empty ' +
      '"stats" objects, so a misspelled or wrongly-formed name is indistinguishable from a metric that genuinely has ' +
      'no data — except by the check this server just ran. Do NOT tell the user that this metric is unavailable, that ' +
      'the devices are not reporting it, that CPU/memory/whatever "has no data", or anything else that reads as a ' +
      'negative finding about the estate: this response does not support any of that.' +
      discovery
    );
  }

  return (
    `SOME PROPERTIES RETURNED NO VALUES: of the ${String(entries.length)} propert(ies) requested, ` +
    `${String(unresolved.length)} produced no value on any of the ${rows} returned (${listUnresolved(unresolved)}). ` +
    'The rows below are real and the properties that did resolve can be read normally. The ones that did not may ' +
    'simply be absent on these components — but an unrecognised property name produces exactly the same silent ' +
    'result, because Lumics answers 200 with empty stats rather than rejecting the name. Do not report the missing ' +
    'ones as "not collected" or "no data" without checking the spelling first.' +
    discovery
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
  // the rest of the response means. The property-coverage disclosure follows it
  // for the same reason and cannot collide with it: it says nothing at all when
  // there are no rows, which is every case `absentSeriesNote` fires on.
  const absent = absentSeriesNote(series.absence, 'series');
  const notes = absent === undefined ? [] : [absent];

  const coverage = propertyCoverageNote(request.properties, series.points);
  if (coverage !== undefined) {
    notes.push(coverage);
  }

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

// ---------------------------------------------------------------------------
// The company pin on a path that has no company in it
// ---------------------------------------------------------------------------

/**
 * Refuse a device that is not in the company this server is pinned to.
 *
 * spec §12.3's paths are `/metrics/devices/:id/...` — **no company segment**, so
 * these two tools have no `companyId` argument and used to call nothing that
 * enforced the pin. A Lumics token issued to an MSP user reaches every company
 * that user administers, so a `deviceId` for another tenant was read and returned
 * while every other tool refused the same tenant. `deviceId` is precisely the
 * kind of value SECURITY.md classes as untrusted — an id picked up from a
 * document, or from an injected instruction in a device description — so the
 * absence of a gate here was the absence of the control, not a narrower version
 * of it.
 *
 * The device's owner is therefore resolved first, with a company-scoped read of
 * the device (spec §7.2) against the configured company, and the metric read is
 * issued only if that read confirms ownership. That costs one extra round trip
 * per call; the alternative was a security control with a documented exception,
 * which is much weaker than one without.
 *
 * Fail-closed in every ambiguous case:
 *  - a 404 from the company-scoped device read means the device is not in this
 *    company (or does not exist at all) — either way, refused;
 *  - a device record with no `company` field cannot be verified, so it is refused
 *    rather than assumed to belong here.
 *
 * Skipped entirely when the operator has set `LUMICS_ALLOW_CROSS_COMPANY`: there
 * is no pin to enforce then, and no reason to spend the request.
 */
async function assertDeviceInPinnedCompany(deviceId: string, context: ToolContext): Promise<void> {
  if (context.config.allowCrossCompany) {
    return;
  }

  // Registration withholds both tools when no company is configured
  // (`requiresCompany`), so this resolves the configured id rather than throwing.
  const pinned = context.resolveCompanyId();
  const operation = `GET device ${deviceId} to resolve its company`;

  let device: Device;
  try {
    device = expectObject<Device>(
      await context.client.get(devicePath(pinned, deviceId)),
      operation,
    );
  } catch (error) {
    if (error instanceof LumicsApiError && error.status === 404) {
      throw new LumicsInputError(
        `Device ${deviceId} is not in the company this server is configured for (LUMICS_COMPANY_ID is ${pinned}): reading it inside that company returned 404 Not Found. The metric read was NOT performed. Either the id does not exist, or it belongs to another Lumics company — one token can reach several, so this server refuses a device it cannot confirm belongs to the configured company. Confirm the id with lumics_list_devices, which lists only the configured company. If the device really is in another company, tell the user which one and ask them to have the operator set LUMICS_ALLOW_CROSS_COMPANY=1; that is an operator setting and cannot be overridden from here.`,
        'not_permitted',
      );
    }
    throw error;
  }

  const owner = typeof device.company === 'string' ? device.company : undefined;
  if (owner === pinned) {
    return;
  }

  if (owner === undefined) {
    throw new LumicsInputError(
      `Device ${deviceId} could not be confirmed to belong to the company this server is configured for (LUMICS_COMPANY_ID is ${pinned}): the device record Lumics returned carried no "company" field, so its owner cannot be verified. The metric read was NOT performed, because an unverified owner is not a verified one and this metric path (spec section 12.3) carries no company segment of its own to constrain it. Report this as unexpected API drift. An operator who accepts the risk can set LUMICS_ALLOW_CROSS_COMPANY=1, which turns this check off; that is an operator setting and cannot be overridden from here.`,
      'not_permitted',
    );
  }

  throw new LumicsInputError(
    `Device ${deviceId} belongs to Lumics company ${owner}, which is not the company this server is configured for (LUMICS_COMPANY_ID is ${pinned}). The metric read was NOT performed. Cross-company access is refused unless the operator sets LUMICS_ALLOW_CROSS_COMPANY=1, because one Lumics token can reach several tenants and a device id is exactly the sort of value that arrives from a document or another tool's output. Use lumics_list_devices to pick a device in the configured company. If you genuinely need the other company, tell the user which one and ask them to have the operator enable LUMICS_ALLOW_CROSS_COMPANY; this is an operator setting and cannot be overridden from here.`,
    'not_permitted',
  );
}

/** The sentence both device-scoped metric tools append to their description. */
const DEVICE_PIN_DISCLOSURE =
  ' This tool takes no companyId argument because the Lumics metric path for a device carries no company (spec section 12.3). It is still covered by the company pin: before reading any metrics this server reads the device inside the company it is configured for (LUMICS_COMPANY_ID) and refuses the call if the device belongs to another company, so a device id that arrived from a document or from another tool cannot reach a tenant the operator did not configure. That costs one extra request per call.';

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
    'Get metrics for every monitored component of one polling module across a whole Lumics company, returning a separate row per item per time bucket with its stats. Use this to answer "what does X look like across the estate" — for example the status of every F5 pool, or CPU on every switch. "properties" is REQUIRED and must name metrics as "<TypeGroup>.<metric>" (e.g. "Calculated.cpu"): the call fails without it, and an unrecognised name comes back as a successful but EMPTY result rather than an error — see the properties argument. Set lastMetric true when you want current values rather than a time series. The window defaults to the last 1 hour. A resolution is always sent because the Lumics API requires one; it defaults to 60 data points across the window unless you pass dataPoints. Each returned row carries a "type" field holding the singular component id, which is the correct value for itemType on a follow-up call. For a total or an average across components rather than a row per component, use lumics_summarize_company_metrics; for one device, use lumics_get_device_metrics.',
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

    // Deliberately no `requestedLimit`. A metric response is one row per
    // component per time bucket, so `metricRowCapNote` describes what a cap did
    // to the SERIES; the list-completeness note would describe the same response
    // as a possibly-incomplete inventory and tell the model to "re-run with a
    // higher limit", which is the opposite of "drop this limit". Two notes with
    // opposite advice in one response is the defect that was already fixed on the
    // list path.
    return result(series.points, {
      fields: args.fields,
      notes: metricSeriesNotes(request, series),
    });
  },
});

// ---------------------------------------------------------------------------
// spec §12.2 — company metrics, aggregated into time buckets
// ---------------------------------------------------------------------------

/**
 * What a model needs to know when `/summarize` runs out of time, over and above
 * the generic transport advice `LumicsApiError.timeout` already carries.
 *
 * Three things, in order of how much damage getting them wrong does:
 *
 *  1. **A timeout is not an empty result.** This is the one that matters. The
 *     generic message says the request timed out and stops there, and a model
 *     that has just asked "how much aggregate space is the estate using" and
 *     received a failure is one short step from answering "no data was found".
 *     That is the silent-completeness failure this codebase is organised against,
 *     arriving through the error path instead of the success path.
 *  2. **Why there was only one attempt.** Otherwise the single attempt looks like
 *     the retry policy failing to fire, and the natural response — reissue the
 *     identical call — is exactly the nine minutes the cap exists to prevent.
 *  3. **What to make smaller.** The generic advice ("a smaller limit, a shorter
 *     time range, or fewer metric properties") is true but incomplete here: it
 *     omits `itemType`, which is the single most effective lever on an endpoint
 *     whose cost is the number of components it aggregates, and it omits the fast
 *     §12.1 endpoint, which answers many of the same questions in seconds.
 *
 * The generic message is appended to, never replaced: it already names the
 * deadline that actually applied and the attempt count, and both are facts this
 * text then relies on.
 */
const SUMMARIZE_TIMEOUT_GUIDANCE =
  'THIS ENDPOINT IS KNOWN TO BE SLOW (spec section 12.2): it aggregates every matching component in the company before it answers, has been measured taking over 90 seconds, and this server therefore gave it a deadline of its own rather than the shared LUMICS_TIMEOUT_MS — the duration above is the deadline that actually applied, and it elapsed. It was attempted ONCE and deliberately not retried: an endpoint that did not answer within that deadline is not suffering a transient fault, and further attempts would spend the same wait to learn the same thing, which from a client is indistinguishable from a hung server. THIS IS A TIMEOUT, NOT AN EMPTY RESULT. It is not evidence that this company, module or metric has no data — nothing was measured either way — so do NOT report an absence of data, a zero, or an empty estate on the strength of it. Make the work smaller and call again: pass itemType to aggregate one class of component instead of all of them, cut "properties" down to the single metric you actually need, or shorten the window (an hour rather than a day). Or use lumics_get_company_metrics (spec section 12.1), which reads the same module without the cross-component aggregation and answers in one to two seconds, at one row per component rather than one row per time bucket. Raising LUMICS_TIMEOUT_MS beyond this deadline is an operator change, and this server honours it.';

/**
 * Add {@link SUMMARIZE_TIMEOUT_GUIDANCE} to a `/summarize` timeout, or return
 * `undefined` for anything else so the caller rethrows it untouched.
 *
 * Only `timeout` is enriched. A 400, a 404 or an unparseable body already carry
 * the right guidance, and pasting "this endpoint is slow" onto a malformed
 * `properties` value would send the model to narrow a request that was never too
 * large. Every field of the original error is preserved — `attempts` in
 * particular, which the text refers to.
 */
function summarizeTimeoutError(cause: unknown): LumicsApiError | undefined {
  if (!(cause instanceof LumicsApiError) || cause.code !== 'timeout') {
    return undefined;
  }
  return new LumicsApiError(`${cause.message} ${SUMMARIZE_TIMEOUT_GUIDANCE}`, {
    code: cause.code,
    // Not retryable *as issued*. The generic timeout is marked retryable because
    // on a read a retry is usually right; here the whole point is that it is not,
    // and a caller reading this flag must not conclude otherwise.
    retryable: false,
    ...(cause.operation === undefined ? {} : { operation: cause.operation }),
    ...(cause.attempts === undefined ? {} : { attempts: cause.attempts }),
    cause,
  });
}

/**
 * spec §12.2 `GET /metrics/companies/:companyId/modules/:moduleType/summarize`.
 * The shared set **plus `sum`** — the one parameter unique to this endpoint.
 */
const summarizeCompanyMetrics = defineTool({
  name: 'lumics_summarize_company_metrics',
  title: 'Summarize company metrics into time buckets',
  operation: 'read',
  description:
    'Aggregate one polling module\'s metrics across ALL matching components in a company into time buckets, giving one row per bucket rather than one row per component. Without "sum" the metrics are averaged across components; with "sum" they are added up, and the value of "sum" chooses which per-component rollup property ("min", "max" or "avg") feeds that total. Use this for estate-wide trends and totals — total aggregate space used, average CPU over the day. Each bucket also carries how many samples and component-documents it covers, and buckets with no data are omitted entirely rather than returned as zero, so do not read a gap as a zero. THIS ENDPOINT IS SLOW: it aggregates every matching component in the company before it answers, and has been measured taking over 90 seconds where the other metric endpoints take one or two. This server gives it a 3-minute deadline of its own and reports a timeout immediately rather than retrying, because a retry would spend another 3 minutes failing the same way. On a large tenant it can still time out — if it does, that is a timeout and NOT evidence that there is no data. Narrow it with itemType, a shorter window or a tighter "properties" before retrying, or use lumics_get_company_metrics, which is fast. "properties" is REQUIRED here too and must name metrics as "<TypeGroup>.<metric>". The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. If a short window returns nothing, lower minIntervals. For a row per component instead, use lumics_get_company_metrics. This tool CANNOT rank or identify individual devices or components: every row it returns is a time bucket covering all of them at once, and no device name or id appears in the output. If the question is "which devices are highest", "top N devices" or anything else that needs a per-device answer, use lumics_get_metric_summary instead, which returns one row per item and supports sortBy and topN. Note the confusable name: this tool summarises over TIME, lumics_get_metric_summary summarises over ITEMS.',
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
    let response: unknown;
    try {
      response = await context.client.get<unknown>(
        companyMetricsSummarizePath(companyId, args.moduleType),
        {
          query: request.query,
          // The one endpoint that needs its own deadline (module comment, fact C).
          // `Math.max` rather than a plain assignment so an operator who has already
          // raised LUMICS_TIMEOUT_MS above this keeps their value.
          timeoutMs: Math.max(context.config.timeoutMs, METRIC_SUMMARIZE_TIMEOUT_MS),
          // And the attempt cap that keeps that deadline from multiplying. Without
          // it a timing-out summarize costs three deadlines — nine minutes of
          // silence — for retries that cannot succeed. See
          // METRIC_SUMMARIZE_MAX_ATTEMPTS for why the cap is on attempts rather
          // than on one retry class.
          maxAttempts: METRIC_SUMMARIZE_MAX_ATTEMPTS,
        },
      );
    } catch (cause) {
      const explained = summarizeTimeoutError(cause);
      if (explained !== undefined) {
        throw explained;
      }
      throw cause;
    }
    const series = unwrapMetricSeries(response, operation);

    const notes = metricSeriesNotes(request, series);
    notes.push(
      args.sum === undefined
        ? 'AGGREGATION: no "sum" was requested, so each bucket below is the AVERAGE across components, not a total.'
        : `AGGREGATION: values below are SUMMED across components using each component's "${args.sum}" rollup property, so a bucket is a total and not an average.`,
    );

    // No `requestedLimit` here either — see getCompanyMetrics.
    return result(series.points, {
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
 * path, so no `companyId` argument; the pin is enforced instead by
 * {@link assertDeviceInPinnedCompany}, which is why the tool is marked
 * `requiresCompany`.
 */
const getDeviceMetrics = defineTool({
  name: 'lumics_get_device_metrics',
  title: 'Get metrics for one device',
  operation: 'read',
  requiresCompany: true,
  description:
    'Get metrics for the components of a single device — every fan, interface, pool or volume the named module polls on it — returning a row per component per time bucket. This is the tool for "how is this device doing": pair it with lastMetric true and a narrow "properties" list for a current-status readout, or leave lastMetric unset for a series over the window. "properties" is REQUIRED and must name metrics as "<TypeGroup>.<metric>" (e.g. "Calculated.cpu"); a name Lumics does not recognise returns a successful but EMPTY result rather than an error. Restrict to one kind of component with itemType when a device has many, using the singular component id — and note that Lumics validates itemType before properties, so a wrong itemType hides a properties problem. The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. For one specific component, or for the device\'s own device-level metrics, use lumics_get_device_item_metrics.' +
    DEVICE_PIN_DISCLOSURE,
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
    // Before the metric read, never after: an unpinned device must not have its
    // metrics fetched at all, not merely withheld from the response.
    await assertDeviceInPinnedCompany(args.deviceId, context);

    const request = buildMetricRequest(args);
    const operation = `GET device ${args.deviceId} metrics ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      deviceMetricsPath(args.deviceId, args.moduleType),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    // Deliberately no `requestedLimit`: `metricRowCapNote` already describes a
    // capped series, and the list-completeness note's "re-run with a higher
    // limit" is the opposite advice on this path. See `metricRowCapNote`.
    return result(series.points, {
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
  requiresCompany: true,
  description:
    'Get metrics for exactly one item on a device: pass the device\'s own id as itemId for device-level metrics such as CPU, memory or uptime, or a component id for one interface, fan, pool or volume. This is the narrowest and cheapest metric read, and the right one for charting a single series or checking one thing. Results are returned as time buckets, typically carrying min, max and avg per property along with the owning device\'s id and name. "properties" is REQUIRED and must name metrics as "<TypeGroup>.<metric>" (e.g. "Calculated.cpu", "TimeTicks.sysUpTime"); an unrecognised name returns a successful but EMPTY result rather than an error, so read the properties argument before guessing at one. The window defaults to the last 1 hour and a resolution of 60 data points is sent unless you pass dataPoints. Unlike the other metric tools this one takes no itemType, because the item is already identified.' +
    DEVICE_PIN_DISCLOSURE,
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
    await assertDeviceInPinnedCompany(args.deviceId, context);

    const request = buildMetricRequest(args);
    const operation = `GET device ${args.deviceId} item ${args.itemId} metrics ${args.moduleType}`;
    const response = await context.client.get<unknown>(
      deviceItemMetricsPath(args.deviceId, args.moduleType, args.itemId),
      { query: request.query },
    );
    const series = unwrapMetricSeries(response, operation);

    // No `requestedLimit`, as on every series endpoint — see getDeviceMetrics.
    return result(series.points, {
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
    'Summarize one metric module across every device or component in a company that reports it, giving one row per item with its averaged and peak values over the window — the tool for "which devices have the highest CPU" or "what is memory doing estate-wide". Pass itemType "device" for device-level summaries, or a singular component id for component-level ones. THIS IS ALSO THE ONLY WAY TO DISCOVER LEGAL "properties" VALUES for the other metric tools: call it with no properties, then read data.<class>[].stats — the outer keys are metric type groups (Calculated, Rate, TimeTicks) and the inner keys are metric names, so joining them with a dot gives a value you can pass as "properties" to lumics_get_company_metrics, lumics_get_device_metrics, lumics_get_device_item_metrics or lumics_summarize_company_metrics. Two limits on that: it surfaces DEVICE-scoped metric names only, so a component-level name such as an interface counter is discoverable from no endpoint at all and has to come from the Lumics UI; and the response key varies by module ("devices" for snmp, "http_endpoints" for http), so read whichever key is present instead of assuming "devices". Note that "properties" behaves differently HERE than on the other metric tools — it filters the result rather than projecting it, and supplying it has been observed to empty an otherwise full response — so leave it unset unless you have a reason. This endpoint has a much smaller parameter surface than the other metric tools: it accepts no resolution, interval, isMonitored, lastMetric or limit parameter of any kind, so Lumics always returns the entire matching set. The topN and sortBy arguments are therefore applied by this server AFTER fetching everything, not by Lumics, and the response says so. The window defaults to the last 1 hour. Note the confusable name: this tool summarises over ITEMS and returns no time series — one row per device or component, with values already reduced over the whole window. For an estate-wide total or average plotted over time, one row per time bucket and no per-item detail, use lumics_summarize_company_metrics instead.',
  inputSchema: {
    moduleType: moduleTypeSchema,
    companyId: companyIdSchema,
    itemType: itemTypeSchema.optional(),
    // A different parameter with the same name: optional here, and a filter
    // rather than a projection. See `metricSummaryPropertiesSchema`.
    properties: metricSummaryPropertiesSchema.optional(),
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
        'Keep only this many items after the local sort. This is a client-side trim of a full response, not a server-side limit — Lumics fetched and returned everything either way. Combine it with sortBy, otherwise it just keeps the first N items in whatever order Lumics happened to return, which is not a documented ordering. Note that when Lumics returns more than one item class (spec section 12.4 keys its results by class, e.g. devices and pools), this trim is applied to EACH class separately, so you can receive up to topN multiplied by the number of classes, and no ranking crosses classes; the response says so when that happens. Pass itemType to reduce the response to one class if you need a single global top-N.',
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

    // Said whenever `properties` was sent, not only when the result came back
    // empty: a filtered-down-but-non-empty response is the more dangerous of the
    // two, because it looks complete. This endpoint's `properties` is not the
    // projection the identically-named argument is on the other four tools.
    if (args.properties !== undefined) {
      notes.push(
        `PROPERTIES IS A FILTER HERE: you passed properties="${args.properties}". On this endpoint (unlike the other ` +
          'metric tools, where it selects which values to return) it restricts WHICH ITEMS come back, and supplying ' +
          'it has been observed to empty an otherwise full response. The item list below is therefore narrower than ' +
          "the company's real one, by an amount this server cannot measure. If you wanted a complete list, or you " +
          'are using this call to discover which metric names exist, re-run it with no "properties".',
      );
    }

    const effective = describeEffectiveWindow(meta);
    if (effective !== undefined) {
      notes.push(effective);
    }

    // Ranking and trimming happen INSIDE each item class, so `topN` is not a cap
    // on the response: with two classes and topN 2, four rows come back. That
    // used to be inferable only from the presence of two LOCAL RANKING notes,
    // while the explicit cross-class caveat lived in the truncation note — which
    // fires only when the budget dropped something. It is stated here instead,
    // whenever more than one class is present.
    const rankedClasses: Record<string, readonly MetricSummaryItem[]> = {};
    for (const className of classNames) {
      const items = classes[className] ?? [];
      const ranked = rankSummaryItems(items, args.sortBy, args.sortDirection, args.topN);
      rankedClasses[className] = ranked.items;
      if (ranked.notes.length > 0) {
        notes.push(`LOCAL RANKING of "${className}": ${ranked.notes.join(' ')}`);
      }
    }

    // Said once, whether or not any class was long enough to trim: the reader
    // needs to know that topN is not a cap on the response and that no ranking
    // crossed a class boundary. "No class was long enough this time" is not a
    // reason to leave that unsaid, and a per-class trim is not what "top N"
    // means to anyone reading the answer.
    if (args.topN !== undefined && classNames.length > 1) {
      notes.push(
        `LOCAL RANKING ACROSS CLASSES: topN was applied to EACH item class separately, NOT across the response. Lumics returned ${String(classNames.length)} item classes (${classNames.join(', ')}), so up to ${String(args.topN * classNames.length)} row(s) can appear below, and the top item of one class is not comparable with the top item of another — this server ranked within each class only. For a single global top-${String(args.topN)}, pass itemType to reduce the response to one class.`,
      );
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
        // Deliberately no longer a flat "nothing matched". When `properties` was
        // supplied, the measured behaviour of this endpoint makes the parameter
        // itself the likeliest cause, so leading with "nothing matched" would be
        // a confident negative about the estate produced by our own argument.
        notes.push(
          'NO ITEMS: the Lumics response contained no item-class arrays at all — its "data" object was present but ' +
            'empty. This is not an error and not a truncation, but do not report it as "this company has no data for ' +
            'this module" until the arguments below are ruled out.' +
            (args.properties === undefined
              ? ''
              : ' MOST LIKELY CAUSE: you supplied "properties". On this endpoint it FILTERS the result rather than ' +
                'projecting it, and supplying it has been observed to empty a response that was otherwise full. ' +
                'Re-run this call with no "properties" at all before drawing any conclusion.') +
            ' Check itemType: it must be the SINGULAR component id ("snmp_common_cpu", not the plural ' +
            '"snmp_common_cpus" that lumics_list_component_types returns), or the literal "device" for device-level ' +
            'summaries; build it from lumics_get_device_definition_components. Check the moduleType, and widen the ' +
            'window — a module that is configured but has not polled inside the window returns nothing here.',
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

    // The notes are counted against the budget before the classes are fitted to
    // it, the same way `shapeToolOutput` reserves them: fitting the payload to the
    // whole budget and letting ~1,100 characters of disclosure be prepended
    // afterwards is what made `LUMICS_MAX_OUTPUT_CHARS` not a cap. Here it would
    // also undo the shedding — a keyed object over budget is hard-truncated into
    // JSON that does not parse, which is the H4 defect this branch exists to fix.
    //
    // The truncation note itself costs budget, which can shed more, which changes
    // the note's counts, so this settles it in a bounded loop and keeps a little
    // slack for the digits.
    const maxChars = context.config.maxOutputChars;
    const truncationNote = (dropped: number, total: number, perKeyCap: number): string =>
      `NOTE ON TRUNCATION: this response holds ${String(classNames.length)} item classes (${classNames.join(', ')}) ` +
      `and exceeded the ${String(maxChars)}-character output budget, so ` +
      `${String(dropped)} of ${String(total)} item(s) were dropped — each class was cut to at most ` +
      `${String(perKeyCap)} item(s), taken from the start of the order shown. The dropped items exist; ` +
      'they are simply not here, and no ranking you asked for was applied across classes. Narrow "properties" ' +
      'or "itemType" (which also reduces this to a single class), pass a smaller "fields" projection, use topN, ' +
      'or ask the operator to raise LUMICS_MAX_OUTPUT_CHARS.';

    /** Slack for the counts in the truncation note growing by a digit. */
    const digitSlack = 16;
    const budgetFor = (extra: readonly string[]): number =>
      Math.max(0, budgetAfterNotes([...notes, ...extra], maxChars) - digitSlack);

    let fitted = fitKeyedArraysToBudget(projectedClasses, budgetFor([]));
    for (let pass = 0; pass < 5; pass += 1) {
      const extra =
        fitted.dropped > 0
          ? [truncationNote(fitted.dropped, fitted.total, fitted.perKeyCap)]
          : ([] as readonly string[]);
      const refitted = fitKeyedArraysToBudget(projectedClasses, budgetFor(extra));
      const settled = refitted.dropped === fitted.dropped;
      fitted = refitted;
      if (settled) {
        break;
      }
    }

    if (fitted.dropped > 0) {
      notes.push(truncationNote(fitted.dropped, fitted.total, fitted.perKeyCap));
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
