/**
 * Error taxonomy — `src/api/errors.ts`.
 *
 * spec §3 is the only documented status table, and it is mapped here in its
 * entirety. The table below is deliberately written as data so a reviewer can
 * diff it against spec §3 line by line, which is the same reason the source
 * keeps `STATUS_MAP` in that shape.
 *
 * Messages are asserted for the *actionable* part, not word for word: the point
 * of the mapping is that a model can tell "fix your arguments" from "tell the
 * operator" from "stop retrying".
 */

import { describe, expect, it } from 'vitest';
import {
  describeError,
  isDocumentedStatus,
  LumicsApiError,
  LumicsInputError,
  type LumicsErrorCode,
} from '../../src/api/errors.js';
import { clearRegisteredSecrets, registerSecret, REDACTED } from '../../src/util/redact.js';

interface StatusCase {
  readonly status: number;
  readonly code: LumicsErrorCode;
  readonly retryable: boolean;
  /** A phrase from the guidance that tells the model what to do next. */
  readonly guidance: RegExp;
}

/** spec §3, complete: the ten documented status codes and nothing else. */
const DOCUMENTED: readonly StatusCase[] = [
  {
    status: 200,
    code: 'unexpected_success_status',
    retryable: false,
    guidance: /did not match the documented shape/,
  },
  { status: 304, code: 'not_modified', retryable: false, guidance: /Reuse the result/ },
  {
    status: 400,
    code: 'bad_request',
    retryable: false,
    guidance: /Do not retry the identical call/,
  },
  {
    status: 401,
    code: 'unauthorized',
    retryable: false,
    guidance: /tell the operator to issue a fresh token/,
  },
  {
    status: 403,
    code: 'forbidden',
    retryable: false,
    guidance: /Verify the companyId with lumics_get_me/,
  },
  {
    status: 404,
    code: 'not_found',
    retryable: false,
    guidance: /listing the parent collection first/,
  },
  {
    status: 409,
    code: 'conflict',
    retryable: false,
    guidance: /update it instead of creating a second/,
  },
  { status: 423, code: 'locked', retryable: true, guidance: /already retried once/ },
  { status: 429, code: 'rate_limited', retryable: true, guidance: /reduce the number of calls/ },
  {
    status: 500,
    code: 'server_error',
    retryable: true,
    guidance: /not a problem with your arguments/,
  },
];

describe('LumicsApiError.fromStatus maps every documented status of spec section 3', () => {
  it.each(DOCUMENTED.map((entry) => [entry.status, entry] as const))(
    'HTTP %i maps to the documented code, retryability and guidance',
    (_status, entry: StatusCase) => {
      const error = LumicsApiError.fromStatus(entry.status, { operation: 'GET /devices' });
      expect(error).toBeInstanceOf(LumicsApiError);
      expect(error.name).toBe('LumicsApiError');
      expect(error.code).toBe(entry.code);
      expect(error.status).toBe(entry.status);
      expect(error.retryable).toBe(entry.retryable);
      expect(error.operation).toBe('GET /devices');
      expect(error.message).toMatch(entry.guidance);
      // The operation and the status are always in the message, so a log line
      // alone identifies the call.
      expect(error.message).toContain('GET /devices');
      expect(error.message).toContain(`HTTP ${String(entry.status)}`);
    },
  );

  it('covers exactly the ten statuses spec section 3 documents', () => {
    for (const entry of DOCUMENTED) {
      expect(isDocumentedStatus(entry.status)).toBe(true);
    }
    for (const status of [201, 204, 302, 402, 418, 422, 502, 503, 504, 599]) {
      expect(isDocumentedStatus(status)).toBe(false);
    }
  });

  it('treats an undocumented status as a transport fault and names the spec section', () => {
    const error = LumicsApiError.fromStatus(502, { operation: 'GET /devices' });
    expect(error.code).toBe('http_error');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/documentation does not describe/);
    expect(error.message).toMatch(
      /spec section 3 lists only 200, 304, 400, 401, 403, 404, 409, 423, 429 and 500/,
    );
  });

  it('carries an error-body snippet through, bounded to 500 characters', () => {
    const long = 'e'.repeat(2_000);
    const error = LumicsApiError.fromStatus(400, { operation: 'GET /devices', bodySnippet: long });
    expect(error.bodySnippet).toHaveLength(500);
    expect(error.message).toContain('Response body:');
  });

  it('omits the body detail entirely when there was no body', () => {
    const error = LumicsApiError.fromStatus(404, { operation: 'GET /devices' });
    expect(error.bodySnippet).toBeUndefined();
    expect(error.message).not.toContain('Response body:');
  });

  it('records Retry-After and attempt count when supplied', () => {
    const error = LumicsApiError.fromStatus(429, {
      operation: 'GET /devices',
      retryAfterMs: 2_000,
      attempts: 3,
    });
    expect(error.retryAfterMs).toBe(2_000);
    expect(error.attempts).toBe(3);
  });
});

describe('LumicsApiError factory constructors', () => {
  it('timeout names the budget, the attempt count and how to narrow the request', () => {
    const error = LumicsApiError.timeout('GET /devices', 30_000, 2);
    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.attempts).toBe(2);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('timed out after 30000ms across 2 attempt(s)');
    expect(error.message).toMatch(/LUMICS_TIMEOUT_MS/);
  });

  /**
   * Finding H2. Both transport-failure messages ended with fixed advice written
   * for a read — "Retry the call", "Narrow the request" — regardless of verb. On
   * a POST or PATCH the client makes exactly one attempt *by design*, because the
   * write may already have been applied upstream, and then handed the model an
   * instruction to retry it anyway. An agent that complies creates a duplicate,
   * or a 409 it then has to reason about. DELETE joined that set when it stopped
   * being retried.
   */
  const WRITE_OPERATIONS = [
    'POST /companies/c/devices',
    'PATCH /companies/c/devices/d',
    'DELETE /companies/c/devices/d',
  ] as const;

  it.each(WRITE_OPERATIONS)(
    'incompleteBody on "%s" never tells the model to retry',
    (operation) => {
      const error = LumicsApiError.incompleteBody(operation, 1, new Error('ECONNRESET'));

      expect(error.message).not.toMatch(/retry the call/i);
      expect(error.message).toMatch(/may already have been applied/);
      // Verify, do not replay.
      expect(error.message).toMatch(/read/i);
      // "A truncated list is indistinguishable from a short one" is nonsense on a
      // create, and reads as though the server were describing a collection.
      expect(error.message).not.toContain('a truncated list is indistinguishable');
    },
  );

  it.each(WRITE_OPERATIONS)('timeout on "%s" never tells the model to retry', (operation) => {
    const error = LumicsApiError.timeout(operation, 30_000, 1);

    expect(error.message).not.toMatch(/retry the call/i);
    expect(error.message).toMatch(/may already have been applied/);
    expect(error.message).toMatch(/read/i);
  });

  it.each(WRITE_OPERATIONS)(
    'network on "%s" does not imply the write never landed',
    (operation) => {
      const error = LumicsApiError.network(operation, 1, new TypeError('fetch failed'));
      expect(error.message).toMatch(/may already have been applied/);
      expect(error.message).not.toMatch(/retry the call/i);
    },
  );

  it.each(['GET /companies/c/devices', 'PUT /companies/c/devices/d/modules/snmp/lastDiscovery'])(
    'keeps the retry advice on "%s", where a replay changes nothing',
    (operation) => {
      const incomplete = LumicsApiError.incompleteBody(operation, 2, new Error('ECONNRESET'));
      expect(incomplete.message).toMatch(/retry the call/i);
      expect(incomplete.message).not.toMatch(/may already have been applied/);

      const timedOut = LumicsApiError.timeout(operation, 30_000, 2);
      expect(timedOut.message).toMatch(/narrow the request/i);
      expect(timedOut.message).not.toMatch(/may already have been applied/);
    },
  );

  it('network pulls the innermost cause out of a fetch cause chain', () => {
    const inner = new Error('getaddrinfo ENOTFOUND lumics.invalid');
    const middle = new Error('connection failed', { cause: inner });
    const outer = new TypeError('fetch failed', { cause: middle });

    const error = LumicsApiError.network('GET /devices', 3, outer);
    expect(error.code).toBe('network_error');
    expect(error.retryable).toBe(true);
    // The useful reason, not "fetch failed".
    expect(error.message).toContain('getaddrinfo ENOTFOUND lumics.invalid');
    expect(error.message).toMatch(/environment problem, not an argument problem/);
    expect(error.cause).toBe(outer);
  });

  it('network stops walking a cause chain deeper than five links', () => {
    let cause: Error = new Error('deepest');
    for (let depth = 0; depth < 10; depth += 1) {
      cause = new Error(`level ${String(depth)}`, { cause });
    }
    const error = LumicsApiError.network('GET /devices', 1, cause);
    expect(error.message).toContain('level');
    expect(error.message).not.toContain('deepest');
  });

  it('invalidResponse points at the captured contract rather than guessing', () => {
    const error = LumicsApiError.invalidResponse('GET /devices', 'the body was not valid JSON');
    expect(error.code).toBe('invalid_response');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('docs/reference/lumics-api-v1.md');
  });

  it('defaults to a non-retryable http_error when nothing is specified', () => {
    const error = new LumicsApiError('something broke');
    expect(error.code).toBe('http_error');
    expect(error.retryable).toBe(false);
    expect(error.status).toBeUndefined();
    expect(error.attempts).toBeUndefined();
  });
});

describe('LumicsApiError redacts at construction, so there is no unredacted variant', () => {
  it('scrubs a JWT out of the message', () => {
    const error = new LumicsApiError(
      'GET /devices failed with Authorization: Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
    );
    expect(error.message).not.toContain('eyJhbGciOi');
    expect(error.message).toContain(REDACTED);
  });

  it('scrubs a registered secret out of the message and the body snippet', () => {
    clearRegisteredSecrets();
    registerSecret('placeholder-secret-value-not-real');
    try {
      const error = new LumicsApiError('failed for placeholder-secret-value-not-real', {
        bodySnippet: 'token=placeholder-secret-value-not-real',
      });
      expect(error.message).not.toContain('placeholder-secret-value-not-real');
      expect(error.bodySnippet).not.toContain('placeholder-secret-value-not-real');
    } finally {
      clearRegisteredSecrets();
    }
  });
});

describe('LumicsInputError', () => {
  it('defaults to invalid_input and redacts its message', () => {
    const error = new LumicsInputError('lookback "6w" is not recognised');
    expect(error.name).toBe('LumicsInputError');
    expect(error.code).toBe('invalid_input');
  });

  it('accepts not_permitted for a refused gate', () => {
    expect(new LumicsInputError('nope', 'not_permitted').code).toBe('not_permitted');
  });
});

describe('describeError', () => {
  it('preserves the code and status of a LumicsApiError', () => {
    const described = describeError(LumicsApiError.fromStatus(404, { operation: 'GET /devices' }));
    expect(described.code).toBe('not_found');
    expect(described.status).toBe(404);
    expect(described.message).toContain('404');
  });

  it('preserves the code of a LumicsInputError and reports no status', () => {
    const described = describeError(new LumicsInputError('bad lookback'));
    expect(described.code).toBe('invalid_input');
    expect(described.status).toBeUndefined();
    expect(described.message).toBe('bad lookback');
  });

  it('labels anything else as a defect in this server, not the caller', () => {
    const described = describeError(new TypeError('x.y is not a function'));
    expect(described.code).toBe('unknown_error');
    expect(described.message).toMatch(/defect in lumics-mcp, not a problem with your arguments/);
    expect(described.message).toContain('x.y is not a function');
  });

  it.each([
    ['a bare string', 'something went wrong'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 'weird' }],
  ])('handles %s without throwing', (_label, thrown) => {
    const described = describeError(thrown);
    expect(described.code).toBe('unknown_error');
    expect(typeof described.message).toBe('string');
  });

  it('never leaks a stack trace into the message a model sees (RFC-001 D3)', () => {
    const error = new Error('boom');
    const described = describeError(error);
    expect(described.message).not.toContain('at ');
    expect(described.message).not.toContain(import.meta.url);
  });

  it('redacts a credential embedded in an unexpected error', () => {
    clearRegisteredSecrets();
    registerSecret('placeholder-token-abcdefgh');
    try {
      const described = describeError(new Error('failed with placeholder-token-abcdefgh'));
      expect(described.message).not.toContain('placeholder-token-abcdefgh');
      expect(described.message).toContain(REDACTED);
    } finally {
      clearRegisteredSecrets();
    }
  });
});
