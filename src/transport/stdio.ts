/**
 * stdio transport (RFC-001 D3, v0.1).
 *
 * No domain knowledge lives here — it wires an already-built `McpServer` to
 * `process.stdin` / `process.stdout` and nothing else.
 *
 * The reason `src/util/logger.ts` is the only module allowed to touch `console`
 * is this transport: **stdout is the JSON-RPC frame channel**. Anything else
 * written there is interleaved with protocol frames, the client fails to parse,
 * and the visible symptom is "server disconnected" with no clue as to the cause.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../util/logger.js';

export interface StdioHandle {
  readonly transport: StdioServerTransport;
  /** Close the transport and the server. Idempotent. */
  close(): Promise<void>;
}

/** Connect `server` to stdio and start reading frames. */
export async function startStdioTransport(server: McpServer): Promise<StdioHandle> {
  const transport = new StdioServerTransport();

  transport.onerror = (error: Error) => {
    // Redaction happens inside the logger; the raw error never reaches a stream.
    logger.error('stdio transport error', error);
  };

  await server.connect(transport);
  logger.info('lumics-mcp listening on stdio');

  let closed = false;
  return {
    transport,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      // Close the server first: it owns the transport once connected, and
      // closing in the other order can drop an in-flight response.
      await server.close();
    },
  };
}
