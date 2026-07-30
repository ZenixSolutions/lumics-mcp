/**
 * Single source of truth for every literal that would otherwise be duplicated
 * across layers. Nothing here reads the environment; `src/config.ts` owns that
 * and uses these values as defaults.
 *
 * Values marked "spec" are taken from `docs/reference/lumics-api-v1.md` and must
 * not be changed without a corresponding change to that captured contract.
 */

/** Server identity reported in the MCP `initialize` response. */
export const SERVER_NAME = 'lumics-mcp';

/**
 * Kept in step with `package.json` by hand. Reading `package.json` at runtime
 * would require `resolveJsonModule` output to land in `dist/`, which it does
 * not, and would break the published `bin` shim.
 */
export const SERVER_VERSION = '0.1.0';

/** Prefix for every registered tool name. */
export const TOOL_PREFIX = 'lumics_';

// ---------------------------------------------------------------------------
// API surface (spec §2, §4)
// ---------------------------------------------------------------------------

/** spec §1 base URL plus the documented `/api/v1` prefix every path shares. */
export const DEFAULT_BASE_URL = 'https://app.lumics.io/api/v1';

/**
 * spec §4.1: `:context` is a literal path segment. v0.1 is `companies`-only
 * (RFC-001 open question 3, owner-approved), so this is the only value the
 * server will ever emit. `admingroups` and `system` are deliberately absent.
 */
export const CONTEXT_COMPANIES = 'companies';

/**
 * Every identifier in this API is a 24-character hex MongoDB ObjectId
 * (spec §preamble redaction note).
 */
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** spec §12.0: `interval` is an enum of exactly these four values. */
export const METRIC_INTERVALS = ['minute', 'fiveMin', 'hour', 'day'] as const;

/**
 * spec §12.2: `sum` is a *string* naming which per-component rollup property
 * feeds the cross-component sum. The prototype typed this as a boolean.
 */
export const METRIC_SUM_PROPERTIES = ['min', 'max', 'avg'] as const;

/** spec §8: `state` on an IP address; examples use these lowercase literals. */
export const IP_ADDRESS_STATES = ['used', 'reserved'] as const;

/** spec §9.3: `type` on an IP group. */
export const IP_GROUP_TYPES = ['group', 'supernet'] as const;

/**
 * spec §12.0: `dataPoints` OR `width` is *required* on all four metric-data
 * endpoints. Models will not know that, so we always send a resolution.
 * RFC-001 D5 item 2.
 */
export const DEFAULT_METRIC_DATA_POINTS = 60;

/** spec §12.0: `minIntervals` defaults to 40 server-side; documented for parity. */
export const METRIC_MIN_INTERVALS_DEFAULT = 40;

// ---------------------------------------------------------------------------
// Client behaviour
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 300_000;

/** Total attempts including the first, so 3 means at most 2 retries. */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

/**
 * spec §3 documents 429 but no limits, windows or headers anywhere
 * (RFC-001 assumption A2). Default conservatively rather than guess.
 */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Upper bound on a honoured `Retry-After`. A longer value is **clamped to this
 * and still retried** rather than abandoned: the server explicitly invited the
 * retry, so failing fast would throw away the one attempt most likely to succeed,
 * while sleeping for the value it asked for could park a tool call for minutes.
 * (The comment here previously said "fail fast instead", which the code has never
 * done — see `backoffDelayMs` and `parseRetryAfterMs` in `src/api/client.ts`.)
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** spec §3: transient statuses worth retrying on any verb. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 502, 503, 504];

/**
 * spec §3: 423 Locked means another process holds the resource. Worth exactly
 * one retry — a second is unlikely to help and doubles the write risk.
 */
export const LOCKED_STATUS = 423;
export const LOCKED_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_OUTPUT_CHARS = 25_000;
export const MIN_MAX_OUTPUT_CHARS = 1_000;
export const MAX_MAX_OUTPUT_CHARS = 1_000_000;

/**
 * Default `limit` applied to list tools. The API has no pagination (spec §4.3),
 * so an unbounded list can blow the output budget on a large tenant. A default
 * plus honest truncation disclosure beats silent budget truncation.
 *
 * This default is only satisfiable if a default row fits the character budget.
 * A full device record built from the fields spec §7.1 documents is ~1.9 kB, so
 * 100 of them are ~190 kB against a 25 kB budget: the budget, not the limit,
 * would decide how many devices a default call returned, and 87 of them would be
 * dropped. {@link DEFAULT_DEVICE_LIST_FIELDS} is what makes the two constants
 * agree — see the comment there.
 */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1_000;

/**
 * Default top-level field projection for `lumics_list_devices`.
 *
 * A device's bulk is its `modules` map (three nested module objects, one of them
 * carrying an array of snapshot items). Projecting it away takes a record from
 * ~1.9 kB to ~200 bytes, so `DEFAULT_LIST_LIMIT` devices land at roughly 20 kB
 * and the default call actually returns the number of rows it asked for instead
 * of silently shedding seven eighths of them.
 *
 * These seven fields are the ones an inventory answer needs: identity (`id`,
 * `name`), reachability (`ipAddress`), classification (`deviceType`), the
 * collector another tool will need, and the two operational toggles that decide
 * whether an absence of data means anything. The projection is always disclosed
 * in the output and any explicit `fields` argument replaces it — including an
 * empty array, which asks for every field.
 */
export const DEFAULT_DEVICE_LIST_FIELDS: readonly string[] = [
  'id',
  'name',
  'ipAddress',
  'deviceType',
  'collector',
  'enabled',
  'maintenanceMode',
];

// ---------------------------------------------------------------------------
// Time handling
// ---------------------------------------------------------------------------

/** spec §12.0: `fromMs` defaults to one hour ago, `toMs` to now. */
export const DEFAULT_LOOKBACK = '1h';

/** Reject anything before 2000-01-01 as an epoch-unit mistake (seconds vs ms). */
export const MIN_EPOCH_MS = 946_684_800_000;

/** A range wider than this is almost certainly a model arithmetic error. */
export const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/** Tolerance for clock skew when rejecting future timestamps. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

export const DEFAULT_HTTP_PORT = 3000;

/** RFC-001 D3: loopback bind by default; widening it is an explicit act. */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;

/**
 * Hosts for which plaintext `http:` is accepted on `LUMICS_BASE_URL`. Anywhere
 * else the bearer token would cross a network in clear text.
 *
 * Spelled as `URL.hostname` returns them: WHATWG keeps the brackets on an IPv6
 * literal, so `[::1]` is the value to compare against, and it also canonicalises
 * `[0:0:0:0:0:0:0:1]` to that form before the comparison happens.
 */
export const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];
export const MCP_HTTP_PATH = '/mcp';
export const HTTP_RATE_LIMIT_WINDOW_MS = 60_000;
export const HTTP_RATE_LIMIT_MAX = 120;
export const HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Minimum acceptable length for `LUMICS_HTTP_AUTH_TOKEN` (`openssl rand -hex 32`). */
export const MIN_HTTP_AUTH_TOKEN_LENGTH = 32;
