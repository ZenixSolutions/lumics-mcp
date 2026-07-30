/**
 * In-process MCP harness.
 *
 * `buildServer(config, {clientOptions, tools})` exists so a whole server can be
 * assembled, connected to an in-memory transport, and driven through real
 * `tools/list` and `tools/call` requests without a child process or a socket.
 * Tests that assert on *registration* (read-only filtering, feature-flag gating)
 * must go through this rather than inspecting the definition array, because
 * "absent from tools/list" is the actual security property.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { buildServer, type BuildServerOptions } from '../../src/server.js';
import type { LumicsConfig } from '../../src/config.js';
import type { LumicsToolDefinition, ToolContext } from '../../src/tools/factory.js';

export interface Harness {
  readonly client: Client;
  readonly tools: readonly Tool[];
  tool(name: string): Tool | undefined;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** The text of the single content block a lumics tool returns. */
  text(name: string, args?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Build a server, connect an in-memory client, and list its tools. */
export async function connect(
  config: LumicsConfig,
  options: BuildServerOptions = {},
): Promise<Harness> {
  const { server } = buildServer(config, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lumics-mcp-tests', version: '0.0.0' });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const listed = await client.listTools();
  const tools = listed.tools;

  return {
    client,
    tools,
    tool: (name) => tools.find((candidate) => candidate.name === name),
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    text: async (name, args = {}) => {
      const called = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return firstText(called);
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Extract the single text block, failing loudly on any other shape. */
export function firstText(result: CallToolResult): string {
  const block = result.content[0];
  if (result.content.length !== 1 || block === undefined || block.type !== 'text') {
    throw new Error(
      `expected exactly one text content block, got ${JSON.stringify(result.content).slice(0, 200)}`,
    );
  }
  return block.text;
}

/** Parse the JSON payload out of a shaped tool result, ignoring leading notes. */
export function payloadOf(text: string): unknown {
  const start = text.search(/[[{]/);
  const candidates = start === -1 ? [text] : [text.slice(start), text];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  throw new Error(`no JSON payload found in tool output: ${text.slice(0, 300)}`);
}

/** The notes portion of a shaped tool result (everything before the payload). */
export function notesOf(text: string): string {
  const start = text.search(/[[{]/);
  return start === -1 ? text : text.slice(0, start);
}

export interface RegisteredTool {
  readonly name: string;
  readonly config: {
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly annotations?: Record<string, unknown>;
  };
  readonly handler: (args: unknown) => Promise<CallToolResult>;
}

/**
 * A stand-in for `McpServer` that records `registerTool` calls, so a single
 * `defineTool` declaration can be exercised without the SDK's own argument
 * validation in the way. Used where the assertion is about the factory's
 * behaviour (the `confirm` guard, the read-only defence-in-depth check) rather
 * than about the protocol surface.
 */
export function recordingServer(): {
  readonly server: McpServer;
  readonly tools: RegisteredTool[];
} {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler'],
    ) {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

/** Register one definition against a recording server and return its handler. */
export function registerOne(
  definition: LumicsToolDefinition,
  context: ToolContext,
): RegisteredTool {
  const { server, tools } = recordingServer();
  definition.register(server, context);
  const only = tools[0];
  if (tools.length !== 1 || only === undefined) {
    throw new Error(`expected 1 registered tool, got ${String(tools.length)}`);
  }
  return only;
}
