/**
 * SECURITY: a `.env` file in the process working directory must not configure
 * this server.
 *
 * `src/index.ts` used to call `process.loadEnvFile('.env')` — a **relative**
 * path, so for the published binary it meant whatever directory the MCP client
 * happened to launch the server from: the user's workspace, a cloned repository,
 * a directory the very agent this server serves can write to. Two consequences,
 * both reproduced end to end before this test existed:
 *
 *  1. **Token exfiltration.** `LUMICS_BASE_URL` in that file redirected every
 *     request, so the bearer token was sent to a host of the file's choosing.
 *  2. **Gate escalation.** `LUMICS_ALLOW_CROSS_COMPANY`,
 *     `LUMICS_ENABLE_BATCH_UPDATE` and `LUMICS_ENABLE_TOKEN_REVOCATION` came
 *     back on, registering two tools that a default install does not have.
 *
 * Real environment variables always won (`loadEnvFile` does not overwrite), so
 * only variables the operator had left unset were hijackable — which is every
 * gate, by default. SECURITY.md says those flags are "set by the human who
 * deploys the server, out of band from any conversation, and no prompt can
 * change it"; Article VIII says a claim like that is verified by test, so here it
 * is. The load was removed entirely: local development uses Node's own
 * `node --env-file=.env dist/index.js`, which is explicit and operator-controlled.
 *
 * This runs the **built** artefact, because the defect lived in the entry point
 * and the working directory only exists for a real process. Credentials are
 * dummies and the `.env` points at a loopback sink, which is asserted to receive
 * nothing: no host outside this machine is contacted.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL } from '../../src/constants.js';
import { TEST_COMPANY_ID, TEST_TOKEN } from '../helpers/config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(REPO_ROOT, 'dist', 'index.js');
const BUILT = existsSync(ENTRY);

/** Every tool the default configuration registers; 39 declared minus 2 gated. */
const EXPECTED_TOOL_COUNT = 37;

interface JsonRpcResponse {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
}

interface StderrRecord {
  readonly msg?: string;
  readonly config?: Record<string, unknown>;
}

interface Session {
  readonly toolNames: readonly string[];
  /** The `describeConfig` summary the server logs at startup, from stderr. */
  readonly loggedConfig: Record<string, unknown>;
  readonly stderr: string;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'lumics-mcp-dotenv-test', version: '0.0.0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST_TOOLS = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

/**
 * Start the built server **with `cwd` set to the planted directory** and ask it
 * what it registered. The working directory is the whole point: it is what the
 * removed `loadEnvFile('.env')` resolved against.
 */
async function runInDirectory(cwd: string): Promise<Session> {
  const child = spawn(process.execPath, [ENTRY], {
    cwd,
    env: {
      // PATH only. Nothing from the developer's shell can supply a credential or,
      // more to the point here, a variable that would mask the planted one.
      PATH: process.env.PATH ?? '',
      LUMICS_TOKEN: TEST_TOKEN,
      LUMICS_COMPANY_ID: TEST_COMPANY_ID,
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

  for (const request of [INITIALIZE, INITIALIZED, LIST_TOOLS]) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 100));
    if (parseFrames(stdout).some((frame) => frame.id === 2)) {
      break;
    }
  }
  child.stdin.end();
  child.kill('SIGTERM');
  await new Promise((wait) => setTimeout(wait, 100));

  const listed = parseFrames(stdout).find((frame) => frame.id === 2);
  const tools = (listed?.result?.tools ?? []) as { name: string }[];
  const built = parseStderr(stderr).find((record) => record.msg === 'lumics-mcp server built');

  return {
    toolNames: tools.map((tool) => tool.name),
    loggedConfig: built?.config ?? {},
    stderr,
  };
}

function parseFrames(stdout: string): JsonRpcResponse[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

function parseStderr(stderr: string): StderrRecord[] {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as StderrRecord);
}

describe.skipIf(!BUILT)('a .env in the process working directory configures nothing', () => {
  let workdir: string;
  let sink: Server;
  let sinkRequests: string[];
  let sinkUrl: string;

  beforeEach(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'lumics-dotenv-'));
    sinkRequests = [];
    sink = createServer((request, response) => {
      // Reached only if the token leaves the process for the planted host. It
      // never should, so anything recorded here is the finding itself.
      sinkRequests.push(`${request.method ?? '?'} ${request.url ?? '?'}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((ready) => sink.listen(0, '127.0.0.1', ready));
    const address = sink.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    sinkUrl = `http://127.0.0.1:${String(port)}/api/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((closed) => {
      sink.close(() => {
        closed();
      });
    });
    rmSync(workdir, { recursive: true, force: true });
  });

  it('cannot redirect the API base URL, and so cannot exfiltrate the token', async () => {
    writeFileSync(join(workdir, '.env'), `LUMICS_BASE_URL=${sinkUrl}\n`);

    const session = await runInDirectory(workdir);

    expect(session.loggedConfig.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(session.stderr).not.toContain(sinkUrl);
    expect(sinkRequests).toEqual([]);
  }, 30_000);

  it('cannot open the cross-company or feature gates', async () => {
    writeFileSync(
      join(workdir, '.env'),
      [
        'LUMICS_ALLOW_CROSS_COMPANY=1',
        'LUMICS_ENABLE_BATCH_UPDATE=1',
        'LUMICS_ENABLE_TOKEN_REVOCATION=1',
        '',
      ].join('\n'),
    );

    const session = await runInDirectory(workdir);

    // The two gated tools stay unregistered: 39 declared minus 2.
    expect(session.toolNames).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(session.toolNames).not.toContain('lumics_batch_update_devices');
    expect(session.toolNames).not.toContain('lumics_revoke_tokens');
    expect(session.loggedConfig.allowCrossCompany).toBe(false);
    expect(session.loggedConfig.features).toEqual({
      batchUpdate: false,
      tokenRevocation: false,
    });
  }, 30_000);

  /**
   * The mirror image, and the reason this is not merely "the file is ignored, so
   * who cares": a planted `.env` must not be able to turn a control ON either,
   * because an operator who reads `LUMICS_READ_ONLY` in a file and sees read-only
   * tools would believe a protection is in force that the next launch — from a
   * different directory — silently drops.
   */
  it('cannot switch read-only mode on either', async () => {
    writeFileSync(join(workdir, '.env'), 'LUMICS_READ_ONLY=1\n');

    const session = await runInDirectory(workdir);

    expect(session.loggedConfig.readOnly).toBe(false);
    expect(session.toolNames).toHaveLength(EXPECTED_TOOL_COUNT);
  }, 30_000);

  it('does not even fail differently on a malformed .env', async () => {
    // A file the removed loader would have thrown on. The server must start
    // normally: it is not reading the file at all.
    writeFileSync(join(workdir, '.env'), 'this is not = a valid\x00 env file\n');

    const session = await runInDirectory(workdir);

    expect(session.toolNames).toHaveLength(EXPECTED_TOOL_COUNT);
    expect(session.loggedConfig.baseUrl).toBe(DEFAULT_BASE_URL);
  }, 30_000);
});

/**
 * Asserted against the source as well, so the control does not silently vanish
 * on a machine where `dist/` has not been built and the suite above skips.
 */
describe('the entry point reads no dotfile', () => {
  const source = readFileSync(resolve(REPO_ROOT, 'src', 'index.ts'), 'utf8');

  it('never calls process.loadEnvFile', () => {
    // A call, not a mention: the file explains at length why the load was removed,
    // and that explanation is the thing most likely to stop it coming back.
    expect(source).not.toMatch(/loadEnvFile\s*\(/);
    expect(source).not.toMatch(/loadEnvFile\s*=/);
  });

  it('names --env-file, the supported alternative, so the removal is not read as an oversight', () => {
    expect(source).toContain('--env-file');
  });
});

describe.skipIf(BUILT)('dotenv security test skipped', () => {
  it('reports that dist/ is absent rather than passing silently', () => {
    // Not a failure: `npm test` on a fresh clone runs before `npm run build`.
    // `npm run validate` builds first, so CI always runs the suite above.
    expect(BUILT).toBe(false);
  });
});
