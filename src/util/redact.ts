/**
 * Structural credential redaction.
 *
 * `standards/security-standard.md`: "Never commit, log, echo, or expose
 * secrets." RFC-001 D6 requires this to be *structural* rather than incidental,
 * because the failure mode is a future contributor writing
 * `logger.error('request failed', { err })` and shipping it. A native `fetch`
 * rejection carries a `cause` chain; an axios-style error carries the request
 * headers, `Authorization` included. So every log and error boundary in this
 * server funnels through `redact()`, and nothing else is trusted to be clean.
 *
 * Three layers of defence:
 *  1. Pattern scrubbing — JWTs and `Bearer <x>` / `Authorization: <x>` forms.
 *  2. Key-name scrubbing — any object key that names a credential.
 *  3. Exact-value scrubbing — secrets registered at config load, so the
 *     configured token is removed even if it appears somewhere we never
 *     anticipated (a URL, a nested cause, a stack frame).
 */

export const REDACTED = '[REDACTED]';

/** Depth cap: a cyclic or pathologically deep object must not hang the logger. */
const MAX_DEPTH = 8;

/** Breadth cap per array, so a huge payload cannot stall an error path. */
const MAX_ARRAY_ITEMS = 200;

/** Below this length an "exact secret" match is too likely to be coincidence. */
const MIN_REGISTERED_SECRET_LENGTH = 8;

/**
 * JWT shape: three base64url segments. The Lumics API issues JWTs (spec §2), so
 * this catches a token even when it arrives with no `Bearer` prefix and no
 * telltale key name.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** `Bearer <token>` in any casing, in a header dump or a curl command. */
const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi;

/** `Authorization: <value>` / `"authorization" = <value>` in serialised output. */
const AUTHORIZATION_PATTERN = /\b(authorization)(["']?\s*[:=]\s*["']?)[^"',;}\s]+/gi;

/** Query-string credential leakage, e.g. `?token=...` or `&password=...`. */
const QUERY_SECRET_PATTERN =
  /\b(token|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)(=)[^&\s"']+/gi;

/** Object keys whose *value* is a credential regardless of its shape. */
const SECRET_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|token|jwt|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|credential|credentials|auth|bearer|lumics_token|lumics_http_auth_token)$/i;

/**
 * Exact secret values registered at config load. A module-level set is
 * deliberate: redaction must work from any call site without threading config
 * through every function signature, which is exactly how the "incidental"
 * version of this gets bypassed.
 */
const registeredSecrets = new Set<string>();

/**
 * Register a literal secret so it is scrubbed from any string or nested value
 * this module ever sees. Called by `loadConfig()` for the Lumics API token and
 * the HTTP transport's shared secret.
 *
 * Values shorter than {@link MIN_REGISTERED_SECRET_LENGTH} are ignored: masking
 * a short, common string would corrupt unrelated output without protecting
 * anything meaningful.
 */
export function registerSecret(value: string | undefined): void {
  if (typeof value === 'string' && value.length >= MIN_REGISTERED_SECRET_LENGTH) {
    registeredSecrets.add(value);
  }
}

/** Test-only: drop all registered secrets so cases do not leak into each other. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** Number of registered secrets. Exposed for assertions, never the values. */
export function registeredSecretCount(): number {
  return registeredSecrets.size;
}

/** Scrub credential material from a single string. */
export function redactString(input: string): string {
  let out = input;

  // Exact registered values first: they are the highest-confidence match, and
  // doing them first means a partially pattern-mangled token still gets caught.
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }

  out = out.replace(JWT_PATTERN, REDACTED);
  out = out.replace(BEARER_PATTERN, `$1 ${REDACTED}`);
  out = out.replace(AUTHORIZATION_PATTERN, `$1$2${REDACTED}`);
  out = out.replace(QUERY_SECRET_PATTERN, `$1$2${REDACTED}`);

  return out;
}

/**
 * Deep-redact any value into something safe to serialise. The result is a plain
 * JSON-compatible structure: `Error`s become objects, `Map`/`Set` become arrays,
 * cycles become `'[Circular]'`, and anything unserialisable becomes a string.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>());
}

/**
 * Redact an error into a plain, loggable object. Use this at every `catch`.
 * Walks the `cause` chain, which is where native `fetch` puts the underlying
 * network error (`TypeError: fetch failed` → `cause: Error: getaddrinfo ...`).
 */
export function redactError(error: unknown): Record<string, unknown> {
  const redacted = redact(error);
  if (isPlainRecord(redacted)) {
    return redacted;
  }
  return { message: typeof redacted === 'string' ? redacted : String(redacted) };
}

/**
 * Human-readable, redacted single-line message for an unknown thrown value.
 * Never includes a stack trace — those reach logs only, never tool output or an
 * HTTP response body (RFC-001 D3).
 */
export function redactedMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.message || error.name);
  }
  if (typeof error === 'string') {
    return redactString(error);
  }
  try {
    return redactString(JSON.stringify(error) ?? String(error));
  } catch {
    return 'unserialisable error value';
  }
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return redactString(value.toString());
    case 'function':
      return `[Function ${redactString(value.name || 'anonymous')}]`;
    default:
      break;
  }

  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }

  const obj: object = value;
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  try {
    if (value instanceof Error) {
      return redactErrorObject(value, depth, seen);
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof URL) {
      return redactString(value.toString());
    }
    if (value instanceof Map) {
      return redactInner(Object.fromEntries(value.entries()), depth, seen);
    }
    if (value instanceof Set) {
      return redactInner([...value.values()], depth, seen);
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => redactInner(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[+${String(value.length - MAX_ARRAY_ITEMS)} more items omitted]`);
      }
      return items;
    }

    // Headers has no index signature but is a common carrier of Authorization.
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      const asRecord: Record<string, string> = {};
      value.forEach((headerValue, key) => {
        asRecord[key] = headerValue;
      });
      return redactInner(asRecord, depth, seen);
    }

    return redactRecord(value as Record<string, unknown>, depth, seen);
  } finally {
    seen.delete(obj);
  }
}

function redactErrorObject(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: redactString(error.name),
    message: redactString(error.message),
  };

  if (typeof error.stack === 'string') {
    out.stack = redactString(error.stack);
  }
  if (error.cause !== undefined) {
    out.cause = redactInner(error.cause, depth + 1, seen);
  }

  // Own enumerable extras (`code`, `errno`, `syscall` on Node errors; `status`
  // and friends on ours) matter for diagnosis, so keep them — redacted.
  for (const [key, keyValue] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
      continue;
    }
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactInner(keyValue, depth + 1, seen);
  }

  return out;
}

function redactRecord(
  record: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, keyValue] of Object.entries(record)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactInner(keyValue, depth + 1, seen);
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
