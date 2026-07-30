/**
 * Device tools — all seven endpoints of spec §7.
 *
 * **This module is the reference pattern for every other tool module.** If you
 * are adding collectors, components, IPAM, metrics or me, copy the shape of what
 * is here:
 *
 *  1. One `defineTool({...})` per endpoint, in spec order, each with a spec
 *     reference in its comment so a reviewer can diff the two.
 *  2. Schemas built from `./schemas.js` fragments, not from bare `z.string()`.
 *  3. Descriptions written for a model: what it returns, when to prefer it over
 *     the neighbouring tool, and any constraint the model would otherwise learn
 *     from a 400.
 *  4. Handlers that build a path with `../api/paths.js`, call the client, unwrap
 *     the vendor envelope, and `return result(data, { requestedLimit, fields })`.
 *     No try/catch, no stringify, no `encodeURIComponent` — all of that is the
 *     factory's job and duplicating it is how the prototype got to 1,900 lines.
 *  5. A default export of `readonly LumicsToolDefinition[]`.
 *
 * Two facts from the spec shape everything below:
 *
 *  - **Device writes are `companies`-only** (spec §7.3–§7.7 / §13 Q2). Reads
 *    additionally document `admingroups` and `system`, but v0.1 is
 *    `companies`-only throughout (RFC-001 open question 3, owner-approved), so
 *    tools take an optional `companyId` and never a `context` pair.
 *  - **PATCH and PUT return `{updated: {...}}`, DELETE returns `{deleted: {...}}`**
 *    (spec §4.2). Those envelopes are unwrapped here so a write returns the same
 *    shape as the corresponding read, and the model does not have to learn two.
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
import {
  deviceModuleLastDiscoveryPath,
  devicePath,
  devicesBatchPath,
  devicesPath,
} from '../api/paths.js';
import { DEFAULT_DEVICE_LIST_FIELDS } from '../constants.js';
import type { Device } from '../domain/index.js';
import { toEpochMs } from '../util/time.js';
import { defineTool, result, type LumicsToolDefinition } from './factory.js';
import {
  companyIdSchema,
  fieldsSchema,
  listLimitSchema,
  objectIdSchema,
  ipAddressSchema,
} from './schemas.js';

/**
 * spec §7.3 documents `deviceType` as a required string with no enumeration
 * (spec §14 defect 14); examples show `default` and `switch`. A free string with
 * an honest description beats a guessed enum that rejects a valid value.
 */
const deviceTypeSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Device type. Lumics documents no fixed list; "default" suits most hosts and "switch" is used for switches. To match an existing convention, list devices first and reuse a deviceType already present in the tenant.',
  );

const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe('Device name as it will appear in Lumics. Usually the hostname.');

/**
 * spec §7.5 documents the PATCH body as a single field named `device`, but the
 * example sends a flat object and says it "must include the device ID"
 * (spec §14 defect 5). The example is authoritative, so this is a flat set of
 * fields and the handler adds `id` itself.
 *
 * Deliberately narrow: spec §7.5 enumerates no fields at all, so exposing an
 * arbitrary object would let a model write anything into any field, including
 * `company` — which would move a device between tenants. These five are the
 * fields spec §7.3 documents as writable on create plus the two operational
 * toggles that appear in every device example.
 */
const deviceMutableFields = {
  name: deviceNameSchema.optional(),
  ipAddress: ipAddressSchema.optional().describe('New management IP address for the device.'),
  collector: objectIdSchema
    .optional()
    .describe('Id of the collector that should poll this device.'),
  deviceType: deviceTypeSchema.optional(),
  description: z.string().trim().max(1_000).optional().describe('Free-text description.'),
  location: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('Free-text location, e.g. a site or rack name.'),
  enabled: z
    .boolean()
    .optional()
    .describe('Set false to stop polling the device without deleting it.'),
  maintenanceMode: z
    .boolean()
    .optional()
    .describe(
      'Set true to suppress alerting while work is in progress, e.g. during a planned change.',
    ),
  priority: z
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Device priority; Lumics defaults new devices to 0.'),
} as const;

/**
 * spec §7.1 `GET /:context/:contextId/devices`.
 *
 * `limit` is documented under "URL Parameters" on the vendor page but is a query
 * parameter (spec §4.3, §14 defect 7).
 *
 * A default `fields` projection is applied here, and only here among the list
 * tools, because a device is the one record in this API whose full form does not
 * fit the default output budget a hundred times over — see
 * {@link DEFAULT_DEVICE_LIST_FIELDS}. Without it, a default call asks Lumics for
 * a hundred devices and can only show thirteen of them.
 */
const listDevices = defineTool({
  name: 'lumics_list_devices',
  title: 'List devices',
  operation: 'read',
  description:
    'List monitored devices in a Lumics company. Start here when you need a device id for any other tool, or to answer "what is Lumics monitoring". By default this returns a compact projection of each device — id, name, ipAddress, deviceType, collector, enabled, maintenanceMode — because a full device record is around 1.9 kB and a hundred of them do not fit the output budget; the projection is stated in the response. To choose your own fields pass "fields" (for example ["id","name","location","modules"]), pass an empty array to get every field on every device, or use lumics_get_device for one device in full including its "modules" polling map. The Lumics API cannot filter or sort this list server-side, so retrieve it and filter locally.',
  inputSchema: {
    companyId: companyIdSchema,
    limit: listLimitSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(devicesPath(companyId), {
      query: { limit: args.limit },
    });
    const devices = expectArray<Device>(response, 'GET devices');

    // An explicit `fields` argument always wins, including an empty array, which
    // `projectFields` treats as "no projection" and is therefore the documented
    // way to ask for whole records.
    const projected = args.fields ?? DEFAULT_DEVICE_LIST_FIELDS;
    const notes = [...absentBodyNotes(response)];
    if (args.fields === undefined) {
      notes.push(
        'FIELD PROJECTION APPLIED BY THIS SERVER: only the fields ' +
          DEFAULT_DEVICE_LIST_FIELDS.join(', ') +
          ' are shown for each device. Every device has more fields than these — notably "modules", the per-module polling configuration, plus location, description, model, version, priority and customProperties. Nothing was filtered out of the device LIST by this projection; only fields were. Pass "fields" with the names you need, pass an empty array for whole records, or call lumics_get_device for one device in full.',
      );
    }

    return result(devices, {
      requestedLimit: args.limit,
      fields: projected,
      notes,
    });
  },
});

/**
 * spec §7.2 `GET /:context/:contextId/devices/:id`.
 * The vendor's parameter list omits `:id` even though the template contains it
 * (spec §14 defect 1); it is a required 24-hex ObjectId.
 */
const getDevice = defineTool({
  name: 'lumics_get_device',
  title: 'Get a device',
  operation: 'read',
  description:
    'Retrieve one device by its Lumics id, including its complete "modules" map — the per-module polling configuration (snmp credential and version, ping intervals, configuration-snapshot items) and each module\'s lastDiscovery timestamp. Use this after lumics_list_devices when you need the full detail of a single device. Note that a module\'s key in the map is not always its "module" value: the key "deviceConfigs" carries module "snapshots".',
  inputSchema: {
    deviceId: objectIdSchema.describe('Lumics device id. Get it from lumics_list_devices.'),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    // `expectObject` rather than a bare `get<Device>`: an absent body on a single
    // read would otherwise be returned as the literal `null`, in a result the
    // client marks as successful, which reads as "there is no such device".
    const device = expectObject<Device>(
      await context.client.get(devicePath(companyId, args.deviceId)),
      `GET device ${args.deviceId}`,
    );
    return result(device, { fields: args.fields });
  },
});

/**
 * spec §7.3 `POST /:context/:contextId/devices` — `companies` only.
 *
 * All five body fields are documented as required. `company` must be repeated in
 * the body even though it is already in the path, so the handler fills it from
 * the resolved company rather than asking the model for it twice.
 */
const createDevice = defineTool({
  name: 'lumics_create_device',
  title: 'Create a device',
  operation: 'create',
  description:
    "Create a new device for Lumics to monitor. All four fields are required by the Lumics API. The collector you name must already exist and be reachable on the device's network — list collectors first and pick one, rather than guessing an id. Lumics populates the rest itself: priority 0, enabled true, maintenanceMode false, and a ping module enabled as primary. It does not configure SNMP; that is a separate change in the Lumics UI. Creating the same device twice returns 409 Conflict, so check lumics_list_devices first.",
  inputSchema: {
    name: deviceNameSchema,
    ipAddress: ipAddressSchema.describe('Management IP address Lumics will poll.'),
    collector: objectIdSchema.describe('Id of an existing collector that will poll this device.'),
    deviceType: deviceTypeSchema,
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const created = await context.client.post<Device>(devicesPath(companyId), {
      body: {
        // spec §7.3: `company` is a required *body* field as well as a path segment.
        company: companyId,
        name: args.name,
        ipAddress: args.ipAddress,
        collector: args.collector,
        deviceType: args.deviceType,
      },
    });
    return result(created);
  },
});

/**
 * spec §7.5 `PATCH /:context/:contextId/devices/:id` — `companies` only.
 * Response envelope `{updated: {...}}` is unwrapped.
 */
const updateDevice = defineTool({
  name: 'lumics_update_device',
  title: 'Update a device',
  operation: 'update',
  description:
    'Update one device in place. Send only the fields you want to change; omitted fields are left alone. Common uses: setting maintenanceMode true before planned work so alerts are suppressed, setting enabled false to stop polling a decommissioned device without losing its history, or correcting an ipAddress after a renumber. Returns the complete updated device. To change many devices at once use lumics_batch_update_devices, which the operator must enable explicitly.',
  inputSchema: {
    deviceId: objectIdSchema.describe('Lumics device id to update.'),
    companyId: companyIdSchema,
    ...deviceMutableFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { deviceId, companyId: _companyId, ...changes } = args;
    const patch = pruneUndefined(changes);

    if (Object.keys(patch).length === 0) {
      // A no-field PATCH would return 200 and change nothing, which reads to a
      // model as "the update worked". Better to say what happened.
      throw new LumicsInputError(
        'No fields to update were supplied. Provide at least one of name, ipAddress, collector, deviceType, description, location, enabled, maintenanceMode or priority.',
      );
    }

    const operation = `PATCH device ${deviceId}`;
    const response = await context.client.patch<unknown>(devicePath(companyId, deviceId), {
      // spec §7.5: the example body is flat and "must include the device ID",
      // which appears in both the path and the body.
      body: { id: deviceId, ...patch },
    });
    return result(unwrapUpdated<Device>(response, operation));
  },
});

/**
 * spec §7.6 `PATCH /:context/:contextId/devices/:ids/batch` — `companies` only.
 *
 * Classified `admin`, not `update`: one call rewrites arbitrary fields across N
 * devices, and spec §7.6 documents no cap on how many ids may be passed. That
 * blast radius earns both a `confirm: true` argument and the
 * `LUMICS_ENABLE_BATCH_UPDATE` flag, per RFC-001 D6. The env flag is the real
 * gate; see `requiresConfirmation` in `./factory.ts`.
 *
 * Response envelope is `{updated: [ ... ]}` — an **array** inside the envelope,
 * unlike the single PATCH.
 */
const batchUpdateDevices = defineTool({
  name: 'lumics_batch_update_devices',
  title: 'Update many devices at once',
  operation: 'admin',
  featureFlag: 'batchUpdate',
  description:
    'Apply the same field changes to several devices in one call — for example putting a whole rack into maintenance mode before a power event, or moving a set of devices to a new collector. Every field you supply is written to every device listed, so double-check the id list: there is no dry run and no undo. Returns the full updated record for each device. Prefer lumics_update_device when you are changing one device.',
  inputSchema: {
    deviceIds: z
      .array(objectIdSchema)
      .min(1)
      .max(200)
      .describe(
        'Ids of the devices to update. Every change below is applied to every device in this list. Verify each id with lumics_list_devices first.',
      ),
    companyId: companyIdSchema,
    ...deviceMutableFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { deviceIds, companyId: _companyId, ...changes } = args;
    const patch = pruneUndefined(changes);

    if (Object.keys(patch).length === 0) {
      throw new LumicsInputError(
        'No fields to update were supplied, so this call would change nothing. Provide at least one field to apply across the listed devices.',
      );
    }

    const operation = `PATCH devices batch (${String(deviceIds.length)} devices)`;
    const response = await context.client.patch<unknown>(devicesBatchPath(companyId, deviceIds), {
      // spec §7.6: the documented body field is `device` but the example is flat.
      body: patch,
    });
    const updated = unwrapUpdated<readonly Device[]>(response, operation);
    return result(updated, {
      notes: [
        `Applied ${String(Object.keys(patch).length)} field change(s) to ${String(deviceIds.length)} device(s). Lumics returned ${String(Array.isArray(updated) ? updated.length : 0)} updated record(s); if that count is lower than the number of ids you sent, some ids did not match a device in this company.`,
      ],
    });
  },
});

/**
 * spec §7.4 `PUT /:context/:contextId/devices/:id/modules/:module/lastDiscovery`
 * — `companies` only. Body is `{ date: <ISO-8601> }`; response is
 * `{updated: {...full device...}}`.
 */
const updateLastDiscovery = defineTool({
  name: 'lumics_update_device_last_discovery',
  title: 'Set a module lastDiscovery time',
  operation: 'update',
  description:
    'Set the lastDiscovery timestamp on one polling module of one device. This is a bookkeeping field a collector normally maintains for itself; a human operator sets it by hand only to force or defer the next discovery cycle for a module. It does not run a discovery. If you are trying to find out when a module last discovered, read the device with lumics_get_device instead of writing here.',
  inputSchema: {
    deviceId: objectIdSchema.describe('Lumics device id.'),
    module: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Module key exactly as it appears in the device\'s "modules" map, e.g. "snmp", "ping" or "deviceConfigs". Read the device first — the key is not always the same as the module\'s own "module" value.',
      ),
    date: z
      .string()
      .trim()
      .min(1)
      .describe(
        'The timestamp to record, as ISO-8601 with an explicit zone, e.g. "2026-07-29T14:14:41.000Z". The zone is required: a timestamp with a time but no zone would be read in this server\'s timezone and written to Lumics shifted by that offset, so it is rejected instead.',
      ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);

    // Shared with the metric window parsing rather than a local `Date.parse`:
    // this value is WRITTEN to Lumics, so a naive timestamp read in the server's
    // local timezone would persist a discovery time shifted by that offset.
    const parsed = toEpochMs(args.date, 'date');

    const operation = `PUT device ${args.deviceId} module ${args.module} lastDiscovery`;
    const response = await context.client.put<unknown>(
      deviceModuleLastDiscoveryPath(companyId, args.deviceId, args.module),
      { body: { date: new Date(parsed).toISOString() } },
    );
    return result(unwrapUpdated<Device>(response, operation));
  },
});

/**
 * spec §7.7 `DELETE /:context/:contextId/devices/:id` — `companies` only.
 * Response envelope `{deleted: {...}}` is unwrapped, so the caller can report
 * exactly what was removed.
 */
const deleteDevice = defineTool({
  name: 'lumics_delete_device',
  title: 'Delete a device',
  operation: 'destructive',
  description:
    'Permanently delete a device from Lumics. This removes the device and its monitoring configuration; it cannot be undone from here and there is no trash to restore from. If the device is only temporarily out of service, call lumics_update_device with enabled false instead — that stops polling and keeps the record and its history. Returns the record that was deleted so you can report exactly what went.',
  inputSchema: {
    deviceId: objectIdSchema.describe(
      'Lumics device id to delete. Confirm it with lumics_get_device first.',
    ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const operation = `DELETE device ${args.deviceId}`;
    const response = await context.client.delete<unknown>(devicePath(companyId, args.deviceId));
    return result(unwrapDeleted<Device>(response, operation), {
      notes: ['The device below has been permanently deleted from Lumics.'],
    });
  },
});

/**
 * Drop keys whose value is `undefined` so a partial update sends only what the
 * caller actually set. `exactOptionalPropertyTypes` means an absent optional
 * argument is genuinely absent, but a client may still send an explicit `null`
 * or `undefined`, and `JSON.stringify` would turn a `null` into a field wipe.
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

/** All seven device endpoints of spec §7, in spec order. */
export const deviceTools: readonly LumicsToolDefinition[] = [
  listDevices,
  getDevice,
  createDevice,
  updateLastDiscovery,
  updateDevice,
  batchUpdateDevices,
  deleteDevice,
];

export default deviceTools;
