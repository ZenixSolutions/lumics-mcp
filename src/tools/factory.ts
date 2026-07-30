/**
 * `defineTool` — the declaration-plus-factory abstraction every tool module uses.
 *
 * The prototype carried roughly 1,900 lines of copy-pasted handler boilerplate
 * across 39 tools: the same try/catch, the same `JSON.stringify(x, null, 2)`, the
 * same forgotten `encodeURIComponent`, the same missing gate. When a
 * cross-cutting concern lives in 39 places, it is wrong in at least one of them,
 * and nobody can tell which.
 *
 * So a tool here is a *declaration*. It states its name, its audience-facing
 * description, its input schema, its operation classification, and a handler that
 * returns plain data. Everything else is this module's job, done once:
 *
 *  - error mapping and redaction (`src/api/errors.ts`, `src/util/redact.ts`);
 *  - output shaping, projection and the token budget (`src/presentation/format.ts`);
 *  - the no-pagination completeness disclosure (spec §4.3);
 *  - MCP annotations derived from the classification, never hand-written;
 *  - registration gating from `LUMICS_READ_ONLY` and the `LUMICS_ENABLE_*` flags;
 *  - injection and enforcement of the `confirm` argument on risky operations;
 *  - resolving an omitted `companyId` from `LUMICS_COMPANY_ID`.
 *
 * A tool module exports `readonly LumicsToolDefinition[]`. `src/server.ts`
 * concatenates them and calls {@link registerTools} once.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { LumicsClient } from '../api/client.js';
import { describeError, LumicsInputError } from '../api/errors.js';
import type { FeatureFlags, LumicsConfig } from '../config.js';
import { shapeToolOutput } from '../presentation/format.js';
import { logger } from '../util/logger.js';
import { confirmSchema } from './schemas.js';

/**
 * Operation classification, per `standards/security-standard.md` ("classify
 * every public operation as Read, Create, Update, Admin, or Destructive").
 *
 * This is the *only* risk input. Annotations are derived from it (see
 * {@link annotationsFor}), so an annotation can never contradict the
 * classification — the prototype had `readOnlyHint: true` on a tool that wrote.
 *
 *  - `read`        — no state change. Registered even under `LUMICS_READ_ONLY`.
 *  - `create`      — adds a record. Not idempotent: a retry makes a second one.
 *  - `update`      — modifies an existing record in place. Idempotent.
 *  - `admin`       — account- or tenant-wide effect, or a bulk mutation.
 *  - `destructive` — removes data.
 */
export type ToolOperation = 'read' | 'create' | 'update' | 'admin' | 'destructive';

/** Feature-flag names a tool may gate on. Keys of {@link FeatureFlags}. */
export type FeatureFlagName = keyof FeatureFlags;

/** Everything a handler is given. Handlers never touch `process.env` directly. */
export interface ToolContext {
  readonly client: LumicsClient;
  readonly config: LumicsConfig;
  /**
   * Resolve an optional `companyId` argument against `LUMICS_COMPANY_ID`.
   * v0.1 is `companies`-only (RFC-001 open question 3, owner-approved), so this
   * replaces the `context`/`contextId` pair the API documents and the model
   * never has to reason about tenancy scope.
   */
  resolveCompanyId(explicit?: string): string;
}

/**
 * What a handler returns: the data, plus the metadata the presentation layer
 * needs to be honest about it. Use {@link result} to build one.
 */
export interface ToolOutput {
  /** Already unwrapped from any vendor envelope (spec §4.2). */
  readonly data: unknown;
  /**
   * The `limit` sent to Lumics. **List tools must set this.** It is what enables
   * the "results may be truncated and there is no pagination" disclosure; omit
   * it and the tool silently claims completeness it cannot verify (spec §4.3).
   */
  readonly requestedLimit?: number | undefined;
  /** Top-level field projection requested by the caller. */
  readonly fields?: readonly string[] | undefined;
  /** Extra disclosures, e.g. "ranked client-side because the API cannot sort". */
  readonly notes?: readonly string[] | undefined;
}

/** Convenience constructor for a {@link ToolOutput}. */
export function result(data: unknown, extra: Omit<ToolOutput, 'data'> = {}): ToolOutput {
  return { data, ...extra };
}

/**
 * A tool declaration. `Shape` is a zod raw shape (a plain object of zod schemas),
 * which is what the MCP SDK's `registerTool` accepts; handler arguments are
 * inferred from it, so there is no second place to keep in sync.
 */
export interface LumicsTool<Shape extends ZodRawShapeCompat> {
  /** Full tool name including the `lumics_` prefix, e.g. `lumics_list_devices`. */
  readonly name: string;
  /** Short human-facing label for a client's tool list, e.g. "List devices". */
  readonly title: string;
  /**
   * Written for a model, not for a human skimming a table. Say what the tool
   * returns, when to reach for it over a neighbouring tool, and any constraint
   * the model would otherwise have to discover from an error.
   */
  readonly description: string;
  readonly operation: ToolOperation;
  /**
   * Raw zod shape. Do **not** declare `confirm` — the factory injects it for
   * `admin` and `destructive` operations so it cannot be forgotten.
   */
  readonly inputSchema: Shape;
  /**
   * Environment flag that must be on for this tool to be registered at all.
   * Required for anything whose blast radius exceeds one record.
   */
  readonly featureFlag?: FeatureFlagName;
  /**
   * Whether this tool is scoped to a company and therefore cannot be registered
   * when `LUMICS_COMPANY_ID` is unset.
   *
   * Derived from the schema by default — a tool that declares a `companyId`
   * argument is company-scoped — so it cannot drift out of step with the surface.
   * Set it explicitly only for a tool whose scope the schema does not reveal.
   */
  readonly requiresCompany?: boolean;
  /** Do the work. Return data; do not format, stringify, or catch. */
  readonly handler: (args: ToolArgs<Shape>, context: ToolContext) => Promise<ToolOutput>;
}

/**
 * Inferred handler argument type for a declared shape. Uses the SDK's own
 * `ShapeOutput` so our inference cannot drift from what `registerTool` validates.
 */
export type ToolArgs<Shape extends ZodRawShapeCompat> = ShapeOutput<Shape>;

/**
 * A registerable tool with its generic erased, so a module can export a
 * heterogeneous `readonly LumicsToolDefinition[]`.
 */
export interface LumicsToolDefinition {
  readonly name: string;
  readonly operation: ToolOperation;
  readonly featureFlag: FeatureFlagName | undefined;
  /** True when the tool needs a company id to be callable at all. */
  readonly requiresCompany: boolean;
  /** Called by {@link registerTools} once gating has passed. */
  register(server: McpServer, context: ToolContext): void;
}

/**
 * Derive MCP annotations from the classification.
 *
 * `openWorldHint` is always `true`: every tool talks to a live external tenant
 * whose contents this server does not control.
 *
 * `idempotentHint` describes *repeating the same call*. `update` is idempotent
 * (setting a name twice leaves one name); `create` is not (it leaves two
 * devices); `destructive` is not, because the second call 404s rather than
 * reproducing the first result.
 */
export function annotationsFor(operation: ToolOperation, title: string): ToolAnnotations {
  switch (operation) {
    case 'read':
      return {
        title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case 'create':
      return {
        title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case 'update':
      return {
        title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case 'admin':
    case 'destructive':
      return {
        title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      };
  }
}

/**
 * Whether an operation needs a `confirm: true` argument.
 *
 * **This is a prompt-level speed bump, not human-in-the-loop control.** The
 * `confirm` flag is supplied by the *model*, so a model that decides to delete
 * something will also decide to set `confirm: true`. Its value is that it makes
 * the intent explicit in the transcript and gives the client's own approval UI
 * something concrete to show. The real gate is the environment: `LUMICS_READ_ONLY`
 * and the `LUMICS_ENABLE_*` flags are set by a human, out of band, and no prompt
 * can change them. RFC-001 D6 and `CONSTITUTION.md` Article IX.
 */
export function requiresConfirmation(operation: ToolOperation): boolean {
  return operation === 'admin' || operation === 'destructive';
}

/**
 * Turn a declaration into a registerable definition.
 *
 * Everything cross-cutting happens in the closure this returns, which is the
 * point: there is one `catch`, one call to `shapeToolOutput`, one place that
 * checks `confirm`.
 */
export function defineTool<Shape extends ZodRawShapeCompat>(
  tool: LumicsTool<Shape>,
): LumicsToolDefinition {
  const needsConfirm = requiresConfirmation(tool.operation);
  const requiresCompany =
    tool.requiresCompany ??
    Object.prototype.hasOwnProperty.call(tool.inputSchema, 'companyId') === true;

  return {
    name: tool.name,
    operation: tool.operation,
    featureFlag: tool.featureFlag,
    requiresCompany,

    register(server: McpServer, context: ToolContext): void {
      // Injected rather than declared, so no tool author can ship a destructive
      // tool without it. `confirm` is stripped before the handler runs.
      const inputSchema: ZodRawShapeCompat = needsConfirm
        ? { ...tool.inputSchema, confirm: confirmSchema }
        : { ...tool.inputSchema };

      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: buildDescription(tool, context.config),
          inputSchema,
          annotations: annotationsFor(tool.operation, tool.title),
        },
        async (rawArgs: unknown): Promise<CallToolResult> => {
          const args = (rawArgs ?? {}) as Record<string, unknown>;
          const started = Date.now();

          try {
            if (needsConfirm && args.confirm !== true) {
              throw new LumicsInputError(
                `${tool.name} changes or removes data in the live Lumics tenant and will not run without confirm: true. Tell the user exactly what will change, get their agreement, then call again with confirm: true.`,
                'not_permitted',
              );
            }

            // Defence in depth. Registration already excludes non-read tools
            // under LUMICS_READ_ONLY, so reaching this is a bug — but a bug that
            // writes to a customer's tenant, so it is checked anyway.
            if (context.config.readOnly && tool.operation !== 'read') {
              throw new LumicsInputError(
                `${tool.name} is unavailable because this server runs with LUMICS_READ_ONLY set. Only read operations are permitted. This is an operator setting; it cannot be overridden from here.`,
                'not_permitted',
              );
            }

            const { confirm: _confirm, ...handlerArgs } = args;
            const output = await tool.handler(handlerArgs as ToolArgs<Shape>, context);

            const shaped = shapeToolOutput(output.data, {
              maxChars: context.config.maxOutputChars,
              fields: output.fields,
              requestedLimit: output.requestedLimit,
              notes: output.notes,
            });

            logger.debug('tool completed', {
              tool: tool.name,
              durationMs: Date.now() - started,
              chars: shaped.text.length,
              limitReached: shaped.limitReached,
              droppedItems: shaped.droppedItems,
            });

            // RFC-001 D5 item 8: exactly one text block, and no
            // `structuredContent` because v0.1 declares no `outputSchema`.
            // Never serialise twice.
            return { content: [{ type: 'text', text: shaped.text }] };
          } catch (error) {
            const described = describeError(error);
            logger.error('tool failed', error, {
              tool: tool.name,
              durationMs: Date.now() - started,
              code: described.code,
              status: described.status,
            });
            return {
              isError: true,
              content: [{ type: 'text', text: `${described.code}: ${described.message}` }],
            };
          }
        },
      );
    },
  };
}

export interface RegistrationSummary {
  readonly registered: readonly string[];
  readonly skippedReadOnly: readonly string[];
  readonly skippedFeatureFlag: readonly string[];
  /** Company-scoped tools withheld because `LUMICS_COMPANY_ID` is unset. */
  readonly skippedNoCompany: readonly string[];
}

/**
 * Register the tools this configuration permits, and only those.
 *
 * `LUMICS_READ_ONLY` removes non-read tools from the tool *list* rather than
 * refusing them at call time (RFC-001 D6). That difference matters: a tool the
 * model cannot see is a tool it cannot be talked into trying, and an audit-only
 * consumer gets a surface that is honestly read-only instead of one that merely
 * says no.
 */
export function registerTools(
  server: McpServer,
  context: ToolContext,
  definitions: readonly LumicsToolDefinition[],
): RegistrationSummary {
  const registered: string[] = [];
  const skippedReadOnly: string[] = [];
  const skippedFeatureFlag: string[] = [];
  const skippedNoCompany: string[] = [];
  const seen = new Set<string>();
  const companyConfigured = context.config.companyId.length > 0;

  for (const definition of definitions) {
    if (seen.has(definition.name)) {
      // A duplicate name would silently shadow one implementation; with six
      // agents authoring tool modules independently, that is a live risk.
      throw new Error(
        `Duplicate tool name "${definition.name}". Tool names must be unique across all modules.`,
      );
    }
    seen.add(definition.name);

    if (context.config.readOnly && definition.operation !== 'read') {
      skippedReadOnly.push(definition.name);
      continue;
    }

    // Without a company id, a company-scoped tool has nothing to scope to. It is
    // withheld from the tool list rather than left to fail on every call, for the
    // same reason `LUMICS_READ_ONLY` filters at registration: a tool the model
    // cannot see is a tool it cannot spend a turn discovering is unusable. What
    // remains — `lumics_get_me` above all — is exactly the bootstrap surface the
    // operator needs to find the id and set it.
    if (!companyConfigured && definition.requiresCompany) {
      skippedNoCompany.push(definition.name);
      continue;
    }

    const flag = definition.featureFlag;
    if (flag !== undefined && !context.config.features[flag]) {
      skippedFeatureFlag.push(definition.name);
      continue;
    }

    definition.register(server, context);
    registered.push(definition.name);
  }

  return { registered, skippedReadOnly, skippedFeatureFlag, skippedNoCompany };
}

/** Build the {@link ToolContext} handlers receive. */
export function createToolContext(client: LumicsClient, config: LumicsConfig): ToolContext {
  return {
    client,
    config,
    resolveCompanyId(explicit?: string): string {
      const configured = config.companyId;

      if (explicit !== undefined && explicit.length > 0) {
        // The pin. A Lumics token issued to an MSP user can reach every company
        // that user administers, and `companyId` is a plain tool argument, so
        // without this a model could write to a tenant nobody configured and
        // nobody named in the approval prompt. Cross-company access is therefore
        // an operator act, like every other blast-radius widening here.
        if (!config.allowCrossCompany && configured.length > 0 && explicit !== configured) {
          throw new LumicsInputError(
            `The companyId argument (${explicit}) is not the company this server is configured for (LUMICS_COMPANY_ID is ${configured}). Cross-company access is refused unless the operator sets LUMICS_ALLOW_CROSS_COMPANY=1, because one Lumics token can reach several tenants and a call like this would read or write a tenant the operator did not configure. Omit companyId to use the configured company. If you genuinely need another company, tell the user which one and ask them to have the operator enable LUMICS_ALLOW_CROSS_COMPANY; this is an operator setting and cannot be overridden from here.`,
            'not_permitted',
          );
        }
        return explicit;
      }

      if (configured.length === 0) {
        throw new LumicsInputError(
          'No company id is available: none was supplied and LUMICS_COMPANY_ID is not set on this server. Company-scoped tools are not registered at all in that state, so this call cannot be made to work from here. Call lumics_get_me to read the company id, then tell the operator to set LUMICS_COMPANY_ID to that value and restart the server.',
        );
      }
      return configured;
    },
  };
}

/**
 * Append the standing caveats to a tool's description.
 *
 * Kept here rather than repeated in 39 description strings, and appended rather
 * than prepended so the tool's own purpose is what a client's tool picker shows
 * first.
 */
function buildDescription<Shape extends ZodRawShapeCompat>(
  tool: LumicsTool<Shape>,
  config: LumicsConfig,
): string {
  const parts = [tool.description];

  if (requiresConfirmation(tool.operation)) {
    parts.push(
      'This operation is classified as ' +
        tool.operation +
        ' and requires confirm: true. Describe the exact impact to the user and get their agreement before calling it.',
    );
  }

  if (tool.operation !== 'read') {
    // Deliberately NOT "company <id>". This string is fixed at registration time,
    // while the company written to is decided per call: an explicit `companyId`
    // argument overrides the configured one. Naming one company here asserted
    // something the server cannot guarantee, and client approval UIs render
    // descriptions, so the misstatement reached the human being asked to approve
    // the write. State the rule instead of a value. See `resolveCompanyId`.
    parts.push(
      'Writes apply immediately to the live Lumics tenant and cannot be undone by this server. They apply to the company this server is configured with (LUMICS_COMPANY_ID) unless you pass an explicit companyId argument, which overrides it — so name the company you are writing to when you describe the change, and do not assume it is the configured one if you supplied companyId yourself.' +
        (config.allowCrossCompany
          ? ' This server has LUMICS_ALLOW_CROSS_COMPANY enabled, so an explicit companyId for a different tenant WILL be honoured.'
          : ''),
    );
  }

  return parts.join(' ');
}
