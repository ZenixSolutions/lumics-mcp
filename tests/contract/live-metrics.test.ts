/**
 * CONTRACT tests for the metric endpoints (spec §12). **Opt-in only.**
 *
 * This is the part of the contract with the most at stake. RFC-001 records that
 * the prototype's metric layer "cannot reliably have worked": it sent no
 * resolution parameter at all, and it typed `sum` as a boolean. This server's
 * metric tools are built on four assumptions taken from the vendor's written
 * documentation and never once executed:
 *
 *  1. `dataPoints` is accepted, and actually changes the series you get back.
 *     `src/tools/metrics.ts` **always** sends it, because spec §12.0 says either
 *     `dataPoints` or `width` is required. If that is wrong in either direction —
 *     ignored, or rejected — every metric tool is affected.
 *  2. `sum` is the string enum `min | max | avg`, not a boolean (spec §12.2).
 *  3. `interval` is exactly `minute | fiveMin | hour | day` (spec §12.0).
 *  4. `fromMs`/`toMs` are epoch **milliseconds**, defaulting to one hour ago and
 *     now (spec §12.0), which is what `src/util/time.ts` exists to produce.
 *
 * Plus two envelope shapes the tool layer unwraps differently: §12.1–§12.3 return
 * `{data: [...]}`, §12.4 returns `{data: {devices: [...]}, count: n}`.
 *
 * **The device-ownership pre-read is now part of this contract.** spec §12.3's
 * paths carry no company segment, so `lumics_get_device_metrics` and
 * `lumics_get_device_item_metrics` reach the pin through a company-scoped device
 * read (spec §7.2) issued *before* the metric call: they refuse unless
 * `device.company` equals `LUMICS_COMPANY_ID`. Two consequences for this file.
 *
 *  - A device metric call in the tool layer is **two** requests, and the suite
 *    exercises them separately: the pre-read has its own block below, the metric
 *    read keeps the §12.3 cases. Nothing here counts requests, and no case may
 *    assert on "the metric call" without saying which of the two it means.
 *  - Every device id comes from {@link pinnedCompanyDevices} — the configured
 *    company's own device list — so the pin holds by construction. An id from any
 *    other origin would now be refused by this server for the pin's reason, and a
 *    §12.3 case built on one would fail looking like a metric-contract violation
 *    when it was nothing of the kind.
 *
 * **The 2026-07-30 live run changed what this file has to do.** It found the
 * vendor's documentation wrong in ways that are now recorded in the captured
 * spec (§0.3, §12.5, §14 defects 17–23) and that this file both accommodates and
 * locks:
 *
 *  - **`properties` is REQUIRED** on §12.1, §12.2 and both §12.3 endpoints
 *    (spec §12.5 M1), though §12.0 marks it optional. Every call to those four
 *    endpoints therefore carries one, injected by {@link withRequiredProperties},
 *    so a case written to exercise `interval` exercises `interval` instead of
 *    dying at a 400 about a different parameter. The requirement itself is locked
 *    by its own block below, as is the fact that §12.4 does **not** share it.
 *  - **A property name cannot be invented.** They are tenant-specific, and
 *    spec §12.5 M6 records that §12.4 `metrics/summaries` is the only endpoint
 *    that enumerates any — device-scoped ones at that. So the value is
 *    discovered from §12.4 and, when that yields nothing, every case that needs
 *    it goes UNVERIFIED. There is deliberately **no fallback literal**: writing
 *    `Calculated.cpu` into this file would turn one tenant's data into an
 *    assumption about the API.
 *  - **An invalid `properties` value returns HTTP 200 with empty stats**
 *    (spec §12.5 M2). That is a silent-failure mode a consumer cannot detect, so
 *    it gets an explicit case rather than a note.
 *  - **`componenttypes` ids are not `itemType` values** (spec §12.5 M3), and
 *    `itemType` is validated *before* `properties`, which masks the M1 error.
 *  - **§12.2 `/summarize` never returned** (spec §12.5 M5). Every call to it here
 *    goes through {@link summarizeProbe}, which bounds the wait and reports the
 *    endpoint as slow with the dependent assumption UNVERIFIED. Nothing in this
 *    file may hang on it, and nothing may assert a shape nobody has seen.
 *
 * **READ-ONLY.** Every call here is a GET. Nothing touches the token endpoints.
 *
 * **Cost.** These hit a live production monitoring system, so windows are one
 * hour (24 hours only where the test needs enough buckets to compare), and
 * `dataPoints` is 2–48. Discovery is bounded to a handful of probes and its
 * results are reused. One `LumicsClient` is shared for the whole file so the
 * concurrency semaphore actually bounds the run; the one exception is the
 * non-retrying `slowProbeApi` client used for §12.2, and harness.ts point 5
 * explains why it has to be separate.
 *
 * A failure here is a **documentation defect to report** (CLAUDE.md), not a
 * licence to change `src/`. Where a case now asserts *measured* behaviour that
 * contradicts the vendor, its message says so and cites the spec's measured
 * finding, so a future failure is read as "the API changed again", not as "the
 * suite disagrees with the docs".
 */

import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  companyMetricsPath,
  companyMetricsSummarizePath,
  deviceDefinitionComponentsPath,
  deviceItemMetricsPath,
  deviceMetricsPath,
  devicePath,
  componentTypesPath,
  metricSummariesPath,
} from '../../src/api/paths.js';
import { expectArray } from '../../src/api/client.js';
import type { ComponentType, Device, DeviceDefinitionComponent } from '../../src/domain/index.js';
import { resourceId } from '../../src/domain/index.js';
import {
  api,
  attempt,
  attemptWithin,
  type CallOutcome,
  declareSkipExplanation,
  describeOutcome,
  describeValue,
  describeVocabulary,
  DOCUMENTED_STATUSES,
  isObjectIdShaped,
  isRecord,
  isSlowOutcome,
  keysOf,
  outcomeMentions,
  pinnedCompanyDevices,
  recordAsserted,
  recordObserved,
  reportEvidence,
  RUNNABLE,
  slowProbeApi,
  slowProbeBudgetMs,
  SUITE_DEADLINE_CODE,
  syntheticObjectId,
  unverifiable,
} from './harness.js';

/** Live calls plus client-side retry; the 5s default would flake on latency. */
const TIMEOUT = 60_000;
/**
 * §12.2 only. Must exceed `slowProbeBudgetMs()` (capped at 45s) by enough that
 * the *suite's* budget is what expires, not vitest's — a vitest timeout prints
 * "test timed out" and no finding, which is the outcome spec §12.5 M5 exists to
 * prevent.
 */
const SUMMARIZE_TIMEOUT = 120_000;
const DISCOVERY_TIMEOUT = 180_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Deliberately tiny: this is a contract check, not a data pull. */
const SMALL_DATA_POINTS = 6;
/** The pair the bucket-count comparison uses. */
const COARSE_DATA_POINTS = 2;
const FINE_DATA_POINTS = 48;

/** spec §12.0. Sent verbatim; the enum is the thing under test. */
const DOCUMENTED_INTERVALS = ['minute', 'fiveMin', 'hour', 'day'] as const;
/** spec §12.2. */
const DOCUMENTED_SUMS = ['min', 'max', 'avg'] as const;
/** spec §12.1–§12.3 envelope `type` values seen in the vendor's examples. */
const DOCUMENTED_ENVELOPE_TYPES = ['standard', 'minMaxAvg', 'summed'];

/**
 * Fallback module name. `snmp` is not invented: it is the module the vendor's own
 * §12.1 and §12.3 examples use. Only reached when `componenttypes` is empty and
 * no device declares a module, in which case the acceptance tests still have
 * something valid-looking to send and the data-dependent ones go UNVERIFIED.
 *
 * There is deliberately no equivalent fallback for `properties`: a module name is
 * vendor catalogue vocabulary the docs themselves use, whereas a property name is
 * one tenant's data (spec §12.5 M2/M6). See {@link Fixture.properties}.
 */
const FALLBACK_MODULE = 'snmp';

/** spec §12.4 selects device-level rather than component-level summaries. */
const DEVICE_ITEM_TYPE = 'device';

/**
 * A `properties` value that cannot name anything real, for the silent-failure
 * case (spec §12.5 M2). Not a tenant value and not a plausible one: no type
 * group is named, so it exercises the "unrecognised group" branch.
 */
const NONSENSE_PROPERTY = 'bogusXYZ';

interface Fixture {
  /** Module used for company-scoped calls (§12.1, §12.2, §12.4). */
  readonly moduleType: string;
  /** True when a plain call to §12.1 for {@link moduleType} returned 2xx. */
  readonly controlOk: boolean;
  /** Modules probed, so an UNVERIFIED entry can say what was tried. */
  readonly probedModules: readonly string[];
  /** Rows the probe returned, reused as the baseline by several tests. */
  readonly baselineRows: readonly Record<string, unknown>[];
  /** `data[].type` seen in the probe — a real, live component type string. */
  readonly itemType: string | undefined;
  /** A `group.property` path present in the probe's `stats` (spec §12.0). */
  readonly propertyPath: string | undefined;
  /**
   * The `properties` value sent on §12.1–§12.3, discovered from §12.4.
   *
   * spec §12.5 M1 makes the parameter required there and spec §12.5 M6 records
   * that §12.4 is the only endpoint that enumerates property names at all. When
   * §12.4 yields none — a module it does not serve (M7), or a tenant with no
   * device-scoped metrics — this stays `undefined` and every case that needs it
   * goes UNVERIFIED. It is never defaulted to a literal.
   */
  readonly properties: string | undefined;
  /** Type groups seen in §12.4 `stats`, e.g. `Calculated` (spec §12.5 M2). */
  readonly propertyGroups: readonly string[];
  /** Per-module §12.4 outcomes, for the coverage observation (spec §12.5 M7). */
  readonly summariesProbes: readonly SummariesProbe[];
  /**
   * A `componenttypes` id and the singular id spec §12.5 M3 says the metrics API
   * wants instead. Absent when the two catalogues cannot be lined up on this
   * tenant, in which case the M3 case goes UNVERIFIED rather than guessing.
   */
  readonly itemTypePair: ItemTypePair | undefined;
  /**
   * A device that reports {@link deviceModuleType}, for §12.3. Resolved from the
   * configured company's own device list, which is what makes it usable at all
   * now that the metric tools refuse a device they cannot confirm owning.
   */
  readonly deviceId: string | undefined;
  readonly deviceModuleType: string | undefined;
  /**
   * The first device in the configured company's list, whether or not it declares
   * a polling module. The ownership pre-read needs a device, not a *monitored*
   * device, so this is a weaker requirement than {@link deviceId} and is
   * available on tenants where that one is not.
   */
  readonly pinnedDeviceId: string | undefined;
  /** How many devices the configured company's list returned, for a report line. */
  readonly pinnedDeviceCount: number;
  /**
   * Whether the LIST read carried a `company` field. The pin reads the SINGLE
   * device (spec §7.2), so this is recorded rather than asserted — a list that
   * omits it says nothing about the read the pin performs.
   */
  readonly listCarriedCompany: boolean;
}

/** One §12.4 probe, kept so the coverage report can name what was tried. */
interface SummariesProbe {
  readonly module: string;
  readonly outcome: string;
  /** `data` keys returned — `devices` for `snmp`, `http_endpoints` for `http`. */
  readonly dataKeys: readonly string[];
  readonly propertyPaths: readonly string[];
}

/** spec §12.5 M3: what `componenttypes` hands out versus what metrics accepts. */
interface ItemTypePair {
  /** The id `GET componenttypes` returned — the plural alias. */
  readonly alias: string;
  /** `<module>_<group>_<data.itemType>` from §6.5 — the singular form. */
  readonly singular: string;
  readonly module: string;
}

let fixture: Fixture | undefined;

/** Non-null accessor so tests do not each repeat the undefined check. */
function fx(): Fixture {
  if (fixture === undefined) {
    throw new Error('discovery did not run — this is a bug in the contract suite, not in Lumics');
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | undefined>;

/** A one-hour window ending now, in epoch ms — the API's own default span. */
function hourWindow(): { fromMs: number; toMs: number } {
  const toMs = Date.now();
  return { fromMs: toMs - HOUR_MS, toMs };
}

/**
 * Add the discovered `properties` unless the caller set the key themselves.
 *
 * spec §12.5 M1: §12.1, §12.2 and both §12.3 endpoints reject a call without it
 * with `400 "Must supply required component metrics as properties parameter"`.
 * Before that was measured, every case in this file died at that 400 — including
 * the ones about `interval`, `limit` and the response envelope, none of which
 * were being exercised at all. Injecting it here restores their subject.
 *
 * The key is honoured when present *even if the value is `undefined`*, which is
 * how the M1 and M2 cases send a deliberately absent or deliberately wrong value
 * without the helper quietly repairing it.
 */
function withRequiredProperties(query: Query): Query {
  if ('properties' in query) {
    return query;
  }
  const { properties } = fx();
  return properties === undefined ? query : { ...query, properties };
}

/**
 * Every case that calls §12.1–§12.3 starts here.
 *
 * Without a `properties` value those endpoints return 400 (spec §12.5 M1), so a
 * case that ran anyway would report a failure about whatever parameter it was
 * really testing — `interval`, `limit`, the envelope — when the cause is that
 * this tenant could not tell us a single legal property name. That is precisely
 * the "assumption never exercised, reported as checked" failure the harness
 * exists to prevent, so it goes UNVERIFIED with the reason spelt out.
 */
function requireProperties(ctx: TestContext, spec: string, claim: string): string {
  const state = fx();
  if (state.properties === undefined) {
    unverifiable(
      ctx,
      spec,
      claim,
      `no metric property name could be discovered on this tenant. spec section 12.5 M1 makes "properties" REQUIRED on sections 12.1, 12.2 and 12.3 (400 "Must supply required component metrics as properties parameter"), and spec section 12.5 M6 records that section 12.4 metrics/summaries is the only endpoint in this API that enumerates property names at all — it returned none for any module probed (${state.probedModules.join(', ')}). Property names are TENANT-SPECIFIC, so this suite will not fall back to a literal such as "Calculated.cpu": inventing one would turn one tenant's data into an assumption about the API, and spec section 12.5 M2 says a wrong value comes back as HTTP 200 with empty stats rather than an error, so the case would appear to pass`,
    );
  }
  return state.properties;
}

function companySeries(query: Query): Promise<unknown> {
  const { client, config } = api();
  return client.get<unknown>(companyMetricsPath(config.companyId, fx().moduleType), {
    query: withRequiredProperties(query),
  });
}

function deviceSeries(deviceId: string, moduleType: string, query: Query): Promise<unknown> {
  const { client } = api();
  return client.get<unknown>(deviceMetricsPath(deviceId, moduleType), {
    query: withRequiredProperties(query),
  });
}

function deviceItemSeries(
  deviceId: string,
  moduleType: string,
  itemId: string,
  query: Query,
): Promise<unknown> {
  const { client } = api();
  return client.get<unknown>(deviceItemMetricsPath(deviceId, moduleType, itemId), {
    query: withRequiredProperties(query),
  });
}

/**
 * §12.4 takes `properties` too, but there it is genuinely optional and behaves as
 * a **filter** rather than a projection (spec §12.5 M1: `Calculated.cpu` returned
 * `count: 0`). Nothing is injected here — a summaries call sends exactly what the
 * caller asked for.
 */
function summaries(query: Query): Promise<unknown> {
  const { client, config } = api();
  return client.get<unknown>(metricSummariesPath(config.companyId, fx().moduleType), { query });
}

// ---------------------------------------------------------------------------
// §12.2 /summarize — measured not to answer (spec §12.5 M5, §14 defect 21)
// ---------------------------------------------------------------------------

/**
 * Set once this run has watched `/summarize` fail to answer.
 *
 * Re-probing an endpoint already measured as unresponsive costs the operator the
 * full budget again for each of the six cases that touch it, and tells them
 * nothing they have not already been told. Later cases short-circuit to the same
 * finding and say in their UNVERIFIED reason that they did not re-probe.
 */
let summarizeUnanswered = false;

/**
 * Call §12.2 with a bounded wait (spec §12.5 M5).
 *
 * Uses the non-retrying `slowProbeApi` client: the default client would retry the
 * timeout twice more, so an endpoint that never answers would occupy roughly
 * three times `LUMICS_TIMEOUT_MS` — most of it after the suite had stopped
 * waiting — and its permits would come out of the pool every other case shares.
 */
async function summarizeProbe(query: Query): Promise<CallOutcome<unknown>> {
  if (summarizeUnanswered) {
    return { ok: false, status: undefined, code: SUITE_DEADLINE_CODE, body: undefined };
  }
  const { client, config } = slowProbeApi();
  const outcome = await attemptWithin(
    client.get<unknown>(companyMetricsSummarizePath(config.companyId, fx().moduleType), {
      query: withRequiredProperties(query),
    }),
    slowProbeBudgetMs(),
  );
  if (isSlowOutcome(outcome)) {
    summarizeUnanswered = true;
  }
  return outcome;
}

/**
 * Abandon a §12.2 case because the endpoint did not answer.
 *
 * Never a pass and never a failure: a shape nobody saw cannot be wrong, and a
 * timeout is not evidence that the vendor's documented envelope is incorrect.
 * It is evidence that the endpoint is unusable on this tenant, which is a finding
 * in its own right — spec §12.5 M5 records it and this is what re-checks it.
 */
function abandonSlowSummarize(
  ctx: TestContext,
  spec: string,
  claim: string,
  outcome: CallOutcome<unknown>,
): never {
  const budget = String(slowProbeBudgetMs());
  return unverifiable(
    ctx,
    spec,
    claim,
    `${describeOutcome(outcome)} — spec section 12.2 did not respond within ${budget} ms${
      !outcome.ok && outcome.code === SUITE_DEADLINE_CODE && summarizeUnanswered
        ? ' (not re-probed: an earlier call to /summarize in this run already exceeded the budget)'
        : ''
    }. This reproduces the 2026-07-30 measurement recorded as spec section 12.5 M5 and section 14 defect 21: /summarize exceeded 90 seconds and never returned a 200, while sections 12.1 and 12.3 answered in 1-2 seconds over the same window and module. The endpoint is SLOW/UNAVAILABLE on this tenant, so this assumption is untested — it is not confirmed and it is not refuted`,
  );
}

/** `{data, ...meta}` split the way `src/tools/metrics.ts` splits it (spec §12.1). */
function envelope(response: unknown): {
  readonly data: unknown;
  readonly meta: Record<string, unknown>;
} {
  if (!isRecord(response)) {
    return { data: undefined, meta: {} };
  }
  const { data, ...meta } = response;
  return { data, meta };
}

function rowsOf(response: unknown): readonly Record<string, unknown>[] {
  const { data } = envelope(response);
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function numberFrom(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Flatten `stats` into the `group.property` paths spec §12.0 uses. */
function statPaths(row: Record<string, unknown>): readonly string[] {
  const stats = row['stats'];
  if (!isRecord(stats)) {
    return [];
  }
  const paths: string[] = [];
  for (const [group, properties] of Object.entries(stats)) {
    if (isRecord(properties)) {
      for (const property of Object.keys(properties)) {
        paths.push(`${group}.${property}`);
      }
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Find a module that reports data, a property name to ask it for, and a device.
 *
 * spec §14 defect 14: no enumeration of `moduleType` or component `itemType` is
 * documented anywhere, so both have to be discovered from `componenttypes` and
 * from the devices' own `modules` maps. spec §12.5 M6 adds a third thing that
 * cannot be looked up — the metric **property names** that M1 makes mandatory —
 * and records that §12.4 `metrics/summaries` is the only endpoint anywhere in
 * this API that lists any.
 *
 * So the order matters and is not the obvious one:
 *
 *  1. `componenttypes` for the module names.
 *  2. **§12.4 first**, per module, to harvest property names. It takes no
 *     `properties` of its own, so it is the one metric endpoint that can be
 *     called before anything is known. Its outcomes double as the module
 *     coverage measurement (spec §12.5 M7).
 *  3. §12.1 with those properties, for the control call, the baseline rows and a
 *     live `itemType` (a row's own `type`, which spec §12.5 M3 says is the
 *     singular id the metrics API accepts).
 *  4. §6.5 device definitions, to build the alias/singular pair the M3 case needs.
 *  5. Devices, for §12.3.
 *
 * Probing stays bounded: at most four modules, three device probes, and one
 * catalogue read each. Windows are one hour at `lastMetric=true`.
 */
async function discover(): Promise<Fixture> {
  const { client, config } = api();
  const window = hourWindow();

  const types = expectArray<ComponentType>(
    await client.get(componentTypesPath(config.companyId)),
    'GET componenttypes',
  );
  const modules = [...new Set(types.map((type) => type.module).filter(isNonEmptyString))];
  const candidates = (modules.length > 0 ? modules : [FALLBACK_MODULE]).slice(0, 4);

  // ---- step 2: property names, from the only endpoint that has them ----
  const summariesProbes: SummariesProbe[] = [];
  let propertyModule: string | undefined;
  let propertyPaths: readonly string[] = [];

  for (const candidate of candidates) {
    const outcome = await attempt(
      client.get<unknown>(metricSummariesPath(config.companyId, candidate), {
        query: { ...window, itemType: DEVICE_ITEM_TYPE },
      }),
    );
    const dataKeys = outcome.ok ? keysOf(envelope(outcome.value).data) : [];
    const paths = outcome.ok ? summaryPropertyPaths(outcome.value) : [];
    summariesProbes.push({
      module: candidate,
      outcome: describeOutcome(outcome),
      dataKeys,
      propertyPaths: paths,
    });
    if (propertyModule === undefined && paths.length > 0) {
      propertyModule = candidate;
      propertyPaths = paths;
    }
  }

  // Two names at most. spec §12.0 documents a comma-separated list and the
  // vendor's own example passes several; asking for two exercises the list form
  // without turning a contract check into a data pull.
  const properties = propertyPaths.length === 0 ? undefined : propertyPaths.slice(0, 2).join(',');
  const propertyGroups = [
    ...new Set(propertyPaths.map((path) => path.split('.')[0]).filter(isNonEmptyString)),
  ];

  // ---- step 3: the §12.1 control, now that a properties value exists ----
  // The module that produced property names is tried first: those names are
  // module-scoped, so pairing them with a different module would measure nothing.
  const seriesOrder =
    propertyModule === undefined
      ? candidates
      : [propertyModule, ...candidates.filter((candidate) => candidate !== propertyModule)];

  let moduleType = seriesOrder[0] ?? FALLBACK_MODULE;
  let controlOk = false;
  let baselineRows: readonly Record<string, unknown>[] = [];

  for (const candidate of seriesOrder) {
    const outcome = await attempt(
      client.get<unknown>(companyMetricsPath(config.companyId, candidate), {
        query: {
          ...window,
          dataPoints: SMALL_DATA_POINTS,
          lastMetric: true,
          ...(properties === undefined ? {} : { properties }),
        },
      }),
    );
    if (!outcome.ok) {
      continue;
    }
    const rows = rowsOf(outcome.value);
    if (!controlOk) {
      // First module that answers at all becomes the control, even with no rows:
      // the acceptance tests only need a module the API is willing to serve.
      moduleType = candidate;
      controlOk = true;
    }
    if (rows.length > 0) {
      moduleType = candidate;
      baselineRows = rows;
      break;
    }
  }

  const firstRow = baselineRows[0];
  const itemType =
    firstRow !== undefined && isNonEmptyString(firstRow['type']) ? firstRow['type'] : undefined;
  // Strictly from a §12.1 row, never from the §12.4 harvest: this is the value
  // the "properties returns what you asked for" case requests back from §12.1,
  // and a device-scoped name (spec §12.5 M6) is not a component-level one.
  const propertyPath = baselineRows.flatMap((row) => statPaths(row))[0];

  // ---- step 4: the alias/singular itemType pair (spec §12.5 M3) ----
  const definitions = expectArray<DeviceDefinitionComponent>(
    await client.get(deviceDefinitionComponentsPath()),
    'GET system device definitions',
  );
  const itemTypePair = findItemTypePair(definitions, types, moduleType);

  // ---- step 5: devices ----
  // The configured company's own list, and deliberately nothing else: these ids
  // are the ones the device metric tools' ownership pre-read will accept. See
  // pinnedCompanyDevices in harness.ts.
  const devices = await pinnedCompanyDevices(3);
  const firstDevice = devices[0];
  const pinnedDeviceId = firstDevice === undefined ? undefined : resourceId(firstDevice);
  const listCarriedCompany = firstDevice !== undefined && typeof firstDevice.company === 'string';

  let deviceId: string | undefined;
  let deviceModuleType: string | undefined;

  for (const device of devices) {
    const id = resourceId(device);
    const deviceModules = deviceModuleNames(device);
    if (id === undefined || deviceModules.length === 0) {
      continue;
    }
    const candidate = deviceModules[0];
    if (candidate === undefined) {
      continue;
    }
    deviceId ??= id;
    deviceModuleType ??= candidate;

    const outcome = await attempt(
      client.get<unknown>(deviceMetricsPath(id, candidate), {
        query: {
          ...window,
          dataPoints: SMALL_DATA_POINTS,
          lastMetric: true,
          ...(properties === undefined ? {} : { properties }),
        },
      }),
    );
    if (outcome.ok && rowsOf(outcome.value).length > 0) {
      deviceId = id;
      deviceModuleType = candidate;
      break;
    }
  }

  return {
    moduleType,
    controlOk,
    probedModules: candidates,
    baselineRows,
    itemType,
    propertyPath,
    properties,
    propertyGroups,
    summariesProbes,
    itemTypePair,
    deviceId,
    deviceModuleType,
    pinnedDeviceId,
    pinnedDeviceCount: devices.length,
    listCarriedCompany,
  };
}

/** Flatten the §12.4 `data` object's `stats` into `group.property` paths. */
function summaryPropertyPaths(response: unknown): readonly string[] {
  const { data } = envelope(response);
  if (!isRecord(data)) {
    return [];
  }
  const paths: string[] = [];
  for (const items of Object.values(data)) {
    if (!Array.isArray(items)) {
      continue;
    }
    for (const item of items) {
      if (isRecord(item)) {
        paths.push(...statPaths(item));
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Line the two component vocabularies up (spec §12.5 M3).
 *
 * §6.4 `componenttypes` returns `<module>_<group>_<data.componentAlias>` — the
 * plural alias — and the metrics API rejects it with `400 Unknown component`.
 * The id it accepts is `<module>_<group>_<data.itemType>`, singular, and §6.5 is
 * where both halves live: the module and group come out of `filePath`
 * (`/components/snmp/common/Cpu.yml`), the singular from `data.itemType`.
 *
 * A pair is only usable if the alias really is one `componenttypes` handed out —
 * otherwise the case would be asserting that an invented string is rejected,
 * which proves nothing. Preference goes to the module under test so the call is
 * one the API is otherwise willing to serve.
 */
function findItemTypePair(
  definitions: readonly DeviceDefinitionComponent[],
  types: readonly ComponentType[],
  preferredModule: string,
): ItemTypePair | undefined {
  const catalogueIds = new Set(types.map((type) => type.id).filter(isNonEmptyString));
  const pairs: ItemTypePair[] = [];

  for (const definition of definitions) {
    const segments = (definition.filePath ?? '').split('/').filter((part) => part.length > 0);
    // `/components/<module>/<group>/<Model>.yml`
    if (segments.length < 4 || segments[0] !== 'components') {
      continue;
    }
    const [, module, group] = segments;
    const singularType = definition.data?.itemType;
    const aliasType = definition.data?.componentAlias;
    if (
      !isNonEmptyString(module) ||
      !isNonEmptyString(group) ||
      !isNonEmptyString(singularType) ||
      !isNonEmptyString(aliasType) ||
      singularType === aliasType
    ) {
      continue;
    }
    const alias = `${module}_${group}_${aliasType}`;
    if (!catalogueIds.has(alias)) {
      continue;
    }
    pairs.push({ alias, singular: `${module}_${group}_${singularType}`, module });
  }

  return pairs.find((pair) => pair.module === preferredModule) ?? pairs[0];
}

/**
 * spec §7.1: `modules` is a map whose *key* need not equal the module name, so
 * the `module` field is read rather than the key.
 */
function deviceModuleNames(device: Device): readonly string[] {
  const modules = device.modules;
  if (!isRecord(modules)) {
    return [];
  }
  const names: string[] = [];
  for (const value of Object.values(modules)) {
    if (isRecord(value) && isNonEmptyString(value['module'])) {
      names.push(value['module']);
    }
  }
  return [...new Set(names)];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

beforeAll(async () => {
  if (!RUNNABLE) {
    return;
  }
  fixture = await discover();
}, DISCOVERY_TIMEOUT);

afterAll(() => {
  reportEvidence('metric endpoints (spec section 12)');
});

// ---------------------------------------------------------------------------
// Assumption 1 — dataPoints (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — dataPoints', () => {
  it(
    'ASSERT: dataPoints is accepted on the company metric endpoint',
    async (ctx) => {
      const state = fx();
      requireProperties(
        ctx,
        '12.0',
        'dataPoints is an accepted query parameter on the metric-data endpoints',
      );
      if (!state.controlOk) {
        unverifiable(
          ctx,
          '12.0',
          'dataPoints is an accepted query parameter on the metric-data endpoints',
          `no metric module answered at all (probed: ${state.probedModules.join(', ')}), so a rejection could not be attributed to dataPoints rather than to the module name`,
        );
      }
      const outcome = await attempt(
        companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS }),
      );
      expect(
        outcome.ok,
        `dataPoints=${String(SMALL_DATA_POINTS)} was ${describeOutcome(outcome)}. spec section 12.0 documents dataPoints as one of the two accepted resolution parameters, and src/tools/metrics.ts sends it on EVERY metric call — if it is rejected, every metric tool is broken. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'dataPoints is an accepted query parameter on the metric-data endpoints',
        `module "${state.moduleType}" accepted dataPoints=${String(SMALL_DATA_POINTS)}`,
      );
    },
    TIMEOUT,
  );

  /**
   * Moved off §12.2 onto §12.1 (spec §12.5 M5).
   *
   * This case used to compare the *bucket count* `/summarize` returns, which was
   * the natural reading of the parameter — and it is now the one endpoint that
   * cannot answer. §12.1 measures the same claim through the envelope's own
   * `timeIncrement`: the resolution the API actually chose. The §12.2 form is
   * kept as the case below, budgeted, because bucket count is the more direct
   * evidence and should be collected the day that endpoint recovers.
   */
  it(
    'ASSERT: dataPoints changes the resolution the API returns (spec 12.1)',
    async (ctx) => {
      const claim = 'dataPoints influences the returned resolution';
      requireProperties(ctx, '12.0', claim);
      const state = fx();
      const toMs = Date.now();
      const window = { fromMs: toMs - DAY_MS, toMs };
      const shared = { ...window, aggregate: true, itemType: state.itemType };

      const coarse = await companySeries({ ...shared, dataPoints: COARSE_DATA_POINTS });
      const fine = await companySeries({ ...shared, dataPoints: FINE_DATA_POINTS });

      const coarseRows = rowsOf(coarse).length;
      const fineRows = rowsOf(fine).length;
      const coarseIncrement = numberFrom(envelope(coarse).meta, 'timeIncrement');
      const fineIncrement = numberFrom(envelope(fine).meta, 'timeIncrement');
      const detail =
        `dataPoints=${String(COARSE_DATA_POINTS)} -> ${String(coarseRows)} row(s), timeIncrement ${describeValue(coarseIncrement)}; ` +
        `dataPoints=${String(FINE_DATA_POINTS)} -> ${String(fineRows)} row(s), timeIncrement ${describeValue(fineIncrement)} (24h window, module "${state.moduleType}")`;

      // Equal resolution and no extra rows cannot distinguish "dataPoints
      // ignored" from "this tenant has almost no history in the window", and on
      // §12.1 an unaggregated series may not vary its row count at all. Say so
      // rather than pass.
      if (coarseIncrement === fineIncrement && fineRows <= coarseRows) {
        unverifiable(
          ctx,
          '12.0',
          claim,
          `${detail} — the API reported the same timeIncrement for both and no additional rows, so influence cannot be told from a window with too little history`,
        );
      }

      expect(
        fineRows > coarseRows || coarseIncrement !== fineIncrement,
        `dataPoints appears to be IGNORED: ${detail}. spec section 12.0 documents it as the resolution control ("the number of data points to return"). If this is real, every metric tool returns a series at a resolution nobody chose. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'dataPoints influences the returned resolution (timeIncrement and/or row count) on spec section 12.1',
        detail,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: dataPoints changes the number of buckets summarize returns (spec 12.2)',
    async (ctx) => {
      const claim = 'dataPoints influences the number of buckets spec section 12.2 returns';
      requireProperties(ctx, '12.2', claim);
      const state = fx();
      const toMs = Date.now();
      const window = { fromMs: toMs - DAY_MS, toMs };
      const shared = { ...window, aggregate: true, itemType: state.itemType };

      const coarse = await summarizeProbe({ ...shared, dataPoints: COARSE_DATA_POINTS });
      if (!coarse.ok) {
        if (isSlowOutcome(coarse)) {
          abandonSlowSummarize(ctx, '12.2', claim, coarse);
        }
        unverifiable(
          ctx,
          '12.2',
          claim,
          `the coarse call was ${describeOutcome(coarse)}, so there is no baseline to compare a finer one against`,
        );
      }
      const fine = await summarizeProbe({ ...shared, dataPoints: FINE_DATA_POINTS });
      if (!fine.ok) {
        if (isSlowOutcome(fine)) {
          abandonSlowSummarize(ctx, '12.2', claim, fine);
        }
        unverifiable(ctx, '12.2', claim, `the fine call was ${describeOutcome(fine)}`);
      }

      const coarseRows = rowsOf(coarse.value).length;
      const fineRows = rowsOf(fine.value).length;
      const coarseIncrement = numberFrom(envelope(coarse.value).meta, 'timeIncrement');
      const fineIncrement = numberFrom(envelope(fine.value).meta, 'timeIncrement');
      const detail =
        `dataPoints=${String(COARSE_DATA_POINTS)} -> ${String(coarseRows)} bucket(s), timeIncrement ${describeValue(coarseIncrement)}; ` +
        `dataPoints=${String(FINE_DATA_POINTS)} -> ${String(fineRows)} bucket(s), timeIncrement ${describeValue(fineIncrement)} (24h window, module "${state.moduleType}")`;

      if (fineRows <= COARSE_DATA_POINTS && coarseIncrement === fineIncrement) {
        unverifiable(
          ctx,
          '12.2',
          claim,
          `${detail} — too few buckets exist in this window to tell influence from absent data`,
        );
      }

      expect(
        fineRows > coarseRows || coarseIncrement !== fineIncrement,
        `dataPoints appears to be IGNORED on spec section 12.2: ${detail}.`,
      ).toBe(true);
      recordAsserted(
        '12.2',
        'dataPoints influences the number of buckets summarize returns',
        `${detail}. Note this contradicts nothing about spec section 12.5 M5 — it means /summarize ANSWERED on this run, which the 2026-07-30 measurement did not see`,
      );
    },
    SUMMARIZE_TIMEOUT,
  );

  it(
    'OBSERVE: what happens when neither dataPoints nor width is sent',
    async (ctx) => {
      const state = fx();
      // Without a properties value the call would be rejected for THAT reason
      // (spec §12.5 M1) and the observation would be about the wrong parameter.
      requireProperties(
        ctx,
        '12.0',
        'spec says "Either dataPoints or width must be set" — is a call with neither actually rejected?',
      );
      const outcome = await attempt(companySeries(hourWindow()));

      // The assertion is real: spec section 3 is explicit that its table is the
      // only documented status set, so an undocumented status is drift.
      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `omitting both resolution parameters produced ${describeOutcome(outcome)}, which spec section 3 does not document.`,
      ).toBe(true);

      recordObserved(
        '12.0',
        'spec says "Either dataPoints or width must be set" — is a call with neither actually rejected?',
        `${describeOutcome(outcome)} (module "${state.moduleType}"). ${
          outcome.ok
            ? "The API served the call, so this server's always-send-a-resolution behaviour (RFC-001 D5 item 2) is helpful rather than load-bearing."
            : 'The requirement is real: a metric call with no resolution fails, and the default in src/tools/metrics.ts is what keeps model-issued calls working.'
        }`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 2 — sum (spec §12.2)
// ---------------------------------------------------------------------------

/**
 * Every case in this block depends on §12.2 answering, which on 2026-07-30 it
 * did not (spec §12.5 M5). They are kept, unchanged in what they claim, and each
 * one now reports the endpoint as slow and its own assumption as UNVERIFIED
 * rather than hanging until vitest kills it. Nothing here may assert a shape
 * nobody has seen: a timeout is not evidence that `sum` is misdocumented.
 */
describe.skipIf(!RUNNABLE)('live contract: spec 12.2 — sum is a string enum, not a boolean', () => {
  // A plain loop rather than `it.each`, because each case needs its own test
  // context to report the endpoint as slow rather than as a pass.
  for (const sum of DOCUMENTED_SUMS) {
    it(
      `ASSERT: summarize accepts sum="${sum}"`,
      async (ctx) => {
        const claim = 'sum accepts the documented string values min | max | avg';
        requireProperties(ctx, '12.2', claim);
        const outcome = await summarizeProbe({
          ...hourWindow(),
          dataPoints: SMALL_DATA_POINTS,
          sum,
        });
        if (isSlowOutcome(outcome)) {
          abandonSlowSummarize(ctx, '12.2', claim, outcome);
        }
        expect(
          outcome.ok,
          `sum="${sum}" was ${describeOutcome(outcome)}. spec section 12.2 documents sum as a string naming which per-component rollup property feeds the cross-component total, with values min, max or avg. RFC-001 records that the prototype typed this as a boolean and was malformed on every summarize call; if the string form is rejected too, the parameter is not what the docs say and must be reported. Note that "properties" was supplied (spec section 12.5 M1), so a 400 here is NOT the missing-properties rejection.`,
        ).toBe(true);
        recordAsserted('12.2', claim, `sum="${sum}" accepted`);
      },
      SUMMARIZE_TIMEOUT,
    );
  }

  it(
    "OBSERVE: how the API treats a boolean-ish sum (the prototype's bug)",
    async (ctx) => {
      const claim = 'sum is documented as a string; what does a boolean value do?';
      requireProperties(ctx, '12.2', claim);
      // Sent once, deliberately, to characterise the failure the prototype would
      // have produced. Production code must never send this.
      const outcome = await summarizeProbe({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        sum: true,
      });
      if (isSlowOutcome(outcome)) {
        abandonSlowSummarize(ctx, '12.2', claim, outcome);
      }
      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `sum=true produced ${describeOutcome(outcome)}, which spec section 3 does not document.`,
      ).toBe(true);
      recordObserved(
        '12.2',
        claim,
        `sum=true was ${describeOutcome(outcome)}. ${
          outcome.ok
            ? "Accepted — so the prototype's boolean sum produced a SILENTLY wrong aggregation rather than an error, which is the worse failure mode and worth stating in the release notes."
            : "Rejected — so the prototype's boolean sum failed loudly. This reproduces the 2026-07-30 measurement recorded in spec section 0.4."
        }`,
      );
    },
    SUMMARIZE_TIMEOUT,
  );

  it(
    'OBSERVE: whether the envelope reports a different aggregation mode with sum',
    async (ctx) => {
      const claim = 'presence of sum switches the cross-component reduction from average to sum';
      requireProperties(ctx, '12.2', claim);
      const withoutSum = await summarizeProbe({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS });
      if (isSlowOutcome(withoutSum)) {
        abandonSlowSummarize(ctx, '12.2', claim, withoutSum);
      }
      const withSum = await summarizeProbe({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        sum: 'max',
      });
      if (isSlowOutcome(withSum)) {
        abandonSlowSummarize(ctx, '12.2', claim, withSum);
      }
      if (!withoutSum.ok || !withSum.ok) {
        unverifiable(
          ctx,
          '12.2',
          claim,
          `summarize answered but refused the call: without sum ${describeOutcome(withoutSum)}, with sum=max ${describeOutcome(withSum)} — a refused call carries no envelope to read the mode from`,
        );
      }

      const plain = envelope(withoutSum.value).meta['type'];
      const summed = envelope(withSum.value).meta['type'];
      if (plain === undefined && summed === undefined) {
        unverifiable(
          ctx,
          '12.2',
          claim,
          'neither response carried the envelope "type" field the vendor examples show, so the mode cannot be read',
        );
      }
      recordObserved(
        '12.2',
        'presence of sum switches the reduction from average to sum (vendor example shows type "summed")',
        `without sum: type ${describeVocabulary(plain, DOCUMENTED_ENVELOPE_TYPES)}; with sum=max: type ${describeVocabulary(summed, DOCUMENTED_ENVELOPE_TYPES)}`,
      );
    },
    SUMMARIZE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 3 — interval (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — the interval enum', () => {
  // A plain loop rather than `it.each`: each case needs its own test context so
  // a tenant that cannot supply a `properties` value (spec §12.5 M1) reports
  // UNVERIFIED instead of failing on a 400 about a parameter it is not testing.
  for (const interval of DOCUMENTED_INTERVALS) {
    it(
      `ASSERT: interval="${interval}" is accepted`,
      async (ctx) => {
        const claim = 'interval accepts the documented values minute | fiveMin | hour | day';
        requireProperties(ctx, '12.0', claim);
        const outcome = await attempt(
          companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, interval }),
        );
        expect(
          outcome.ok,
          `interval="${interval}" was ${describeOutcome(outcome)}. spec section 12.0 documents exactly four valid options — minute, fiveMin, hour, day — and src/constants.ts METRIC_INTERVALS mirrors them. A rejection means the enum in the docs is wrong; report it.`,
        ).toBe(true);
        recordAsserted('12.0', claim, `interval="${interval}" accepted`);
      },
      TIMEOUT,
    );
  }

  it(
    'OBSERVE: whether an out-of-enum interval is rejected or silently ignored',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.0',
        'the docs list four interval values but do not say what an unrecognised one does',
      );
      const window = hourWindow();
      // "tenMin" is not in the documented enum. Sent once to establish which of
      // the two failure modes applies; the difference matters because a silently
      // ignored interval returns a series at a resolution the caller did not ask
      // for and cannot detect.
      const baseline = await attempt(
        companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, interval: 'hour' }),
      );
      const bogus = await attempt(
        companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, interval: 'tenMin' }),
      );

      expect(
        bogus.ok || bogus.status === undefined || DOCUMENTED_STATUSES.includes(bogus.status),
        `interval="tenMin" produced ${describeOutcome(bogus)}, which spec section 3 does not document.`,
      ).toBe(true);

      const baselineIncrement = baseline.ok
        ? numberFrom(envelope(baseline.value).meta, 'timeIncrement')
        : undefined;
      const bogusIncrement = bogus.ok
        ? numberFrom(envelope(bogus.value).meta, 'timeIncrement')
        : undefined;

      recordObserved(
        '12.0',
        'the docs list four interval values but do not say what an unrecognised one does',
        `interval="tenMin" was ${describeOutcome(bogus)}; timeIncrement ${describeValue(bogusIncrement)} versus ${describeValue(baselineIncrement)} for interval="hour". ${
          bogus.ok
            ? 'Accepted, so an unrecognised interval does NOT fail loudly — a typo in an interval yields a silently different resolution.'
            : 'Rejected, so an unrecognised interval fails fast.'
        }`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 4 — the fromMs/toMs window (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — fromMs/toMs are epoch milliseconds', () => {
  it(
    'ASSERT: the echoed window proves the values were read as milliseconds, not seconds',
    async (ctx) => {
      requireProperties(ctx, '12.0', 'fromMs/toMs are epoch milliseconds');
      const window = hourWindow();
      const response = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const meta = envelope(response).meta;
      const echoedFromMs = numberFrom(meta, 'fromMs');
      const echoedFrom = meta['from'];

      if (echoedFromMs === undefined || typeof echoedFrom !== 'string') {
        unverifiable(
          ctx,
          '12.0',
          'fromMs/toMs are epoch milliseconds',
          `the response carried no numeric fromMs and/or no ISO "from" to compare (meta keys: ${keysOf(meta).join(',')})`,
        );
      }

      const parsed = Date.parse(echoedFrom);
      expect(
        Number.isNaN(parsed),
        'the envelope\'s "from" was not a parseable ISO-8601 timestamp (spec section 12.1 documents one).',
      ).toBe(false);

      // The envelope is self-consistent: `from` is the ISO rendering of `fromMs`.
      expect(
        parsed,
        'the envelope\'s ISO "from" does not correspond to its own numeric "fromMs" — the two disagree, which makes the reported window untrustworthy.',
      ).toBe(echoedFromMs);

      // The unit claim. Had the API read our integer as epoch *seconds*, the
      // echoed instant would land in 1970, roughly 55 years away. A day of
      // tolerance leaves room for rollup snapping without weakening the check.
      expect(
        Math.abs(parsed - window.fromMs) <= DAY_MS,
        `the window we requested came back as ${new Date(parsed).toISOString()}, which is more than a day from what was sent. spec section 12.0 documents fromMs/toMs as epoch MILLISECONDS; a value near 1970 would mean the API reads them as seconds and src/util/time.ts is producing the wrong unit on every metric call.`,
      ).toBe(true);

      recordAsserted(
        '12.0',
        'fromMs/toMs are interpreted as epoch milliseconds and echoed consistently as ISO instants',
        `requested a 1h window; envelope echoed an instant within a day of it and its ISO "from" matched its own fromMs`,
      );
      recordObserved(
        '12.0',
        'whether the echoed window is the requested window or an adjusted one',
        echoedFromMs === window.fromMs
          ? 'echoed fromMs equals the requested value exactly (no adjustment without alignTimeRange)'
          : `echoed fromMs differs from the requested value by ${String(echoedFromMs - window.fromMs)} ms even though alignTimeRange was not sent — the effective window is not the requested one`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: returned data falls inside the effective window',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.0',
        'the requested fromMs/toMs window is honoured by the returned data',
      );
      const window = hourWindow();
      const response = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const meta = envelope(response).meta;
      const rows = rowsOf(response);
      const timestamps = rows
        .map((row) => numberFrom(row, 'timeMs'))
        .filter((value): value is number => value !== undefined);

      if (timestamps.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'the requested fromMs/toMs window is honoured by the returned data',
          `module "${fx().moduleType}" returned ${String(rows.length)} row(s) with no numeric timeMs over the last hour, so there is nothing to place inside the window`,
        );
      }

      const from = numberFrom(meta, 'fromMs') ?? window.fromMs;
      const to = numberFrom(meta, 'toMs') ?? window.toMs;
      // A bucket is stamped at one of its edges, so one bucket of slack is the
      // honest tolerance. Never less than a minute — the finest documented rollup.
      const slack = Math.max(numberFrom(meta, 'timeIncrement') ?? 0, 60_000);
      const outside = timestamps.filter((value) => value < from - slack || value > to + slack);

      expect(
        outside.length,
        `${String(outside.length)} of ${String(timestamps.length)} returned point(s) fall outside the effective window Lumics itself reported, allowing one bucket (${String(slack)} ms) of slack. spec section 12.0 documents fromMs/toMs as the time-range control; if data outside the window comes back, every windowed answer this server gives is wider than it claims. Report this.`,
      ).toBe(0);

      recordAsserted(
        '12.0',
        'data returned falls inside the requested/effective fromMs..toMs window',
        `${String(timestamps.length)} timestamped point(s) checked against the echoed window with ${String(slack)} ms slack`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: omitting fromMs/toMs yields the documented one-hour default',
    async (ctx) => {
      requireProperties(ctx, '12.0', 'fromMs defaults to one hour ago and toMs to now');
      const before = Date.now();
      const response = await companySeries({ dataPoints: SMALL_DATA_POINTS });
      const after = Date.now();
      const meta = envelope(response).meta;
      const from = numberFrom(meta, 'fromMs');
      const to = numberFrom(meta, 'toMs');

      if (from === undefined || to === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'fromMs defaults to one hour ago and toMs to now',
          `the response echoed no numeric window (meta keys: ${keysOf(meta).join(',')}), so the default cannot be read`,
        );
      }

      const span = to - from;
      expect(
        Math.abs(span - HOUR_MS) <= 120_000,
        `the default window spans ${String(span)} ms, not the documented one hour (${String(HOUR_MS)} ms). spec section 12.0: "Defaults to one hour ago if not specified". src/util/time.ts DEFAULT_LOOKBACK mirrors that hour, so a different server-side default means this server's stated window and the data disagree.`,
      ).toBe(true);
      expect(
        to >= before - 120_000 && to <= after + 120_000,
        `the default toMs (${new Date(to).toISOString()}) is not "the current time" as spec section 12.0 documents.`,
      ).toBe(true);

      recordAsserted(
        '12.0',
        'omitting fromMs/toMs yields a one-hour window ending now',
        `echoed span ${String(span)} ms, within 2 minutes of the documented 3600000 ms`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 5 — envelope shapes (spec §12.1–§12.4)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.1-12.4 — response envelopes', () => {
  it(
    'ASSERT: the company metric endpoint returns {data: [...]} (spec 12.1)',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.1',
        'company metrics returns the documented {data: [...]} envelope',
      );
      const response = await companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS });
      assertSeriesEnvelope(response, '12.1', 'company metrics');
    },
    TIMEOUT,
  );

  /**
   * spec §12.5 M8: the row fields observed on 2026-07-30 were `item`, `timeMs`,
   * `stats` and `type`. The first three are what the tool layer and this suite
   * read — `stats` for every property claim, `timeMs` for the window check — and
   * `type` is the singular component id spec §12.5 M3 says is the reliable
   * source of a usable `itemType`. Asserted rather than observed because a row
   * missing any of them breaks a specific, named thing.
   */
  it(
    'ASSERT: spec 12.1 rows carry item, timeMs, stats and type',
    async (ctx) => {
      const claim = 'each spec section 12.1 data row carries item, timeMs, stats and type';
      requireProperties(ctx, '12.1', claim);
      const rows = rowsOf(
        await companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, lastMetric: true }),
      );
      const first = rows[0];
      if (first === undefined) {
        unverifiable(
          ctx,
          '12.1',
          claim,
          `module "${fx().moduleType}" returned no rows in the last hour, so there is no row whose fields could be inspected`,
        );
      }

      for (const field of ['item', 'timeMs', 'stats'] as const) {
        expect(
          rows.every((row) => row[field] !== undefined),
          `at least one spec section 12.1 row carried no "${field}" (first row keys: ${keysOf(first).join(',')}). The 2026-07-30 run recorded the row shape {item, timeMs, stats, type} (spec section 12.5 M8); "item" identifies which component a row belongs to, "timeMs" places it in the window, and "stats" is the only place a metric value appears — a row without them cannot be interpreted at all.`,
        ).toBe(true);
      }
      expect(
        rows.every((row) => typeof row['type'] === 'string'),
        `at least one spec section 12.1 row carried no string "type" (first row keys: ${keysOf(first).join(',')}). spec section 12.5 M3 records a row's own "type" as the SINGULAR component id the metrics API accepts as itemType — the only reliable source of one, since the componenttypes catalogue returns the plural alias it rejects.`,
      ).toBe(true);

      recordAsserted(
        '12.1',
        claim,
        `${String(rows.length)} row(s) checked; first row keys: ${keysOf(first).join(',')}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: summarize returns {data: [...]} (spec 12.2)',
    async (ctx) => {
      const claim = 'company metrics summarize returns the documented {data: [...]} envelope';
      requireProperties(ctx, '12.2', claim);
      const outcome = await summarizeProbe({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS });
      if (isSlowOutcome(outcome)) {
        abandonSlowSummarize(ctx, '12.2', claim, outcome);
      }
      if (!outcome.ok) {
        unverifiable(
          ctx,
          '12.2',
          claim,
          `summarize was ${describeOutcome(outcome)} on a module spec section 12.1 serves, with a properties value supplied — a refused call carries no envelope to check`,
        );
      }
      assertSeriesEnvelope(outcome.value, '12.2', 'company metrics summarize');
    },
    SUMMARIZE_TIMEOUT,
  );

  it(
    'ASSERT: the device metric endpoint returns {data: [...]} (spec 12.3)',
    async (ctx) => {
      const state = fx();
      requireProperties(
        ctx,
        '12.3',
        'GET /metrics/devices/:id/modules/:moduleType returns {data: [...]}',
      );
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'GET /metrics/devices/:id/modules/:moduleType returns {data: [...]}',
          'no device in the CONFIGURED company declares a polling module, so the endpoint cannot be called meaningfully. Devices from any other company are deliberately not considered: the metric tools refuse them (the ownership pre-read), so an id from elsewhere would test the pin rather than this envelope',
        );
      }
      // The metric read only. In the tool layer this same call is preceded by the
      // company-scoped device read covered above; the device id used here came
      // from the configured company's own list, so that pre-read would pass.
      const response = await deviceSeries(state.deviceId, state.deviceModuleType, {
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
      });
      assertSeriesEnvelope(response, '12.3', 'device metrics');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the single-item device endpoint returns {data: [...]} (spec 12.3)',
    async (ctx) => {
      const state = fx();
      requireProperties(
        ctx,
        '12.3',
        'GET /metrics/devices/:id/modules/:moduleType/:item returns {data: [...]}',
      );
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'GET /metrics/devices/:id/modules/:moduleType/:item returns {data: [...]}',
          'no device in the CONFIGURED company declares a polling module (a device from another company would be refused by the ownership pre-read before this endpoint was reached)',
        );
      }
      // spec §12.3: ":item — Item ID (device ID or component ID)". The device's
      // own id is the documented way to ask for device-level metrics.
      const outcome = await attempt(
        deviceItemSeries(state.deviceId, state.deviceModuleType, state.deviceId, {
          ...hourWindow(),
          dataPoints: SMALL_DATA_POINTS,
        }),
      );
      expect(
        outcome.ok,
        `passing the device's own id as :item was ${describeOutcome(outcome)}. spec section 12.3 documents ":item — Item ID (device ID or component ID)"; if a device id is not accepted there, lumics_get_device_item_metrics cannot serve device-level metrics at all.`,
      ).toBe(true);
      if (outcome.ok) {
        assertSeriesEnvelope(outcome.value, '12.3', 'device item metrics');
      }
    },
    TIMEOUT,
  );

  it(
    'ASSERT: metrics/summaries returns {data: {<class>: [...]}, count} (spec 12.4)',
    async (ctx) => {
      // No `properties`: spec §12.5 M1 records it as genuinely optional here, and
      // as a FILTER rather than a projection when supplied — sending one would
      // narrow the very key set this case is here to look at.
      const response = await summaries({ ...hourWindow(), itemType: DEVICE_ITEM_TYPE });
      const { data, meta } = envelope(response);

      expect(isRecord(response), 'spec section 12.4 documents an object envelope').toBe(true);
      expect(
        Array.isArray(data),
        'spec section 12.4 documents "data" as an OBJECT keyed by item class, not an array. src/tools/metrics.ts unwrapMetricSummaries relies on that difference from sections 12.1-12.3; if data is an array here the two unwrappers are the wrong way round.',
      ).toBe(false);

      // An absent `data` would satisfy "not an array" without demonstrating
      // anything about the documented object shape, so it is reported as
      // unverified rather than counted as evidence. src/tools/metrics.ts does
      // tolerate an absent data (it yields zero classes), which is why this is
      // not a failure.
      if (data === undefined || data === null) {
        recordObserved(
          '12.4',
          'the envelope this endpoint returned when nothing matched',
          `no "data" field at all; envelope keys: ${keysOf(meta).join(',')}`,
        );
        unverifiable(
          ctx,
          '12.4',
          'metrics/summaries returns {data: {<class>: [...]}, count: n}',
          'the response carried no "data" field, so the object-keyed shape the tool layer unwraps could not be observed',
        );
      }
      expect(
        isRecord(data),
        `spec section 12.4 documents "data" as an object; this response carried ${describeValue(data)}.`,
      ).toBe(true);

      const classes = keysOf(data);
      for (const className of classes) {
        expect(
          Array.isArray((data as Record<string, unknown>)[className]),
          `the "${className}" entry of the summaries "data" object is not an array; src/tools/metrics.ts only collects array-valued entries and would silently drop this class.`,
        ).toBe(true);
      }

      // spec §12.5 M8 recorded {count, combineMs, data, preQueryMs, queryMs,
      // timeInterval}. `count` is the one a client acts on: spec §12.4 documents
      // it as the total summarised, and lumics_get_metric_summary ranks locally
      // because there is no server-side limit, so a missing count would leave the
      // model with no way to know how much it was ranking.
      expect(
        typeof meta['count'],
        `the spec section 12.4 envelope carried ${describeValue(meta['count'])} for "count" (envelope keys: ${keysOf(meta).join(',')}). Both the vendor's example and the 2026-07-30 measurement (spec section 12.5 M8) show a numeric count.`,
      ).toBe('number');

      recordAsserted(
        '12.4',
        'metrics/summaries returns an object-keyed data envelope with a numeric count, unlike sections 12.1-12.3',
        `data is ${describeValue(data)}; count is ${describeValue(meta['count'])}; envelope keys: ${keysOf(meta).join(',')}`,
      );
      recordObserved(
        '12.4',
        'the docs name only "devices" as a data key; the 2026-07-30 run found the key is MODULE-DEPENDENT (devices for snmp, http_endpoints for http — spec section 12.5 M6)',
        classes.length === 0
          ? 'this tenant returned no item-class keys at all for itemType="device" in the last hour, so the key set remains undocumented AND unobserved'
          : `keys actually returned for module "${fx().moduleType}" at itemType="device": ${classes.join(', ')}. A client must read whatever keys arrive rather than looking up "devices"`,
      );
    },
    TIMEOUT,
  );
});

/** Shared assertion for the three `{data: [...]}` endpoints (spec §12.1–§12.3). */
function assertSeriesEnvelope(response: unknown, spec: string, label: string): void {
  const { data, meta } = envelope(response);
  expect(
    isRecord(response),
    `spec section ${spec} documents ${label} as an object envelope carrying "data"; the body was ${describeValue(response)}.`,
  ).toBe(true);
  expect(
    Array.isArray(data),
    `spec section ${spec} documents "data" as an ARRAY of metric rows; this response carried ${describeValue(data)}. src/tools/metrics.ts unwrapMetricSeries throws on anything else, so the tool would fail outright.`,
  ).toBe(true);
  recordAsserted(
    spec,
    `${label} returns the documented {data: [...], <meta>} envelope`,
    `data is ${describeValue(data)}; envelope meta keys: ${keysOf(meta).join(',')}; aggregation mode ${describeVocabulary(meta['type'], DOCUMENTED_ENVELOPE_TYPES)}`,
  );
}

// ---------------------------------------------------------------------------
// Assumption 6 — the ownership pre-read that puts §12.3 behind the company pin
// (spec §7.2, relied on by §12.3)
// ---------------------------------------------------------------------------

/**
 * The pre-read is a security control implemented entirely out of *live API
 * behaviour*, which is why it belongs in this file rather than only in
 * `tests/security/company-scoping.test.ts`. That suite proves the server refuses
 * the right things against a mocked tenant; nothing there can tell an operator
 * whether the two live facts the control rests on are true:
 *
 *  1. `GET /:context/:contextId/devices/:id` (spec §7.2) returns a device record
 *     that **carries a `company` field**. spec §7.2 documents only "bare device
 *     object" — the field list including `company` is §7.1's, for the *list* read,
 *     so the single read carrying it is an inference. If the vendor stops sending
 *     it, `assertDeviceInPinnedCompany` takes its "owner cannot be verified"
 *     branch and **both device metric tools refuse every call**, on a healthy
 *     tenant, with a message about API drift. That is a fail-closed outcome and
 *     the right one, but an operator should learn it from this gate rather than
 *     from a user.
 *  2. That field's value is the company in the path — i.e. the company-scoped
 *     device read really is scoped. If it were not, the pin would be comparing a
 *     value the API chose rather than one it constrained.
 *
 * Read-only: one `GET` of a device that this company's own list just returned,
 * plus one `GET` of an id generated at random. No metric read is involved, and no
 * tool is invoked — the suite exercises the two requests of a device metric call
 * separately, this section being the first of them.
 */
describe.skipIf(!RUNNABLE)('live contract: spec 7.2 — the device-ownership pre-read', () => {
  /**
   * The single device read the pin performs, for a device the configured
   * company's own list returned. UNVERIFIED rather than a pass when the tenant has
   * no devices: with nothing to read, neither fact below has been checked.
   */
  async function readPinnedDevice(
    ctx: TestContext,
    claim: string,
  ): Promise<Record<string, unknown>> {
    const state = fx();
    const deviceId = state.pinnedDeviceId;
    if (deviceId === undefined) {
      unverifiable(
        ctx,
        '7.2',
        claim,
        state.pinnedDeviceCount === 0
          ? 'the configured company has no devices at all, so the read the ownership pre-read performs cannot be exercised'
          : 'the configured company\'s device list carried no "id" or "_id", so there is no device to read by id',
      );
    }

    const { client, config } = api();
    const single = await client.get<unknown>(devicePath(config.companyId, deviceId));
    expect(
      isRecord(single),
      `spec section 7.2 documents a bare device object; the body was ${describeValue(single)}. src/tools/metrics.ts passes this response through expectObject() before it will read any metric, so anything else makes both device metric tools fail closed.`,
    ).toBe(true);
    const record = single as Record<string, unknown>;
    // Runtime-to-runtime: the id came from the list read moments ago and no
    // tenant value is written into this file.
    expect(
      resourceId(record as Device),
      'the company-scoped device read returned a different record than the id requested, so nothing it says about ownership describes the device asked about.',
    ).toBe(deviceId);
    return record;
  }

  it(
    'ASSERT: a device read inside the configured company carries a "company" field',
    async (ctx) => {
      const claim =
        'GET /companies/:companyId/devices/:id returns a device record carrying an ObjectId-shaped "company" field';
      const device = await readPinnedDevice(ctx, claim);

      expect(
        isObjectIdShaped(device['company']),
        `the device record carried ${describeValue(device['company'])} for "company" (keys present: ${keysOf(device).join(',')}). The company pin on spec section 12.3 is built on this field: src/tools/metrics.ts assertDeviceInPinnedCompany treats an absent or non-string "company" as an owner it cannot verify and REFUSES the call, so if this is gone lumics_get_device_metrics and lumics_get_device_item_metrics reject every request on a perfectly healthy tenant. spec section 7.1 documents "company" among the device fields; section 7.2 documents only "bare device object", so this is the inference the control depends on. Report this.`,
      ).toBe(true);

      recordAsserted(
        '7.2',
        claim,
        `single device read keys: ${keysOf(device).join(',')}; "company" is ${describeValue(device['company'])}`,
      );
      recordObserved(
        '7.1',
        'whether the device LIST also carries "company", which the pin does not read but a future simplification might',
        fx().listCarriedCompany
          ? 'the list read carried "company" as well, so resolving ownership from a list is possible in principle — it is still not what the pin does, and one list read for N devices is not the same guarantee as a scoped read of the one device asked about'
          : 'the list read carried no "company" field, so the single read the pin performs is the only place this field was observed',
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: that device belongs to the company this server is configured for',
    async (ctx) => {
      const claim =
        'a device read inside a company reports that company as its owner — the company-scoped device path really is scoped';
      const device = await readPinnedDevice(ctx, claim);
      const owner = device['company'];

      if (!isObjectIdShaped(owner)) {
        // Deliberately not a failure here: the previous case owns the "field is
        // present" claim and reports it. Passing this one on an absent field
        // would be a vacuous pass, so it goes UNVERIFIED with the reason.
        unverifiable(
          ctx,
          '7.2',
          claim,
          `the device record carried ${describeValue(owner)} for "company", so there is no owner value to compare — see the preceding case, which is where that failure is reported`,
        );
      }

      // Runtime-to-runtime against the configured id. No company id is written
      // into this file.
      expect(
        owner,
        'a device read INSIDE the configured company came back owned by a different company. src/tools/metrics.ts pins the two device metric tools by comparing exactly these two values, and tests/security/company-scoping.test.ts asserts the refusal; if the API serves a foreign device from a company-scoped path, the path scoping this server relies on everywhere does not hold server-side and the pin is comparing a value the API chose rather than one it constrained. Report this as a security finding, not a documentation defect.',
      ).toBe(api().config.companyId);

      recordAsserted(
        '7.2',
        claim,
        'the device the configured company listed reports that same company as its owner, which is the equality the pin on spec section 12.3 tests',
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: how a company-scoped device read answers for an id this company does not have',
    async () => {
      // A 24-hex id generated at random, never a tenant value. This is the input
      // the pre-read's fail-closed branch is written for: `assertDeviceInPinnedCompany`
      // maps a 404 to a "not in this company" refusal naming LUMICS_ALLOW_CROSS_COMPANY,
      // and lets any other API error propagate as itself. Both are fail-closed;
      // which one an operator sees depends on this answer.
      const unknownId = syntheticObjectId();
      const { client, config } = api();
      const outcome = await attempt(client.get<unknown>(devicePath(config.companyId, unknownId)));

      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `reading an unknown device id inside the configured company produced ${describeOutcome(outcome)}, which spec section 3 does not document — its table is the only documented status set.`,
      ).toBe(true);

      // The real assertion, and it cannot pass vacuously: a record coming back
      // for an id nobody issued would mean this path serves devices it was not
      // asked for, and the pre-read reads a served record as evidence of
      // ownership. A collision with a real ObjectId is not a plausible
      // explanation at twelve random bytes.
      expect(
        outcome.ok && isRecord(outcome.value),
        'a company-scoped read of a randomly generated device id returned a device RECORD. src/tools/metrics.ts treats a record served from this path as the thing to check ownership on, so a path that answers with something for an id it was not asked about undermines the pre-read itself. Report this.',
      ).toBe(false);

      recordObserved(
        '7.2',
        'the pre-read maps a 404 to "not in this company"; what does a company-scoped read of an id the company does not have actually return?',
        `${describeOutcome(outcome)}. ${
          !outcome.ok && outcome.status === 404
            ? 'A 404, which is the branch assertDeviceInPinnedCompany is written for: a device in another company (or no company) produces the refusal that names LUMICS_ALLOW_CROSS_COMPANY and tells the model to confirm the id with lumics_list_devices.'
            : 'NOT a 404, so a device the configured company does not have takes the fall-through path instead: the refusal still happens (the metric read is never issued), but the model sees the raw API error rather than the guidance written for this case. Worth reporting — the message, not the control, is what is wrong.'
        } This case cannot observe a device that exists in ANOTHER company: obtaining such an id would mean reading a tenant this run is not configured for, which the suite does not do.`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Assumption 7 — metrics/summaries accepts no limit (spec §12.4)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.4 — summaries has no limit parameter', () => {
  it(
    'ASSERT: sending limit is ignored rather than honoured',
    async (ctx) => {
      const window = hourWindow();
      const full = await summaries({ ...window, itemType: 'device' });
      // Sent deliberately, once, to check a documented ABSENCE. spec section 12.4
      // lists exactly four query parameters and `limit` is not among them; the
      // client-side ranking in lumics_get_metric_summary exists because of that.
      // Production code must never send this.
      const limited = await summaries({ ...window, itemType: 'device', limit: 1 });

      const fullCount = countSummaryItems(full);
      const limitedCount = countSummaryItems(limited);

      if (fullCount <= 1) {
        unverifiable(
          ctx,
          '12.4',
          'metrics/summaries ignores a limit parameter',
          `the unlimited call returned ${String(fullCount)} item(s), so a limit of 1 cannot be distinguished from no limit`,
        );
      }

      expect(
        limitedCount,
        `sending limit=1 changed the result size from ${String(fullCount)} to ${String(limitedCount)} — so metrics/summaries DOES honour a limit, which spec section 12.4 does not document. lumics_get_metric_summary fetches the whole set and ranks client-side precisely because no server-side limit was believed to exist, and it tells the model "Lumics returned every item that matched". That disclosure would be false. Report this.`,
      ).toBe(fullCount);

      recordAsserted(
        '12.4',
        'metrics/summaries ignores a limit parameter, as the documented parameter list implies',
        `${String(fullCount)} item(s) with and without limit=1`,
      );
    },
    TIMEOUT,
  );
});

function countSummaryItems(response: unknown): number {
  const { data } = envelope(response);
  if (!isRecord(data)) {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) {
      total += value.length;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Assumption 8 — the remaining documented parameters (spec §12.0)
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)('live contract: spec 12.0 — the remaining query parameters', () => {
  /**
   * Acceptance only: each parameter must not produce a 400. Attribution is sound
   * because discovery already established that a plain call to this module is
   * served, so a rejection here is the parameter's doing.
   *
   * `componentQuery` and `filters` are documented but deliberately never sent
   * anywhere in this server (ADR-002 decision 3), so they are not probed here
   * either — a contract test that exercises a withheld capability is how it
   * quietly comes back.
   */
  const acceptanceCases: [string, Query][] = [
    ['lastMetric', { lastMetric: true }],
    ['isMonitored', { isMonitored: true }],
    ['minIntervals', { minIntervals: 4 }],
    ['aggregate', { aggregate: true }],
    ['alignTimeRange', { alignTimeRange: true }],
    ['limit', { limit: 5 }],
  ];

  // A plain loop rather than `it.each`, for the test context each case needs to
  // report a missing `properties` value (spec §12.5 M1) as UNVERIFIED.
  for (const [name, query] of acceptanceCases) {
    it(
      `ASSERT: ${name} is accepted`,
      async (ctx) => {
        const claim = `${name} is accepted on the metric-data endpoints`;
        requireProperties(ctx, '12.0', claim);
        const state = fx();
        const outcome = await attempt(
          companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, ...query }),
        );
        expect(
          outcome.ok,
          `${name} was ${describeOutcome(outcome)} on a module the API otherwise serves, with a properties value supplied so this is not the spec section 12.5 M1 rejection. spec section 12.0 documents it as an accepted query parameter and src/tools/metrics.ts exposes it as a tool argument; a rejection means the documented surface is wrong. Report this.`,
        ).toBe(true);
        recordAsserted('12.0', claim, `sent against module "${state.moduleType}" and served`);
      },
      TIMEOUT,
    );
  }

  it(
    'ASSERT: limit caps the metric rows returned, which is what the row-cap disclosure claims',
    async (ctx) => {
      requireProperties(ctx, '12.0', 'limit caps the number of metric rows Lumics returns');
      const state = fx();
      const window = hourWindow();
      // `src/tools/metrics.ts` sends NO limit on the series endpoints unless the
      // caller supplies one (metricLimitSchema has no default, deliberately), and
      // its ROW COUNT note then tells the model two things: that Lumics returned
      // every matching row, and that a limit — if one IS passed — is applied by
      // Lumics and can cut across time as well as across components. The second
      // half is only true if the parameter does something, which nothing has
      // checked; the acceptance case above only proves it is not rejected.
      const unlimited = rowsOf(
        await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, lastMetric: true }),
      );
      if (unlimited.length < 2) {
        unverifiable(
          ctx,
          '12.0',
          'limit caps the number of metric rows Lumics returns',
          `module "${state.moduleType}" returned ${String(unlimited.length)} row(s) with no limit over the last hour, so a cap of 1 cannot be told from the whole result`,
        );
      }
      const capped = rowsOf(
        await companySeries({
          ...window,
          dataPoints: SMALL_DATA_POINTS,
          lastMetric: true,
          limit: 1,
        }),
      );

      expect(
        capped.length <= 1,
        `limit=1 returned ${String(capped.length)} row(s) where the same call without a limit returned ${String(unlimited.length)}. spec section 12.0 documents limit as "Maximum number of results to return"; if it is ignored, the ROW COUNT note that lumics_get_company_metrics and the device metric tools print when a caller passes one — "you asked for at most N row(s) and Lumics applied that cap" — is false, and a model is being warned about holes in a series that were never cut. Report this.`,
      ).toBe(true);

      recordAsserted(
        '12.0',
        'limit is honoured on the metric-data endpoints as a row cap',
        `${String(unlimited.length)} row(s) with no limit versus ${String(capped.length)} with limit=1 (module "${state.moduleType}", lastMetric)`,
      );
      recordObserved(
        '12.0',
        'this server sends no limit on a metric series unless the caller asks for one, and discloses that Lumics then returned every matching row',
        `the unlimited call returned ${String(unlimited.length)} row(s) for one hour of module "${state.moduleType}" at lastMetric=true. Whether Lumics applies a cap of its own when none is sent is not observable from here — the API documents no default — so the disclosure rests on that documented absence, not on this measurement.`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: itemType is accepted and restricts rows to that component type',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.0',
        'itemType limits the type of component for which metrics are returned',
      );
      const state = fx();
      if (state.itemType === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'itemType limits the type of component for which metrics are returned',
          `no rows with a "type" field were found for module "${state.moduleType}" (probed: ${state.probedModules.join(', ')}), so there is no live itemType to filter on`,
        );
      }
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        itemType: state.itemType,
        lastMetric: true,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'itemType limits the type of component for which metrics are returned',
          `filtering module "${state.moduleType}" by itemType "${state.itemType}" returned no rows in the last hour`,
        );
      }
      const wrong = rows.filter((row) => row['type'] !== state.itemType);
      expect(
        wrong.length,
        `${String(wrong.length)} of ${String(rows.length)} row(s) came back with a "type" other than the requested itemType "${state.itemType}". spec section 12.0 documents itemType as limiting the component type; if it does not, every itemType-scoped answer this server gives includes components the caller excluded. Report this.`,
      ).toBe(0);
      recordAsserted(
        '12.0',
        'itemType restricts returned rows to that component type',
        `${String(rows.length)} row(s) returned for itemType "${state.itemType}", all matching`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: lastMetric returns at most one point per item',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.0',
        'lastMetric limits results to the most recent metric per item',
      );
      const state = fx();
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        lastMetric: true,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'lastMetric limits results to the most recent metric per item',
          `module "${state.moduleType}" returned no rows in the last hour, so "most recent" cannot be checked`,
        );
      }

      const perItem = new Map<string, number>();
      for (const row of rows) {
        const item = row['item'];
        const key = typeof item === 'string' ? item : '<no item field>';
        perItem.set(key, (perItem.get(key) ?? 0) + 1);
      }
      const worst = Math.max(...perItem.values());

      expect(
        worst,
        `with lastMetric=true, one item came back with ${String(worst)} rows. spec section 12.0 documents lastMetric as limiting results "to only include the most recent metric matching the rest of the criteria", which is what lumics_get_device_metrics tells the model to use for a current-status readout. More than one row per item means that readout is a series, not a status.`,
      ).toBe(1);
      recordAsserted(
        '12.0',
        'lastMetric returns a single most-recent point per item',
        `${String(rows.length)} row(s) across ${String(perItem.size)} item(s), at most one each`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: isMonitored=true does not widen the result set',
    async (ctx) => {
      requireProperties(ctx, '12.0', 'isMonitored limits results to monitored components');
      const window = hourWindow();
      const all = rowsOf(
        await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS, lastMetric: true }),
      ).length;
      if (all === 0) {
        unverifiable(
          ctx,
          '12.0',
          'isMonitored limits results to monitored components',
          `module "${fx().moduleType}" returned no rows at all in the last hour, so a filter cannot be observed`,
        );
      }
      const monitored = rowsOf(
        await companySeries({
          ...window,
          dataPoints: SMALL_DATA_POINTS,
          lastMetric: true,
          isMonitored: true,
        }),
      ).length;

      expect(
        monitored <= all,
        `isMonitored=true returned MORE rows (${String(monitored)}) than the unfiltered call (${String(all)}). spec section 12.0 documents it as a restriction ("will limit the components ... to ones which are monitored"); a filter that adds rows is not the parameter the docs describe. Report this.`,
      ).toBe(true);
      recordAsserted(
        '12.0',
        'isMonitored is a restriction, never a widening',
        `${String(monitored)} monitored row(s) of ${String(all)} unfiltered`,
      );
      recordObserved(
        '12.0',
        'how much isMonitored actually filters on this tenant',
        monitored === all
          ? 'identical row counts with and without isMonitored — either every component is monitored or the parameter had no effect here; this run cannot tell them apart'
          : `filtered ${String(all - monitored)} row(s) out of ${String(all)}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: properties returns the requested metric property',
    async (ctx) => {
      const state = fx();
      if (state.propertyPath === undefined) {
        unverifiable(
          ctx,
          '12.0',
          'properties selects which metric properties appear in the results',
          `no non-empty stats path was seen in any spec section 12.1 row for module "${state.moduleType}" (probed: ${state.probedModules.join(', ')}). The names discovered from spec section 12.4 are DEVICE-scoped (spec section 12.5 M6) and this endpoint returns component rows, so requesting one of them back here would prove nothing — and spec section 12.5 M2 means a name this endpoint does not know comes back as HTTP 200 with empty stats rather than an error, so the case would pass while measuring nothing. A component-level property name is discoverable from no endpoint in this API`,
        );
      }
      const response = await companySeries({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        lastMetric: true,
        properties: state.propertyPath,
      });
      const rows = rowsOf(response);
      if (rows.length === 0) {
        unverifiable(
          ctx,
          '12.0',
          'properties selects which metric properties appear in the results',
          `requesting properties="${state.propertyPath}" returned no rows`,
        );
      }
      const returned = new Set(rows.flatMap((row) => statPaths(row)));

      expect(
        returned.has(state.propertyPath),
        `properties="${state.propertyPath}" came back without that path in "stats" (paths returned: ${[...returned].join(', ') || 'none'}). spec section 12.0 documents properties as "a comma separated list of metric properties to be included in the results"; if asking for a property does not return it, every narrowed metric read this server performs loses the data the caller asked for. Report this.`,
      ).toBe(true);

      const extras = [...returned].filter((path) => path !== state.propertyPath);
      recordAsserted(
        '12.0',
        'properties returns the requested metric property path',
        `requested "${state.propertyPath}" and it was present in ${String(rows.length)} row(s)`,
      );
      recordObserved(
        '12.0',
        'whether properties EXCLUDES everything else, which the docs do not state',
        extras.length === 0
          ? 'only the requested path came back — properties is exclusive'
          : `${String(extras.length)} additional path(s) came back alongside the requested one: ${extras.join(', ')} — properties is additive/partial, so a narrowed request still carries other properties`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: what alignTimeRange and minIntervals do to the effective window',
    async (ctx) => {
      requireProperties(
        ctx,
        '12.0',
        'alignTimeRange snaps the time range to natural boundaries; minIntervals governs rollup eligibility',
      );
      const window = hourWindow();
      const plain = await companySeries({ ...window, dataPoints: SMALL_DATA_POINTS });
      const aligned = await companySeries({
        ...window,
        dataPoints: SMALL_DATA_POINTS,
        alignTimeRange: true,
      });
      const coarseEligible = await companySeries({
        ...window,
        dataPoints: SMALL_DATA_POINTS,
        minIntervals: 4,
      });

      const plainMeta = envelope(plain).meta;
      const alignedMeta = envelope(aligned).meta;
      const coarseMeta = envelope(coarseEligible).meta;

      const plainFrom = numberFrom(plainMeta, 'fromMs');
      const alignedFrom = numberFrom(alignedMeta, 'fromMs');

      // Real assertion: whatever the snapping does, the window it reports must
      // still be a window. A reversed or zero-width effective range would make
      // every note this server prints about the effective window nonsense.
      const alignedTo = numberFrom(alignedMeta, 'toMs');
      if (alignedFrom !== undefined && alignedTo !== undefined) {
        expect(
          alignedFrom < alignedTo,
          `with alignTimeRange=true the effective window came back reversed or empty (from ${String(alignedFrom)}, to ${String(alignedTo)}).`,
        ).toBe(true);
      }

      recordObserved(
        '12.0',
        'alignTimeRange "forces time range to snap to natural time boundaries" — by how much, and does it change the window?',
        alignedFrom === undefined || plainFrom === undefined
          ? 'neither response echoed a numeric fromMs, so snapping cannot be measured'
          : alignedFrom === plainFrom
            ? 'the effective fromMs was identical with and without alignTimeRange over a one-hour window — no observable snapping at this resolution'
            : `alignTimeRange moved the effective fromMs by ${String(alignedFrom - plainFrom)} ms relative to the unaligned call`,
      );
      recordObserved(
        '12.0',
        'minIntervals (default 40) governs which rollup collection is eligible',
        `timeIncrement ${describeValue(numberFrom(coarseMeta, 'timeIncrement'))} with minIntervals=4 versus ${describeValue(numberFrom(plainMeta, 'timeIncrement'))} with the default over the same one-hour window`,
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Measured 2026-07-30 — findings that contradict the vendor (spec §12.5)
// ---------------------------------------------------------------------------

/**
 * Markers matched against a rejection body, never printed (see
 * `outcomeMentions`). Short fragments of the vendor's own error wording,
 * recorded verbatim in spec §12.5 M1 and M3.
 */
const PROPERTIES_ERROR_MARKER = 'properties parameter';
const UNKNOWN_COMPONENT_MARKER = 'unknown component';

/**
 * The single most consequential divergence in the captured contract: spec §12.0
 * marks `properties` optional and four of the five metric endpoints reject a call
 * without it (spec §12.5 M1, §14 defect 17).
 *
 * These cases assert **measured** behaviour that contradicts the vendor's
 * documentation, which is unusual enough to say why. A tool layer that treats the
 * parameter as optional cannot make a single successful metric call, so this is
 * not a curiosity to note — it is the shape of the endpoint. If one of these ever
 * fails because the API started accepting the call, that is good news and a spec
 * correction, and the message says so rather than reading as a regression.
 */
describe.skipIf(!RUNNABLE)('live contract: spec 12.5 M1 — properties is required', () => {
  /** Shared body of the four "omit it and get a 400" cases. */
  function assertRejectedWithoutProperties(
    outcome: CallOutcome<unknown>,
    spec: string,
    label: string,
  ): void {
    expect(
      outcome.ok,
      `${label} was SERVED without a "properties" parameter. On 2026-07-30 it was rejected with 400 "Must supply required component metrics as properties parameter" (spec section ${spec}, recorded as spec section 12.5 M1 and section 14 defect 17). If it is now optional as spec section 12.0 always claimed, that is a fix rather than a regression — but the captured contract, this suite and any tool layer that now supplies a mandatory properties argument all describe an API that no longer exists, and the measured finding must be re-dated.`,
    ).toBe(false);
    expect(
      outcome.ok ? undefined : outcome.status,
      `${label} without "properties" was ${describeOutcome(outcome)}, not the measured 400. spec section 3 documents 400 for a malformed request; anything else here means the rejection has changed character.`,
    ).toBe(400);
    recordAsserted(
      spec,
      `properties is REQUIRED on ${label}, contradicting spec section 12.0 which marks it optional (measured 2026-07-30)`,
      `omitting it was ${describeOutcome(outcome)}; the rejection body ${
        outcomeMentions(outcome, PROPERTIES_ERROR_MARKER)
          ? 'names the properties parameter, matching the measured message'
          : 'does NOT name the properties parameter — the status is right but the message has changed, which is worth reporting'
      }`,
    );
  }

  it(
    'ASSERT: spec 12.1 rejects a call with no properties',
    async () => {
      // `properties: undefined` is the key being present with no value, which
      // withRequiredProperties honours — this is the one way to send the call the
      // vendor's documentation says is legal.
      const outcome = await attempt(
        companySeries({ ...hourWindow(), dataPoints: SMALL_DATA_POINTS, properties: undefined }),
      );
      assertRejectedWithoutProperties(outcome, '12.1', 'the company metric endpoint');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: spec 12.2 summarize rejects a call with no properties',
    async (ctx) => {
      const claim = 'properties is REQUIRED on spec section 12.2 summarize';
      const outcome = await summarizeProbe({
        ...hourWindow(),
        dataPoints: SMALL_DATA_POINTS,
        properties: undefined,
      });
      if (isSlowOutcome(outcome)) {
        abandonSlowSummarize(ctx, '12.2', claim, outcome);
      }
      assertRejectedWithoutProperties(outcome, '12.2', 'the summarize endpoint');
    },
    SUMMARIZE_TIMEOUT,
  );

  it(
    'ASSERT: spec 12.3 rejects a device metric call with no properties',
    async (ctx) => {
      const state = fx();
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'properties is REQUIRED on GET /metrics/devices/:id/modules/:moduleType',
          'no device in the CONFIGURED company declares a polling module, so the endpoint cannot be called at all (a device from elsewhere would be refused by the ownership pre-read first)',
        );
      }
      const outcome = await attempt(
        deviceSeries(state.deviceId, state.deviceModuleType, {
          ...hourWindow(),
          dataPoints: SMALL_DATA_POINTS,
          properties: undefined,
        }),
      );
      assertRejectedWithoutProperties(outcome, '12.3', 'the device metric endpoint');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the spec 12.3 single-item endpoint rejects a call with no properties',
    async (ctx) => {
      const state = fx();
      if (state.deviceId === undefined || state.deviceModuleType === undefined) {
        unverifiable(
          ctx,
          '12.3',
          'properties is REQUIRED on GET /metrics/devices/:id/modules/:moduleType/:item',
          'no device in the CONFIGURED company declares a polling module',
        );
      }
      const outcome = await attempt(
        deviceItemSeries(state.deviceId, state.deviceModuleType, state.deviceId, {
          ...hourWindow(),
          dataPoints: SMALL_DATA_POINTS,
          properties: undefined,
        }),
      );
      assertRejectedWithoutProperties(outcome, '12.3', 'the single-item device metric endpoint');
    },
    TIMEOUT,
  );

  it(
    'ASSERT: spec 12.4 summaries does NOT require properties',
    async () => {
      // The asymmetry is the point. Four endpoints require it; this one does not,
      // and a tool layer that made it mandatory everywhere would break the only
      // endpoint that can enumerate the values (spec §12.5 M6).
      const outcome = await attempt(summaries({ ...hourWindow(), itemType: DEVICE_ITEM_TYPE }));
      expect(
        outcome.ok,
        `metrics/summaries without "properties" was ${describeOutcome(outcome)}. On 2026-07-30 it was served (spec section 12.5 M1): the parameter is genuinely optional here, unlike sections 12.1-12.3. If this endpoint has also started requiring it, then NOTHING in this API enumerates metric property names any more (spec section 12.5 M6) and a caller cannot discover a legal value from anywhere. Report that as a blocking finding.`,
      ).toBe(true);
      recordAsserted(
        '12.4',
        'properties is genuinely optional on metrics/summaries, unlike sections 12.1-12.3 (measured 2026-07-30)',
        'the call was served with no properties parameter',
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: on spec 12.4, properties filters items rather than narrowing them',
    async (ctx) => {
      const claim =
        'properties on metrics/summaries acts as a FILTER, not a projection (measured: Calculated.cpu returned count 0)';
      const state = fx();
      if (state.properties === undefined) {
        unverifiable(
          ctx,
          '12.4',
          claim,
          `metrics/summaries returned no property names for any module probed (${state.probedModules.join(', ')}), so there is no live property to filter by`,
        );
      }
      const window = hourWindow();
      const unfiltered = await attempt(summaries({ ...window, itemType: DEVICE_ITEM_TYPE }));
      const filtered = await attempt(
        summaries({ ...window, itemType: DEVICE_ITEM_TYPE, properties: state.properties }),
      );
      if (!unfiltered.ok || !filtered.ok) {
        unverifiable(
          ctx,
          '12.4',
          claim,
          `unfiltered ${describeOutcome(unfiltered)}, filtered ${describeOutcome(filtered)} — a refused call cannot be compared`,
        );
      }

      const before = countSummaryItems(unfiltered.value);
      const after = countSummaryItems(filtered.value);
      recordObserved(
        '12.4',
        'the docs describe properties identically on every endpoint; on this one it drops ITEMS rather than trimming their stats (spec section 12.5 M1)',
        `${String(before)} item(s) without properties versus ${String(after)} with a property name discovered from this same endpoint. ${
          after < before
            ? 'Filtering confirmed — a caller narrowing a summaries request loses items, not just fields.'
            : 'No item was dropped on this tenant, which does not contradict the measurement: there the requested property was one no item carried, and here it was harvested from these very items.'
        }`,
      );
    },
    TIMEOUT,
  );
});

/**
 * spec §12.5 M2 / §14 defect 18 — the silent-failure mode.
 *
 * The required-parameter gate above tests **presence only, never validity**. A
 * mistyped property name comes back as HTTP 200 with empty `stats`, which is
 * indistinguishable from "this component reported nothing in this window". This
 * case exists so that never changes without somebody noticing: it is the one
 * behaviour in §12 that a consumer cannot detect for itself, and a tool layer
 * that reports "no data" on an empty `stats` will be confidently wrong.
 */
describe.skipIf(!RUNNABLE)(
  'live contract: spec 12.5 M2 — an invalid properties value is accepted, silently',
  () => {
    it(
      'ASSERT: a meaningless properties value returns 200 with no metric values at all',
      async (ctx) => {
        const claim =
          'an unrecognised properties value is accepted with HTTP 200 and empty stats rather than rejected';
        const state = fx();
        if (!state.controlOk) {
          unverifiable(
            ctx,
            '12.0',
            claim,
            `no metric module answered at all (probed: ${state.probedModules.join(', ')}), so a 200 could not be attributed to the properties value`,
          );
        }
        const outcome = await attempt(
          companySeries({
            ...hourWindow(),
            dataPoints: SMALL_DATA_POINTS,
            lastMetric: true,
            properties: NONSENSE_PROPERTY,
          }),
        );

        expect(
          outcome.ok,
          `properties="${NONSENSE_PROPERTY}" was ${describeOutcome(outcome)}. On 2026-07-30 it was ACCEPTED with HTTP 200 (spec section 12.5 M2, section 14 defect 18). A rejection is a better API and a WELCOME change — but it is still a contract change: the spec's measured finding and any tool-layer note warning callers that a mistyped property fails silently would both be out of date. Re-date the measurement and report it.`,
        ).toBe(true);

        // Guarded rather than early-returned: the assertion above has already
        // thrown if the call was refused, so this is a type narrowing and not a
        // path where an unchecked assumption could be reported as checked.
        if (outcome.ok) {
          const rows = rowsOf(outcome.value);
          const paths = [...new Set(rows.flatMap((row) => statPaths(row)))];
          expect(
            paths.length,
            `properties="${NONSENSE_PROPERTY}" returned ${String(paths.length)} metric property path(s) across ${String(rows.length)} row(s). A nonsense property name must not produce metric values; if it does, "properties" is not selecting anything and every narrowed read this server performs returns whatever the API felt like sending.`,
          ).toBe(0);

          recordAsserted(
            '12.0',
            claim,
            `properties="${NONSENSE_PROPERTY}" was served: ${String(rows.length)} row(s), zero metric property paths. This is the SILENT-FAILURE mode of spec section 12.5 M2 — a mistyped property name is indistinguishable from a component that reported nothing, and the 400 gate of M1 checks presence only`,
          );
        }
      },
      TIMEOUT,
    );

    it(
      'OBSERVE: what a recognised type group with an unknown metric returns',
      async (ctx) => {
        const claim =
          'a recognised type group with an unknown metric echoes the group empty (measured: Rate.ifInOctets -> {"Rate":{}})';
        const state = fx();
        const group = state.propertyGroups[0];
        if (group === undefined) {
          unverifiable(
            ctx,
            '12.0',
            claim,
            `no metric type group was discovered on this tenant (spec section 12.4 returned no property names for ${state.probedModules.join(', ')}), so there is no real group to pair with an unknown metric`,
          );
        }
        // A real group, a metric that cannot exist. Groups are vendor vocabulary
        // (Calculated, Rate, TimeTicks) and safe to name in a report; the metric
        // half is a constant of this suite.
        const outcome = await attempt(
          companySeries({
            ...hourWindow(),
            dataPoints: SMALL_DATA_POINTS,
            lastMetric: true,
            properties: `${group}.${NONSENSE_PROPERTY}`,
          }),
        );
        expect(
          outcome.ok ||
            outcome.status === undefined ||
            DOCUMENTED_STATUSES.includes(outcome.status),
          `properties="${group}.${NONSENSE_PROPERTY}" produced ${describeOutcome(outcome)}, which spec section 3 does not document.`,
        ).toBe(true);

        const rows = outcome.ok ? rowsOf(outcome.value) : [];
        const groupsEchoed = [...new Set(rows.flatMap((row) => keysOf(row['stats'])))];
        recordObserved(
          '12.0',
          'the docs describe no validation of properties at all; the 2026-07-30 run found three different silent shapes depending on how wrong the value is',
          `properties="${group}.${NONSENSE_PROPERTY}" was ${describeOutcome(outcome)}; ${String(rows.length)} row(s) came back and their stats carried the group key(s) [${groupsEchoed.join(', ') || 'none'}]. Measured 2026-07-30: a recognised group with an unknown metric echoes the group empty, an unrecognised group yields no stats key at all, and a bare metric name with no group yields empty stats — none of them an error`,
        );
      },
      TIMEOUT,
    );
  },
);

/**
 * spec §12.5 M3 / §14 defect 19 — two component vocabularies that look like one.
 *
 * `GET componenttypes` (§6.4) hands out `<module>_<group>_<componentAlias>`, the
 * plural; the metric endpoints accept `<module>_<group>_<itemType>`, the
 * singular, and reject the other with `400 Unknown component`. 213 of 246 ids
 * failed on 2026-07-30. Nothing in the vendor's documentation distinguishes the
 * two, and §12.0's own `itemType` example reads like a `componenttypes` id.
 */
describe.skipIf(!RUNNABLE)(
  'live contract: spec 12.5 M3 — componenttypes ids are not itemType values',
  () => {
    it(
      'ASSERT: the plural catalogue id is rejected where the singular form is accepted',
      async (ctx) => {
        const claim =
          'a componenttypes id is rejected as itemType while the singular id built from the device definitions is accepted';
        const state = fx();
        const pair = state.itemTypePair;
        if (pair === undefined) {
          unverifiable(
            ctx,
            '12.0',
            claim,
            "no entry in GET /system/deviceDefinitions/components could be lined up with an id this tenant's componenttypes catalogue actually returned (a usable pair needs a filePath of the form /components/<module>/<group>/<Model>.yml, a data.itemType and a data.componentAlias that differ, and the resulting plural id present in the catalogue). Asserting that an INVENTED string is rejected would prove nothing, so this is not attempted",
          );
        }
        requireProperties(ctx, '12.0', claim);
        const window = hourWindow();

        const rejected = await attempt(
          companySeries({
            ...window,
            dataPoints: SMALL_DATA_POINTS,
            lastMetric: true,
            itemType: pair.alias,
          }),
        );
        const accepted = await attempt(
          companySeries({
            ...window,
            dataPoints: SMALL_DATA_POINTS,
            lastMetric: true,
            itemType: pair.singular,
          }),
        );

        // Component type ids are vendor catalogue vocabulary, not tenant data, so
        // naming them in a message is the same disclosure the rest of this file
        // already makes for module names.
        expect(
          rejected.ok,
          `itemType="${pair.alias}", an id this tenant's own componenttypes catalogue returned, was ACCEPTED by the metric endpoint. On 2026-07-30 213 of 246 catalogue ids were rejected with 400 "Unknown component" (spec section 12.5 M3, section 14 defect 19). If the two vocabularies have been reconciled, that is a fix — and the captured contract, which now tells implementers to construct itemType from section 6.5 rather than section 6.4, needs re-dating.`,
        ).toBe(false);
        expect(
          rejected.ok ? undefined : rejected.status,
          `itemType="${pair.alias}" was ${describeOutcome(rejected)} rather than the measured 400.`,
        ).toBe(400);
        expect(
          accepted.ok,
          `itemType="${pair.singular}", built from GET /system/deviceDefinitions/components as spec section 12.5 M3 prescribes (filePath module/group + data.itemType), was ${describeOutcome(accepted)}. If the singular form is rejected too then the construction rule in the captured contract is wrong and there is NO documented way to obtain a valid itemType. Report this.`,
        ).toBe(true);

        recordAsserted(
          '12.0',
          claim,
          `componenttypes id "${pair.alias}" -> ${describeOutcome(rejected)}${
            outcomeMentions(rejected, UNKNOWN_COMPONENT_MARKER)
              ? ' (body names an unknown component, matching the measured message)'
              : ' (body does NOT use the measured "Unknown component" wording)'
          }; singular id "${pair.singular}" -> ${describeOutcome(accepted)}`,
        );
      },
      TIMEOUT,
    );

    it(
      'OBSERVE: itemType is validated before properties, masking the M1 rejection',
      async (ctx) => {
        const claim =
          'a bad itemType is reported before a missing properties, hiding the spec section 12.5 M1 error';
        const pair = fx().itemTypePair;
        if (pair === undefined) {
          unverifiable(
            ctx,
            '12.0',
            claim,
            'no alias/singular pair could be built on this tenant, so there is no itemType known to be rejected to pair with a missing properties',
          );
        }
        // Both faults at once: an itemType the API rejects AND no properties.
        // Which error comes back is the ordering, and it matters because someone
        // debugging M1 against a wrong itemType will chase the wrong parameter.
        const outcome = await attempt(
          companySeries({
            ...hourWindow(),
            dataPoints: SMALL_DATA_POINTS,
            itemType: pair.alias,
            properties: undefined,
          }),
        );
        expect(
          outcome.ok,
          `a call with BOTH a rejected itemType and no properties was served. Each fault alone produced a 400 on 2026-07-30; together they cannot produce a success.`,
        ).toBe(false);

        const namesComponent = outcomeMentions(outcome, UNKNOWN_COMPONENT_MARKER);
        const namesProperties = outcomeMentions(outcome, PROPERTIES_ERROR_MARKER);
        recordObserved(
          '12.0',
          'the docs document no validation order; the 2026-07-30 run found itemType checked first, so a bad itemType hides the missing-properties error entirely',
          namesComponent === namesProperties
            ? `the rejection (${describeOutcome(outcome)}) named ${namesComponent ? 'BOTH parameters' : 'NEITHER parameter'}, so the validation order could not be read from this answer — the ordering trap in spec section 12.5 M3 is neither confirmed nor refuted here`
            : namesComponent
              ? `the rejection named the unknown component and NOT the properties parameter — the measured ordering holds, and anyone debugging the M1 requirement against a wrong itemType will be told about the wrong parameter`
              : `the rejection named the properties parameter and NOT the component — the ordering has REVERSED since 2026-07-30, which makes the trap described in spec section 12.5 M3 obsolete`,
        );
      },
      TIMEOUT,
    );
  },
);

/**
 * spec §12.5 M7 / §14 defect 23 — §12.4 does not serve every module, and when it
 * does not, it can answer with an HTML error page rather than anything §3
 * documents. Reported from the discovery probes, so it costs no extra calls.
 */
describe.skipIf(!RUNNABLE)('live contract: spec 12.4 — per-module availability', () => {
  it(
    'OBSERVE: which modules metrics/summaries actually serves on this tenant',
    (ctx) => {
      const probes = fx().summariesProbes;
      if (probes.length === 0) {
        unverifiable(
          ctx,
          '12.4',
          'metrics/summaries serves every module the componenttypes catalogue names',
          'discovery probed no modules at all, so no coverage was measured',
        );
      }
      const served = probes.filter((probe) => probe.outcome.startsWith('accepted'));
      recordObserved(
        '12.4',
        'nothing documents which modules metrics/summaries supports; the 2026-07-30 run found snmp and http served, ping and syslog answering with HTML error pages, and deviceConfigs 500 (spec section 12.5 M7)',
        probes
          .map(
            (probe) =>
              `${probe.module}: ${probe.outcome}${
                probe.dataKeys.length > 0 ? ` [data keys: ${probe.dataKeys.join(', ')}]` : ''
              }${probe.propertyPaths.length > 0 ? ` [${String(probe.propertyPaths.length)} property name(s)]` : ''}`,
          )
          .join('; ') +
          `. ${String(served.length)} of ${String(probes.length)} module(s) served. A "no API answer — transport failure (invalid_response)" line here is the HTML-error-page case: the body was not JSON, which contradicts section 1 ("The API uses JSON as its data format") as well as the section 3 status table`,
      );
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: metrics/summaries is the only source of metric property names, and only for devices',
    (ctx) => {
      const state = fx();
      const claim =
        'metric property names are enumerable from metrics/summaries and nowhere else (spec section 12.5 M6)';
      if (state.properties === undefined) {
        unverifiable(
          ctx,
          '12.4',
          claim,
          `no property name was returned by metrics/summaries for any module probed (${state.probedModules.join(', ')}). Since spec section 12.5 M1 makes the parameter REQUIRED on sections 12.1-12.3 and section 12.5 M6 records that no other endpoint enumerates the values, a caller on this tenant has no documented way to construct a legal metric request at all — which is the finding, not an absence of one`,
        );
      }
      recordObserved(
        '12.4',
        claim,
        `discovered ${String(state.propertyGroups.length)} type group(s) [${state.propertyGroups.join(', ')}] from module "${state.moduleType}" at itemType="device". These are DEVICE-scoped: spec section 12.5 M6 records that a component-level property name is discoverable from no endpoint in this API, while spec section 12.5 M1 makes supplying one mandatory on sections 12.1-12.3. Group names are vendor vocabulary and are printed; the property names themselves are tenant data and are not`,
      );
    },
    TIMEOUT,
  );
});

declareSkipExplanation('the metric contract (spec section 12)');
