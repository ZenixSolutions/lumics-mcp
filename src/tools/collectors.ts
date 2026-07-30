/**
 * Collector tools — all five endpoints of spec §5.
 *
 * Structure follows `./devices.ts`, which is the reference pattern: one
 * `defineTool` per endpoint in spec order, schemas assembled from `./schemas.js`,
 * handlers that build a path with `../api/paths.js` and return `result(...)`. No
 * try/catch, no stringify, no `encodeURIComponent` — the factory owns all three.
 *
 * Two facts from spec §5 shape the descriptions below, because both cause real
 * failures a model would otherwise only learn from an error:
 *
 *  - **Create without `user` auto-creates a collector user account** (spec §5.3:
 *    "A collector user is created automatically if omitted"). That is a side
 *    effect outside the collector record itself, so the create description says
 *    so rather than leaving it as a surprise in the tenant's user list.
 *  - **A collector cannot be deleted while devices are assigned to it**
 *    (spec §5.5, verbatim). Lumics surfaces that as 409 Conflict, so the delete
 *    description tells the model to move or remove the devices first.
 *
 * spec §5 documents `:context` as `admingroups | companies`; v0.1 is
 * `companies`-only (RFC-001 open question 3, owner-approved), so these tools take
 * an optional `companyId` and never a `context` pair.
 */

import { z } from 'zod';
import {
  absentBodyNotes,
  expectArray,
  expectObject,
  unwrapDeleted,
  unwrapUpdated,
} from '../api/client.js';
import { LumicsInputError } from '../api/errors.js';
import { collectorPath, collectorsPath } from '../api/paths.js';
import type { Collector } from '../domain/index.js';
import { defineTool, result, type LumicsToolDefinition } from './factory.js';
import {
  companyIdSchema,
  fieldsSchema,
  ipAddressSchema,
  listLimitSchema,
  objectIdSchema,
} from './schemas.js';

const collectorNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe('Collector name as it will appear in Lumics, e.g. "dc1-collector-01".');

/**
 * spec §5.3 documents `osConfig` as an untyped object and shows exactly one
 * nested key in its examples: `{ "ntpServers": [ "<host>", "<host>" ] }`, with
 * "No other nested keys documented".
 *
 * Deliberately closed rather than passed through as an open object: an
 * unvalidated object argument lets a model write keys the API does not document
 * into a collector's operating-system configuration, and neither we nor the model
 * can predict what Lumics does with them. `ntpServers` entries are typed as plain
 * strings because spec §5.3 shows hostnames, which `ipAddressSchema` would reject.
 */
const osConfigSchema = z
  .object({
    ntpServers: z
      .array(z.string().trim().min(1).max(255))
      .max(10)
      .describe(
        'NTP servers the collector host should synchronise from, as hostnames or IP addresses, e.g. ["ntp1.example.net","10.20.30.40"]. This replaces the whole list; it is not merged with the existing one.',
      ),
  })
  .strict()
  .describe(
    'Operating-system configuration for the collector host. The only key Lumics documents is ntpServers.',
  );

/**
 * The fields spec §5.3/§5.4 document as writable, minus four held back
 * deliberately:
 *
 *  - `_id` (create only) — letting a model choose a record's own ObjectId invites
 *    collisions and id spoofing, and Lumics assigns one itself.
 *  - `company` — it is the tenancy field. Writing it would move a collector
 *    between customers; the handler supplies the resolved company on create and
 *    never sends it on update. Same reasoning as `./devices.ts`.
 *  - `adminGroup` — v0.1 does not expose the `admingroups` context at all
 *    (RFC-001 open question 3), so an argument that assigns one would be a
 *    scope the rest of the server cannot read back.
 *  - `needsRestart` — documented as "Date the collector was marked as needing a
 *    restart, or false if a restart is not needed", with no documentation of what
 *    Lumics does when the field is written by hand (it does not trigger a
 *    restart). **Capability reduction:** the field is readable through the list
 *    and get tools but cannot be set from here.
 */
const collectorMutableFields = {
  name: collectorNameSchema.optional(),
  description: z.string().trim().max(1_000).optional().describe('Free-text description.'),
  location: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('Free-text location, e.g. a site, room or rack name.'),
  user: objectIdSchema
    .optional()
    .describe(
      'Id of the Lumics user account the collector authenticates as. Change this only when an operator has told you which account to use.',
    ),
  ipAddress: ipAddressSchema
    .optional()
    .describe(
      'IP address of the collector host. spec §5.3: "This should only be updated by the collector itself" — set it by hand only to correct a stale value an operator has confirmed is wrong.',
    ),
  version: z
    .string()
    .trim()
    .max(64)
    .optional()
    .describe(
      'Collector software version. Lumics documents that this should only be updated by the collector itself; it does not install or upgrade anything.',
    ),
  osConfig: osConfigSchema.optional(),
} as const;

/**
 * spec §5.1 `GET /:context/:contextId/collectors`.
 * `limit` ("Amount of results") is the only result-control parameter (spec §4.3).
 */
const listCollectors = defineTool({
  name: 'lumics_list_collectors',
  title: 'List collectors',
  operation: 'read',
  description:
    'List the collectors in a Lumics company — the poller appliances that reach into a customer network and gather device data. Each record carries name, description, location, ipAddress, software version, needsRestart (a date when a restart is pending, or false), the collector user account and the osConfig NTP settings. Start here whenever you need a collector id: lumics_create_device and lumics_update_device both require one, and guessing an id fails with 404. The Lumics API cannot filter or sort this list server-side, so retrieve it and filter locally.',
  inputSchema: {
    companyId: companyIdSchema,
    limit: listLimitSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(collectorsPath(companyId), {
      query: { limit: args.limit },
    });
    const collectors = expectArray<Collector>(response, 'GET collectors');
    return result(collectors, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: absentBodyNotes(response),
    });
  },
});

/**
 * spec §5.2 `GET /:context/:contextId/collectors/:id`. No query parameters.
 */
const getCollector = defineTool({
  name: 'lumics_get_collector',
  title: 'Get a collector',
  operation: 'read',
  description:
    'Retrieve one collector by its Lumics id, with the same fields the list returns. Use this to check a single collector before acting on it — for example to read needsRestart before telling an operator a restart is pending, or to confirm a collector exists and is in the expected company before assigning a device to it. If you do not already have the id, call lumics_list_collectors instead: this tool cannot look a collector up by name.',
  inputSchema: {
    collectorId: objectIdSchema.describe(
      'Lumics collector id. Get it from lumics_list_collectors.',
    ),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const collector = expectObject<Collector>(
      await context.client.get(collectorPath(companyId, args.collectorId)),
      `GET collector ${args.collectorId}`,
    );
    return result(collector, { fields: args.fields });
  },
});

/**
 * spec §5.3 `POST /:context/:contextId/collectors`.
 *
 * `company` and `name` are the only required body fields. `company` is required
 * in the body as well as the path, so the handler fills it from the resolved
 * company rather than asking the model for the same id twice.
 */
const createCollector = defineTool({
  name: 'lumics_create_collector',
  title: 'Create a collector',
  operation: 'create',
  description:
    'Register a new collector in Lumics. Only name is required. This creates the Lumics-side record and its credentials; it does not install, provision or connect any software — an operator still has to deploy the collector on the customer network and point it at this record. If you omit "user", Lumics automatically creates a new collector user account for it, which is a change in the tenant\'s user list you should mention to the operator; supply "user" only when they have told you which existing account to use. Returns the created collector including the id you will need for lumics_create_device. Check lumics_list_collectors first — nothing stops you creating a second collector with the same name.',
  inputSchema: {
    name: collectorNameSchema,
    description: collectorMutableFields.description,
    location: collectorMutableFields.location,
    user: objectIdSchema
      .optional()
      .describe(
        'Id of an existing Lumics user account for the collector to authenticate as. Omit this and Lumics creates a dedicated collector user account automatically, which is the normal path.',
      ),
    ipAddress: collectorMutableFields.ipAddress,
    version: collectorMutableFields.version,
    osConfig: osConfigSchema.optional(),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { companyId: _companyId, ...body } = args;
    const created = await context.client.post<Collector>(collectorsPath(companyId), {
      body: {
        // spec §5.3: `company` is a required *body* field as well as a path segment.
        company: companyId,
        ...pruneUndefined(body),
      },
    });
    return result(created);
  },
});

/**
 * spec §5.4 `PATCH /:context/:contextId/collectors/:id`. Every body field is
 * optional here, unlike POST. Response envelope `{updated: {...}}` is unwrapped
 * so a write returns the same shape as the corresponding read (spec §4.2).
 */
const updateCollector = defineTool({
  name: 'lumics_update_collector',
  title: 'Update a collector',
  operation: 'update',
  description:
    'Update one collector in place. Send only the fields you want to change; omitted fields are left alone. Typical uses are correcting a name, description or location, or replacing the osConfig NTP server list. Note that osConfig.ntpServers is replaced wholesale rather than merged, so read the collector first and resend the full list you want. This tool cannot restart a collector, upgrade it, or clear a pending needsRestart flag — Lumics documents no field write that does any of those. Returns the complete updated collector.',
  inputSchema: {
    collectorId: objectIdSchema.describe('Lumics collector id to update.'),
    companyId: companyIdSchema,
    ...collectorMutableFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { collectorId, companyId: _companyId, ...changes } = args;
    const patch = pruneUndefined(changes);

    if (Object.keys(patch).length === 0) {
      // A no-field PATCH would return 200 and change nothing, which reads to a
      // model as "the update worked". Better to say what happened.
      throw new LumicsInputError(
        'No fields to update were supplied. Provide at least one of name, description, location, user, ipAddress, version or osConfig.',
      );
    }

    const operation = `PATCH collector ${collectorId}`;
    const response = await context.client.patch<unknown>(collectorPath(companyId, collectorId), {
      body: patch,
    });
    return result(unwrapUpdated<Collector>(response, operation));
  },
});

/**
 * spec §5.5 `DELETE /:context/:contextId/collectors/:id`, whose description
 * carries the constraint verbatim: "A collector cannot be deleted while devices
 * are assigned to it." Lumics reports that as 409 Conflict (spec §3).
 *
 * Response envelope `{deleted: {...}}` is unwrapped so the caller can report
 * exactly what was removed.
 */
const deleteCollector = defineTool({
  name: 'lumics_delete_collector',
  title: 'Delete a collector',
  operation: 'destructive',
  description:
    'Permanently delete a collector from Lumics. This cannot be undone from here and there is no trash to restore from. Lumics refuses to delete a collector while any device is still assigned to it and answers 409 Conflict; if that happens, list devices, find the ones whose "collector" is this id, and either move them to another collector with lumics_update_device or delete them first. Deleting a collector stops all monitoring that depended on it, so confirm with the operator that the appliance is genuinely being retired rather than merely offline. Returns the record that was deleted.',
  inputSchema: {
    collectorId: objectIdSchema.describe(
      'Lumics collector id to delete. Confirm it with lumics_get_collector first, and check which devices reference it with lumics_list_devices.',
    ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const operation = `DELETE collector ${args.collectorId}`;
    const response = await context.client.delete<unknown>(
      collectorPath(companyId, args.collectorId),
    );
    return result(unwrapDeleted<Collector>(response, operation), {
      notes: [
        'The collector below has been permanently deleted from Lumics. Any devices that referenced it must now be assigned to another collector or they will no longer be polled.',
      ],
    });
  },
});

/**
 * Drop keys whose value is `undefined` or `null` so a partial update sends only
 * what the caller actually set. `exactOptionalPropertyTypes` means an absent
 * optional argument is genuinely absent, but a client may still send an explicit
 * `null`, and `JSON.stringify` would turn that into a field wipe.
 */
function pruneUndefined(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/** All five collector endpoints of spec §5, in spec order. */
export const collectorTools: readonly LumicsToolDefinition[] = [
  listCollectors,
  getCollector,
  createCollector,
  updateCollector,
  deleteCollector,
];

export default collectorTools;
