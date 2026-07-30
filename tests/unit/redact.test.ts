/**
 * Redaction primitives — `src/util/redact.ts`.
 *
 * This file covers the mechanics: the three layers of pattern, key-name and
 * exact-value scrubbing, and the structural guarantees (depth cap, breadth cap,
 * cycle handling, `Error`/`Map`/`Set`/`Headers` normalisation).
 *
 * The adversarial cases — a real fetch-shaped error carrying a live-looking
 * credential — live in `tests/security/redaction.test.ts`, because that is the
 * control being verified rather than the implementation being described.
 *
 * No real credential appears anywhere. Every value is either an obvious
 * placeholder or a JWT-shaped string built from the word "placeholder".
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  redact,
  redactError,
  redactString,
  redactedMessage,
  registerSecret,
  registeredSecretCount,
  REDACTED,
} from '../../src/util/redact.js';

/** JWT-shaped, obviously fake. */
const FAKE_JWT = 'eyJwbGFjZWhvbGRlcg.eyJub3RhcmVhbHRva2Vu.cGxhY2Vob2xkZXJzaWc';

afterEach(() => {
  clearRegisteredSecrets();
});

describe('redactString: pattern scrubbing', () => {
  it.each([
    ['a bare JWT', FAKE_JWT],
    ['a JWT inside a sentence', `request failed with ${FAKE_JWT} attached`],
    ['a JWT in a URL', `https://x.invalid/cb?id_token=${FAKE_JWT}`],
  ])('removes %s', (_label, input) => {
    const out = redactString(input);
    expect(out).not.toContain('eyJwbGFjZWhvbGRlcg');
    expect(out).toContain(REDACTED);
  });

  it.each(['Bearer abcdefghijklmnop', 'bearer abcdefghijklmnop', 'BEARER abcdefghijklmnop'])(
    'removes the credential from %j while keeping the scheme label',
    (input) => {
      const out = redactString(input);
      expect(out).not.toContain('abcdefghijklmnop');
      expect(out.toLowerCase()).toContain('bearer');
    },
  );

  it.each([
    'Authorization: sometokenvalue',
    'authorization="sometokenvalue"',
    "'authorization' = sometokenvalue",
    'Authorization:sometokenvalue',
    // Both patterns fire here; the credential is what must not survive.
    'authorization: Bearer sometokenvalue',
  ])('removes an Authorization value in the serialised form %j', (input) => {
    expect(redactString(input)).not.toContain('sometokenvalue');
  });

  it.each([
    'token=leakedvalue',
    'password=leakedvalue',
    'passwd=leakedvalue',
    'secret=leakedvalue',
    'api-key=leakedvalue',
    'api_key=leakedvalue',
    'apikey=leakedvalue',
    'access_token=leakedvalue',
    'access-token=leakedvalue',
    'refresh_token=leakedvalue',
  ])('removes a query-string credential in %j', (input) => {
    const out = redactString(input);
    expect(out).not.toContain('leakedvalue');
    expect(out).toContain(REDACTED);
  });

  it('scrubs a credential from a full URL query while keeping the rest legible', () => {
    const out = redactString('GET https://x.invalid/api/v1/devices?limit=100&token=leakedvalue');
    expect(out).not.toContain('leakedvalue');
    expect(out).toContain('limit=100');
    expect(out).toContain('/devices');
  });

  it('leaves ordinary text alone', () => {
    const benign = 'GET /companies/000000000000000000000000/devices returned 42 records';
    expect(redactString(benign)).toBe(benign);
  });

  it('does not mangle a 24-hex ObjectId, which is not a secret', () => {
    expect(redactString('id 5628b8174b6cf000001bf163')).toBe('id 5628b8174b6cf000001bf163');
  });

  it('handles an empty string', () => {
    expect(redactString('')).toBe('');
  });
});

describe('registerSecret: exact-value scrubbing', () => {
  it('removes a registered value wherever it appears, including inside a word', () => {
    registerSecret('placeholder-secret-abcdefgh');
    const out = redactString(
      'url=https://x.invalid/?q=placeholder-secret-abcdefgh and again placeholder-secret-abcdefgh',
    );
    expect(out).not.toContain('placeholder-secret-abcdefgh');
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('ignores a value too short to be a meaningful secret', () => {
    registerSecret('abc');
    expect(registeredSecretCount()).toBe(0);
    expect(redactString('abc def abc')).toBe('abc def abc');
  });

  it('accepts a value exactly at the minimum length', () => {
    registerSecret('12345678');
    expect(registeredSecretCount()).toBe(1);
    expect(redactString('x 12345678 y')).toBe(`x ${REDACTED} y`);
  });

  it('ignores undefined, so an absent optional secret is not an error', () => {
    registerSecret(undefined);
    expect(registeredSecretCount()).toBe(0);
  });

  it('de-duplicates', () => {
    registerSecret('placeholder-value-one');
    registerSecret('placeholder-value-one');
    expect(registeredSecretCount()).toBe(1);
  });

  it('clearRegisteredSecrets empties the set', () => {
    registerSecret('placeholder-value-one');
    clearRegisteredSecrets();
    expect(registeredSecretCount()).toBe(0);
    expect(redactString('placeholder-value-one')).toBe('placeholder-value-one');
  });
});

describe('redact: key-name scrubbing', () => {
  it.each([
    'authorization',
    'Authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'token',
    'jwt',
    'access_token',
    'access-token',
    'refresh_token',
    'id_token',
    'password',
    'passwd',
    'pwd',
    'secret',
    'client_secret',
    'api_key',
    'apiKey',
    'credential',
    'credentials',
    'auth',
    'bearer',
    'LUMICS_TOKEN',
    'lumics_http_auth_token',
  ])('replaces the value of a key named %j regardless of its shape', (key) => {
    const redacted = redact({ [key]: 'anything-at-all-here' }) as Record<string, unknown>;
    expect(redacted[key]).toBe(REDACTED);
  });

  it('leaves a key that merely mentions a credential in passing', () => {
    const redacted = redact({ tokenConfigured: true, authTokenLength: 40 }) as Record<
      string,
      unknown
    >;
    expect(redacted.tokenConfigured).toBe(true);
    expect(redacted.authTokenLength).toBe(40);
  });

  it('scrubs a credential key at depth', () => {
    const redacted = redact({ request: { options: { headers: { authorization: 'Bearer x' } } } });
    expect(JSON.stringify(redacted)).not.toContain('Bearer x');
  });
});

describe('redact: structural guarantees', () => {
  it('converts an Error into a plain loggable object', () => {
    const error = new Error('boom');
    const redacted = redact(error) as Record<string, unknown>;
    expect(redacted.name).toBe('Error');
    expect(redacted.message).toBe('boom');
    expect(typeof redacted.stack).toBe('string');
  });

  it('walks the cause chain, which is where fetch puts the real reason', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND lumics.invalid'),
    });
    const redacted = redact(error) as { cause: { message: string } };
    expect(redacted.cause.message).toBe('getaddrinfo ENOTFOUND lumics.invalid');
  });

  it('keeps own enumerable extras on an Error, because they aid diagnosis', () => {
    const error = Object.assign(new Error('boom'), { code: 'ECONNRESET', errno: -104 });
    const redacted = redact(error) as Record<string, unknown>;
    expect(redacted.code).toBe('ECONNRESET');
    expect(redacted.errno).toBe(-104);
  });

  it('scrubs a credential-named extra on an Error', () => {
    const error = Object.assign(new Error('boom'), { token: 'leakedvalue' });
    expect(JSON.stringify(redact(error))).not.toContain('leakedvalue');
  });

  it('replaces a cycle with [Circular] rather than hanging', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(redact(node)).toEqual({ name: 'root', self: '[Circular]' });
  });

  it('handles a cycle through an array', () => {
    const array: unknown[] = [1];
    array.push(array);
    expect(redact(array)).toEqual([1, '[Circular]']);
  });

  it('handles two references to the same object without falsely reporting a cycle', () => {
    const shared = { id: 'a' };
    expect(redact({ left: shared, right: shared })).toEqual({
      left: { id: 'a' },
      right: { id: 'a' },
    });
  });

  it('caps depth so a pathologically nested payload cannot stall the log path', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 20; level += 1) {
      deep = { child: deep };
    }
    expect(JSON.stringify(redact(deep))).toContain('[MaxDepth]');
  });

  it('caps array breadth and says how many items were omitted', () => {
    const redacted = redact(Array.from({ length: 250 }, (_unused, index) => index)) as unknown[];
    expect(redacted).toHaveLength(201);
    expect(redacted.at(-1)).toBe('[+50 more items omitted]');
  });

  it('does not truncate an array inside the breadth cap', () => {
    expect(redact([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it.each([
    ['a Date', new Date('2026-07-29T12:00:00.000Z'), '2026-07-29T12:00:00.000Z'],
    [
      'a URL',
      new URL('https://x.invalid/a?token=leakedvalue'),
      `https://x.invalid/a?token=${REDACTED}`,
    ],
  ])('normalises %s', (_label, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('normalises a Map into an object and scrubs credential keys inside it', () => {
    const map = new Map<string, string>([
      ['authorization', 'Bearer leakedvalue'],
      ['accept', 'application/json'],
    ]);
    expect(redact(map)).toEqual({ authorization: REDACTED, accept: 'application/json' });
  });

  it('normalises a Set into an array', () => {
    expect(redact(new Set([1, 2]))).toEqual([1, 2]);
  });

  it('normalises Headers, a common carrier of Authorization', () => {
    const headers = new Headers({
      Authorization: `Bearer ${FAKE_JWT}`,
      Accept: 'application/json',
    });
    const redacted = redact(headers) as Record<string, unknown>;
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.accept).toBe('application/json');
  });

  it.each([
    ['null', null, null],
    ['undefined', undefined, undefined],
    ['a number', 7, 7],
    ['a boolean', true, true],
    ['a bigint', 10n, '10n'],
  ])('passes %s through in a serialisable form', (_label, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('renders a function as a label rather than dropping it', () => {
    expect(redact(function namedFn() {})).toBe('[Function namedFn]');
    expect(redact(() => undefined)).toMatch(/^\[Function /);
  });

  it('renders a symbol as its redacted description', () => {
    expect(redact(Symbol('token=leakedvalue'))).not.toContain('leakedvalue');
  });
});

describe('redactError', () => {
  it('returns a plain record for an Error', () => {
    const record = redactError(new Error('boom'));
    expect(record.name).toBe('Error');
    expect(record.message).toBe('boom');
  });

  it('wraps a non-object thrown value in a message field', () => {
    expect(redactError('just a string')).toEqual({ message: 'just a string' });
    expect(redactError(42)).toEqual({ message: '42' });
  });

  it('wraps an array, which is not a plain record', () => {
    expect(redactError(['a'])).toEqual({ message: 'a' });
    expect(redactError([])).toEqual({ message: '' });
  });
});

describe('redactedMessage', () => {
  it('uses the message of an Error', () => {
    expect(redactedMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to the name when the message is empty', () => {
    expect(redactedMessage(new TypeError(''))).toBe('TypeError');
  });

  it('passes a string through, redacted', () => {
    expect(redactedMessage(`Bearer ${FAKE_JWT}`)).not.toContain('eyJwbGFjZWhvbGRlcg');
  });

  it('serialises anything else', () => {
    expect(redactedMessage({ code: 'x' })).toBe('{"code":"x"}');
    expect(redactedMessage(42)).toBe('42');
  });

  it('never includes a stack trace', () => {
    expect(redactedMessage(new Error('boom'))).not.toContain('at ');
  });

  it('reports an unserialisable value rather than throwing on the error path', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactedMessage(cyclic)).toBe('unserialisable error value');
  });

  it('handles undefined and null', () => {
    expect(redactedMessage(undefined)).toBe('undefined');
    expect(redactedMessage(null)).toBe('null');
  });
});
