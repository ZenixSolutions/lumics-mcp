/**
 * INSTALLATION: the built artefact actually speaks MCP over stdio.
 *
 * Everything else in this suite runs in process. That is the right default, but
 * it cannot prove the two things that only a real child process can:
 *
 *  1. `dist/index.js` starts, reads its configuration from the environment, and
 *     answers a real `initialize` followed by a real `tools/list`.
 *  2. **stdout carries nothing but JSON-RPC frames.** On stdio, stdout is the
 *     protocol channel. An in-process spy can show that no `console.log` is
 *     called; only a real process can show that fd 1 is clean — which is the
 *     property a client actually depends on.
 *
 * Credentials are dummies: `LUMICS_TOKEN=dummy` and 24 zeros for the company id.
 * The server never issues a request during `initialize` or `tools/list`, so no
 * network access is needed and no real credential is involved.
 *
 * Skips cleanly when `dist/` is absent, so `npm test` works on a fresh clone
 * before `npm run build`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(REPO_ROOT, 'dist', 'index.js');
const BUILT = existsSync(ENTRY);

/** Every tool the default configuration registers; 39 declared minus 2 gated. */
const EXPECTED_TOOL_COUNT = 37;

interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
  readonly method?: string;
}

interface Session {
  readonly responses: readonly JsonRpcResponse[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Spawn the built server, write newline-delimited JSON-RPC requests to stdin,
 * and collect everything both streams produce.
 */
async function runSession(
  requests: readonly unknown[],
  env: Record<string, string>,
): Promise<Session> {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: {
      // A clean environment: PATH for node, nothing inherited that could supply a
      // real credential from the developer's shell.
      PATH: process.env.PATH ?? '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const settled = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  // Give the server time to answer, then close stdin so it shuts down.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 100));
    if (countFrames(stdout) >= requests.filter(isRequest).length) {
      break;
    }
  }

  child.stdin.end();
  child.kill('SIGTERM');
  const exitCode = await Promise.race([
    settled,
    new Promise<number | null>((resolveExit) => setTimeout(() => resolveExit(null), 3_000)),
  ]);

  return { responses: parseFrames(stdout), stdout, stderr, exitCode };
}

function isRequest(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'id' in message;
}

function countFrames(stdout: string): number {
  return parseFrames(stdout).filter((frame) => frame.id !== undefined).length;
}

/** Parse newline-delimited JSON, failing loudly on any line that is not JSON. */
function parseFrames(stdout: string): JsonRpcResponse[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const DUMMY_ENV = {
  LUMICS_TOKEN: 'dummy',
  LUMICS_COMPANY_ID: '000000000000000000000000',
  // Point at an unroutable host so an accidental request fails fast rather than
  // reaching anything real. Nothing here should issue one.
  LUMICS_BASE_URL: 'http://127.0.0.1:1/api/v1',
} as const;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lumics-mcp-installation-test', version: '0.0.0' },
  },
};

const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

describe.skipIf(!BUILT)('the built dist/index.js speaks MCP over stdio', () => {
  it('answers initialize and tools/list with valid JSON-RPC, and keeps stdout clean', async () => {
    const session = await runSession([INITIALIZE, INITIALIZED, LIST_TOOLS], { ...DUMMY_ENV });

    // Every line on stdout parsed as JSON — `parseFrames` throws otherwise — and
    // every one of them is a JSON-RPC 2.0 message. A single stray `console.log`
    // would break this.
    expect(session.responses.length).toBeGreaterThanOrEqual(2);
    for (const frame of session.responses) {
      expect(frame.jsonrpc, `non-JSON-RPC frame on stdout: ${JSON.stringify(frame)}`).toBe('2.0');
    }

    const initialize = session.responses.find((frame) => frame.id === 1);
    expect(initialize?.error).toBeUndefined();
    expect(initialize?.result?.protocolVersion).toBeDefined();
    expect(initialize?.result?.serverInfo).toMatchObject({ name: 'lumics-mcp' });
    expect(initialize?.result?.capabilities).toMatchObject({ tools: expect.anything() as unknown });

    const listed = session.responses.find((frame) => frame.id === 2);
    expect(listed?.error).toBeUndefined();
    const tools = (listed?.result?.tools ?? []) as { name: string }[];
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^lumics_/);
    }
  }, 30_000);

  it('writes its diagnostics to stderr, where they cannot corrupt the protocol', async () => {
    const session = await runSession([INITIALIZE, INITIALIZED, LIST_TOOLS], { ...DUMMY_ENV });

    // The startup log line lands on stderr, not stdout.
    expect(session.stderr).toContain('lumics-mcp server built');
    expect(session.stdout).not.toContain('lumics-mcp server built');

    // And it is parseable newline-delimited JSON.
    const stderrLines = session.stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    expect(stderrLines.length).toBeGreaterThan(0);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  }, 30_000);

  it('registers only read tools when LUMICS_READ_ONLY is set in the client env block', async () => {
    const session = await runSession([INITIALIZE, INITIALIZED, LIST_TOOLS], {
      ...DUMMY_ENV,
      LUMICS_READ_ONLY: '1',
    });

    const tools = (session.responses.find((frame) => frame.id === 2)?.result?.tools ?? []) as {
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    expect(tools).toHaveLength(20);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} is not read-only`).toBe(true);
    }
  }, 30_000);

  it('exits non-zero with an actionable message when configuration is invalid', async () => {
    // A malformed company id rather than a missing one: `LUMICS_COMPANY_ID` is
    // optional now (finding H6), so its absence is a supported state and cannot be
    // the fixture for a configuration failure.
    const session = await runSession([INITIALIZE], {
      LUMICS_TOKEN: 'dummy',
      LUMICS_COMPANY_ID: 'not-an-object-id',
    });

    // Nothing at all on stdout: a configuration failure must not emit a partial
    // protocol frame that a client would try to parse.
    expect(session.stdout.trim()).toBe('');
    expect(session.stderr).toContain('LUMICS_COMPANY_ID');
    expect(session.stderr).toContain('No request was made and no credential was read');
    expect(session.exitCode).toBe(1);
  }, 30_000);

  it('still refuses to start with no LUMICS_TOKEN at all', async () => {
    const session = await runSession([INITIALIZE], { LUMICS_COMPANY_ID: '0'.repeat(24) });
    expect(session.stdout.trim()).toBe('');
    expect(session.stderr).toContain('LUMICS_TOKEN');
    expect(session.exitCode).toBe(1);
  }, 30_000);

  /**
   * Finding H6, through the built artefact. The server used to refuse to start
   * without `LUMICS_COMPANY_ID`, while the documented way to find one is
   * `lumics_get_me` — which needs a running server.
   */
  it('starts without LUMICS_COMPANY_ID and offers the bootstrap surface', async () => {
    const session = await runSession([INITIALIZE, INITIALIZED, LIST_TOOLS], {
      LUMICS_TOKEN: 'dummy',
      LUMICS_BASE_URL: DUMMY_ENV.LUMICS_BASE_URL,
    });

    expect(session.exitCode).not.toBe(1);
    const tools = (session.responses.find((frame) => frame.id === 2)?.result?.tools ?? []) as {
      name: string;
    }[];
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('lumics_get_me');
    expect(names).not.toContain('lumics_list_devices');
    expect(names.length).toBeGreaterThan(0);
    expect(names.length).toBeLessThan(EXPECTED_TOOL_COUNT);
    // And the operator is told why the surface is small, on stderr.
    expect(session.stderr).toContain('LUMICS_COMPANY_ID is not set');
    expect(session.stderr).toContain('lumics_get_me');
  }, 30_000);

  /**
   * Finding M8. ADR-001 decision 3 is "v0.1 transport: stdio", and its Security
   * Impact says v0.1 "opens no network listener at all" — while the code shipped a
   * working Express listener behind `LUMICS_TRANSPORT=http`.
   */
  it('refuses LUMICS_TRANSPORT=http and opens no listener', async () => {
    const session = await runSession([INITIALIZE], {
      ...DUMMY_ENV,
      LUMICS_TRANSPORT: 'http',
      LUMICS_HTTP_AUTH_TOKEN: 'placeholder-http-secret-32-chars',
    });

    expect(session.exitCode).toBe(1);
    expect(session.stdout.trim()).toBe('');
    expect(session.stderr).toContain('HTTP transport is not available in this release');
    expect(session.stderr).toContain('ADR-001');
    expect(session.stderr).not.toContain('placeholder-http-secret-32-chars');
  }, 30_000);

  it('never echoes the configured token on either stream', async () => {
    const session = await runSession([INITIALIZE, INITIALIZED, LIST_TOOLS], {
      ...DUMMY_ENV,
      // Long enough for the redactor's exact-value layer to accept it.
      LUMICS_TOKEN: 'placeholder-token-do-not-use-abcdefgh',
    });
    expect(session.stdout).not.toContain('placeholder-token-do-not-use-abcdefgh');
    expect(session.stderr).not.toContain('placeholder-token-do-not-use-abcdefgh');
  }, 30_000);
});

/**
 * Finding R8. `src/index.ts` imported `./transport/http.js` at the top level, so
 * every stdio start paid roughly 230ms loading Express and express-rate-limit for
 * a transport it never uses — and, in 0.1.0, for a transport `loadConfig` refuses.
 * The import moved inside the branch.
 *
 * Asserted against the source rather than by timing a start-up, because a timing
 * assertion on a shared CI runner is a flaky test pretending to be a guarantee.
 */
describe('the HTTP transport is not loaded on a stdio start (finding R8)', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf8');

  it('has no top-level import of the http transport', () => {
    expect(source).not.toMatch(/^import .*transport\/http\.js/m);
  });

  it('imports it dynamically, inside the branch that needs it', () => {
    expect(source).toContain("await import('./transport/http.js')");
  });

  it('still imports the stdio transport statically, since it is always used', () => {
    expect(source).toMatch(/^import .*transport\/stdio\.js/m);
  });
});

describe.skipIf(BUILT)('installation test skipped', () => {
  it('reports that dist/ is absent rather than passing silently', () => {
    // Not a failure: `npm test` on a fresh clone runs before `npm run build`.
    expect(BUILT).toBe(false);
  });
});
