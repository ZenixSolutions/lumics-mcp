#!/usr/bin/env node
/**
 * Thin bin. Parse the environment, build the server, start one transport, and
 * shut down cleanly. No business logic lives here — `buildServer()` is in
 * `src/server.ts` precisely so that importing this package does not start a
 * transport as a side effect (RFC-001 D2).
 *
 * Everything this file logs goes through the redacting logger to **stderr**. A
 * process-level handler that printed a raw error to stdout would corrupt the
 * stdio protocol stream and could echo the Lumics token from a `fetch` error's
 * request headers.
 */

import { loadConfig, type LumicsConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { buildServer } from './server.js';
import { startStdioTransport } from './transport/stdio.js';
import { logger, setLogLevel } from './util/logger.js';
import { redactedMessage } from './util/redact.js';

interface Shutdownable {
  close(): Promise<void>;
}

async function main(): Promise<void> {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    // Version goes to stderr like everything else: stdout belongs to the
    // protocol, even for a one-shot flag, and a client that inspects stdout
    // must never find non-JSON-RPC bytes there.
    logger.info(`${SERVER_NAME} ${SERVER_VERSION}`);
    return;
  }

  // The environment is read exactly as the process received it. Nothing here
  // discovers a `.env`, and nothing should: see the note at the foot of this file.
  const config: LumicsConfig = loadConfig();

  // Before anything can log. `loadConfig` only parses the level; applying it is a
  // process-wide side effect and belongs in the entry point, so importing the
  // package cannot change a host application's logging.
  setLogLevel(config.logLevel);

  const handle = await start(config);

  installProcessHandlers(handle);
}

async function start(config: LumicsConfig): Promise<Shutdownable> {
  if (config.transport === 'http') {
    // Imported dynamically, inside the branch. `./transport/http.js` pulls in
    // Express and express-rate-limit, roughly 230ms of module evaluation, and a
    // stdio start has no use for any of it. `loadConfig` currently refuses
    // `LUMICS_TRANSPORT=http` (ADR-001 decision 3), so this branch is unreachable
    // in 0.1.0 and kept so that v0.2 is additive.
    const { startHttpTransport } = await import('./transport/http.js');
    // A fresh McpServer per session; see `startHttpTransport`.
    return startHttpTransport(config, () => buildServer(config).server);
  }
  const { server } = buildServer(config);
  return startStdioTransport(server);
}

/**
 * Register signal and last-resort handlers.
 *
 * `unhandledRejection` and `uncaughtException` are logged through the redactor
 * and then the process exits non-zero. Continuing after an uncaught exception
 * leaves the server in an unknown state while still holding a live API token,
 * which is worse than a restart.
 */
function installProcessHandlers(handle: Shutdownable): void {
  let shuttingDown = false;

  const shutdown = (signal: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('shutting down', { signal });

    handle
      .close()
      .then(
        () => {
          process.exit(exitCode);
        },
        (error: unknown) => {
          logger.error('error during shutdown', error);
          process.exit(1);
        },
      )
      .catch(() => {
        process.exit(1);
      });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM', 0);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled promise rejection', reason);
    shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error: unknown) => {
    logger.error('uncaught exception', error);
    shutdown('uncaughtException', 1);
  });
}

/**
 * No implicit `.env` load. This file used to hand Node's own dotenv loader the
 * **relative** path `.env`, which for the published binary meant whatever
 * directory the MCP client happened to launch the server from — a user's
 * workspace, a cloned repository, a directory the very agent this server serves
 * can write to. A planted file could redirect `LUMICS_BASE_URL` (the token is a
 * bearer credential, so that is exfiltration, reproduced against a loopback sink)
 * and open every `LUMICS_ENABLE_*` gate the operator had left unset, which is all
 * of them by default. Real environment variables won, so only the defaults were
 * hijackable — and the defaults are the security posture.
 *
 * Local development uses Node's own flag, which is explicit and chosen by the
 * operator rather than discovered from the filesystem:
 *
 *   node --env-file=.env dist/index.js
 *
 * Every documented client install passes the variables in the client's own `env`
 * block instead. Verified by `tests/security/dotenv-not-loaded.test.ts`.
 */

main().catch((error: unknown) => {
  // The one place a configuration failure surfaces. `loadConfig` throws a
  // multi-line, actionable message; anything else is redacted before it is seen.
  logger.error(`${SERVER_NAME} failed to start: ${redactedMessage(error)}`, error);
  process.exit(1);
});
