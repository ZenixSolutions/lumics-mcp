/**
 * Streamable HTTP transport (RFC-001 D3), hardened from the first commit.
 *
 * The prototype's HTTP transport was unauthenticated, bound to every interface,
 * and had no DNS-rebinding protection. That is a remote-code-path into a
 * customer's monitoring platform, so this one is built the other way round —
 * every control is on by default and widening it is an explicit act by the
 * operator:
 *
 *  - **Bearer auth required.** `Authorization: Bearer <LUMICS_HTTP_AUTH_TOKEN>`,
 *    compared in constant time. Config refuses to start without a token of at
 *    least 32 characters.
 *  - **DNS-rebinding protection** via the SDK's own `hostHeaderValidation`
 *    middleware (through `createMcpExpressApp`), with an explicit host allowlist.
 *    Preferred over hand-rolling because the SDK's version is the one the SDK's
 *    own tests cover.
 *  - **Loopback bind by default** (`127.0.0.1`).
 *  - **Origin allowlist**, empty by default: no browser origin is trusted unless
 *    named.
 *  - **Rate limiting** on the MCP path.
 *  - **Error middleware that never emits a stack trace.** Stacks go to stderr
 *    through the redacting logger; the client gets a JSON-RPC error and nothing
 *    else.
 *
 * `express` and `express-rate-limit` are declared as **direct** dependencies in
 * `package.json`. They are also transitive dependencies of the MCP SDK, and the
 * prototype imported express while relying on that — which breaks silently the
 * day the SDK swaps to Hono.
 *
 * Sessions are per-client: each `initialize` gets its own transport and its own
 * `McpServer`, so one client's state cannot leak into another's.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LumicsConfig } from '../config.js';
import {
  HTTP_MAX_BODY_BYTES,
  HTTP_RATE_LIMIT_MAX,
  HTTP_RATE_LIMIT_WINDOW_MS,
  MCP_HTTP_PATH,
} from '../constants.js';
import { logger } from '../util/logger.js';

/** JSON-RPC error codes used for transport-level refusals. */
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface HttpHandle {
  readonly httpServer: NodeHttpServer;
  readonly url: string;
  /** Stop accepting connections and close every live session. Idempotent. */
  close(): Promise<void>;
}

/**
 * Factory for a per-session `McpServer`. Each session gets a fresh instance so
 * two clients never share tool state.
 */
export type ServerFactory = () => McpServer;

interface Session {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

/**
 * Start the hardened HTTP listener.
 *
 * @param createServer Called once per `initialize` request. Pass
 *   `() => buildServer(config).server`.
 */
export async function startHttpTransport(
  config: LumicsConfig,
  createServer: ServerFactory,
): Promise<HttpHandle> {
  const httpConfig = config.http;
  if (httpConfig === undefined) {
    // Unreachable via `loadConfig`, which builds `http` whenever the transport is
    // http. Checked because the alternative is a confusing crash inside express.
    throw new Error(
      'LUMICS_TRANSPORT=http requires HTTP configuration; loadConfig should have supplied it.',
    );
  }

  // SDK-provided app: applies `hostHeaderValidation(allowedHosts)` for us, so
  // DNS-rebinding protection is active before any of our handlers run.
  const app: Express = createMcpExpressApp({
    host: httpConfig.host,
    allowedHosts: [...httpConfig.allowedHosts],
  });

  app.disable('x-powered-by');
  app.use(originAllowlist(httpConfig.allowedOrigins));
  app.use(
    MCP_HTTP_PATH,
    rateLimit({
      windowMs: HTTP_RATE_LIMIT_WINDOW_MS,
      limit: HTTP_RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests. Slow down.' },
    }),
  );
  app.use(MCP_HTTP_PATH, bearerAuth(httpConfig.authToken));
  app.use(MCP_HTTP_PATH, express.json({ limit: HTTP_MAX_BODY_BYTES }));

  const sessions = new Map<string, Session>();

  // POST carries every client-to-server JSON-RPC message.
  app.post(MCP_HTTP_PATH, (req: Request, res: Response, next: NextFunction) => {
    void handlePost(req, res, sessions, createServer).catch(next);
  });

  // GET opens the server-to-client SSE stream; DELETE terminates a session.
  // Both require an existing session, so they share a lookup path.
  const bySession = (req: Request, res: Response, next: NextFunction): void => {
    void handleSessionScoped(req, res, sessions).catch(next);
  };
  app.get(MCP_HTTP_PATH, bySession);
  app.delete(MCP_HTTP_PATH, bySession);

  app.use(errorMiddleware);

  const httpServer = await listen(app, httpConfig.port, httpConfig.host);
  const url = `http://${formatHost(httpConfig.host)}:${String(httpConfig.port)}${MCP_HTTP_PATH}`;

  logger.info('lumics-mcp listening on streamable http', {
    url,
    allowedHosts: [...httpConfig.allowedHosts],
    allowedOrigins: [...httpConfig.allowedOrigins],
    rateLimit: { windowMs: HTTP_RATE_LIMIT_WINDOW_MS, max: HTTP_RATE_LIMIT_MAX },
  });

  if (
    httpConfig.host !== '127.0.0.1' &&
    httpConfig.host !== 'localhost' &&
    httpConfig.host !== '::1'
  ) {
    logger.warn(
      'LUMICS_HTTP_HOST is not loopback. This listener speaks plain HTTP and holds a Lumics API token; put TLS and an authenticating proxy in front of it before exposing it.',
      { host: httpConfig.host },
    );
  }

  let closed = false;
  return {
    httpServer,
    url,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;

      await Promise.allSettled([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();

      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    },
  };
}

async function handlePost(
  req: Request,
  res: Response,
  sessions: Map<string, Session>,
  createServer: ServerFactory,
): Promise<void> {
  const sessionId = readSessionId(req);

  if (sessionId !== undefined) {
    const existing = sessions.get(sessionId);
    if (existing === undefined) {
      writeJsonRpcError(
        res,
        404,
        JSONRPC_INVALID_REQUEST,
        'Unknown or expired session. Re-initialize.',
      );
      return;
    }
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    writeJsonRpcError(
      res,
      400,
      JSONRPC_INVALID_REQUEST,
      'Missing Mcp-Session-Id header. Send an initialize request first.',
    );
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId: string) => {
      sessions.set(newSessionId, { server, transport });
      logger.info('mcp session initialized', {
        sessionId: newSessionId,
        sessionCount: sessions.size,
      });
    },
    onsessionclosed: (closedSessionId: string) => {
      sessions.delete(closedSessionId);
      logger.info('mcp session closed', {
        sessionId: closedSessionId,
        sessionCount: sessions.size,
      });
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id !== undefined) {
      sessions.delete(id);
    }
  };

  // `StreamableHTTPServerTransport` exposes `onclose`/`onerror`/`onmessage` as
  // accessor pairs whose getters return `T | undefined` while `Transport`
  // declares them as optional properties. Under `exactOptionalPropertyTypes`
  // those are not structurally assignable, which is an SDK 1.30.0 typing quirk
  // rather than a real mismatch — the runtime contract is identical. Narrowed to
  // `Transport` here so the cast is one line with one reason.
  await server.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, req.body);
}

async function handleSessionScoped(
  req: Request,
  res: Response,
  sessions: Map<string, Session>,
): Promise<void> {
  const sessionId = readSessionId(req);
  if (sessionId === undefined) {
    writeJsonRpcError(res, 400, JSONRPC_INVALID_REQUEST, 'Missing Mcp-Session-Id header.');
    return;
  }
  const session = sessions.get(sessionId);
  if (session === undefined) {
    writeJsonRpcError(res, 404, JSONRPC_INVALID_REQUEST, 'Unknown or expired session.');
    return;
  }
  await session.transport.handleRequest(req, res);
}

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * secret's length, so both sides are hashed to a fixed width first — comparing
 * digests rather than raw bytes makes the comparison length-independent.
 */
function bearerAuth(
  expectedToken: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const expected = digest(expectedToken);

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization');
    const presented =
      header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length).trim() : undefined;

    if (presented === undefined || presented.length === 0) {
      res.status(401).set('WWW-Authenticate', 'Bearer realm="lumics-mcp"').json({
        error: 'Authorization required: send Authorization: Bearer <LUMICS_HTTP_AUTH_TOKEN>.',
      });
      return;
    }

    if (!timingSafeEqual(digest(presented), expected)) {
      // Deliberately identical to the missing-credential path in everything but
      // the status: no hint about whether the token was close.
      // Worded to avoid the phrase "bearer <word>", which the redactor treats as
      // credential material and would mask — leaving an unreadable log line.
      logger.warn('rejected http request: presented credential did not match', {
        ip: req.ip ?? 'unknown',
      });
      res.status(403).json({ error: 'Invalid credential.' });
      return;
    }

    next();
  };
}

/**
 * Origin allowlist for DNS-rebinding and CORS protection. Empty allowlist means
 * no cross-origin browser client is permitted; requests without an `Origin`
 * header (the normal case for a native MCP client) pass through untouched.
 */
function originAllowlist(
  allowedOrigins: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set(allowedOrigins);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (origin === undefined) {
      next();
      return;
    }
    if (!allowed.has(origin)) {
      logger.warn('rejected http request from disallowed origin', { origin });
      res.status(403).json({ error: 'Origin not allowed. Add it to LUMICS_HTTP_ALLOWED_ORIGINS.' });
      return;
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
    );
    res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    res.set('Vary', 'Origin');
    next();
  };
}

/**
 * Terminal error handler. Logs the full redacted error to stderr and returns a
 * generic JSON-RPC error — **never** a stack trace, a file path, or a message
 * that could carry credential material (RFC-001 D3).
 */
function errorMiddleware(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  logger.error('unhandled http transport error', error);
  if (res.headersSent) {
    // The SDK transport may already be streaming SSE; ending it here would
    // truncate a response mid-frame. Let express finish the connection.
    next(error);
    return;
  }
  writeJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, 'Internal server error.');
}

function writeJsonRpcError(res: Response, httpStatus: number, code: number, message: string): void {
  res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function readSessionId(req: Request): string | undefined {
  const value = req.get('mcp-session-id');
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

/** Fixed-width digest so the comparison above is length-independent. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function listen(app: Express, port: number, host: string): Promise<NodeHttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      resolve(server);
    });
    server.once('error', reject);
  });
}

/** `[::1]` must keep its brackets in a URL; a bare IPv6 literal is invalid. */
function formatHost(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}
