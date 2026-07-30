/**
 * The HTTP client — `src/api/client.ts`.
 *
 * The part worth reading carefully is retry safety. spec §3 documents which
 * statuses are transient, but a *network* failure on a POST or PATCH is
 * ambiguous: the request may already have been applied, so replaying it can
 * duplicate a device or double-apply an update. Those cases assert an exact
 * attempt count, because "retried once too often" is invisible in production
 * until a customer finds two of something.
 *
 * `fetchImpl` and `sleep` are both injected, so nothing here opens a socket or
 * waits on a real timer.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSENT_BODY_LIST_NOTE,
  absentBodyNotes,
  isAbsentBody,
  expectArray,
  expectObject,
  LumicsClient,
  unwrapDeleted,
  unwrapUpdated,
  unwrapUpdatedArray,
} from '../../src/api/client.js';
import { LumicsApiError } from '../../src/api/errors.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  RETRYABLE_STATUSES,
} from '../../src/constants.js';
import { makeConfig, TEST_TOKEN } from '../helpers/config.js';
import {
  errorResponse,
  jsonResponse,
  networkFailureFetch,
  recordFetch,
  recordSleep,
  timeoutFetch,
  type FetchRecorder,
} from '../helpers/fetch.js';

function makeClient(
  fetcher: FetchRecorder,
  options: { maxAttempts?: number; maxConcurrency?: number } = {},
): { client: LumicsClient; delays: number[] } {
  const sleeper = recordSleep();
  const client = new LumicsClient(makeConfig(), {
    fetchImpl: fetcher.fetchImpl,
    sleep: sleeper.sleep,
    ...options,
  });
  return { client, delays: sleeper.delays };
}

/**
 * Await a request that must reject, and hand back the `LumicsApiError`.
 *
 * The obvious `.catch((e: unknown) => e as LumicsApiError)` widens back to
 * `unknown` through the awaited union, so this asserts the type instead of
 * casting it — which also means a rejection with the wrong class fails loudly.
 */
async function captureApiError(promise: Promise<unknown>): Promise<LumicsApiError> {
  try {
    const value = await promise;
    throw new Error(
      `expected a LumicsApiError but the call resolved with ${JSON.stringify(value)}`,
    );
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(LumicsApiError);
    return thrown as LumicsApiError;
  }
}

describe('request construction', () => {
  it('sends the bearer credential from config as spec section 2 documents', async () => {
    const fetcher = recordFetch(jsonResponse({ ok: true }));
    const { client } = makeClient(fetcher);
    await client.get('/me');

    expect(fetcher.only().headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(fetcher.only().headers.accept).toBe('application/json');
  });

  it('sets Content-Type only when there is a body', async () => {
    const fetcher = recordFetch(jsonResponse({ ok: true }));
    const { client } = makeClient(fetcher);

    await client.get('/me');
    expect(fetcher.calls[0]?.headers['content-type']).toBeUndefined();

    await client.post('/me/token/revoke', { body: { a: 1 } });
    expect(fetcher.calls[1]?.headers['content-type']).toBe('application/json');
    expect(fetcher.calls[1]?.rawBody).toBe('{"a":1}');
  });

  it('joins the path onto the base URL without introducing a double slash', async () => {
    const fetcher = recordFetch(jsonResponse({}));
    const client = new LumicsClient(makeConfig({ baseUrl: 'https://lumics.invalid/api/v1' }), {
      fetchImpl: fetcher.fetchImpl,
    });
    await client.get('/me');
    expect(fetcher.only().url.toString()).toBe('https://lumics.invalid/api/v1/me');
  });

  it('serialises query values and drops undefined and null', async () => {
    const fetcher = recordFetch(jsonResponse({}));
    const { client } = makeClient(fetcher);
    await client.get('/devices', {
      query: {
        limit: 100,
        enabled: true,
        disabled: false,
        name: 'core switch',
        omittedUndefined: undefined,
        omittedNull: null,
      },
    });

    expect(fetcher.only().query).toEqual({
      limit: '100',
      enabled: 'true',
      disabled: 'false',
      name: 'core switch',
    });
    expect(fetcher.only().url.searchParams.has('omittedUndefined')).toBe(false);
    expect(fetcher.only().url.searchParams.has('omittedNull')).toBe(false);
  });

  it('refuses to follow a redirect and always arms an abort signal', async () => {
    // `recordFetch` normalises headers and bodies, which loses `redirect` and
    // `signal`, so this one assertion uses a bare stub.
    const captured: RequestInit[] = [];
    const fetchImpl = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      captured.push(init ?? {});
      return Promise.resolve(jsonResponse({ ok: true }));
    }) as typeof fetch;

    await new LumicsClient(makeConfig(), { fetchImpl }).get('/me');

    // A followed redirect would carry the Authorization header to a host the
    // operator never configured.
    expect(captured[0]?.redirect).toBe('error');
    expect(captured[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['get', 'GET'],
    ['post', 'POST'],
    ['patch', 'PATCH'],
    ['put', 'PUT'],
    ['delete', 'DELETE'],
  ] as const)('%s issues an HTTP %s', async (method, expected) => {
    const fetcher = recordFetch(jsonResponse({}));
    const { client } = makeClient(fetcher);
    await client[method]('/devices');
    expect(fetcher.only().method).toBe(expected);
  });

  it('never puts the credential in the operation string used for errors', async () => {
    const fetcher = recordFetch(errorResponse(404));
    const { client } = makeClient(fetcher);
    const error = await captureApiError(client.get('/devices', { query: { limit: 1 } }));
    // `operation` is method plus path, never the full URL, because a URL can
    // carry a credential in its query string.
    expect(error.operation).toBe('GET /devices');
    expect(error.message).not.toContain('limit=1');
    expect(error.message).not.toContain(TEST_TOKEN);
  });
});

describe('response handling', () => {
  it('parses a JSON body', async () => {
    const fetcher = recordFetch(jsonResponse([{ id: 'a' }]));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).resolves.toEqual([{ id: 'a' }]);
  });

  it('returns null for 204 No Content', async () => {
    const fetcher = recordFetch(new Response(null, { status: 204 }));
    const { client } = makeClient(fetcher);
    await expect(client.delete('/devices/x')).resolves.toBeNull();
  });

  it('returns null for an empty 200 body', async () => {
    const fetcher = recordFetch(new Response('   ', { status: 200 }));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).resolves.toBeNull();
  });

  it('reports a non-JSON 200 body as invalid_response rather than guessing', async () => {
    const fetcher = recordFetch(
      new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const { client } = makeClient(fetcher);
    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('not valid JSON');
    expect(error.message).toContain('text/html');
  });
});

describe('retry policy', () => {
  it.each(RETRYABLE_STATUSES)(
    'retries HTTP %i on a GET and succeeds on the retry',
    async (status) => {
      const fetcher = recordFetch([errorResponse(status), jsonResponse({ ok: true })]);
      const { client, delays } = makeClient(fetcher);

      await expect(client.get('/devices')).resolves.toEqual({ ok: true });
      expect(fetcher.calls).toHaveLength(2);
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeGreaterThan(0);
    },
  );

  it('retries a network error on a GET, because a GET that never landed changed nothing', async () => {
    let attempt = 0;
    const fetcher = recordFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      }
      return jsonResponse({ ok: true });
    });
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).resolves.toEqual({ ok: true });
    expect(fetcher.calls).toHaveLength(2);
  });

  it('retries a timeout on a GET', async () => {
    let attempt = 0;
    const fetcher = recordFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      }
      return jsonResponse({ ok: true });
    });
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).resolves.toEqual({ ok: true });
    expect(fetcher.calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409])(
    'never retries HTTP %i, which would produce the identical result',
    async (status) => {
      const fetcher = recordFetch(errorResponse(status, 'nope'));
      const { client, delays } = makeClient(fetcher);

      await expect(client.get('/devices')).rejects.toBeInstanceOf(LumicsApiError);
      expect(fetcher.calls).toHaveLength(1);
      expect(delays).toHaveLength(0);
    },
  );

  it('never retries an undocumented 4xx either', async () => {
    const fetcher = recordFetch(errorResponse(418));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).rejects.toBeInstanceOf(LumicsApiError);
    expect(fetcher.calls).toHaveLength(1);
  });

  it('retries HTTP 423 Locked exactly once, then reports the lock', async () => {
    const fetcher = recordFetch(errorResponse(423));
    const { client } = makeClient(fetcher, { maxAttempts: 5 });

    const error = await captureApiError(client.get('/devices/x'));
    expect(error.code).toBe('locked');
    // One retry means two attempts, not five, even though the cap allows five.
    expect(fetcher.calls).toHaveLength(2);
    expect(error.message).toMatch(/already retried once/);
    expect(error.message).toMatch(/Report the lock to the user rather than looping/);
  });

  it('honours a Retry-After given in seconds', async () => {
    const fetcher = recordFetch([
      errorResponse(429, '', { 'retry-after': '3' }),
      jsonResponse({ ok: true }),
    ]);
    const { client, delays } = makeClient(fetcher);
    await client.get('/devices');
    expect(delays).toEqual([3_000]);
  });

  it('honours a Retry-After given as an HTTP date', async () => {
    const when = new Date(Date.now() + 4_000).toUTCString();
    const fetcher = recordFetch([
      errorResponse(429, '', { 'retry-after': when }),
      jsonResponse({ ok: true }),
    ]);
    const { client, delays } = makeClient(fetcher);
    await client.get('/devices');
    expect(delays[0]).toBeGreaterThan(2_000);
    expect(delays[0]).toBeLessThanOrEqual(4_000);
  });

  it('caps an absurd Retry-After rather than sleeping for an hour', async () => {
    const fetcher = recordFetch([
      errorResponse(429, '', { 'retry-after': '86400' }),
      jsonResponse({ ok: true }),
    ]);
    const { client, delays } = makeClient(fetcher);
    await client.get('/devices');
    expect(delays).toEqual([MAX_RETRY_AFTER_MS]);
  });

  it('falls back to computed backoff when Retry-After is unparseable', async () => {
    const fetcher = recordFetch([
      errorResponse(429, '', { 'retry-after': 'soon please' }),
      jsonResponse({ ok: true }),
    ]);
    const { client, delays } = makeClient(fetcher);
    await client.get('/devices');
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[0]).toBeLessThanOrEqual(DEFAULT_RETRY_MAX_DELAY_MS);
  });

  it('backoff grows between attempts and stays under the cap', async () => {
    const fetcher = recordFetch(errorResponse(429));
    const { client, delays } = makeClient(fetcher, { maxAttempts: 6 });
    await client.get('/devices').catch(() => undefined);

    expect(delays).toHaveLength(5);
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_MAX_DELAY_MS);
    }
    // Full jitter means only the trend is guaranteed, not each step.
    expect(delays.at(-1)).toBeGreaterThan(delays[0] as number);
  });

  it('stops at the attempt cap and reports the attempt count', async () => {
    const fetcher = recordFetch(errorResponse(429));
    const { client } = makeClient(fetcher);
    const error = await captureApiError(client.get('/devices'));

    expect(fetcher.calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    expect(error.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(error.code).toBe('rate_limited');
  });

  it('honours an explicit maxAttempts of 1: no retry at all', async () => {
    const fetcher = recordFetch(errorResponse(503));
    const { client, delays } = makeClient(fetcher, { maxAttempts: 1 });
    await expect(client.get('/devices')).rejects.toBeInstanceOf(LumicsApiError);
    expect(fetcher.calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it('clamps a nonsensical maxAttempts of 0 up to one attempt', async () => {
    const fetcher = recordFetch(jsonResponse({ ok: true }));
    const { client } = makeClient(fetcher, { maxAttempts: 0 });
    await expect(client.get('/devices')).resolves.toEqual({ ok: true });
    expect(fetcher.calls).toHaveLength(1);
  });
});

/**
 * The per-request attempt cap (`RequestOptions.maxAttempts`).
 *
 * It exists for one endpoint — spec §12.2 `/summarize`, which also carries the
 * per-request `timeoutMs` override — and the two multiply: without a cap, a
 * request granted a three-minute deadline and three attempts can consume nine
 * minutes before it reports anything, which from inside an MCP client is
 * indistinguishable from a hung server.
 *
 * The direction of the cap is the property that matters most here. It may only
 * *lower* the client-wide budget. A per-request option that could raise it would
 * be a way to multiply load on an API that documents 429 without documenting any
 * limit, and the concurrency gate would not save us — it bounds requests in
 * flight, not requests in total.
 */
describe('per-request attempt cap', () => {
  it('stops a retryable status after one attempt when the request caps itself at 1', async () => {
    const fetcher = recordFetch(errorResponse(503));
    const { client, delays } = makeClient(fetcher);

    const error = await captureApiError(client.get('/devices', { maxAttempts: 1 }));
    expect(fetcher.calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(error.attempts).toBe(1);
  });

  it('stops a timing-out GET after one attempt: the expensive case the cap is for', async () => {
    const fetcher = timeoutFetch();
    const { client, delays } = makeClient(fetcher);

    const error = await captureApiError(
      client.get('/metrics/summarize', { timeoutMs: 180_000, maxAttempts: 1 }),
    );
    expect(error.code).toBe('timeout');
    // One deadline's worth of waiting, not three. Without the cap this GET is
    // retryable and would have burned 3 x 180s before reporting anything.
    expect(fetcher.calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(error.attempts).toBe(1);
    expect(error.message).toContain('180000ms');
  });

  it('never raises the budget above the client-wide cap', async () => {
    const fetcher = recordFetch(errorResponse(503));
    const { client } = makeClient(fetcher, { maxAttempts: 2 });

    await expect(client.get('/devices', { maxAttempts: 10 })).rejects.toBeInstanceOf(
      LumicsApiError,
    );
    // Two, the client-wide budget — not the ten the request asked for.
    expect(fetcher.calls).toHaveLength(2);
  });

  it('clamps a nonsensical per-request cap of 0 up to one attempt', async () => {
    const fetcher = recordFetch(jsonResponse({ ok: true }));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices', { maxAttempts: 0 })).resolves.toEqual({ ok: true });
    expect(fetcher.calls).toHaveLength(1);
  });

  it('leaves a request that sets no cap on the client-wide budget', async () => {
    const fetcher = recordFetch(errorResponse(503));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).rejects.toBeInstanceOf(LumicsApiError);
    expect(fetcher.calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
  });

  it('still allows 423 Locked exactly one retry when the cap permits it', async () => {
    const fetcher = recordFetch(errorResponse(423));
    const { client } = makeClient(fetcher, { maxAttempts: 5 });

    const error = await captureApiError(client.get('/devices/x', { maxAttempts: 2 }));
    expect(error.code).toBe('locked');
    expect(fetcher.calls).toHaveLength(2);
  });
});

describe('retry safety for non-idempotent verbs', () => {
  it.each(['post', 'patch', 'delete'] as const)(
    'never retries a %s on a network error: the request may already have been applied',
    async (method) => {
      const fetcher = networkFailureFetch();
      const { client, delays } = makeClient(fetcher);

      const error = await captureApiError(client[method]('/devices', { body: { name: 'x' } }));
      expect(error.code).toBe('network_error');
      // Exactly one attempt. A second could create a duplicate device, or 404 on
      // a record the first attempt already deleted.
      expect(fetcher.calls).toHaveLength(1);
      expect(delays).toHaveLength(0);
      expect(error.attempts).toBe(1);
    },
  );

  it.each(['post', 'patch', 'delete'] as const)(
    'never retries a %s on a timeout',
    async (method) => {
      const fetcher = timeoutFetch();
      const { client } = makeClient(fetcher);

      const error = await captureApiError(client[method]('/devices', { body: { name: 'x' } }));
      expect(error.code).toBe('timeout');
      expect(fetcher.calls).toHaveLength(1);
    },
  );

  /**
   * The DELETE blocker, reproduced exactly as the reviewer found it.
   *
   * The connection drops *after* Lumics applied the delete. The old retry policy
   * treated DELETE as idempotent and replayed it; the second attempt found
   * nothing and answered 404, and 404 is not retryable, so `not_found` was the
   * error that surfaced — "Lumics has no such resource" reported for a record
   * this server had just successfully deleted. A completed destructive action
   * described as never having happened is the exact inversion this codebase is
   * organised against, and `factory.ts` already states the position: destructive
   * tools carry `idempotentHint: false` because "the second call 404s rather
   * than reproducing the first result".
   */
  it('does not turn a dropped DELETE into a 404 by replaying it', async () => {
    const fetcher = recordFetch((_call, attempt) => {
      if (attempt === 1) {
        // Lumics applied the delete; the response never made it back.
        throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      }
      return errorResponse(404);
    });
    const { client } = makeClient(fetcher);

    const error = await captureApiError(client.delete('/companies/c/devices/d'));

    expect(fetcher.calls).toHaveLength(1);
    expect(error.code).toBe('network_error');
    expect(error.code).not.toBe('not_found');
    expect(error.status).toBeUndefined();
    expect(error.message).not.toContain('Lumics has no such resource');
    // And it says what to do about a delete whose outcome is unknown.
    expect(error.message).toMatch(/may already have been applied/);
  });

  it('does retry a POST on HTTP 429, because the server answered and did not act', async () => {
    const fetcher = recordFetch([errorResponse(429), jsonResponse({ ok: true })]);
    const { client } = makeClient(fetcher);
    await expect(client.post('/devices', { body: { name: 'x' } })).resolves.toEqual({ ok: true });
    expect(fetcher.calls).toHaveLength(2);
  });

  it('does retry a DELETE on HTTP 429: a status proves the server answered and did not act', async () => {
    const fetcher = recordFetch([errorResponse(429), jsonResponse({ deleted: { id: 'a' } })]);
    const { client } = makeClient(fetcher);
    await expect(client.delete('/devices/x')).resolves.toEqual({ deleted: { id: 'a' } });
    expect(fetcher.calls).toHaveLength(2);
  });

  it.each(['get', 'put'] as const)(
    'does retry a %s on a network error: replaying it cannot change the outcome',
    async (method) => {
      // PUT stays here deliberately. The only PUT this server issues sets
      // `lastDiscovery` to an absolute value (spec §7.4), so replaying it writes
      // the same timestamp — unlike a DELETE, whose replay 404s.
      const fetcher = networkFailureFetch();
      const { client } = makeClient(fetcher);
      await expect(client[method]('/devices/x')).rejects.toBeInstanceOf(LumicsApiError);
      expect(fetcher.calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    },
  );
});

describe('concurrency gate', () => {
  it('never runs more than maxConcurrency requests at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher = recordFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    });
    const { client } = makeClient(fetcher, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/devices')));
    expect(fetcher.calls).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases its permit when a request fails, so the gate cannot deadlock', async () => {
    const fetcher = recordFetch(errorResponse(400));
    const { client } = makeClient(fetcher, { maxConcurrency: 1 });

    await Promise.all(
      Array.from({ length: 3 }, () => client.get('/devices').catch(() => undefined)),
    );
    expect(fetcher.calls).toHaveLength(3);
  });
});

describe('envelope unwrapping (spec section 4.2)', () => {
  it('unwrapUpdated returns the inner value', () => {
    expect(unwrapUpdated({ updated: { id: 'a' } }, 'PATCH x')).toEqual({ id: 'a' });
  });

  it('unwrapUpdatedArray handles the batch shape, where the envelope holds an array', () => {
    expect(unwrapUpdatedArray({ updated: [{ id: 'a' }, { id: 'b' }] }, 'PATCH batch')).toHaveLength(
      2,
    );
    // An empty array is a real answer here — "none of your ids matched" — and is
    // not the same as an absent or non-array envelope.
    expect(unwrapUpdatedArray({ updated: [] }, 'PATCH batch')).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a single record', { id: 'a' }],
  ])('unwrapUpdatedArray rejects a batch envelope holding %s', (_label, inner) => {
    const error = (() => {
      try {
        unwrapUpdatedArray({ updated: inner }, 'PATCH batch');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toContain('an array of the records it changed');
  });

  it.each([
    ['a bare object', { id: 'a' }],
    ['null', null],
    ['an array', [{ id: 'a' }]],
    ['the deleted envelope', { deleted: { id: 'a' } }],
  ])('unwrapUpdated rejects %s as documented drift', (_label, response) => {
    const error = (() => {
      try {
        unwrapUpdated(response, 'PATCH x');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toContain('"updated" envelope');
  });

  it('unwrapDeleted returns the inner value and rejects anything else', () => {
    expect(unwrapDeleted({ deleted: { id: 'a' } }, 'DELETE x')).toEqual({ id: 'a' });
    expect(() => unwrapDeleted({ updated: { id: 'a' } }, 'DELETE x')).toThrow(/"deleted" envelope/);
  });

  /**
   * Finding H3. The envelope *key* was validated but never its contents, so
   * `{updated: null}` and `{deleted: null}` unwrapped to `null` and were returned
   * as a successful result whose whole payload was the literal text `null` —
   * under a note stating as fact that the record had been updated or permanently
   * deleted. `expectObject` exists to close exactly this hole on the read path;
   * leaving it open on the write path let a write make a stronger claim from the
   * identical body shape than a read is allowed to make.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'gone'],
    ['a number', 0],
    ['an array', [{ id: 'a' }]],
  ])('unwrapUpdated rejects an envelope holding %s rather than passing it through', (_l, inner) => {
    const error = (() => {
      try {
        unwrapUpdated({ updated: inner }, 'PATCH device x');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    expect(error?.code).toBe('invalid_response');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'gone'],
    // A single delete documents `{deleted: {...}}` (spec §4.2). An array here is
    // drift, and it was previously rendered under the singular "the device below
    // has been permanently deleted" note.
    ['an array', [{ id: 'a' }]],
  ])('unwrapDeleted rejects an envelope holding %s rather than passing it through', (_l, inner) => {
    const error = (() => {
      try {
        unwrapDeleted({ deleted: inner }, 'DELETE device x');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    expect(error?.code).toBe('invalid_response');
  });

  it('an empty envelope is not reported as "the record does not exist"', () => {
    const error = (() => {
      try {
        unwrapDeleted({ deleted: null }, 'DELETE device x');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    // The same distinction `expectObject` draws on a read: a missing record is a
    // documented 404, not an empty 200.
    expect(error?.message).toContain('This is not the same as "the record does not exist"');
    // And the write may well have landed, so the model is told to go and look
    // rather than to report a failure or replay the call.
    expect(error?.message).toMatch(/may already have been applied/);
  });

  it('expectArray passes a bare array through', () => {
    const array = [{ id: 'a' }];
    expect(expectArray(array, 'GET x')).toBe(array);
  });

  it('expectArray treats an absent body as an empty list', () => {
    expect(expectArray(null, 'GET x')).toEqual([]);
    expect(expectArray(undefined, 'GET x')).toEqual([]);
  });

  it.each([
    // Finding L1: `describeJsonKind` used to render `a ${typeof value}`, so an
    // object read as "a object". A model reads this sentence.
    ['an object', { id: 'a' }, 'an object'],
    ['a string', 'nope', 'a string'],
    ['a number', 7, 'a number'],
  ])('expectArray surfaces %s as drift rather than wrapping it', (_label, response, described) => {
    const error = (() => {
      try {
        expectArray(response, 'GET devices');
        return undefined;
      } catch (thrown) {
        return thrown as LumicsApiError;
      }
    })();
    expect(error?.code).toBe('invalid_response');
    expect(error?.message).toContain(`the body was ${described}`);
  });

  it('expectObject passes an object through', () => {
    const object = { id: 'a' };
    expect(expectObject(object, 'GET device')).toBe(object);
  });

  it.each([[null], [undefined]])(
    'expectObject raises invalid_response for an absent body (%s), never returns data',
    (response) => {
      const error = (() => {
        try {
          expectObject(response, 'GET device');
          return undefined;
        } catch (thrown) {
          return thrown as LumicsApiError;
        }
      })();
      expect(error?.code).toBe('invalid_response');
      // A single read has no reading under which "no body" means "no record":
      // a missing record is a documented 404 (spec section 3).
      expect(error?.message).toContain('carried no body at all');
      expect(error?.message).toContain('404');
    },
  );

  it.each([
    [[{ id: 'a' }], 'an array'],
    ['nope', 'a string'],
    [7, 'a number'],
  ])('expectObject surfaces %j as drift', (response, described) => {
    expect(() => expectObject(response, 'GET device')).toThrow(`the body was ${described}`);
  });

  it('isAbsentBody is true only for the null the client returns for a 204 or empty 200', () => {
    expect(isAbsentBody(null)).toBe(true);
    expect(isAbsentBody(undefined)).toBe(true);
    // A present-but-empty payload is a real answer, not an absent body — the
    // distinction the metric tools depend on to avoid calling a device silent.
    expect(isAbsentBody([])).toBe(false);
    expect(isAbsentBody({})).toBe(false);
    expect(isAbsentBody({ data: [] })).toBe(false);
    expect(isAbsentBody(0)).toBe(false);
    expect(isAbsentBody('')).toBe(false);
  });

  it('absentBodyNotes discloses a body-less list, and stays silent otherwise', () => {
    expect(absentBodyNotes(null)).toEqual([ABSENT_BODY_LIST_NOTE]);
    expect(absentBodyNotes(undefined)).toEqual([ABSENT_BODY_LIST_NOTE]);
    expect(absentBodyNotes([])).toEqual([]);
    expect(absentBodyNotes([{ id: 'a' }])).toEqual([]);
  });

  it('the absent-body note distinguishes "no body" from "the collection is empty"', () => {
    expect(ABSENT_BODY_LIST_NOTE).toContain('no response body at all');
    expect(ABSENT_BODY_LIST_NOTE).toContain('the collection is empty');
    expect(ABSENT_BODY_LIST_NOTE).toMatch(/do NOT tell the user/i);
    // No fabricated pagination, even here (spec section 4.3).
    expect(ABSENT_BODY_LIST_NOTE).not.toMatch(/offset|has_more|next_offset|cursor/);
  });
});

describe('edge cases on the transport path', () => {
  it('defaults fetchImpl to the global fetch when none is injected', () => {
    // Constructed only — nothing is requested, so no socket is opened.
    expect(() => new LumicsClient(makeConfig())).not.toThrow();
  });

  it('uses a real timer when no sleep is injected', async () => {
    const fetcher = recordFetch([errorResponse(429), jsonResponse({ ok: true })]);
    const client = new LumicsClient(makeConfig(), { fetchImpl: fetcher.fetchImpl, maxAttempts: 2 });

    const started = Date.now();
    await expect(client.get('/devices')).resolves.toEqual({ ok: true });
    // Full jitter means at least half the base delay elapsed.
    expect(Date.now() - started).toBeGreaterThan(100);
    expect(fetcher.calls).toHaveLength(2);
  }, 15_000);

  it('gives up on 423 at the attempt cap rather than looping past it', async () => {
    const fetcher = recordFetch(errorResponse(423));
    const { client } = makeClient(fetcher, { maxAttempts: 1 });

    const error = await captureApiError(client.patch('/devices/x', { body: {} }));
    expect(error.code).toBe('locked');
    expect(fetcher.calls).toHaveLength(1);
  });

  it.each([
    ['a bare string', 'a bare string reason'],
    ['null', null],
    ['a plain object with no name', { detail: 'nope' }],
  ])('treats %s thrown by fetch as a network failure, not a timeout', async (_label, reason) => {
    // `isAbortLike` name-checks rather than using instanceof, so a rejection
    // that is not an object at all must not be mistaken for an abort.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is a non-Error rejection
    const fetcher = recordFetch(() => Promise.reject(reason));
    const { client } = makeClient(fetcher, { maxAttempts: 1 });

    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('network_error');
  });

  it('reports content-type as "unknown" when a non-JSON 200 carries no header', async () => {
    // `new Response('...')` always sets text/plain, so the header has to be
    // genuinely absent for this branch.
    const headerless = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve('not json'),
    } as unknown as Response;

    const fetcher = recordFetch(() => headerless);
    const { client } = makeClient(fetcher);
    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('content-type "unknown"');
  });

  /**
   * A 200 whose body stream fails partway through — a mid-stream reset, or the
   * abort signal firing while the body is still arriving.
   *
   * This used to be `.catch(() => '')`, which is indistinguishable from a
   * zero-byte body, so the call resolved with `null`, `expectArray` turned that
   * into `[]`, and `lumics_list_devices` reported a tenant with no devices as a
   * successful, non-error, complete answer. Because it classified as success it
   * was also never retried, even on a GET.
   */
  function unreadableSuccess(): Response {
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.reject(new Error('terminated: aborted')),
    } as unknown as Response;
  }

  it('reports a failed body read as a transport failure, never as an empty success', async () => {
    const fetcher = recordFetch(() => unreadableSuccess());
    const { client } = makeClient(fetcher, { maxAttempts: 1 });

    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
    // The message has to say why a partial body is not an empty one, because the
    // whole failure mode is that a short answer looks like a complete one.
    expect(error.message).toContain('did not arrive completely');
    expect(error.message).toContain('truncated');
  });

  it('retries a failed body read on a GET, because a read that failed changed nothing', async () => {
    let attempt = 0;
    const fetcher = recordFetch(() => {
      attempt += 1;
      return attempt === 1 ? unreadableSuccess() : jsonResponse([{ id: 'a' }]);
    });
    const { client } = makeClient(fetcher);

    await expect(client.get('/devices')).resolves.toEqual([{ id: 'a' }]);
    expect(fetcher.calls).toHaveLength(2);
  });

  it('never retries a failed body read on a POST, whose effect may already have landed', async () => {
    const fetcher = recordFetch(() => unreadableSuccess());
    const { client } = makeClient(fetcher);

    const error = await captureApiError(client.post('/devices', { body: { name: 'x' } }));
    expect(error.code).toBe('network_error');
    expect(fetcher.calls).toHaveLength(1);
  });

  it('reports a body read aborted by the timeout as a timeout, not a bare network error', async () => {
    const aborted = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      },
    } as unknown as Response;

    const fetcher = recordFetch(() => aborted);
    const { client } = makeClient(fetcher, { maxAttempts: 1 });
    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('timeout');
  });

  it('still treats a genuinely empty 200 body as null', async () => {
    // The distinction that matters: no bytes is a documented shape, a failed read
    // is not.
    const fetcher = recordFetch(() => new Response('', { status: 200 }));
    const { client } = makeClient(fetcher);
    await expect(client.get('/devices')).resolves.toBeNull();
  });

  it('treats an unreadable ERROR body as having no snippet', async () => {
    const unreadable = {
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream error')),
    } as unknown as Response;

    const fetcher = recordFetch(() => unreadable);
    const { client } = makeClient(fetcher, { maxAttempts: 1 });
    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('server_error');
    expect(error.bodySnippet).toBeUndefined();
  });

  it('unwrapUpdated rejects a primitive body', () => {
    expect(() => unwrapUpdated('nope', 'PATCH x')).toThrow(/"updated" envelope/);
    expect(() => unwrapDeleted(7, 'DELETE x')).toThrow(/"deleted" envelope/);
  });
});

describe('timeout enforcement', () => {
  it('aborts a hanging request at the configured budget and reports it as a timeout', async () => {
    // A fetch that only settles when its signal aborts is how the real timeout
    // presents: `AbortSignal.timeout()` fires and the promise rejects.
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        });
      })) as typeof fetch;

    const client = new LumicsClient(makeConfig({ timeoutMs: 1_000 }), {
      fetchImpl,
      sleep: () => Promise.resolve(),
      maxAttempts: 1,
    });

    const error = await captureApiError(client.get('/devices'));
    expect(error.code).toBe('timeout');
    expect(error.message).toContain('timed out after 1000ms');
  }, 10_000);

  /**
   * Live finding 5. spec §12.2 `/summarize` was measured taking over 90 seconds
   * without returning, against one to two seconds for every other metric
   * endpoint, so under the shared 30-second default `lumics_summarize_company_metrics`
   * could not succeed at all. The fix is a per-request override rather than a
   * larger global default, because a larger global default would make every other
   * tool wait three minutes to discover an unreachable host.
   */
  describe('per-request timeout override (live finding 5)', () => {
    /** Capture the deadline `AbortSignal.timeout()` was actually given. */
    function timeoutSpy(): { readonly restore: () => void; readonly deadlines: number[] } {
      const deadlines: number[] = [];
      const original = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = (ms: number) => {
        deadlines.push(ms);
        return original(ms);
      };
      return { restore: () => (AbortSignal.timeout = original), deadlines };
    }

    it('uses the configured timeout when no override is supplied', async () => {
      const spy = timeoutSpy();
      try {
        const client = new LumicsClient(makeConfig({ timeoutMs: 5_000 }), {
          fetchImpl: recordFetch(jsonResponse([])).fetchImpl,
        });
        await client.get('/devices');
        expect(spy.deadlines).toEqual([5_000]);
      } finally {
        spy.restore();
      }
    });

    it('honours a longer per-request timeout', async () => {
      const spy = timeoutSpy();
      try {
        const client = new LumicsClient(makeConfig({ timeoutMs: 5_000 }), {
          fetchImpl: recordFetch(jsonResponse([])).fetchImpl,
        });
        await client.get('/metrics', { timeoutMs: 180_000 });
        expect(spy.deadlines).toEqual([180_000]);
      } finally {
        spy.restore();
      }
    });

    it('reports the deadline that actually applied, not the configured one', async () => {
      const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            reject(error);
          });
        })) as typeof fetch;

      const client = new LumicsClient(makeConfig({ timeoutMs: 30_000 }), {
        fetchImpl,
        sleep: () => Promise.resolve(),
        maxAttempts: 1,
      });

      const error = await captureApiError(client.get('/metrics', { timeoutMs: 50 }));
      expect(error.code).toBe('timeout');
      // The message a model reads must name the budget this request had, or the
      // advice it gives ("raise LUMICS_TIMEOUT_MS") is about the wrong number.
      expect(error.message).toContain('timed out after 50ms');
      expect(error.message).not.toContain('30000ms');
    }, 10_000);
  });
});
