/**
 * The only module in this repository permitted to call `console.*`
 * (enforced by an override in `eslint.config.js`).
 *
 * On the stdio transport **stdout is the JSON-RPC channel**. A single stray
 * `console.log` corrupts the protocol stream and the client disconnects with a
 * parse error that gives no hint where it came from. Every level here therefore
 * writes to **stderr** via `console.error`, including `info` and `debug`.
 *
 * Output is newline-delimited JSON so a supervisor can parse it. Every payload
 * passes through `redact()` first — see `src/util/redact.ts` for why that is
 * structural rather than a convention.
 */

import { redact, redactError, redactString } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Level used until an operator says otherwise. `src/config.ts` defaults
 * `LUMICS_LOG_LEVEL` to this same value, and `src/index.ts` applies it.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

let currentLevel: LogLevel = DEFAULT_LOG_LEVEL;

/**
 * Fields the log record owns. A context key with one of these names is emitted as
 * `ctx.<name>` rather than being allowed to overwrite it.
 */
const RESERVED_RECORD_KEYS: ReadonlySet<string> = new Set(['time', 'level', 'msg']);

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  /** `error` accepts an unknown thrown value and redacts its whole cause chain. */
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  payload?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) {
    return;
  }

  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg: redactString(message),
  };
  if (payload !== undefined) {
    // Not `Object.assign`. Context keys come from call sites all over the server
    // and, on the error path, from a redacted error object — so a key named `msg`,
    // `level` or `time` would overwrite the record's own field. That does not just
    // lose the context value: it replaces the diagnostic's message or its severity
    // with attacker- or vendor-influenced text, and a supervisor parsing the
    // stream would file the line under the wrong level or the wrong event.
    for (const [key, value] of Object.entries(payload)) {
      record[RESERVED_RECORD_KEYS.has(key) ? `ctx.${key}` : key] = value;
    }
  }

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A payload that will not serialise must not silence the diagnostic.
    line = JSON.stringify({
      time: record.time,
      level,
      msg: record.msg,
      note: 'payload unserialisable',
    });
  }

  // stderr only, never stdout. `eslint.config.js` exempts this file from
  // `no-console`; see the module docstring for why that exemption exists here
  // and nowhere else.
  console.error(line);
}

function redactContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (context === undefined) {
    return undefined;
  }
  const redacted = redact(context);
  return typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { context: redacted };
}

export const logger: Logger = {
  debug(message, context) {
    emit('debug', message, redactContext(context));
  },
  info(message, context) {
    emit('info', message, redactContext(context));
  },
  warn(message, context) {
    emit('warn', message, redactContext(context));
  },
  error(message, error, context) {
    const payload: Record<string, unknown> = { ...redactContext(context) };
    if (error !== undefined) {
      payload.err = redactError(error);
    }
    emit('error', message, payload);
  },
};
