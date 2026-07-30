/**
 * `buildServer(config)` — the composition root.
 *
 * **It does not start a transport.** The prototype's entry point connected stdio
 * as an import side effect, which made the whole server untestable in process:
 * you could not construct one, list its tools, and call one without hijacking
 * `process.stdin`. RFC-001 D2 fixes that by separating construction from
 * connection. `src/index.ts` chooses and starts a transport; this file only
 * assembles.
 *
 * This is also the module `package.json` points `main` at, so importing the
 * package must remain free of side effects beyond module evaluation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LumicsClient, type LumicsClientOptions } from './api/client.js';
import { describeConfig, type LumicsConfig } from './config.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import { createToolContext, registerTools, type LumicsToolDefinition } from './tools/factory.js';
import { collectorTools } from './tools/collectors.js';
import { componentTools } from './tools/components.js';
import { deviceTools } from './tools/devices.js';
import { ipamTools } from './tools/ipam.js';
import { meTools } from './tools/me.js';
import { metricTools } from './tools/metrics.js';
import { logger } from './util/logger.js';

/**
 * Every tool module registered by this server, in the order they appear in
 * `docs/reference/lumics-api-v1.md`.
 *
 * Add a module's exported array here and nowhere else. Do not add registration
 * logic — `registerTools` owns gating, and a module that registers itself
 * bypasses `LUMICS_READ_ONLY`.
 */
const ALL_TOOLS: readonly LumicsToolDefinition[] = [
  ...collectorTools, // spec §5
  ...componentTools, // spec §6
  ...deviceTools, // spec §7
  ...ipamTools, // spec §8–§10
  ...meTools, // spec §11
  ...metricTools, // spec §12
];

export interface BuildServerOptions {
  /** Client overrides. Tests inject `fetchImpl` and `sleep`; production does not. */
  readonly clientOptions?: LumicsClientOptions;
  /** Override the tool set. Tests use this to register a single tool. */
  readonly tools?: readonly LumicsToolDefinition[];
}

export interface BuiltServer {
  readonly server: McpServer;
  readonly client: LumicsClient;
  readonly registeredToolNames: readonly string[];
}

/**
 * Assemble a configured {@link McpServer}. Pure with respect to I/O: no socket
 * is opened and no request is made until a transport is connected and a client
 * calls something.
 */
export function buildServer(config: LumicsConfig, options: BuildServerOptions = {}): BuiltServer {
  const client = new LumicsClient(config, options.clientOptions ?? {});
  const context = createToolContext(client, config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Tools for the Lumics network monitoring platform (devices, collectors, components, IPAM and metrics). ' +
        'Two things to know before you use them. First, the Lumics API has NO pagination: the only result control ' +
        'is a "limit" parameter, list responses carry no total, and there is no offset, page, cursor or sort — so ' +
        'when a list comes back exactly as long as the limit you asked for, treat it as possibly incomplete and say ' +
        'so. Second, you never need to compute epoch milliseconds: metric tools accept a relative window such as ' +
        '"6h" or an ISO-8601 timestamp and convert it for you.',
    },
  );

  const summary = registerTools(server, context, options.tools ?? ALL_TOOLS);

  logger.info('lumics-mcp server built', {
    version: SERVER_VERSION,
    // Never the config object itself; `describeConfig` omits every secret.
    config: describeConfig(config),
    toolCount: summary.registered.length,
    tools: summary.registered,
    ...(summary.skippedReadOnly.length > 0 ? { skippedReadOnly: summary.skippedReadOnly } : {}),
    ...(summary.skippedFeatureFlag.length > 0
      ? { skippedFeatureFlag: summary.skippedFeatureFlag }
      : {}),
    ...(summary.skippedNoCompany.length > 0 ? { skippedNoCompany: summary.skippedNoCompany } : {}),
  });

  if (config.readOnly) {
    logger.info(
      'LUMICS_READ_ONLY is set: only read tools are registered, so no write tool is visible to the model.',
    );
  }

  if (summary.skippedNoCompany.length > 0) {
    logger.warn(
      `LUMICS_COMPANY_ID is not set, so ${String(summary.skippedNoCompany.length)} company-scoped tool(s) were not registered. ` +
        'Call lumics_get_me through this server to read your company id, set LUMICS_COMPANY_ID to that value, and restart. ' +
        'Until then only the tools that need no company are available.',
    );
  }

  return { server, client, registeredToolNames: summary.registered };
}

/** The tool set `buildServer` uses by default. Exported for tests and docs. */
export function allToolDefinitions(): readonly LumicsToolDefinition[] {
  return ALL_TOOLS;
}
