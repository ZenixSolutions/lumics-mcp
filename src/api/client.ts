/**
 * The Lumics HTTP client: native `fetch`, no axios (RFC-001 D1).
 *
 * Responsibilities, all of them single-point:
 *  - attach the bearer credential (spec §2) and never let it reach a log;
 *  - abort on `LUMICS_TIMEOUT_MS` via `AbortSignal.timeout()`;
 *  - retry the transient statuses spec §3 documents, with exponential backoff
 *    plus jitter, honouring `Retry-After`;
 *  - bound concurrency, because spec §3 documents 429 but publishes no limits
 *    (RFC-001 assumption A2);
 *  - turn every failure into a {@link LumicsApiError} whose message tells the
 *    model what to do.
 *
 * Retry safety is the part worth reading carefully. A network error on a POST or
 * PATCH is *ambiguous*: the request may have been applied before the connection
 * died, so retrying risks a duplicate device or a double update. Those verbs are
 * therefore never retried on a network error — only on a status code, which
 * proves the server answered and did not act.
 *
 * Paths must come from `src/api/paths.ts`. This module never interpolates a
 * caller string into a path, which is what keeps the encoding guarantee real.
 */

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  LOCKED_MAX_RETRIES,
  LOCKED_STATUS,
  MAX_RETRY_AFTER_MS,
  RETRYABLE_STATUSES,
} from '../constants.js';
import type { LumicsConfig } from '../config.js';
import { logger } from '../util/logger.js';
import { LumicsApiError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Query values we know how to serialise. `undefined` and `null` are dropped. */
export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface RequestOptions {
  readonly query?: QueryParams;
  readonly body?: unknown;
  /** Longest error-body snippet to keep for diagnosis. */
  readonly maxErrorBodyChars?: number;
}

export interface LumicsClientOptions {
  readonly maxAttempts?: number;
  readonly maxConcurrency?: number;
  /** Injected in tests so backoff does not make the suite slow. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so no real socket is opened. */
  readonly fetchImpl?: typeof fetch;
}

/** Verbs whose effect may have landed even when the connection failed. */
const NON_IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['POST', 'PATCH']);

const DEFAULT_MAX_ERROR_BODY_CHARS = 500;

export class LumicsClient {
  private readonly config: LumicsConfig;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: Semaphore;

  constructor(config: LumicsConfig, options: LumicsClientOptions = {}) {
    this.config = config;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.gate = new Semaphore(Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Issue a request, retrying where it is both useful and safe.
   *
   * @param path A value produced by a builder in `src/api/paths.ts`. Already
   *   percent-encoded; do not pass a raw caller string.
   */
  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    // `operation` is what appears in error messages and logs: method and path
    // only. Never the full URL — a URL can carry credentials in its query.
    const operation = `${method} ${path}`;
    const url = this.buildUrl(path, options.query);
    const release = await this.gate.acquire();

    try {
      let lockedRetries = 0;
      let lastError: LumicsApiError | undefined;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        const outcome = await this.attempt<T>(method, url, operation, options, attempt);

        if (outcome.kind === 'success') {
          return outcome.value;
        }

        lastError = outcome.error;

        // 423 Locked gets exactly one retry: spec §3 says another process holds
        // the resource, and hammering it neither helps nor is safe on a write.
        if (outcome.error.status === LOCKED_STATUS) {
          if (lockedRetries >= LOCKED_MAX_RETRIES) {
            throw outcome.error;
          }
          lockedRetries += 1;
        } else if (!this.shouldRetry(method, outcome, attempt)) {
          throw outcome.error;
        }

        if (attempt >= this.maxAttempts) {
          throw outcome.error;
        }

        const delayMs = this.backoffDelayMs(attempt, outcome.error.retryAfterMs);
        logger.warn('retrying lumics request', {
          operation,
          attempt,
          maxAttempts: this.maxAttempts,
          status: outcome.error.status,
          code: outcome.error.code,
          delayMs,
        });
        await this.sleep(delayMs);
      }

      // Unreachable: the loop either returns, throws, or exhausts attempts and
      // throws above. Kept as a typed guard rather than a non-null assertion.
      throw (
        lastError ??
        new LumicsApiError(`${operation} failed with no recorded error.`, { operation })
      );
    } finally {
      release();
    }
  }

  private async attempt<T>(
    method: HttpMethod,
    url: string,
    operation: string,
    options: RequestOptions,
    attempt: number,
  ): Promise<Attempt<T>> {
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(options.body !== undefined),
        // spec §2/§4: all bodies are JSON. Callers pass plain objects.
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      if (isAbortLike(cause)) {
        return {
          kind: 'failure',
          error: LumicsApiError.timeout(operation, this.config.timeoutMs, attempt, cause),
        };
      }
      return {
        kind: 'failure',
        error: LumicsApiError.network(operation, attempt, cause),
        networkFailure: true,
      };
    }

    if (!response.ok) {
      const bodySnippet = await readBodySnippet(
        response,
        options.maxErrorBodyChars ?? DEFAULT_MAX_ERROR_BODY_CHARS,
      );
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      return {
        kind: 'failure',
        error: LumicsApiError.fromStatus(response.status, {
          operation,
          attempts: attempt,
          ...(bodySnippet === undefined ? {} : { bodySnippet }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        }),
      };
    }

    // 204 and an empty 200 both occur in practice even though spec §4.2
    // documents a body for every operation. Return `null` rather than throwing.
    if (response.status === 204) {
      return { kind: 'success', value: null as T };
    }

    // Reading the body is a second I/O operation and it can fail on its own: the
    // stream can be reset mid-transfer, or `AbortSignal.timeout()` can fire while
    // the body is still arriving. `.catch(() => '')` here would report that as a
    // zero-byte body, which `expectArray` then turns into `[]` — a partial read
    // presented as an empty-but-complete collection, with no error and no
    // disclosure. It is classified as a transport failure instead, so it is
    // retried on an idempotent verb and never on POST/PATCH (the request may
    // already have been applied upstream).
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (isAbortLike(cause)) {
        return {
          kind: 'failure',
          error: LumicsApiError.timeout(operation, this.config.timeoutMs, attempt, cause),
        };
      }
      return {
        kind: 'failure',
        error: LumicsApiError.incompleteBody(operation, attempt, cause),
        networkFailure: true,
      };
    }

    if (text.trim().length === 0) {
      return { kind: 'success', value: null as T };
    }

    try {
      return { kind: 'success', value: JSON.parse(text) as T };
    } catch (cause) {
      return {
        kind: 'failure',
        error: LumicsApiError.invalidResponse(
          operation,
          `the body was not valid JSON (${String(text.length)} bytes, content-type "${response.headers.get('content-type') ?? 'unknown'}")`,
          cause,
        ),
      };
    }
  }

  private shouldRetry(method: HttpMethod, outcome: Failure, attempt: number): boolean {
    if (attempt >= this.maxAttempts) {
      return false;
    }

    // A network failure on POST/PATCH may already have been applied upstream.
    // Retrying could duplicate a device or double-apply an update, so it is
    // never worth the risk; the model is told to verify state instead.
    if (outcome.networkFailure === true && NON_IDEMPOTENT_METHODS.has(method)) {
      return false;
    }

    if (outcome.error.code === 'timeout' || outcome.error.code === 'network_error') {
      // Same reasoning: a timeout means we stopped waiting, not that the server
      // stopped working, so a non-idempotent verb must not be replayed.
      return !NON_IDEMPOTENT_METHODS.has(method);
    }

    const status = outcome.error.status;
    if (status === undefined) {
      return false;
    }
    // Only the documented transient set. Never any other 4xx — a 400, 401, 403,
    // 404 or 409 will produce the identical result on every attempt.
    return RETRYABLE_STATUSES.includes(status);
  }

  /** Full jitter: `random(0, min(cap, base * 2^attempt))`, or `Retry-After`. */
  private backoffDelayMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const exponential = DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const capped = Math.min(exponential, DEFAULT_RETRY_MAX_DELAY_MS);
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      // spec §2: `Authorization: Bearer <jwt>`.
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    };
    if (hasBody) {
      // Every endpoint page declares this content type (spec §5–§12).
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private buildUrl(path: string, query: QueryParams | undefined): string {
    // `path` is already percent-encoded by src/api/paths.ts. Concatenating
    // rather than using `new URL(path, base)` is deliberate: URL resolution
    // would let a leading `/` or `..` in a path escape the `/api/v1` prefix.
    const url = new URL(`${this.config.baseUrl}${path}`);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
          continue;
        }
        url.searchParams.set(key, typeof value === 'boolean' ? String(value) : String(value));
      }
    }
    return url.toString();
  }
}

/**
 * Unwrap `{ updated: ... }` (spec §4.2, PATCH/PUT). Tool output stays consistent
 * with the equivalent read rather than exposing a vendor envelope the model then
 * has to reason about.
 */
export function unwrapUpdated<T>(response: unknown, operation: string): T {
  if (isRecord(response) && 'updated' in response) {
    return response.updated as T;
  }
  throw LumicsApiError.invalidResponse(
    operation,
    'the response did not contain the documented "updated" envelope (spec section 4.2)',
  );
}

/** Unwrap `{ deleted: ... }` (spec §4.2, DELETE). */
export function unwrapDeleted<T>(response: unknown, operation: string): T {
  if (isRecord(response) && 'deleted' in response) {
    return response.deleted as T;
  }
  throw LumicsApiError.invalidResponse(
    operation,
    'the response did not contain the documented "deleted" envelope (spec section 4.2)',
  );
}

/**
 * Assert a list endpoint really returned a bare array (spec §4.2). A single
 * object where an array was documented is drift worth surfacing, not silently
 * wrapping.
 */
export function expectArray<T>(response: unknown, operation: string): readonly T[] {
  if (Array.isArray(response)) {
    return response as readonly T[];
  }
  if (response === null || response === undefined) {
    return [];
  }
  throw LumicsApiError.invalidResponse(
    operation,
    `a bare JSON array was documented (spec section 4.2) but the body was ${describeJsonKind(response)}`,
  );
}

/**
 * Assert a single-record read really returned an object (spec §4.2).
 *
 * An absent body is **not** acceptable here, and that asymmetry with
 * {@link expectArray} is deliberate. On a list read, no body plausibly means "no
 * records" and the caller discloses it (see {@link absentBodyNotes}). On a single
 * read there is no such reading: spec §4.2 documents a bare JSON object, so a
 * `null` means the endpoint answered 200 with nothing — drift, or a body that
 * never arrived. Returning `null` to the model would render as the literal text
 * `null` inside a successful, non-error tool result, which reads as "this device
 * does not exist" rather than "this server could not tell".
 */
export function expectObject<T>(response: unknown, operation: string): T {
  if (isRecord(response)) {
    return response as T;
  }
  if (response === null || response === undefined) {
    throw LumicsApiError.invalidResponse(
      operation,
      'a single JSON object was documented (spec section 4.2) but the response carried no body at all. This is not the same as "the record does not exist" — a missing record is a documented 404 (spec section 3). Do not report the record as absent or empty on the strength of this response',
    );
  }
  throw LumicsApiError.invalidResponse(
    operation,
    `a single JSON object was documented (spec section 4.2) but the body was ${describeJsonKind(response)}`,
  );
}

/**
 * The disclosure a list read owes its caller when the body was absent rather
 * than an empty array.
 *
 * `expectArray` maps both to `[]` because a 204 or an empty 200 does occur in
 * practice, but "Lumics sent no body" and "the collection is empty" are different
 * facts and the API gives no way to tell them apart. Reporting the first as the
 * second is exactly the silent-completeness failure this codebase is organised
 * against, so list tools pass this into their notes.
 */
export const ABSENT_BODY_LIST_NOTE =
  'NOTE ON AN EMPTY RESULT: Lumics returned no response body at all for this list — an empty 200 or a 204 — rather than an empty JSON array. This server reports that as zero records because there is nothing else it can do, but "no body was sent" and "the collection is empty" are different things and the Lumics API does not distinguish them (spec section 4.2 documents a body for every operation). Do NOT tell the user this collection is empty on the strength of this response: re-run the call, and if it is still empty verify in the Lumics UI before reporting a count of zero.';

/**
 * True when the transport delivered no body at all — a 204, or a 200 whose body
 * was empty (see `attempt()`, which maps both to `null`).
 *
 * This is the single definition of "absent body" every caller shares, so a tool
 * cannot drift into its own idea of what counts. The *wording* of the disclosure
 * is the caller's, because it depends on what the caller is reading: see
 * {@link ABSENT_BODY_LIST_NOTE} for a collection, and `absentSeriesNote` in
 * `src/tools/metrics.ts` for a time series, where "empty" reads differently.
 */
export function isAbsentBody(response: unknown): boolean {
  return response === null || response === undefined;
}

/** `[ABSENT_BODY_LIST_NOTE]` when the raw body was absent, otherwise `[]`. */
export function absentBodyNotes(response: unknown): readonly string[] {
  return isAbsentBody(response) ? [ABSENT_BODY_LIST_NOTE] : [];
}

type Attempt<T> = { readonly kind: 'success'; readonly value: T } | Failure;

interface Failure {
  readonly kind: 'failure';
  readonly error: LumicsApiError;
  /** True when no response was received at all. */
  readonly networkFailure?: boolean;
}

/**
 * Fixed-size permit pool. Conservative by default because Lumics documents 429
 * without documenting a limit — an unbounded burst is how you discover the
 * limit the hard way, mid-conversation.
 */
class Semaphore {
  private available: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiting.shift();
      if (next === undefined) {
        this.available += 1;
      } else {
        next();
      }
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `AbortSignal.timeout()` rejects with a `TimeoutError` `DOMException`; an
 * externally aborted signal rejects with `AbortError`. Both are name-checked
 * because `instanceof DOMException` is not reliable across realms.
 */
function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function readBodySnippet(response: Response, maxChars: number): Promise<string | undefined> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    return trimmed.length === 0 ? undefined : trimmed.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

/**
 * spec §3 documents no rate-limit headers, so `Retry-After` may be absent or in
 * either documented form (delay-seconds or an HTTP date). Both are handled;
 * anything unparseable falls back to computed backoff.
 */
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (headerValue === null) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number.parseInt(trimmed, 10) * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) {
    return undefined;
  }
  return Math.max(0, Math.min(asDate - Date.now(), MAX_RETRY_AFTER_MS));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonKind(value: unknown): string {
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (value === null) {
    return 'null';
  }
  // A model reads this sentence, so the article has to agree: "a object" is the
  // kind of wording that makes a diagnostic look like a bug in the diagnostic.
  if (typeof value === 'object') {
    return 'an object';
  }
  return `a ${typeof value}`;
}
