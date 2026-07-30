/**
 * Explicit error types for the Lumics client.
 *
 * `standards/typescript-standard.md`: "Use explicit error types." Two classes
 * cover everything this server throws deliberately:
 *
 *  - {@link LumicsApiError} — the API answered, or the transport failed.
 *  - {@link LumicsInputError} — the *caller* (the model) supplied something we
 *    can reject before spending a request.
 *
 * Every message is written for a model to act on. "403 Forbidden" tells it
 * nothing; "your user lacks access to this company; verify the companyId with
 * lumics_get_me" tells it what to do next. spec §3 is the full documented status
 * table and it is mapped here in its entirety — including 200 and 304, which are
 * only reachable as errors if the API contradicts its own documentation.
 *
 * spec §3 also notes: "No endpoint detail page documents per-endpoint status
 * codes, error bodies, or error shapes." So we never assume an error body shape;
 * we capture a bounded, redacted snippet and move on.
 */

import {
  COMPANY_METRIC_500_CORRELATED_PARAMS,
  COMPANY_METRIC_500_SERVED_PARAMS,
  COMPANY_SCOPED_METRIC_PATH_PATTERN,
} from '../constants.js';
import { redactString, redactedMessage } from '../util/redact.js';

/** Machine-readable classification, stable across releases. */
export type LumicsErrorCode =
  | 'unexpected_success_status'
  | 'not_modified'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'locked'
  | 'rate_limited'
  | 'server_error'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'invalid_input'
  | 'not_permitted';

/** Longest error-body snippet retained for diagnosis. */
const MAX_BODY_SNIPPET_CHARS = 500;

/**
 * Verbs whose effect may already have landed when the transport failed, and
 * which `LumicsClient` therefore refuses to replay (see `NON_IDEMPOTENT_METHODS`
 * in `./client.ts`).
 *
 * `PUT` is absent on purpose: the only PUT this server issues writes an absolute
 * `lastDiscovery` value (spec §7.4), so a replay writes the same timestamp.
 */
const UNREPLAYABLE_METHODS: ReadonlySet<string> = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * The verb an `operation` describes. Every `operation` this module receives is
 * built as `${method} ${path}` by `LumicsClient.request`, or as `PATCH device
 * <id>` by a tool. Anything unrecognised is treated as a read, which is the
 * conservative direction: a read gets retry advice, and advising a retry of
 * something that is genuinely a read cannot duplicate a record.
 */
function methodOf(operation: string): string {
  return (operation.trim().split(/\s+/)[0] ?? '').toUpperCase();
}

/**
 * What to tell the model after a transport failure, which depends entirely on
 * the verb.
 *
 * On a read, the request either arrived or it did not, nothing changed either
 * way, and a retry is the right move. On a POST, PATCH or DELETE it is not: the
 * request may have been applied before the connection died, the client made
 * exactly one attempt for that reason, and telling the model to "retry the call"
 * hands it an instruction to create a duplicate, re-apply a change, or delete a
 * record it cannot see. It is sent to look at the current state instead.
 */
function transportGuidance(operation: string, readAdvice: string): string {
  if (!UNREPLAYABLE_METHODS.has(methodOf(operation))) {
    return readAdvice;
  }
  return 'This was a write, and it may already have been applied: the transport cannot distinguish a request Lumics never processed from one it processed and then failed to answer. This server deliberately did NOT retry it, because replaying a write whose outcome is unknown duplicates a record, re-applies a change, or turns a completed delete into a 404 that reads as a record which never existed. Do not retry it either: read the record back, or list its parent collection, to establish what the current state actually is, and report that. Do not report the write as having failed on the strength of this error alone.';
}

interface StatusMapping {
  readonly code: LumicsErrorCode;
  /** Actionable guidance. Present tense, addressed to the model. */
  readonly guidance: string;
  /** Whether a retry could plausibly succeed without changing the request. */
  readonly retryable: boolean;
}

/**
 * spec §3, complete. Keep the order and the comments — this table is the
 * contract, and a reviewer should be able to diff it against §3 line by line.
 */
const STATUS_MAP: Readonly<Record<number, StatusMapping>> = {
  // 200 OK — Success. Only an error if a caller demanded a different status.
  200: {
    code: 'unexpected_success_status',
    guidance:
      'The Lumics API returned 200 OK but the response body did not match the documented shape for this endpoint. Treat the data as untrusted and report the mismatch rather than acting on it.',
    retryable: false,
  },
  // 304 Not Modified — "There was no new data to return."
  304: {
    code: 'not_modified',
    guidance:
      'Lumics reported no new data (304 Not Modified). Reuse the result of your previous call for this resource; re-requesting immediately will return 304 again.',
    retryable: false,
  },
  // 400 Bad Request — problem with the parameters supplied.
  400: {
    code: 'bad_request',
    guidance:
      "Lumics rejected the parameters (400 Bad Request). Re-read this tool's argument descriptions, check that every id is a 24-character hex ObjectId, and that enum values match exactly. Do not retry the identical call.",
    retryable: false,
  },
  // 401 Unauthorized — "probably a problem with the token".
  401: {
    code: 'unauthorized',
    guidance:
      'Lumics rejected the credential (401 Unauthorized). The configured LUMICS_TOKEN is missing, malformed, or expired — Lumics tokens default to a 24-hour lifetime. This is a server configuration problem you cannot fix by retrying or by changing arguments; tell the operator to issue a fresh token.',
    retryable: false,
  },
  // 403 Forbidden — "data that your user does not have access to".
  403: {
    code: 'forbidden',
    guidance:
      'Your Lumics user lacks access to this data (403 Forbidden). Verify the companyId with lumics_get_me — the configured LUMICS_COMPANY_ID may belong to a different tenant than the token. Do not retry with the same ids.',
    retryable: false,
  },
  // 404 Not found.
  404: {
    code: 'not_found',
    guidance:
      'Lumics has no such resource (404 Not Found). Confirm the id exists by listing the parent collection first; ids are not interchangeable between resource types even though they share the 24-hex ObjectId shape.',
    retryable: false,
  },
  // 409 Conflict — duplicate of an existing resource.
  409: {
    code: 'conflict',
    guidance:
      'Creating this resource would duplicate an existing one (409 Conflict). List the collection to find the existing record and update it instead of creating a second. Retrying the create will conflict again.',
    retryable: false,
  },
  // 423 Locked — another process or user holds the resource.
  423: {
    code: 'locked',
    guidance:
      'The resource is locked by another process or user (423 Locked). The server already retried once. Report the lock to the user rather than looping; a Lumics collector or another operator is mid-change.',
    retryable: true,
  },
  // 429 Too Many Requests.
  429: {
    code: 'rate_limited',
    guidance:
      'Lumics rate-limited the request (429 Too Many Requests). The server already retried with backoff and honoured any Retry-After header. Lumics publishes no rate limits, so reduce the number of calls you make rather than retrying immediately.',
    retryable: true,
  },
  // 500 Server Error.
  500: {
    code: 'server_error',
    guidance:
      'Lumics failed internally (500 Server Error). This is not a problem with your arguments. The server already retried where safe; report the failure rather than reissuing the same call.',
    retryable: true,
  },
};

// ---------------------------------------------------------------------------
// The one endpoint whose 500 means something more specific than "500"
// ---------------------------------------------------------------------------

/**
 * The path half of an `operation`, which `LumicsClient.request` builds as
 * `${method} ${path}`.
 *
 * A tool can also construct its own operation string (`PATCH device <id>`), so
 * this returns `undefined` rather than guessing when the second token is not a
 * path. Nothing below fires on `undefined`, which is the safe direction: the
 * generic guidance is never wrong, only less specific.
 */
function pathOf(operation: string | undefined): string | undefined {
  const parts = (operation ?? '').trim().split(/\s+/);
  const candidate = parts[1];
  return candidate !== undefined && candidate.startsWith('/') ? candidate : undefined;
}

/** True for spec §12.1 and §12.2 only. spec §12.3's device paths are excluded. */
function isCompanyScopedMetricPath(operation: string | undefined): boolean {
  const path = pathOf(operation);
  return path !== undefined && COMPANY_SCOPED_METRIC_PATH_PATTERN.test(path);
}

/** True for spec §12.2 specifically — the half that has never been seen to answer. */
function isSummarizePath(operation: string | undefined): boolean {
  return isCompanyScopedMetricPath(operation) && pathOf(operation)?.endsWith('/summarize') === true;
}

/**
 * What a 500 from spec §12.1 or §12.2 means, as opposed to what a 500 means
 * anywhere else in this API.
 *
 * The generic 500 guidance says two things that are actively misleading here:
 *
 *  1. **"This is not a problem with your arguments."** On every other endpoint
 *     that is the right thing to say. On this one it is the opposite of what was
 *     measured (spec §12.5 M12): the 500s tracked specific query parameters, and
 *     the same endpoint served the same tenant when those parameters were left
 *     out. No mechanism has been established and none is claimed — but a model
 *     told its arguments are irrelevant will not try the one change that has been
 *     observed to work.
 *  2. **"report the failure rather than reissuing the same call."** Reporting a
 *     failure is right; stopping there is not, because there is a documented
 *     alternative that answers the same question. The device-scoped endpoints
 *     (spec §12.3) returned populated data in one to two seconds in every run,
 *     and the vendor's own product does not use the company-scoped endpoint for
 *     company-wide metrics at all.
 *
 * Deliberately **not** overstated. §12.1 is intermittent, not dead: a minimal
 * query was served, and so were `interval=hour`, `interval=day`, `aggregate` and
 * `alignTimeRange`. The text says what was observed, under which conditions, and
 * offers the narrowed retry as a second option rather than declaring the tool
 * useless.
 */
function companyMetricServerErrorGuidance(operation: string | undefined): string {
  const correlated = COMPANY_METRIC_500_CORRELATED_PARAMS.join(', ');
  const served = COMPANY_METRIC_500_SERVED_PARAMS.join(', ');
  const summarize = isSummarizePath(operation)
    ? ' This is the /summarize half (spec section 12.2), which is the worse of the two: across every live run it has NEVER returned at all — over 90 seconds, with and without itemType narrowing — so a failure from it says almost nothing about your query. Do not spend attempts tuning it.'
    : '';

  return (
    'Lumics failed internally (500 Server Error) on the COMPANY-SCOPED metric endpoint (spec section 12.1/12.2). ' +
    'THIS ENDPOINT IS KNOWN TO BE UNRELIABLE IN PRACTICE and this failure is not a surprise: measured against a ' +
    'live tenant on 2026-07-30 (spec section 12.5 M12), it returned 500 on ordinary queries that carried a valid ' +
    '"properties" value.' +
    summarize +
    ' UNLIKE a generic 500, YOUR ARGUMENTS DO CORRELATE WITH THIS FAILURE — do not read this as "nothing you can ' +
    `change". The 500s coincided with ${correlated}; ${served} were served, as was a minimal query, so the endpoint ` +
    'is intermittent and query-dependent rather than dead. No cause has been established; the correlation is what ' +
    'was measured. This server did NOT retry the call, because a retry of an expensive query-dependent 500 spends ' +
    'wall time to learn the same thing, and you should not reissue it unchanged either. WHAT TO DO INSTEAD, in ' +
    'order of reliability: (1) GO DEVICE-SCOPED, which is the dependable path — the spec section 12.3 endpoints ' +
    'returned populated data in one to two seconds in every run, so call lumics_list_devices to resolve the ' +
    'devices you care about, then lumics_get_device_metrics for each one, or lumics_get_device_item_metrics for a ' +
    'single component; it is more calls, and it is the path that works. (2) Or, since the endpoint is intermittent, ' +
    'retry ONCE with the correlated parameters above dropped and interval=hour or interval=day. FINALLY: a 500 ' +
    'here is NOT evidence that this company, module or metric has no data — nothing was measured either way — so ' +
    'do not report an absence, a zero, or an empty estate on the strength of it.'
  );
}

/** True when `status` is one of the ten codes spec §3 documents. */
export function isDocumentedStatus(status: number): boolean {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, status);
}

export interface LumicsApiErrorOptions {
  readonly status?: number;
  readonly code?: LumicsErrorCode;
  /** Method and path only. Never a full URL — a URL can carry query secrets. */
  readonly operation?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly attempts?: number;
  readonly bodySnippet?: string;
  readonly cause?: unknown;
}

/**
 * Anything that went wrong talking to Lumics.
 *
 * The `message` is already redacted at construction time. There is no
 * unredacted variant, deliberately: an unredacted field would eventually be the
 * one that gets logged.
 */
export class LumicsApiError extends Error {
  override readonly name = 'LumicsApiError';
  readonly code: LumicsErrorCode;
  readonly status: number | undefined;
  readonly operation: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly attempts: number | undefined;
  readonly bodySnippet: string | undefined;

  constructor(message: string, options: LumicsApiErrorOptions = {}) {
    super(
      redactString(message),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = options.code ?? 'http_error';
    this.status = options.status;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.attempts = options.attempts;
    this.bodySnippet =
      options.bodySnippet === undefined
        ? undefined
        : redactString(options.bodySnippet).slice(0, MAX_BODY_SNIPPET_CHARS);
  }

  /**
   * Build the error for an HTTP response, mapping spec §3 to guidance.
   * `bodySnippet` is whatever text the response carried; no shape is assumed.
   */
  static fromStatus(
    status: number,
    options: {
      readonly operation: string;
      readonly bodySnippet?: string;
      readonly retryAfterMs?: number;
      readonly attempts?: number;
    },
  ): LumicsApiError {
    const mapped = STATUS_MAP[status];

    // Endpoint-aware only where an endpoint has been measured behaving
    // differently from the table, and only for the status that was measured.
    // Everything else keeps spec §3's mapping exactly as it was: a 400 from this
    // same path is still a 400, because nothing about §12.5 M12 concerns a 400.
    const endpointSpecific =
      status === 500 && isCompanyScopedMetricPath(options.operation)
        ? companyMetricServerErrorGuidance(options.operation)
        : undefined;

    const guidance =
      endpointSpecific ??
      mapped?.guidance ??
      `Lumics returned HTTP ${String(status)}, which its documentation does not describe (spec section 3 lists only 200, 304, 400, 401, 403, 404, 409, 423, 429 and 500). Treat this as a transport or gateway fault, not as a result.`;
    const detail = options.bodySnippet ? ` Response body: ${options.bodySnippet}` : '';

    return new LumicsApiError(
      `${options.operation} failed with HTTP ${String(status)}. ${guidance}${detail}`,
      {
        status,
        code: mapped?.code ?? 'http_error',
        operation: options.operation,
        // Fail fast, and say so in the flag as well as in the prose. The client
        // has never retried a 500 (500 is absent from `RETRYABLE_STATUSES`), so
        // this corrects metadata that already disagreed with behaviour — and on
        // this endpoint the disagreement is load-bearing, because a caller acting
        // on `retryable` would reissue an expensive call whose failure correlates
        // with the very arguments it would send again.
        retryable: endpointSpecific === undefined ? (mapped?.retryable ?? false) : false,
        ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
        ...(options.bodySnippet === undefined ? {} : { bodySnippet: options.bodySnippet }),
      },
    );
  }

  /**
   * The request exceeded `LUMICS_TIMEOUT_MS` and was aborted.
   *
   * Reachable on a write as well as a read, and the guidance differs: a timeout
   * means *this server stopped waiting*, not that Lumics stopped working, so on
   * a POST, PATCH or DELETE the change may well have been applied after the
   * abort. See {@link transportGuidance}.
   */
  static timeout(
    operation: string,
    timeoutMs: number,
    attempts: number,
    cause?: unknown,
  ): LumicsApiError {
    return new LumicsApiError(
      `${operation} timed out after ${String(timeoutMs)}ms across ${String(attempts)} attempt(s). ${transportGuidance(operation, 'Narrow the request — a smaller limit, a shorter time range, or fewer metric properties — or ask the operator to raise LUMICS_TIMEOUT_MS.')}`,
      {
        code: 'timeout',
        operation,
        retryable: true,
        attempts,
        ...(cause === undefined ? {} : { cause }),
      },
    );
  }

  /**
   * The request never produced a response: DNS failure, TLS failure, connection
   * reset. Native `fetch` surfaces these as `TypeError: fetch failed` with the
   * real reason on `cause`, so the reason is pulled out here rather than lost.
   */
  static network(operation: string, attempts: number, cause: unknown): LumicsApiError {
    return new LumicsApiError(
      `${operation} could not reach the Lumics API after ${String(attempts)} attempt(s): ${redactedMessage(describeCause(cause))}. Check LUMICS_BASE_URL and network connectivity. This is an environment problem, not an argument problem. ${transportGuidance(operation, 'Retry the call once the environment is sound.')}`,
      { code: 'network_error', operation, retryable: true, attempts, cause },
    );
  }

  /**
   * The response headers arrived but the body did not finish arriving: the stream
   * was reset mid-transfer, or the timeout fired while it was still coming.
   *
   * Classified `network_error` so the retry policy treats it exactly like any
   * other transport failure — retried on a replayable verb, never on POST, PATCH
   * or DELETE. The message is separate from {@link LumicsApiError.network}
   * because "could not reach the API" would be untrue here, and because the
   * *reason* this is an error at all is worth stating: a truncated body read as a
   * complete one is an under-reported inventory presented as a confident answer.
   *
   * Both halves of the message are verb-aware. On a read, the discarded body is a
   * possibly-truncated collection and a retry is the correct next step. On a
   * write, "a truncated list is indistinguishable from a short one" describes
   * nothing that happened, and "retry the call" is an instruction to replay a
   * write this client refused to replay.
   */
  static incompleteBody(operation: string, attempts: number, cause: unknown): LumicsApiError {
    const discarded = UNREPLAYABLE_METHODS.has(methodOf(operation))
      ? 'The partial body was discarded rather than parsed, because half of a write response cannot be trusted to describe what was applied.'
      : 'The partial body was discarded rather than parsed, because a truncated list is indistinguishable from a short one and would otherwise be reported as a complete result.';

    return new LumicsApiError(
      `${operation} reached Lumics but the response body did not arrive completely after ${String(attempts)} attempt(s): ${redactedMessage(describeCause(cause))}. ${discarded} ${transportGuidance(operation, 'Retry the call; if it keeps failing, narrow the request or ask the operator to raise LUMICS_TIMEOUT_MS.')}`,
      { code: 'network_error', operation, retryable: true, attempts, cause },
    );
  }

  /** A 2xx response whose body was not the JSON this endpoint documents. */
  static invalidResponse(operation: string, detail: string, cause?: unknown): LumicsApiError {
    return new LumicsApiError(
      `${operation} returned a response this server could not interpret: ${detail}. The live API may have drifted from docs/reference/lumics-api-v1.md; report the mismatch rather than guessing at the data.`,
      {
        code: 'invalid_response',
        operation,
        retryable: false,
        ...(cause === undefined ? {} : { cause }),
      },
    );
  }
}

/**
 * A caller-supplied argument we reject before issuing a request: an out-of-range
 * time window, a missing companyId with no configured default, a refused
 * confirmation. Separate from {@link LumicsApiError} so the factory can tell
 * "the model can fix this" from "Lumics said no".
 */
export class LumicsInputError extends Error {
  override readonly name = 'LumicsInputError';
  readonly code: LumicsErrorCode;

  constructor(message: string, code: LumicsErrorCode = 'invalid_input') {
    super(redactString(message));
    this.code = code;
  }
}

/** Normalised, redacted view of any thrown value for tool output and logs. */
export interface DescribedError {
  readonly code: LumicsErrorCode | 'unknown_error';
  readonly status: number | undefined;
  readonly message: string;
}

/**
 * Single point at which an unknown thrown value becomes tool-visible text.
 * Used by the tool factory so no individual tool decides how errors are
 * rendered — and so nothing unredacted can reach a client through a handler
 * that forgot.
 */
export function describeError(error: unknown): DescribedError {
  if (error instanceof LumicsApiError) {
    return { code: error.code, status: error.status, message: error.message };
  }
  if (error instanceof LumicsInputError) {
    return { code: error.code, status: undefined, message: error.message };
  }
  return {
    code: 'unknown_error',
    status: undefined,
    message: `Unexpected internal error: ${redactedMessage(error)}. This is a defect in lumics-mcp, not a problem with your arguments.`,
  };
}

/** Pull the most specific message out of a native `fetch` cause chain. */
function describeCause(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current;
}
