/**
 * Environment validation — `src/config.ts`.
 *
 * The requirement is that it fails **closed** and that the message names the
 * offending variable. An MCP server that dies inside a client's process shows the
 * user nothing but "server disconnected", so the message is the whole diagnostic
 * surface; a failure that says `TypeError: undefined is not a string` costs the
 * operator an afternoon.
 *
 * `loadConfig` takes an explicit env object, so nothing here touches
 * `process.env`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_URL_REQUIRES_TLS,
  buildHttpTransportConfig,
  describeConfig,
  HTTP_TRANSPORT_UNAVAILABLE,
  loadConfig,
  type LumicsConfig,
} from '../../src/config.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_OUTPUT_CHARS,
  MAX_TIMEOUT_MS,
  MIN_HTTP_AUTH_TOKEN_LENGTH,
  MIN_MAX_OUTPUT_CHARS,
  MIN_TIMEOUT_MS,
} from '../../src/constants.js';
import { LOG_LEVELS } from '../../src/util/logger.js';
import {
  clearRegisteredSecrets,
  redactString,
  registeredSecretCount,
} from '../../src/util/redact.js';
import { makeConfig, makeEnv, TEST_COMPANY_ID, TEST_TOKEN } from '../helpers/config.js';

/** A 32-character placeholder for the HTTP shared secret. Obviously not real. */
const HTTP_SECRET = 'placeholder-http-secret-32-chars';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(() => {
  // `registerSecret` writes to a module-level set; keep cases isolated.
  clearRegisteredSecrets();
});

describe('loadConfig defaults', () => {
  it('produces a frozen config from the two required variables', () => {
    const config = loadConfig(makeEnv());
    expect(config.token).toBe(TEST_TOKEN);
    expect(config.companyId).toBe(TEST_COMPANY_ID);
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(config.transport).toBe('stdio');
    expect(config.http).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('defaults every gate to CLOSED', () => {
    const config = loadConfig(makeEnv());
    expect(config.readOnly).toBe(false);
    expect(config.features).toEqual({ batchUpdate: false, tokenRevocation: false });
  });

  it('registers the token with the redactor so it is scrubbed from any later log', () => {
    clearRegisteredSecrets();
    expect(registeredSecretCount()).toBe(0);
    loadConfig(makeEnv());
    expect(registeredSecretCount()).toBe(1);
  });

  it('strips a trailing slash from the base URL so paths do not double up', () => {
    expect(loadConfig(makeEnv({ LUMICS_BASE_URL: 'https://x.invalid/api/v1///' })).baseUrl).toBe(
      'https://x.invalid/api/v1',
    );
  });

  it('treats an exported-but-blank variable as unset', () => {
    const config = loadConfig(makeEnv({ LUMICS_BASE_URL: '   ', LUMICS_TIMEOUT_MS: '' }));
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('loadConfig fails closed and names the variable', () => {
  /**
   * A required variable that is simply absent. `loadConfig` strips empty and
   * whitespace-only values before parsing, so an unset variable and an exported
   * blank one land in the same place. Both must name the variable.
   *
   * KNOWN GAP (reported, not fixed here): for the absent case the message is
   * zod's generic "expected string, received undefined" rather than the crafted
   * guidance the schema declares, because the crafted messages hang off `.min(1)`
   * and `.regex()`, which an absent value never reaches. The variable is still
   * named, so this asserts that much.
   */
  it.each([
    ['LUMICS_TOKEN unset', { LUMICS_TOKEN: undefined }],
    ['LUMICS_TOKEN exported blank', { LUMICS_TOKEN: '   ' }],
  ])('rejects %s and names it in the message', (label, overrides) => {
    const variable = label.split(' ')[0] as string;
    expect(() => loadConfig(makeEnv(overrides))).toThrow(/cannot start: invalid configuration/);
    expect(() => loadConfig(makeEnv(overrides))).toThrow(new RegExp(`- ${variable}:`));
  });

  it.each([
    [
      'LUMICS_TOKEN still the .env.example placeholder',
      { LUMICS_TOKEN: 'replace-me' },
      /LUMICS_TOKEN is still the placeholder/,
    ],
    [
      'LUMICS_COMPANY_ID too short',
      { LUMICS_COMPANY_ID: 'abc123' },
      /LUMICS_COMPANY_ID must be a 24-character hex ObjectId/,
    ],
    [
      'LUMICS_COMPANY_ID not hex',
      { LUMICS_COMPANY_ID: 'zzzzzzzzzzzzzzzzzzzzzzzz' },
      /LUMICS_COMPANY_ID/,
    ],
    ['LUMICS_COMPANY_ID a company name', { LUMICS_COMPANY_ID: 'Acme Corp' }, /LUMICS_COMPANY_ID/],
    [
      'LUMICS_BASE_URL not absolute',
      { LUMICS_BASE_URL: 'app.lumics.io/api/v1' },
      /LUMICS_BASE_URL must be an absolute http\(s\) URL/,
    ],
    ['LUMICS_BASE_URL a file URL', { LUMICS_BASE_URL: 'file:///etc/passwd' }, /LUMICS_BASE_URL/],
    ['LUMICS_TIMEOUT_MS not a number', { LUMICS_TIMEOUT_MS: 'fast' }, /LUMICS_TIMEOUT_MS/],
    [
      'LUMICS_TIMEOUT_MS below the floor',
      { LUMICS_TIMEOUT_MS: String(MIN_TIMEOUT_MS - 1) },
      /LUMICS_TIMEOUT_MS/,
    ],
    [
      'LUMICS_TIMEOUT_MS above the ceiling',
      { LUMICS_TIMEOUT_MS: String(MAX_TIMEOUT_MS + 1) },
      /LUMICS_TIMEOUT_MS/,
    ],
    [
      'LUMICS_MAX_OUTPUT_CHARS below the floor',
      { LUMICS_MAX_OUTPUT_CHARS: String(MIN_MAX_OUTPUT_CHARS - 1) },
      /LUMICS_MAX_OUTPUT_CHARS/,
    ],
    [
      'LUMICS_MAX_OUTPUT_CHARS above the ceiling',
      { LUMICS_MAX_OUTPUT_CHARS: String(MAX_MAX_OUTPUT_CHARS + 1) },
      /LUMICS_MAX_OUTPUT_CHARS/,
    ],
    ['LUMICS_TRANSPORT unknown', { LUMICS_TRANSPORT: 'websocket' }, /LUMICS_TRANSPORT/],
    ['LUMICS_HTTP_PORT out of range', { LUMICS_HTTP_PORT: '70000' }, /LUMICS_HTTP_PORT/],
  ])('rejects %s', (_label, overrides, matcher) => {
    expect(() => loadConfig(makeEnv(overrides))).toThrow(matcher);
    expect(() => loadConfig(makeEnv(overrides))).toThrow(/lumics-mcp cannot start/);
  });

  /**
   * Finding H6. `LUMICS_COMPANY_ID` used to be mandatory, so the server refused to
   * start without it — while the documented way to discover the id is
   * `lumics_get_me`, which needs a running server. The first thing a new user hit
   * was an instruction they could not follow. It is optional now; the format check
   * still applies to a value that IS given.
   */
  it.each([
    ['unset', { LUMICS_COMPANY_ID: undefined }],
    ['exported blank', { LUMICS_COMPANY_ID: '' }],
    ['whitespace only', { LUMICS_COMPANY_ID: '   ' }],
  ])('starts with LUMICS_COMPANY_ID %s, reporting it as unconfigured', (_label, overrides) => {
    const config = loadConfig(makeEnv(overrides));
    expect(config.companyId).toBe('');
    // The token is still required; only the company became optional.
    expect(config.token).toBe(TEST_TOKEN);
    expect(describeConfig(config).companyConfigured).toBe(false);
  });

  it('still validates the format of a LUMICS_COMPANY_ID that IS supplied', () => {
    expect(() => loadConfig(makeEnv({ LUMICS_COMPANY_ID: 'abc123' }))).toThrow(
      /LUMICS_COMPANY_ID must be a 24-character hex ObjectId/,
    );
    // And it says that leaving it out entirely is a supported choice.
    expect(() => loadConfig(makeEnv({ LUMICS_COMPANY_ID: 'abc123' }))).toThrow(
      /Leave it unset entirely/,
    );
  });

  it('says plainly that nothing was attempted, so an operator is not left guessing', () => {
    expect(() => loadConfig({})).toThrow(/No request was made and no credential was read/);
    expect(() => loadConfig({})).toThrow(/See \.env\.example/);
  });

  it('reports every invalid variable at once rather than one per restart', () => {
    const error = (() => {
      try {
        loadConfig({ LUMICS_COMPANY_ID: 'nope', LUMICS_TIMEOUT_MS: 'soon' });
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).toContain('LUMICS_TOKEN');
    expect(error?.message).toContain('LUMICS_COMPANY_ID');
    expect(error?.message).toContain('LUMICS_TIMEOUT_MS');
  });

  it('never echoes the offending VALUE of a secret variable', () => {
    const error = (() => {
      try {
        loadConfig({ LUMICS_TOKEN: 'not-a-real-token-but-still-secret', LUMICS_COMPANY_ID: 'bad' });
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();
    expect(error?.message).not.toContain('not-a-real-token-but-still-secret');
  });
});

describe('boolean flags refuse to fail open', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['  1  ', true],
  ])('LUMICS_READ_ONLY=%j resolves to %s', (value, expected) => {
    expect(loadConfig(makeEnv({ LUMICS_READ_ONLY: value })).readOnly).toBe(expected);
  });

  it.each(['flase', 'maybe', 'y', 'enabled', '2', '-1'])(
    'rejects LUMICS_READ_ONLY=%j instead of quietly enabling writes',
    (value) => {
      expect(() => loadConfig(makeEnv({ LUMICS_READ_ONLY: value }))).toThrow(/LUMICS_READ_ONLY/);
      expect(() => loadConfig(makeEnv({ LUMICS_READ_ONLY: value }))).toThrow(/boolean-like value/);
    },
  );

  it('maps the LUMICS_ENABLE_* variables onto the feature flags', () => {
    const config = loadConfig(
      makeEnv({ LUMICS_ENABLE_BATCH_UPDATE: '1', LUMICS_ENABLE_TOKEN_REVOCATION: 'true' }),
    );
    expect(config.features).toEqual({ batchUpdate: true, tokenRevocation: true });
  });

  it.each(['LUMICS_ENABLE_BATCH_UPDATE', 'LUMICS_ENABLE_TOKEN_REVOCATION'])(
    'rejects a garbage %s rather than treating it as off',
    (variable) => {
      expect(() => loadConfig(makeEnv({ [variable]: 'sure' }))).toThrow(new RegExp(variable));
    },
  );
});

/**
 * The API token is a bearer credential sent on every request, so the base URL
 * decides who receives it. Requiring TLS is the control that keeps a redirected
 * base URL from being a plaintext credential disclosure as well; loopback is
 * exempt because a local development proxy is a real use and cannot leave the
 * machine.
 */
describe('LUMICS_BASE_URL requires TLS off the loopback interface', () => {
  it.each([
    'https://app.lumics.io/api/v1',
    'https://lumics.example.invalid/api/v1',
    'http://127.0.0.1:8080/api/v1',
    'http://localhost:8080/api/v1',
    'http://[::1]:8080/api/v1',
    'http://localhost/api/v1',
  ])('accepts %s', (value) => {
    expect(loadConfig(makeEnv({ LUMICS_BASE_URL: value })).baseUrl).toBe(value);
  });

  it.each([
    'http://app.lumics.io/api/v1',
    'http://192.168.1.10/api/v1',
    'http://lumics.internal:8080/api/v1',
    // Not loopback: the hostname merely starts with one of the loopback spellings.
    'http://localhost.attacker.invalid/api/v1',
    'http://127.0.0.1.attacker.invalid/api/v1',
  ])('rejects the plaintext non-loopback URL %s', (value) => {
    expect(() => loadConfig(makeEnv({ LUMICS_BASE_URL: value }))).toThrow(/LUMICS_BASE_URL/);
    expect(() => loadConfig(makeEnv({ LUMICS_BASE_URL: value }))).toThrow(
      /lumics-mcp cannot start/,
    );
  });

  it('says exactly why, naming the credential and the exemption', () => {
    const attempt = (): unknown =>
      loadConfig(makeEnv({ LUMICS_BASE_URL: 'http://app.lumics.io/api/v1' }));
    // The operator has to be able to act on this without reading the source.
    expect(attempt).toThrow(/must use https:/);
    expect(attempt).toThrow(/credential sent in the Authorization header/);
    expect(attempt).toThrow(/clear text/);
    expect(attempt).toThrow(/127\.0\.0\.1/);
    expect(attempt).toThrow(/localhost/);
    expect(attempt).toThrow(/\[::1\]/);
  });

  /**
   * The constant is exported so a test can assert "the same sentence the operator
   * reads" — which only means anything while the two actually agree. An earlier
   * wording said "a bearer credential sent on every request", and `BEARER_PATTERN`
   * in the redactor matches `bearer <word>`, so the operator was shown "a bearer
   * [REDACTED] sent on every request". The redactor is right to be greedy about
   * anything shaped like a credential; the prose has to stay out of its way. This
   * asserts that property directly rather than trusting a reviewer to notice.
   */
  it('survives the redactor unchanged, so the operator reads the exported sentence', () => {
    expect(redactString(BASE_URL_REQUIRES_TLS)).toBe(BASE_URL_REQUIRES_TLS);
    expect(redactString(BASE_URL_REQUIRES_TLS)).not.toContain('[REDACTED]');
  });

  it('still reports a non-absolute URL as such rather than as a TLS problem', () => {
    expect(() => loadConfig(makeEnv({ LUMICS_BASE_URL: 'app.lumics.io/api/v1' }))).toThrow(
      /must be an absolute http\(s\) URL/,
    );
  });
});

/**
 * `LUMICS_LOG_LEVEL`. The mechanism (`setLogLevel`) already existed and was
 * tested, but nothing in `src/` called it, so `logger.debug` — the per-call
 * diagnostic in the tool factory — was unreachable in production and an operator
 * could not quiet a server whose stderr they did not want.
 */
describe('LUMICS_LOG_LEVEL', () => {
  it('defaults to info', () => {
    expect(loadConfig(makeEnv()).logLevel).toBe('info');
    expect(describeConfig(loadConfig(makeEnv())).logLevel).toBe('info');
  });

  it.each(LOG_LEVELS)('accepts %s', (level) => {
    expect(loadConfig(makeEnv({ LUMICS_LOG_LEVEL: level })).logLevel).toBe(level);
  });

  it.each(['verbose', 'trace', 'INFO', 'quiet', '2'])(
    'rejects %j instead of falling back to a level the operator did not choose',
    (value) => {
      expect(() => loadConfig(makeEnv({ LUMICS_LOG_LEVEL: value }))).toThrow(/LUMICS_LOG_LEVEL/);
      expect(() => loadConfig(makeEnv({ LUMICS_LOG_LEVEL: value }))).toThrow(
        /debug, info, warn, error, silent/,
      );
    },
  );

  it('is applied by the entry point, not merely parsed', () => {
    // `src/index.ts` is the only place that may touch the process-wide logger:
    // `loadConfig` stays free of that side effect so tests can call it freely.
    const source = readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf8');
    expect(source).toContain('setLogLevel(config.logLevel)');
  });
});

describe('http transport requires its own shared secret', () => {
  it('fails when LUMICS_TRANSPORT=http and no LUMICS_HTTP_AUTH_TOKEN is set', () => {
    expect(() => loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http' }))).toThrow(
      /LUMICS_TRANSPORT=http requires LUMICS_HTTP_AUTH_TOKEN/,
    );
    expect(() => loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http' }))).toThrow(
      /exposes your entire Lumics tenant/,
    );
    // And it says how to make one.
    expect(() => loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http' }))).toThrow(/openssl rand -hex 32/);
  });

  it('fails when the shared secret is too short to be worth having', () => {
    const short = 'a'.repeat(MIN_HTTP_AUTH_TOKEN_LENGTH - 1);
    expect(() =>
      loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http', LUMICS_HTTP_AUTH_TOKEN: short })),
    ).toThrow(new RegExp(`at least ${String(MIN_HTTP_AUTH_TOKEN_LENGTH)} characters`));
  });

  /**
   * Regression: the placeholder branch used to sit *below* the length gate, and
   * since `replace-me` is 10 characters the length check always won. An operator
   * who left the example value in place was told their secret was too short
   * rather than that it was still the placeholder. Both fail closed, but only
   * one of them tells you what you actually did wrong.
   */
  it('names the placeholder rather than its length when the shared secret is unchanged', () => {
    expect(() =>
      loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http', LUMICS_HTTP_AUTH_TOKEN: 'replace-me' })),
    ).toThrow(/still the placeholder/);
    expect(() =>
      loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http', LUMICS_HTTP_AUTH_TOKEN: 'replace-me' })),
    ).not.toThrow(new RegExp(`at least ${String(MIN_HTTP_AUTH_TOKEN_LENGTH)} characters`));
  });

  it('does not require an HTTP secret on the stdio transport', () => {
    expect(loadConfig(makeEnv({ LUMICS_TRANSPORT: 'stdio' })).http).toBeUndefined();
  });
});

/**
 * Finding M8. `LUMICS_TRANSPORT=http` used to start an Express listener, while
 * ADR-001 decision 3 says "v0.1 transport: stdio" and its Security Impact says
 * v0.1 "opens no network listener at all". No decision-log row brought decision 4
 * forward. `src/transport/http.ts` stays in the tree so v0.2 is additive; it is
 * unreachable from configuration until then.
 */
describe('the HTTP transport is refused in 0.1.0 (ADR-001 decision 3)', () => {
  const httpEnv = makeEnv({
    LUMICS_TRANSPORT: 'http',
    LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET,
  });

  it('refuses to start even with a perfectly valid HTTP configuration', () => {
    expect(() => loadConfig(httpEnv)).toThrow(/lumics-mcp cannot start/);
    expect(() => loadConfig(httpEnv)).toThrow(/HTTP transport is not available in this release/);
  });

  it('names the ADR and the release that will carry it, and says what to do now', () => {
    expect(() => loadConfig(httpEnv)).toThrow(/ADR-001/);
    expect(() => loadConfig(httpEnv)).toThrow(/v0\.2/);
    expect(() => loadConfig(httpEnv)).toThrow(/stdio/);
    expect(HTTP_TRANSPORT_UNAVAILABLE).toContain('opens no network listener at all');
  });

  it('never echoes the shared secret in the refusal', () => {
    const message = (() => {
      try {
        loadConfig(httpEnv);
        return '';
      } catch (thrown) {
        return thrown instanceof Error ? thrown.message : String(thrown);
      }
    })();
    expect(message).not.toContain(HTTP_SECRET);
    expect(message).not.toContain(TEST_TOKEN);
  });

  it('mentions the v0.2 gate in the shared-secret failures too, so the fix is one restart', () => {
    // Otherwise an operator generates a secret, restarts, and only then learns
    // the transport does not exist in this release.
    expect(() => loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http' }))).toThrow(
      /not available in this release/,
    );
    expect(() =>
      loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http', LUMICS_HTTP_AUTH_TOKEN: 'replace-me' })),
    ).toThrow(/not available in this release/);
  });

  it('leaves stdio entirely unaffected', () => {
    expect(loadConfig(makeEnv()).transport).toBe('stdio');
    expect(loadConfig(makeEnv({ LUMICS_TRANSPORT: 'stdio' })).transport).toBe('stdio');
  });
});

/**
 * The HTTP configuration checks themselves, exercised directly.
 *
 * `loadConfig` refuses the transport before it can return one of these, so these
 * assertions would otherwise be unverified until v0.2 — and loopback-by-default
 * binding plus the DNS-rebinding allow list are exactly the controls that must not
 * rot in the meantime.
 */
describe('buildHttpTransportConfig (kept verified for v0.2)', () => {
  it('binds to loopback and allows only loopback hosts by default', () => {
    const http = buildHttpTransportConfig({ LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET });
    expect(http.host).toBe('127.0.0.1');
    expect(http.port).toBe(DEFAULT_HTTP_PORT);
    expect(http.allowedHosts).toContain('127.0.0.1');
    expect(http.allowedHosts).toContain('localhost');
    // No cross-origin browser client unless one is named explicitly.
    expect(http.allowedOrigins).toEqual([]);
  });

  it('adds a custom bind host to the allow list, or every request would 403', () => {
    const http = buildHttpTransportConfig({
      LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET,
      LUMICS_HTTP_HOST: '10.0.0.5',
    });
    expect(http.allowedHosts).toContain('10.0.0.5');
  });

  it('uses the explicit host and origin lists when they are given', () => {
    const http = buildHttpTransportConfig({
      LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET,
      LUMICS_HTTP_ALLOWED_HOSTS: ['a.invalid', 'b.invalid'],
      LUMICS_HTTP_ALLOWED_ORIGINS: ['https://c.invalid'],
    });
    expect(http.allowedHosts).toEqual(['a.invalid', 'b.invalid']);
    expect(http.allowedOrigins).toEqual(['https://c.invalid']);
  });

  it('registers the HTTP shared secret with the redactor too', () => {
    clearRegisteredSecrets();
    buildHttpTransportConfig({ LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET });
    expect(registeredSecretCount()).toBe(1);
  });

  it('registers the secret even on the path where loadConfig then refuses the transport', () => {
    clearRegisteredSecrets();
    expect(() =>
      loadConfig(makeEnv({ LUMICS_TRANSPORT: 'http', LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET })),
    ).toThrow(/not available in this release/);
    // The Lumics token and the HTTP secret: both known to the redactor before the
    // refusal was raised, so neither can reach a log through it.
    expect(registeredSecretCount()).toBe(2);
  });

  it('still refuses a missing, short or placeholder secret', () => {
    expect(() => buildHttpTransportConfig({})).toThrow(/LUMICS_HTTP_AUTH_TOKEN/);
    expect(() =>
      buildHttpTransportConfig({
        LUMICS_HTTP_AUTH_TOKEN: 'a'.repeat(MIN_HTTP_AUTH_TOKEN_LENGTH - 1),
      }),
    ).toThrow(new RegExp(`at least ${String(MIN_HTTP_AUTH_TOKEN_LENGTH)} characters`));
    expect(() => buildHttpTransportConfig({ LUMICS_HTTP_AUTH_TOKEN: 'replace-me' })).toThrow(
      /still the placeholder/,
    );
  });

  it('parses comma-separated host and origin lists in the environment schema', () => {
    // The CSV parsing lives in the schema rather than in the builder, so it is
    // asserted on a configuration that does not need the transport to start.
    expect(
      () =>
        loadConfig(
          makeEnv({
            LUMICS_TRANSPORT: 'http',
            LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET,
            LUMICS_HTTP_ALLOWED_HOSTS: 'a.invalid, b.invalid ,,',
          }),
        ),
      // It reaches the v0.2 gate, which proves the lists parsed without error.
    ).toThrow(/not available in this release/);
  });
});

describe('describeConfig never includes a secret', () => {
  /**
   * An http-shaped config, built directly. `loadConfig` refuses the transport in
   * 0.1.0, and `describeConfig`'s http branch still has to be proven secret-free —
   * it is the branch that will run first in v0.2.
   */
  function httpConfig(): LumicsConfig {
    return makeConfig({
      token: TEST_TOKEN,
      transport: 'http',
      http: buildHttpTransportConfig({ LUMICS_HTTP_AUTH_TOKEN: HTTP_SECRET }),
    });
  }

  it('omits the token and the HTTP shared secret by construction', () => {
    const config = httpConfig();
    const described = describeConfig(config);
    const serialised = JSON.stringify(described);

    expect(serialised).not.toContain(TEST_TOKEN);
    expect(serialised).not.toContain(HTTP_SECRET);
    // Not masked — absent. A masked field is a field a future edit can unmask.
    expect(Object.hasOwn(described, 'token')).toBe(false);
    expect(described.tokenConfigured).toBe(true);
    expect((described.http as Record<string, unknown>).authTokenConfigured).toBe(true);
    expect(Object.hasOwn(described.http as object, 'authToken')).toBe(false);
  });

  it('still reports everything an operator needs for diagnosis', () => {
    const described = describeConfig(loadConfig(makeEnv({ LUMICS_READ_ONLY: '1' })));
    expect(described).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      companyId: TEST_COMPANY_ID,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
      readOnly: true,
      transport: 'stdio',
      features: { batchUpdate: false, tokenRevocation: false },
      http: undefined,
    });
  });

  it('copies the feature flags rather than exposing the frozen originals', () => {
    const config = loadConfig(makeEnv());
    const described = describeConfig(config);
    expect(described.features).not.toBe(config.features);
  });

  it('finds no secret-looking value anywhere in the described object', () => {
    const serialised = JSON.stringify(describeConfig(httpConfig()));
    // No JWT shape, and no key that names a credential.
    expect(serialised).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(serialised).not.toMatch(/"(authToken|token|secret|password|apiKey)"\s*:/i);
  });
});
