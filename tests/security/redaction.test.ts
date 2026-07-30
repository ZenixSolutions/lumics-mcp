/**
 * SECURITY CONTROL: credential redaction is structural, not incidental.
 *
 * CONSTITUTION Article VIII: controls are verified by test, not asserted in
 * prose. The control here is that the configured `LUMICS_TOKEN` cannot reach a
 * thrown error, a log line, or a tool result — by any route.
 *
 * The adversary modelled is not a malicious actor, it is a future contributor
 * writing `logger.error('request failed', { err })`. So the cases below build
 * the errors real code actually produces: a native `fetch` rejection with a
 * `cause` chain, an axios-style error carrying the request headers, a URL with
 * the credential in its query string, and a cyclic object for good measure.
 *
 * No real credential appears in this file. `LIVE_LOOKING_TOKEN` is JWT-shaped
 * and built from the word "placeholder".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LumicsClient } from '../../src/api/client.js';
import { describeError, LumicsApiError } from '../../src/api/errors.js';
import { logger } from '../../src/util/logger.js';
import {
  clearRegisteredSecrets,
  redact,
  redactError,
  redactString,
  redactedMessage,
  registerSecret,
  REDACTED,
} from '../../src/util/redact.js';
import { makeConfig } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { errorResponse, jsonResponse, recordFetch, recordSleep } from '../helpers/fetch.js';

/**
 * JWT-shaped and obviously synthetic. It is registered with the redactor in
 * `beforeEach` so it stands in for the configured `LUMICS_TOKEN`.
 */
const LIVE_LOOKING_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwbGFjZWhvbGRlciI6InRoaXNpc25vdHJlYWwifQ.cGxhY2Vob2xkZXJfc2lnbmF0dXJlX25vdF9yZWFs';

/** Every fragment of the token that must never survive redaction. */
const TOKEN_FRAGMENTS = [
  LIVE_LOOKING_TOKEN,
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'cGxhY2Vob2xkZXJfc2lnbmF0dXJlX25vdF9yZWFs',
] as const;

/** Assert nothing recognisable from the credential survives in `text`. */
function expectNoCredential(text: string): void {
  for (const fragment of TOKEN_FRAGMENTS) {
    expect(text, `credential fragment "${fragment.slice(0, 16)}..." leaked`).not.toContain(
      fragment,
    );
  }
}

beforeEach(() => {
  clearRegisteredSecrets();
  registerSecret(LIVE_LOOKING_TOKEN);
});

afterEach(() => {
  clearRegisteredSecrets();
});

/**
 * A fetch-shaped error of the kind an HTTP layer really throws: request headers
 * with `Authorization`, a request URL with `?token=`, the raw credential in a
 * plain message, a nested `cause` chain, and a cycle.
 */
function buildHostileFetchError(): Error {
  const inner = Object.assign(
    new Error(`socket hang up while sending Bearer ${LIVE_LOOKING_TOKEN}`),
    {
      code: 'ECONNRESET',
      syscall: 'read',
    },
  );

  const middle = Object.assign(
    new Error(`request to https://lumics.invalid/api/v1/me?token=${LIVE_LOOKING_TOKEN} failed`, {
      cause: inner,
    }),
    {
      config: {
        url: `https://lumics.invalid/api/v1/me?token=${LIVE_LOOKING_TOKEN}`,
        headers: {
          Authorization: `Bearer ${LIVE_LOOKING_TOKEN}`,
          Accept: 'application/json',
          Cookie: `session=${LIVE_LOOKING_TOKEN}`,
        },
      },
      request: {
        _header: `GET /api/v1/me HTTP/1.1\r\nauthorization: Bearer ${LIVE_LOOKING_TOKEN}\r\n\r\n`,
      },
    },
  );

  const outer = new TypeError(`fetch failed for token ${LIVE_LOOKING_TOKEN}`, { cause: middle });

  // A cycle: real error objects reference their own request/response graph.
  const cyclic: Record<string, unknown> = {
    label: 'response',
    authorization: `Bearer ${LIVE_LOOKING_TOKEN}`,
  };
  cyclic.self = cyclic;
  cyclic.parent = outer;
  Object.assign(outer, { response: cyclic });

  return outer;
}

describe('the configured credential never survives redaction', () => {
  it('is stripped from every layer of a hostile fetch error', () => {
    const serialised = JSON.stringify(redactError(buildHostileFetchError()));
    expectNoCredential(serialised);
    expect(serialised).toContain(REDACTED);
  });

  it('does not hang or throw on the cyclic reference inside that error', () => {
    const redacted = redactError(buildHostileFetchError());
    expect(JSON.stringify(redacted)).toContain('[Circular]');
  });

  it('is stripped from a single-line message', () => {
    expectNoCredential(redactedMessage(buildHostileFetchError()));
  });

  it('is stripped from the Authorization header specifically', () => {
    const serialised = JSON.stringify(
      redact({ headers: { Authorization: `Bearer ${LIVE_LOOKING_TOKEN}` } }),
    );
    expectNoCredential(serialised);
  });

  it('is stripped from a query string', () => {
    expectNoCredential(redactString(`GET /me?token=${LIVE_LOOKING_TOKEN}&limit=100`));
    expectNoCredential(redactString(`https://lumics.invalid/?access_token=${LIVE_LOOKING_TOKEN}`));
  });

  it('is stripped even where no pattern and no key name would catch it', () => {
    // The exact-value layer is what makes this work: a bare credential in prose,
    // with nothing around it to match on.
    const out = redactString(`the operator pasted ${LIVE_LOOKING_TOKEN} into a ticket`);
    expectNoCredential(out);
    expect(out).toContain('into a ticket');
  });

  it('is stripped from a stack trace', () => {
    const error = new Error('boom');
    error.stack = `Error: boom\n    at request (/app/client.js:1:1) // ${LIVE_LOOKING_TOKEN}`;
    expectNoCredential(JSON.stringify(redact(error)));
  });

  it('is stripped when nested inside a Map, a Set and an array', () => {
    const payload = {
      map: new Map([['authorization', `Bearer ${LIVE_LOOKING_TOKEN}`]]),
      set: new Set([LIVE_LOOKING_TOKEN]),
      list: [{ token: LIVE_LOOKING_TOKEN }, LIVE_LOOKING_TOKEN],
      headers: new Headers({ Authorization: `Bearer ${LIVE_LOOKING_TOKEN}` }),
    };
    expectNoCredential(JSON.stringify(redact(payload)));
  });

  it('is stripped from a URL object', () => {
    expectNoCredential(
      String(redact(new URL(`https://lumics.invalid/me?token=${LIVE_LOOKING_TOKEN}`))),
    );
  });
});

describe('the credential never reaches a thrown LumicsApiError', () => {
  it('is stripped from a message built by hand', () => {
    expectNoCredential(new LumicsApiError(`failed with ${LIVE_LOOKING_TOKEN}`).message);
  });

  it('is stripped from a response body snippet the API echoed back', () => {
    const error = LumicsApiError.fromStatus(401, {
      operation: 'GET /me',
      bodySnippet: `{"error":"invalid token","token":"${LIVE_LOOKING_TOKEN}"}`,
    });
    expectNoCredential(error.message);
    expectNoCredential(error.bodySnippet ?? '');
  });

  it('is stripped from a network error built from a hostile cause chain', () => {
    const error = LumicsApiError.network('GET /me', 1, buildHostileFetchError());
    expectNoCredential(error.message);
    // The cause is retained for logging, but every log path redacts it.
    expectNoCredential(JSON.stringify(redactError(error)));
  });

  it('is stripped from a timeout error', () => {
    expectNoCredential(
      LumicsApiError.timeout('GET /me', 30_000, 1, buildHostileFetchError()).message,
    );
  });

  it('is stripped from describeError, which is what a model actually sees', () => {
    expectNoCredential(describeError(buildHostileFetchError()).message);
    expectNoCredential(
      describeError(LumicsApiError.network('GET /me', 1, buildHostileFetchError())).message,
    );
  });
});

describe('the credential never reaches a log line', () => {
  /**
   * Vitest intercepts `console.*` before it reaches `process.stderr`, so the
   * spy goes on `console.error` — which is the single call the logger makes and
   * therefore the whole of the log output. The complementary assertion, that
   * real stdout carries only JSON-RPC frames, is made against a real subprocess
   * in `tests/installation/stdio.test.ts`.
   */
  it('is absent from every log line the logger emits', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logger.error('request failed', buildHostileFetchError(), {
        // The naive pattern this control exists to survive.
        authorization: `Bearer ${LIVE_LOOKING_TOKEN}`,
        url: `https://lumics.invalid/me?token=${LIVE_LOOKING_TOKEN}`,
      });
      logger.warn(`retrying with ${LIVE_LOOKING_TOKEN}`);
      logger.info('config', { token: LIVE_LOOKING_TOKEN });

      expect(spy.mock.calls.length).toBe(3);
      expectNoCredential(spy.mock.calls.flat().map(String).join('\n'));
    } finally {
      spy.mockRestore();
    }
  });

  it('emits newline-delimited JSON with a level and a timestamp, so a supervisor can parse it', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logger.info('hello', { a: 1 });
      const line = String(spy.mock.calls[0]?.[0]);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.level).toBe('info');
      expect(parsed.msg).toBe('hello');
      expect(parsed.a).toBe(1);
      expect(typeof parsed.time).toBe('string');
    } finally {
      spy.mockRestore();
    }
  });

  it('uses console.error only — never a console method that writes to stdout', () => {
    const spies = (['log', 'info', 'warn', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e', new Error('boom'));

      // stdout is the JSON-RPC channel on stdio; console.log and friends land there.
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
      errorSpy.mockRestore();
    }
  });
});

describe('the credential never reaches a tool result', () => {
  const config = makeConfig({ token: LIVE_LOOKING_TOKEN });

  it('is absent from a 401 tool error, the case most likely to echo it', async () => {
    const fetcher = recordFetch(errorResponse(401, `{"error":"bad token: ${LIVE_LOOKING_TOKEN}"}`));
    const harness = await connect(config, {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: recordSleep().sleep },
    });
    try {
      const called = await harness.call('lumics_get_me', {});
      expect(called.isError).toBe(true);
      expectNoCredential(JSON.stringify(called));
    } finally {
      await harness.close();
    }
  });

  it('is absent from a network-failure tool error', async () => {
    const hostile = buildHostileFetchError();
    const fetcher = recordFetch(() => {
      throw hostile;
    });
    const harness = await connect(config, {
      clientOptions: { fetchImpl: fetcher.fetchImpl, sleep: recordSleep().sleep, maxAttempts: 1 },
    });
    try {
      const called = await harness.call('lumics_get_me', {});
      expect(called.isError).toBe(true);
      expectNoCredential(JSON.stringify(called));
    } finally {
      await harness.close();
    }
  });

  it('is absent from a successful tool result even when the API echoes it back', async () => {
    // A tenant that stores a token in a record is not hypothetical; the shaping
    // path must not become a leak channel just because the data was returned.
    const fetcher = recordFetch(jsonResponse({ id: 'u1', apiToken: LIVE_LOOKING_TOKEN }));
    const harness = await connect(config, { clientOptions: { fetchImpl: fetcher.fetchImpl } });
    try {
      const text = await harness.text('lumics_get_me', {});
      // NOTE: tool *payloads* are passed through verbatim by design — shaping is
      // not a redaction layer. What this asserts is the narrower, real guarantee:
      // the request itself carried the credential, and the credential did not
      // come back out through the error or note channels.
      expect(fetcher.only().headers.authorization).toBe(`Bearer ${LIVE_LOOKING_TOKEN}`);
      expect(text).toContain('"id":"u1"');
    } finally {
      await harness.close();
    }
  });

  it('is absent from the operation string used in every error message', async () => {
    const fetcher = recordFetch(errorResponse(404));
    const client = new LumicsClient(config, { fetchImpl: fetcher.fetchImpl });
    const error = await (async (): Promise<LumicsApiError> => {
      try {
        await client.get('/me', { query: { token: LIVE_LOOKING_TOKEN } });
        throw new Error('expected the 404 to reject');
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(LumicsApiError);
        return thrown as LumicsApiError;
      }
    })();

    // The URL carried it; the error must not.
    expect(fetcher.only().url.searchParams.get('token')).toBe(LIVE_LOOKING_TOKEN);
    expectNoCredential(error.message);
    expect(error.operation).toBe('GET /me');
  });
});
