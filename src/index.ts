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
import { logger } from './util/logger.js';
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

  loadDotEnvIfPresent();

  const config: LumicsConfig = loadConfig();
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
 * Load `.env` when one is present, using Node's built-in loader so no dotenv
 * dependency is added. `.env.example` tells developers to copy it to `.env`, so
 * without this the documented workflow would not work.
 *
 * Real environment variables always win: `loadEnvFile` does not overwrite them.
 */
function loadDotEnvIfPresent(): void {
  const loadEnvFile = (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loadEnvFile !== 'function') {
    return;
  }
  try {
    loadEnvFile('.env');
  } catch {
    // No .env, or unreadable. Both are normal — the file is optional and
    // configuration may come entirely from the client's env block.
  }
}

main().catch((error: unknown) => {
  // The one place a configuration failure surfaces. `loadConfig` throws a
  // multi-line, actionable message; anything else is redacted before it is seen.
  logger.error(`${SERVER_NAME} failed to start: ${redactedMessage(error)}`, error);
  process.exit(1);
});
