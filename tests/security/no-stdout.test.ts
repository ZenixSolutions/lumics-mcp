/**
 * SECURITY CONTROL: nothing in this server writes to stdout.
 *
 * On the stdio transport stdout **is** the MCP JSON-RPC channel. One stray
 * `console.log` interleaves with protocol frames and the client disconnects with
 * a parse error that gives no hint where it came from, which is expensive to
 * diagnose and, if the stray write happens to be an error object carrying request
 * headers, is also a credential leak.
 *
 * In-process this is asserted by spying on every `console` method that writes to
 * stdout while a whole server is built and driven. The complementary end-to-end
 * assertion — that a real child process emits nothing but JSON-RPC frames on fd 1
 * — lives in `tests/installation/stdio.test.ts`, because only a real process can
 * prove it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/server.js';
import { logger, setLogLevel } from '../../src/util/logger.js';
import { makeConfig, TEST_DEVICE_ID } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { errorResponse, jsonResponse, recordFetch, recordSleep } from '../helpers/fetch.js';

/** Every console method whose output lands on fd 1. */
const STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'table', 'trace'] as const;

/** A restorable spy with call bookkeeping. Narrow, so `mockRestore` is callable. */
interface ConsoleSpy {
  mockRestore(): void;
}
type Spies = ConsoleSpy[];

function spyOnStdoutConsole(): Spies {
  return STDOUT_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

function expectNoStdoutWrites(spies: Spies): void {
  for (const [index, spy] of spies.entries()) {
    expect(
      spy,
      `console.${STDOUT_METHODS[index] ?? '?'} was called — stdout is the protocol channel`,
    ).not.toHaveBeenCalled();
  }
}

let spies: Spies = [];

beforeEach(() => {
  // debug level so nothing is skipped by the level filter and the assertion is
  // exercised against the noisiest configuration.
  setLogLevel('debug');
  spies = spyOnStdoutConsole();
});

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
  setLogLevel('info');
});

describe('building a server writes nothing to stdout', () => {
  it('holds for the default configuration', () => {
    buildServer(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse([])).fetchImpl },
    });
    expectNoStdoutWrites(spies);
  });

  it('holds under LUMICS_READ_ONLY, which logs an extra line', () => {
    buildServer(makeConfig({ readOnly: true }), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse([])).fetchImpl },
    });
    expectNoStdoutWrites(spies);
  });

  it('holds with both feature flags on, which logs the skipped lists', () => {
    buildServer(makeConfig({ features: { batchUpdate: true, tokenRevocation: true } }), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse([])).fetchImpl },
    });
    expectNoStdoutWrites(spies);
  });
});

describe('invoking tools writes nothing to stdout', () => {
  it('holds for a successful read', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse([{ id: 'a' }])).fetchImpl },
    });
    try {
      await harness.call('lumics_list_devices', {});
      expectNoStdoutWrites(spies);
    } finally {
      await harness.close();
    }
  });

  it('holds for a failing read, where the error path is exercised', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: {
        fetchImpl: recordFetch(errorResponse(500, 'internal')).fetchImpl,
        sleep: recordSleep().sleep,
      },
    });
    try {
      const called = await harness.call('lumics_get_me', {});
      expect(called.isError).toBe(true);
      expectNoStdoutWrites(spies);
    } finally {
      await harness.close();
    }
  });

  it('holds for a retried request, which logs a warning per retry', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: {
        fetchImpl: recordFetch([errorResponse(429), jsonResponse({ id: 'me' })]).fetchImpl,
        sleep: recordSleep().sleep,
      },
    });
    try {
      await harness.call('lumics_get_me', {});
      expectNoStdoutWrites(spies);
    } finally {
      await harness.close();
    }
  });

  it('holds for a refused destructive call', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({})).fetchImpl },
    });
    try {
      await harness.call('lumics_delete_device', { deviceId: TEST_DEVICE_ID });
      expectNoStdoutWrites(spies);
    } finally {
      await harness.close();
    }
  });

  it('holds for an internal defect, where the unknown-error path runs', async () => {
    // A body that is not the documented envelope drives the invalid_response path.
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse({ nope: true })).fetchImpl },
    });
    try {
      const called = await harness.call('lumics_update_device', {
        deviceId: TEST_DEVICE_ID,
        enabled: false,
      });
      expect(called.isError).toBe(true);
      expectNoStdoutWrites(spies);
    } finally {
      await harness.close();
    }
  });
});

describe('the logger writes to stderr', () => {
  it('routes every level through console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      expect(errorSpy).toHaveBeenCalledTimes(4);
      expectNoStdoutWrites(spies);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('respects the level filter without falling back to stdout', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setLogLevel('error');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      expect(errorSpy).not.toHaveBeenCalled();
      logger.error('e');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expectNoStdoutWrites(spies);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits nothing at all when silenced', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setLogLevel('silent');
      logger.error('e', new Error('boom'));
      expect(errorSpy).not.toHaveBeenCalled();
      expectNoStdoutWrites(spies);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /**
   * Finding L5. `Object.assign(record, payload)` let a context key named `msg`,
   * `level` or `time` overwrite the record's own field. That is not merely a lost
   * context value: it replaces the diagnostic's message or its severity with text
   * from a call site — or, on the error path, from a redacted vendor error — and a
   * supervisor parsing the stream files the line under the wrong level.
   */
  it.each(['msg', 'level', 'time'])(
    "never lets a context key named %s overwrite the record's own field",
    (reserved) => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        setLogLevel('info');
        logger.warn('the real message', { [reserved]: 'HIJACKED', tool: 'lumics_list_devices' });

        const parsed = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
        expect(parsed.msg).toBe('the real message');
        expect(parsed.level).toBe('warn');
        expect(typeof parsed.time).toBe('string');
        expect(parsed[reserved]).not.toBe('HIJACKED');
        // The value is kept, namespaced, rather than silently discarded.
        expect(parsed[`ctx.${reserved}`]).toBe('HIJACKED');
        // Ordinary keys are untouched.
        expect(parsed.tool).toBe('lumics_list_devices');
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it('keeps the level honest even when an error payload carries a level key', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      setLogLevel('info');
      logger.error('tool failed', new Error('boom'), {
        level: 'debug',
        msg: 'nothing to see here',
      });
      const parsed = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(parsed.level).toBe('error');
      expect(parsed.msg).toBe('tool failed');
      expect(parsed['ctx.level']).toBe('debug');
      expect(parsed.err).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('emits a parseable line for a payload that would otherwise not serialise', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cyclic: Record<string, unknown> = { name: 'response' };
      cyclic.self = cyclic;
      // `redact()` flattens cycles, BigInts and functions before the logger ever
      // reaches `JSON.stringify`, which is why the logger's own
      // "payload unserialisable" fallback is defence rather than a live path.
      logger.info('awkward payload', { cyclic, big: 1n, fn: () => undefined });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(parsed.msg).toBe('awkward payload');
      expect(JSON.stringify(parsed)).toContain('[Circular]');
      expectNoStdoutWrites(spies);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
