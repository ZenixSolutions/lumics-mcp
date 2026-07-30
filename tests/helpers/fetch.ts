/**
 * A recording `fetch` double.
 *
 * `LumicsClient` takes an injectable `fetchImpl`, so no test in the default
 * suite opens a socket. Every call is recorded with its parsed URL, method,
 * headers and body so a test can assert the exact request that would have gone
 * out — which is the only way to catch a wrong path, a dropped query parameter
 * or a fabricated pagination argument.
 */

export interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly rawBody: string | undefined;
  /** Parsed JSON body, or `undefined` when there was no body. */
  readonly body: unknown;
  /** Query parameters as a plain object. Repeated keys keep the last value. */
  readonly query: Record<string, string>;
  /** Path only, with the base URL prefix removed. */
  readonly path: string;
}

export interface FetchRecorder {
  readonly fetchImpl: typeof fetch;
  readonly calls: RecordedCall[];
  /** Convenience accessor for the single expected call. Throws if there isn't exactly one. */
  only(): RecordedCall;
  last(): RecordedCall;
}

export type Responder = (call: RecordedCall, attempt: number) => Response | Promise<Response>;

/**
 * `tsconfig.json` sets `lib: ["ES2023"]` with no DOM lib, so `RequestInfo` and
 * `HeadersInit` are not global names even though `fetch` itself is typed by
 * @types/node. Derive the parameter types from `fetch` instead of naming them.
 */
type FetchInput = Parameters<typeof fetch>[0];
type FetchHeaders = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['headers']>;

/** JSON response helper. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Error response helper: a status with an optional text body. */
export function errorResponse(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

/**
 * Build a recording fetch. `responder` may be a single `Response`, an array of
 * responses consumed in order (the last one repeats), or a function.
 */
export function recordFetch(
  responder: Responder | Response | readonly Response[] | (() => Response),
  options: { readonly baseUrl?: string } = {},
): FetchRecorder {
  const base = options.baseUrl ?? 'https://lumics.invalid/api/v1';
  const calls: RecordedCall[] = [];

  const resolve: Responder = (() => {
    if (typeof responder === 'function') {
      return responder;
    }
    if (Array.isArray(responder)) {
      const queue = responder as readonly Response[];
      return (_call, attempt) => {
        const picked = queue[Math.min(attempt - 1, queue.length - 1)];
        if (picked === undefined) {
          throw new Error('recordFetch: responder array was empty');
        }
        // A Response body can only be read once, so hand out a clone.
        return picked.clone();
      };
    }
    const single = responder as Response;
    return () => single.clone();
  })();

  const fetchImpl = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = new URL(urlOf(input));
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;

    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: normaliseHeaders(init?.headers),
      rawBody,
      body: rawBody === undefined ? undefined : safeParse(rawBody),
      query: Object.fromEntries(url.searchParams.entries()),
      path: url.pathname.startsWith(new URL(base).pathname)
        ? url.pathname.slice(new URL(base).pathname.length)
        : url.pathname,
    };
    calls.push(call);
    return await resolve(call, calls.length);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    only(): RecordedCall {
      if (calls.length !== 1) {
        throw new Error(`expected exactly 1 fetch call but recorded ${String(calls.length)}`);
      }
      return calls[0] as RecordedCall;
    },
    last(): RecordedCall {
      const call = calls.at(-1);
      if (call === undefined) {
        throw new Error('expected at least 1 fetch call but recorded none');
      }
      return call;
    },
  };
}

/** A fetch that rejects the way native `fetch` does on a transport failure. */
export function networkFailureFetch(
  message = 'fetch failed',
  cause: unknown = new Error('getaddrinfo ENOTFOUND lumics.invalid'),
): FetchRecorder {
  return recordFetch(() => {
    throw new TypeError(message, { cause });
  });
}

/** A fetch that rejects the way `AbortSignal.timeout()` does. */
export function timeoutFetch(): FetchRecorder {
  return recordFetch(() => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  });
}

/** Records every `sleep()` the client asks for, and never actually waits. */
export function recordSleep(): { readonly sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

function normaliseHeaders(headers: FetchHeaders | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * `fetch` accepts a string, a `URL` or a `Request`. Only the first two are used
 * by `LumicsClient`, but the type admits all three, and `Request.toString()`
 * would silently produce "[object Object]".
 */
function urlOf(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
