/**
 * Environment loading and validation. Fails closed with an actionable message.
 *
 * Every variable in `.env.example` is honoured here; adding one there without
 * adding it here (or vice versa) is a defect. Validation is a zod schema so the
 * failure message names the variable and says what to do about it — an MCP
 * server that dies with `TypeError: undefined is not a string` inside a client's
 * process is effectively undebuggable, because the client shows the user nothing
 * but "server disconnected".
 *
 * The resulting object is frozen and must **never be logged whole**. Use
 * {@link describeConfig} for diagnostics; it omits every secret by construction
 * rather than relying on the redactor as a backstop.
 */

import { z } from 'zod';
import {
  DEFAULT_BASE_URL,
  DEFAULT_HTTP_ALLOWED_HOSTS,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  LOOPBACK_HOSTNAMES,
  MAX_MAX_OUTPUT_CHARS,
  MAX_TIMEOUT_MS,
  MIN_HTTP_AUTH_TOKEN_LENGTH,
  MIN_MAX_OUTPUT_CHARS,
  MIN_TIMEOUT_MS,
  OBJECT_ID_PATTERN,
} from './constants.js';
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, type LogLevel } from './util/logger.js';
import { registerSecret } from './util/redact.js';

export const TRANSPORTS = ['stdio', 'http'] as const;
export type TransportKind = (typeof TRANSPORTS)[number];

/**
 * Feature flags that gate individual tools. Names match the `LUMICS_ENABLE_*`
 * variables; the tool factory keys off these, so a tool cannot invent its own.
 */
export interface FeatureFlags {
  /** `LUMICS_ENABLE_BATCH_UPDATE` — one call can rewrite N devices (RFC-001 D6). */
  readonly batchUpdate: boolean;
  /** `LUMICS_ENABLE_TOKEN_REVOCATION` — revokes EVERY token on the account. */
  readonly tokenRevocation: boolean;
}

export interface HttpTransportConfig {
  readonly port: number;
  readonly host: string;
  /** Shared secret clients must present as `Authorization: Bearer <value>`. */
  readonly authToken: string;
  readonly allowedHosts: readonly string[];
  /** Empty means "no cross-origin browser client is allowed". */
  readonly allowedOrigins: readonly string[];
}

export interface LumicsConfig {
  readonly token: string;
  /**
   * `LUMICS_COMPANY_ID`, or the empty string when the operator has not set one.
   *
   * Optional deliberately: it is discovered with `lumics_get_me`, and a server
   * that refuses to start without it cannot run the tool that finds it. When it is
   * empty, company-scoped tools are not registered at all — see `registerTools`.
   */
  readonly companyId: string;
  /**
   * `LUMICS_ALLOW_CROSS_COMPANY` — permit a call whose explicit `companyId`
   * differs from {@link companyId}. Off by default: an MSP token can reach several
   * tenants, and every other blast-radius widening in this server is an act the
   * operator has to perform out of band.
   */
  readonly allowCrossCompany: boolean;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  /** `LUMICS_READ_ONLY` — when true only `read` tools are *registered*. */
  readonly readOnly: boolean;
  /**
   * `LUMICS_LOG_LEVEL` — verbosity of the stderr diagnostics, `info` by default.
   * Parsed here; applied to the process-wide logger by `src/index.ts`, so that
   * importing this package cannot change a host application's logging.
   */
  readonly logLevel: LogLevel;
  readonly features: FeatureFlags;
  readonly transport: TransportKind;
  /** Present only when `transport === 'http'`. */
  readonly http: HttpTransportConfig | undefined;
}

/**
 * `1`, `true`, `yes` and `on` are all true; `0`, `false`, `no`, `off` and empty
 * are false. Anything else is an error rather than a silent falsy, because
 * `LUMICS_READ_ONLY=flase` must not quietly enable writes.
 */
const booleanFlag = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalised = value.toLowerCase();
    if (normalised === '' || ['0', 'false', 'no', 'off'].includes(normalised)) {
      return false;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalised)) {
      return true;
    }
    ctx.addIssue({
      code: 'custom',
      message: `expected a boolean-like value (1/0, true/false, yes/no, on/off) but received "${value}"`,
    });
    return z.NEVER;
  });

const integerInRange = (min: number, max: number) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!/^\d+$/.test(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `expected a whole number but received "${value}"`,
        });
        return z.NEVER;
      }
      const parsed = Number.parseInt(value, 10);
      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `expected a number between ${String(min)} and ${String(max)} but received ${String(parsed)}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const csvList = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

/**
 * Why a plaintext base URL is refused off the loopback interface. Exported so the
 * test that locks the control asserts the same sentence the operator reads.
 *
 * Deliberately avoids the phrase "bearer <word>": `BEARER_PATTERN` in
 * `src/util/redact.ts` matches that shape, so an earlier wording ("a bearer
 * credential sent on every request") reached the operator as "a bearer
 * [REDACTED] sent on every request". The redactor is right to be greedy — the
 * fix belongs in the prose, not in the pattern. If you reword this, check the
 * rendered output rather than trusting the constant, because the test asserting
 * this string is only meaningful while the two agree.
 */
export const BASE_URL_REQUIRES_TLS = `LUMICS_BASE_URL must use https:. The Lumics API token is a credential sent in the Authorization header of every request, so over plain http: to a remote host it crosses the network in clear text and is readable by anything on the path. Plain http: is accepted only for a loopback host (${LOOPBACK_HOSTNAMES.join(
  ', ',
)}), which is enough for a local development proxy.`;

const envSchema = z.object({
  // `loadConfig` strips empty and whitespace-only values before parsing, so an
  // unset variable arrives as `undefined` and never reaches `.min(1)`. The
  // message therefore has to be attached to the type error itself, or the most
  // common misconfiguration — the variable simply not being set — reports
  // zod's generic "expected string, received undefined" and the operator gets
  // no advice at all. Verified by tests/unit/config.test.ts.
  LUMICS_TOKEN: z
    .string({
      error:
        'LUMICS_TOKEN is required. Obtain a JWT from the Lumics UI at /api/v1/me/token — see .env.example.',
    })
    .trim()
    .min(
      1,
      'LUMICS_TOKEN is required. Obtain a JWT from the Lumics UI at /api/v1/me/token — see .env.example.',
    )
    .refine(
      (value) => value !== 'replace-me',
      'LUMICS_TOKEN is still the placeholder from .env.example. Replace it with a real Lumics API token.',
    ),

  // Optional, and that is the point. The documented way to discover a company id
  // is `lumics_get_me`, which needs a running server — so making the variable
  // mandatory made the first-run instructions impossible to follow. When it is
  // absent the server starts with only the tools that need no company (see
  // `registerTools`). The format check still applies to a value that IS supplied:
  // a typo'd id must fail at startup, not as a 404 mid-conversation.
  LUMICS_COMPANY_ID: z
    .string()
    .trim()
    .regex(
      OBJECT_ID_PATTERN,
      'LUMICS_COMPANY_ID must be a 24-character hex ObjectId. Find yours with the lumics_get_me tool, or read it from the Lumics web UI URL after /companies/. Leave it unset entirely to start the server with only the tools that need no company.',
    )
    .optional(),

  LUMICS_ALLOW_CROSS_COMPANY: booleanFlag.optional(),

  LUMICS_BASE_URL: z
    .string()
    .trim()
    .refine(
      isHttpUrl,
      'LUMICS_BASE_URL must be an absolute http(s) URL, e.g. https://app.lumics.io/api/v1 — include the /api/v1 prefix.',
    )
    .refine(isTlsOrLoopback, BASE_URL_REQUIRES_TLS)
    .optional(),

  LUMICS_LOG_LEVEL: z
    .enum(
      LOG_LEVELS,
      `LUMICS_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (default ${DEFAULT_LOG_LEVEL}). Diagnostics go to stderr; "debug" adds a per-call record of duration, output size and any truncation, and "silent" turns them off entirely.`,
    )
    .optional(),

  LUMICS_TIMEOUT_MS: integerInRange(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS).optional(),
  LUMICS_MAX_OUTPUT_CHARS: integerInRange(MIN_MAX_OUTPUT_CHARS, MAX_MAX_OUTPUT_CHARS).optional(),

  LUMICS_READ_ONLY: booleanFlag.optional(),
  LUMICS_ENABLE_BATCH_UPDATE: booleanFlag.optional(),
  LUMICS_ENABLE_TOKEN_REVOCATION: booleanFlag.optional(),

  LUMICS_TRANSPORT: z
    .enum(TRANSPORTS, 'LUMICS_TRANSPORT must be either "stdio" (default) or "http".')
    .optional(),

  LUMICS_HTTP_PORT: integerInRange(1, 65_535).optional(),
  LUMICS_HTTP_HOST: z.string().trim().min(1).optional(),
  LUMICS_HTTP_AUTH_TOKEN: z.string().trim().optional(),
  LUMICS_HTTP_ALLOWED_HOSTS: csvList.optional(),
  LUMICS_HTTP_ALLOWED_ORIGINS: csvList.optional(),
});

/** Raw environment shape, exported so tests can build one without `process.env`. */
export type RawEnv = Record<string, string | undefined>;

/**
 * Why `LUMICS_TRANSPORT=http` is refused in 0.1.0. Exported so the test that
 * locks this asserts the same sentence the operator reads.
 */
export const HTTP_TRANSPORT_UNAVAILABLE =
  'the HTTP transport is not available in this release. lumics-mcp 0.1.0 ships stdio only (docs/adr/ADR-001-transport-and-distribution.md decision 3: "v0.1 transport: stdio"), and this version opens no network listener at all. Streamable HTTP is decision 4 of the same ADR and is scheduled for v0.2. Unset LUMICS_TRANSPORT, or set it to "stdio", and connect this server over stdio from your MCP client.';

/**
 * Validate an environment and produce the frozen config.
 *
 * @throws Error with a multi-line, variable-by-variable explanation. The message
 * is safe to print: it names variables, never values.
 */
export function loadConfig(env: RawEnv = process.env): LumicsConfig {
  // Strip empties first: an exported-but-blank variable should behave as unset,
  // otherwise `LUMICS_BASE_URL=` in a shell profile breaks the URL check.
  const present: RawEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      present[key] = value;
    }
  }

  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const variable = issue.path.length > 0 ? String(issue.path[0]) : 'environment';
      return `  - ${variable}: ${issue.message}`;
    });
    throw new Error(
      `lumics-mcp cannot start: invalid configuration.\n${lines.join('\n')}\n\nSee .env.example for every supported variable. No request was made and no credential was read.`,
    );
  }

  const data = parsed.data;

  // Registered before anything else can throw. Every later failure path — the
  // HTTP-transport refusal below included — builds a message while this value is
  // in scope, and the redactor should already know it by then. `registerSecret` is
  // idempotent, so the call at the end of this function is harmless.
  registerSecret(data.LUMICS_TOKEN);

  const transport: TransportKind = data.LUMICS_TRANSPORT ?? 'stdio';

  // Always `undefined` in 0.1.0, because the branch below never returns. Kept as
  // a binding rather than inlined so that v0.2 restores the transport by deleting
  // the `throw` and assigning here.
  const http: HttpTransportConfig | undefined = undefined;
  if (transport === 'http') {
    // Validated first, then refused. The validation is not dead weight: an
    // operator preparing an HTTP deployment for v0.2 learns now that their
    // configuration would be unsafe, instead of being told only that the transport
    // is unavailable and discovering the missing secret a release later. It also
    // registers the shared secret with the redactor before anything can log.
    buildHttpTransportConfig(data);

    // ADR-001 decision 3: "v0.1 transport: stdio". Decision 4 schedules
    // Streamable HTTP for v0.2 and no decision-log row brings it forward, while
    // the ADR's Security Impact states that v0.1 "opens no network listener at
    // all". `src/transport/http.ts` stays in the tree so v0.2 is additive, but it
    // must not be reachable from configuration in this release: a network
    // listener that three documents say does not exist is the kind of thing an
    // operator discovers from a port scan.
    throw new Error(`lumics-mcp cannot start: ${HTTP_TRANSPORT_UNAVAILABLE}`);
  }

  const config: LumicsConfig = {
    token: data.LUMICS_TOKEN,
    // The empty string means "not configured"; every consumer checks the length
    // rather than treating it as a usable id.
    companyId: data.LUMICS_COMPANY_ID ?? '',
    allowCrossCompany: data.LUMICS_ALLOW_CROSS_COMPANY ?? false,
    baseUrl: normaliseBaseUrl(data.LUMICS_BASE_URL ?? DEFAULT_BASE_URL),
    timeoutMs: data.LUMICS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: data.LUMICS_MAX_OUTPUT_CHARS ?? DEFAULT_MAX_OUTPUT_CHARS,
    readOnly: data.LUMICS_READ_ONLY ?? false,
    logLevel: data.LUMICS_LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    features: {
      batchUpdate: data.LUMICS_ENABLE_BATCH_UPDATE ?? false,
      tokenRevocation: data.LUMICS_ENABLE_TOKEN_REVOCATION ?? false,
    },
    transport,
    http,
  };

  // Register every secret with the redactor before anything can log. This is the
  // hook that makes redaction cover the *configured* token specifically, not
  // just anything that happens to look like a JWT. The token is also registered
  // earlier, right after parsing, so the failure paths above are covered too; the
  // HTTP shared secret is registered inside `buildHttpTransportConfig` for the
  // same reason.
  registerSecret(config.token);

  return Object.freeze(config);
}

/**
 * Diagnostic summary safe to log. Secrets are omitted, not masked — there is no
 * code path here that touches `token` or `authToken`, so no future edit to the
 * redactor can accidentally start leaking them.
 */
export function describeConfig(config: LumicsConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    companyId: config.companyId,
    companyConfigured: config.companyId.length > 0,
    allowCrossCompany: config.allowCrossCompany,
    timeoutMs: config.timeoutMs,
    maxOutputChars: config.maxOutputChars,
    readOnly: config.readOnly,
    logLevel: config.logLevel,
    features: { ...config.features },
    transport: config.transport,
    tokenConfigured: config.token.length > 0,
    http:
      config.http === undefined
        ? undefined
        : {
            host: config.http.host,
            port: config.http.port,
            allowedHosts: [...config.http.allowedHosts],
            allowedOrigins: [...config.http.allowedOrigins],
            authTokenConfigured: true,
          },
  };
}

/**
 * Validate and assemble the HTTP transport configuration.
 *
 * Extracted from `loadConfig` so that the v0.1 refusal above can sit after it
 * without making it unreachable, and **exported** so its checks stay verified by
 * test while `LUMICS_TRANSPORT=http` is refused: loopback-by-default binding and
 * the shared-secret floor are the controls v0.2 depends on, and an untested
 * control is one a future change can quietly delete. Every check here fails
 * closed. Not part of the supported API surface.
 */
export function buildHttpTransportConfig(data: {
  readonly LUMICS_HTTP_AUTH_TOKEN?: string | undefined;
  readonly LUMICS_HTTP_HOST?: string | undefined;
  readonly LUMICS_HTTP_PORT?: number | undefined;
  readonly LUMICS_HTTP_ALLOWED_HOSTS?: readonly string[] | undefined;
  readonly LUMICS_HTTP_ALLOWED_ORIGINS?: readonly string[] | undefined;
}): HttpTransportConfig {
  const authToken = data.LUMICS_HTTP_AUTH_TOKEN;
  // The placeholder check must precede the length check: 'replace-me' is
  // shorter than the minimum, so ordering it second made it unreachable and
  // the operator got a length complaint instead of being told they had left
  // the example value in place. Fails closed either way, but the wrong
  // message costs debugging time.
  if (authToken === 'replace-me') {
    throw new Error(
      `lumics-mcp cannot start: LUMICS_HTTP_AUTH_TOKEN is still the placeholder from .env.example. Generate a real secret with: openssl rand -hex 32\n\n${HTTP_TRANSPORT_UNAVAILABLE}`,
    );
  }
  if (authToken === undefined || authToken.length < MIN_HTTP_AUTH_TOKEN_LENGTH) {
    throw new Error(
      `lumics-mcp cannot start: LUMICS_TRANSPORT=http requires LUMICS_HTTP_AUTH_TOKEN to be at least ${String(
        MIN_HTTP_AUTH_TOKEN_LENGTH,
      )} characters. Generate one with: openssl rand -hex 32\n\nAn HTTP transport without a shared secret exposes your entire Lumics tenant to anything that can reach the port.\n\n${HTTP_TRANSPORT_UNAVAILABLE}`,
    );
  }

  // Registered here rather than only in `loadConfig`, so the secret is known to
  // the redactor from the moment it is validated — including on the path where
  // `loadConfig` goes on to refuse the transport, and including any error raised
  // between here and there.
  registerSecret(authToken);

  const host = data.LUMICS_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  // Allowed hosts must cover the bind host, or every request 403s on the
  // DNS-rebinding check and the operator has no idea why.
  const allowedHosts =
    data.LUMICS_HTTP_ALLOWED_HOSTS ?? Array.from(new Set([...DEFAULT_HTTP_ALLOWED_HOSTS, host]));

  return {
    port: data.LUMICS_HTTP_PORT ?? DEFAULT_HTTP_PORT,
    host,
    authToken,
    allowedHosts,
    allowedOrigins: data.LUMICS_HTTP_ALLOWED_ORIGINS ?? [],
  };
}

/** Trailing slashes would produce `//` when joined with a path builder result. */
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Absolute http(s) only. `file:` or a bare hostname must not reach `fetch`. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * TLS everywhere except loopback.
 *
 * Every request carries `Authorization: Bearer <token>`, so the base URL decides
 * who receives the credential. `https:` is therefore the requirement and `http:`
 * the exception, granted only where the traffic cannot leave the machine — a
 * developer proxying to a self-hosted Lumics is a real case and does not need a
 * certificate. The comparison is against `URL.hostname`, which is exact: a host
 * such as `localhost.attacker.invalid` is not loopback and gets no exemption.
 *
 * No environment flag widens this. If a deployment genuinely needs plaintext to a
 * remote host, that is a change to argue for on its merits, not a default to leave
 * open.
 */
function isTlsOrLoopback(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Unparseable is `isHttpUrl`'s complaint to make; do not shadow it.
    return true;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return LOOPBACK_HOSTNAMES.includes(url.hostname);
}
