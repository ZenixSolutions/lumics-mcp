/**
 * IPAM tools — the fifteen endpoints of spec §10 (IP Subnet), §8 (IP Address)
 * and §9 (IP Group).
 *
 * `./devices.ts` is the reference pattern and this module follows it: one
 * `defineTool` per endpoint with a spec reference, schemas built from
 * `./schemas.js` fragments, handlers that build a path with `../api/paths.js`
 * and return `result(...)`, and no try/catch, stringify or `encodeURIComponent`
 * anywhere. Four things are specific to IPAM and worth reading before changing
 * anything here.
 *
 * **1. The `ipsubnet`/`ipsubnets` asymmetry is NOT real. MEASURED 2026-07-31.**
 * Every ipaddress route uses the SINGULAR segment `/ipsubnet/`, for all five
 * calls. The plural spelling is not routed for any verb — it returns an HTML 404
 * error page rather than JSON, which is what separates "no such route" from "no
 * such record" on this API.
 *
 * This comment previously asserted the opposite, citing spec §13 Q1 and the
 * vendor's generated doc slugs, and instructed the reader not to normalise the
 * two spellings. That was wrong and it shipped: in 0.1.0
 * `lumics_create_ipaddress`, `lumics_update_ipaddress` and
 * `lumics_delete_ipaddress` addressed a route that does not exist and could
 * never have succeeded.
 *
 * Worth remembering how it got here. The prototype used the singular form for
 * all five calls while its own tool description claimed the plural; this comment
 * read that disagreement as evidence the prototype's code was wrong. It was the
 * prototype's *description* that was wrong. Two sources agreeing — the vendor's
 * docs and a plausible reading of its slugs — outweighed the one source that had
 * actually been executed against the API. Prefer the executed evidence.
 *
 * **2. Every IPAM route is `companies`-scoped in the spec itself.** Unlike
 * devices and collectors these paths hard-code `companies` and take a
 * `:company` parameter; there is no `:context` variant to reason about, for
 * reads or for writes. Tools therefore take an optional `companyId` and nothing
 * else.
 *
 * **3. Identity keys are inconsistent (spec §4.2).** The ipgroup, ipsubnet and
 * ipaddress *list* reads return `id`; the ipgroup single read and every
 * create/update/delete payload returns `_id`. Nothing here assumes either —
 * {@link identify} reads whichever arrived via `resourceId()`.
 *
 * **4. This module writes network data,** so the schemas are tight: an address
 * is validated as an address, a netmask as a dotted quad, `cidr` is bounded, and
 * `state`/`type` are the documented enums. A malformed subnet in an IPAM is not
 * a cosmetic error — it is wrong inventory that somebody later trusts.
 *
 * The three CRUD sets are near-identical, which is how the prototype spent 748
 * lines on them. The field groups below are declared once per resource and
 * shared between create and update, and the two handler shapes that carry real
 * logic — the empty-PATCH guard and the envelope unwrap — live in
 * {@link patchResource} and {@link deleteResource} at the foot of the file.
 *
 * Ordered subnets → addresses → groups rather than in spec-number order,
 * because an address tool cannot be called without a subnet id and a reader
 * needs the subnet set first.
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
  ipAddressReadPath,
  ipAddressWritePath,
  ipAddressesReadPath,
  ipAddressesWritePath,
  ipGroupPath,
  ipGroupsPath,
  ipSubnetPath,
  ipSubnetsPath,
} from '../api/paths.js';
import {
  resourceId,
  type IpAddress,
  type IpGroup,
  type IpSubnet,
  type LumicsResource,
} from '../domain/index.js';
import {
  defineTool,
  result,
  type LumicsToolDefinition,
  type ToolContext,
  type ToolOutput,
} from './factory.js';
import {
  companyIdSchema,
  fieldsSchema,
  ipAddressSchema,
  ipAddressStateSchema,
  ipGroupTypeSchema,
  listLimitSchema,
  macAddressSchema,
  netmaskSchema,
  objectIdSchema,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Fragments shared by more than one resource
// ---------------------------------------------------------------------------

/**
 * spec §9.1/§10.1: `parent` as a *query* filter on the two list endpoints.
 * spec §8.1 explicitly has no `parent` filter, so the address list omits it.
 */
const parentFilterSchema = objectIdSchema
  .optional()
  .describe(
    'Return only records whose parent (containing) IP group is this group id. Omit it to list everything in the company. Get group ids from lumics_list_ipgroups.',
  );

/**
 * spec §9.3/§10.3: `parent` as a *body* field — "the id of the parent
 * (containing) group, or null for top level". `null` is meaningful here, which
 * is why {@link pruneUndefined} keeps nulls.
 */
const parentGroupSchema = objectIdSchema
  .nullable()
  .describe(
    'Id of the parent (containing) IP group, or null to place this record at the top level. Get group ids from lumics_list_ipgroups.',
  );

const descriptionSchema = z
  .string()
  .trim()
  .max(1_000)
  .describe('Free-text description, for humans reading the IPAM records.');

/**
 * spec §10.3: `customProperties` is an array of `{customProperty, value}`,
 * where `customProperty` is the id of a custom property defined in the tenant
 * and `value` is genuinely untyped. Typed as that pair rather than as an
 * arbitrary object, so a mistyped key fails here instead of writing a property
 * assignment Lumics cannot resolve.
 */
const customPropertiesSchema = z
  .array(
    z.object({
      customProperty: objectIdSchema.describe(
        'Id of the custom property definition being assigned.',
      ),
      value: z.unknown().describe('Value to store for that custom property.'),
    }),
  )
  .max(100)
  .describe(
    'Custom property values to assign to the subnet. Each entry names an existing custom property by id; Lumics does not create the definition for you, and this server cannot list the available definitions (the API documents no endpoint for them). Supplying this replaces the whole array.',
  );

// ---------------------------------------------------------------------------
// IP Subnet — spec §10
// ---------------------------------------------------------------------------

const networkSchema = ipAddressSchema.describe(
  'The network address of the subnet, e.g. 172.27.16.0 — the base address, not a host inside the range.',
);

/**
 * spec §10.3 documents `cidr` only as "integer, e.g. 24", with no bound. It is
 * bounded to 0–32 here because the same endpoint requires `netmask` as a
 * dotted-quad IPv4 mask, so a subnet expressible through this API is IPv4 and a
 * prefix length above 32 is always a mistake. An unbounded integer here writes
 * nonsense into the inventory that no later reader can distinguish from fact.
 */
const cidrSchema = z
  .int()
  .min(0)
  .max(32)
  .describe(
    'CIDR prefix length as an integer, e.g. 24 for a /24. It must agree with the netmask you supply: 24 pairs with 255.255.255.0. Lumics does not derive one from the other.',
  );

/**
 * The subnet fields spec §10.3 documents as optional on create, reused verbatim
 * on the PATCH of spec §10.4.
 *
 * Deliberately omitted from the write surface, all documented but all owned by
 * the collector rather than by an operator: `lastScan`, `scanProgress`,
 * `addressCount`, `usedCount` and `ipamDiscoveryRule`. Writing scan bookkeeping
 * by hand produces an inventory that reports a scan which never happened. They
 * are returned by the reads, so nothing is hidden. `_id` is omitted too: letting
 * a model pick the primary key invites a collision with a record it cannot see.
 */
const ipSubnetOptionalFields = {
  description: descriptionSchema.optional(),
  vlan: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('VLAN name or number as free text, e.g. "vlan120" or "120".'),
  vrf: z.string().trim().max(255).optional().describe('VRF name as free text.'),
  component: objectIdSchema
    .optional()
    .describe(
      'Id of the SNMP-discovered network component this subnet corresponds to, if any. Get component ids from lumics_list_components.',
    ),
  collector: objectIdSchema
    .optional()
    .describe(
      'Id of the collector that will scan this subnet. It must be able to reach the range. Get collector ids from lumics_list_collectors.',
    ),
  excludeFromScheduledScan: z
    .boolean()
    .optional()
    .describe(
      'Set true to keep the collector from scanning this subnet during a scheduled scan. Use this rather than deleting a subnet you want to stop scanning but keep on record.',
    ),
  scanNetworkAndBroadcast: z
    .boolean()
    .optional()
    .describe(
      'Set true to include the network and broadcast addresses when scanning. Lumics skips them by default.',
    ),
  parent: parentGroupSchema.optional(),
  customProperties: customPropertiesSchema.optional(),
} as const;

/** Fields a caller may change with {@link updateIpSubnet}, for its error text. */
const IP_SUBNET_UPDATABLE =
  'network, netmask, cidr, description, vlan, vrf, component, collector, excludeFromScheduledScan, scanNetworkAndBroadcast, parent or customProperties';

/** spec §10.1 `GET /companies/:company/ipsubnets`. */
const listIpSubnets = defineTool({
  name: 'lumics_list_ipsubnets',
  title: 'List IP subnets',
  operation: 'read',
  description:
    'List the IP subnets recorded in a company\'s IPAM, each with its network, netmask, cidr, description, VLAN and VRF, the collector and component it is tied to, its parent group, and its scan state (lastScan, scanProgress, addressCount, usedCount). This is the entry point for all IPAM work: every IP address tool needs a subnet id, and this is where you get one. Use the "parent" filter to walk the group tree one level at a time. The API cannot filter by network, VLAN or utilisation, so retrieve and filter locally; pass "fields" to keep a large list small.',
  inputSchema: {
    parent: parentFilterSchema,
    companyId: companyIdSchema,
    limit: listLimitSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(ipSubnetsPath(companyId), {
      query: { limit: args.limit, parent: args.parent },
    });
    const subnets = expectArray<IpSubnet>(response, 'GET ipsubnets');
    return result(subnets, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: absentBodyNotes(response),
    });
  },
});

/** spec §10.2 `GET /companies/:company/ipsubnets/:id`. */
const getIpSubnet = defineTool({
  name: 'lumics_get_ipsubnet',
  title: 'Get an IP subnet',
  operation: 'read',
  description:
    'Retrieve one IP subnet by its Lumics id, including its full scan state and custom property assignments. Use this to confirm a subnet before writing to it or deleting it. It returns the subnet definition only — to see the addresses recorded inside the range, call lumics_list_ipaddresses with this subnet id.',
  inputSchema: {
    ipSubnetId: objectIdSchema.describe('Lumics IP subnet id. Get it from lumics_list_ipsubnets.'),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const subnet = expectObject<IpSubnet>(
      await context.client.get(ipSubnetPath(companyId, args.ipSubnetId)),
      `GET ipsubnet ${args.ipSubnetId}`,
    );
    return result(subnet, { fields: args.fields });
  },
});

/**
 * spec §10.3 `POST /companies/:company/ipsubnets`.
 * `network`, `netmask` and `cidr` are the three documented required fields;
 * `company` is required in the body as well as the path, so the handler fills it
 * from the resolved company rather than asking for it twice.
 */
const createIpSubnet = defineTool({
  name: 'lumics_create_ipsubnet',
  title: 'Create an IP subnet',
  operation: 'create',
  description:
    'Record a new subnet in the company IPAM. network, netmask and cidr are required and must agree with each other — Lumics does not derive one from the others, and a subnet whose mask and prefix length disagree is inventory nobody can trust later. Supply a collector if you want Lumics to scan the range; without one the subnet is a record only. Nothing is scanned by this call. Check lumics_list_ipsubnets first: the API does not reject an overlapping or duplicate subnet, so a second definition of the same range is easy to create and confusing to find. Returns the created subnet, whose id you will need for the IP address tools.',
  inputSchema: {
    network: networkSchema,
    netmask: netmaskSchema,
    cidr: cidrSchema,
    companyId: companyIdSchema,
    ...ipSubnetOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { companyId: _companyId, ...fields } = args;
    const created = await context.client.post<IpSubnet>(ipSubnetsPath(companyId), {
      // spec §10.3: `company` is a required *body* field as well as a path segment.
      body: { company: companyId, ...pruneUndefined(fields) },
    });
    return result(created, {
      notes: [
        `The new subnet's id is ${identify(created)}. Pass it as ipSubnetId to lumics_list_ipaddresses or lumics_create_ipaddress.`,
      ],
    });
  },
});

/**
 * spec §10.4 `PATCH /companies/:company/ipsubnets/:id`.
 *
 * spec §14 defect 6: the vendor's body table repeats POST's `required` markers
 * on `company`, `network`, `netmask` and `cidr`, but the documented example
 * sends only `{netmask, cidr}`. The example is authoritative, so every field is
 * optional here and the body carries only what the caller changed.
 */
const updateIpSubnet = defineTool({
  name: 'lumics_update_ipsubnet',
  title: 'Update an IP subnet',
  operation: 'update',
  description:
    'Update one subnet in place. Send only the fields you want to change; omitted fields are left alone. Common uses: assigning a collector so the range starts being scanned, setting excludeFromScheduledScan true to take a range out of the scan rotation without losing its address records, moving a subnet under a different parent group, or correcting a netmask and cidr together after a re-plan. Changing network, netmask or cidr redefines which addresses the subnet covers — the address records already stored under it are not re-homed, so re-check them afterwards with lumics_list_ipaddresses. Returns the complete updated subnet.',
  inputSchema: {
    ipSubnetId: objectIdSchema.describe('Lumics IP subnet id to update.'),
    companyId: companyIdSchema,
    network: networkSchema.optional(),
    netmask: netmaskSchema.optional(),
    cidr: cidrSchema.optional(),
    ...ipSubnetOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { ipSubnetId, companyId: _companyId, ...changes } = args;
    return patchResource<IpSubnet>(context, {
      path: ipSubnetPath(companyId, ipSubnetId),
      operation: `PATCH ipsubnet ${ipSubnetId}`,
      changes,
      updatableFields: IP_SUBNET_UPDATABLE,
    });
  },
});

/**
 * spec §10.5 `DELETE /companies/:company/ipsubnets/:id`.
 * spec §10.5 documents no caveat about the addresses contained in the subnet and
 * no cascade behaviour either way, which is exactly why the description below
 * says what is *knowable*: the address routes are nested under a subnet id, so
 * whatever Lumics does with those records internally, they stop being reachable.
 */
const deleteIpSubnet = defineTool({
  name: 'lumics_delete_ipsubnet',
  title: 'Delete an IP subnet',
  operation: 'destructive',
  description:
    'Permanently delete a subnet from the company IPAM. This is not a small act: the subnet definition goes, and with it the address inventory kept under it — every IP address route in this API is nested under a subnet id, so the addresses recorded in that range, their names, DNS names, MAC addresses, NAT mappings, notes and scan history, are no longer reachable once the subnet is gone. Lumics documents no cascade behaviour and no restore, and this server cannot undo it. Call lumics_list_ipaddresses first and report to the user how many address records the subnet holds. If the aim is only to stop scanning the range, call lumics_update_ipsubnet with excludeFromScheduledScan true instead; if the aim is to reorganise, change parent instead. Returns the subnet record that was deleted.',
  inputSchema: {
    ipSubnetId: objectIdSchema.describe(
      'Lumics IP subnet id to delete. Confirm it with lumics_get_ipsubnet first.',
    ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    return deleteResource<IpSubnet>(context, {
      path: ipSubnetPath(companyId, args.ipSubnetId),
      operation: `DELETE ipsubnet ${args.ipSubnetId}`,
      note: (deleted) =>
        `Subnet ${identify(deleted)} has been permanently deleted from the Lumics IPAM. Any IP address records it held are no longer reachable, because every IP address route is nested under a subnet id.`,
    });
  },
});

// ---------------------------------------------------------------------------
// IP Address — spec §8
// ---------------------------------------------------------------------------
//
// MEASURED 2026-07-31: every route here is SINGULAR `/ipsubnet/`, for all five
// calls. `...ReadPath` and `...WritePath` now build the same string; the two
// names are kept so the call sites still read as reads and writes. spec §13 Q1
// claimed a per-verb split and it is wrong — see the module header.

const ipSubnetIdArgSchema = objectIdSchema.describe(
  'Lumics id of the subnet the address belongs to. Every IP address route is nested under a subnet, so this is required; get it from lumics_list_ipsubnets.',
);

/**
 * The address fields spec §8.3 documents as optional on create, reused on the
 * PATCH of spec §8.4. The prototype exposed an untyped `fields` record here,
 * which let a model write any key into any address; these are the documented
 * fields, each typed.
 *
 * `scanHistory` is documented (as `object`) and deliberately not exposed:
 * firstUp, lastScan, lastStatus and the statusChanges list are the collector's
 * record of what it observed, and a hand-written value is a fabricated
 * observation. Reads return it, so nothing is hidden. `_id` is omitted for the
 * same reason as on subnets.
 */
const ipAddressOptionalFields = {
  name: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('Name for the address given by a person, as opposed to the DNS name.'),
  dnsName: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('Name found for the address by reverse DNS lookup, e.g. "host1.example.com".'),
  macAddress: macAddressSchema
    .optional()
    .describe('Hardware MAC address observed at this IP, e.g. 00:1a:2b:3c:4d:5e.'),
  nat: ipAddressSchema
    .optional()
    .describe(
      'A translated address to record alongside this one, typically the public address this private address is NAT-ed to.',
    ),
  description: descriptionSchema.optional(),
  note: z.string().trim().max(2_000).optional().describe('Free-text operational note.'),
  state: ipAddressStateSchema.optional(),
} as const;

/** Fields a caller may change with {@link updateIpAddress}, for its error text. */
const IP_ADDRESS_UPDATABLE =
  'ipAddress, name, dnsName, macAddress, nat, description, note or state';

/**
 * spec §8.1 `GET /companies/:company/ipsubnet/:ipSubnet/ipaddresses` —
 * SINGULAR `ipsubnet`, per spec §13 Q1.
 */
const listIpAddresses = defineTool({
  name: 'lumics_list_ipaddresses',
  title: 'List IP addresses in a subnet',
  operation: 'read',
  description:
    'List the IP address records held in one subnet, each with its address, name, DNS name, MAC address, NAT address, description, note, state ("used" or "reserved") and scanHistory (firstUp, lastScan, lastStatus and the run of status changes). Use this to answer "what is in this range", "which addresses are free" or "what was last seen at this address", and before deleting a subnet so you can say what it holds. You must know the subnet id first — get it from lumics_list_ipsubnets; there is no company-wide address list in this API. The API cannot filter by state or address, so retrieve and filter locally, and note that only addresses Lumics has a record for appear here: an address absent from the list is not proven unused, only unrecorded.',
  inputSchema: {
    ipSubnetId: ipSubnetIdArgSchema,
    companyId: companyIdSchema,
    limit: listLimitSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    // spec §13 Q1: singular `ipsubnet` on the reads.
    const response = await context.client.get(ipAddressesReadPath(companyId, args.ipSubnetId), {
      query: { limit: args.limit },
    });
    const addresses = expectArray<IpAddress>(response, 'GET ipaddresses');
    return result(addresses, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: absentBodyNotes(response),
    });
  },
});

/**
 * spec §8.2 `GET /companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id` —
 * SINGULAR `ipsubnet`, per spec §13 Q1.
 */
const getIpAddress = defineTool({
  name: 'lumics_get_ipaddress',
  title: 'Get an IP address record',
  operation: 'read',
  description:
    'Retrieve one IP address record by its id, including its full scanHistory. Use this after lumics_list_ipaddresses when you need every field of a single address, for instance to read the complete status-change history behind an intermittent host. Requires both the subnet id and the address id.',
  inputSchema: {
    ipSubnetId: ipSubnetIdArgSchema,
    ipAddressId: objectIdSchema.describe(
      'Lumics IP address record id. Get it from lumics_list_ipaddresses. This is the record id, not the address itself.',
    ),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    // spec §13 Q1: singular `ipsubnet` on the reads.
    const address = expectObject<IpAddress>(
      await context.client.get(ipAddressReadPath(companyId, args.ipSubnetId, args.ipAddressId)),
      `GET ipaddress ${args.ipAddressId}`,
    );
    return result(address, { fields: args.fields });
  },
});

/**
 * spec §8.3 `POST /companies/:company/ipsubnet/:ipSubnet/ipaddresses` —
 * SINGULAR `ipsubnet`, measured 2026-07-31. The spec's plural is not routed.
 *
 * `company` and `ipSubnet` are required in the body as well as in the path, so
 * the handler repeats them rather than asking the caller twice.
 */
const createIpAddress = defineTool({
  name: 'lumics_create_ipaddress',
  title: 'Create an IP address record',
  operation: 'create',
  description:
    'Record an IP address inside a subnet — used to reserve an address for a device that is not yet live, or to document one Lumics has not discovered by scanning. Only ipAddress is required, but a bare address with no name or description is a record nobody can interpret later, so supply at least one. The address must fall inside the subnet you name; Lumics does not move it for you and there is no company-wide address route to fix it from. spec §8.3\'s example came back with state "reserved" when none was sent, but no default is documented — set state explicitly if it matters. Creating the same address twice in one subnet is not documented as rejected, so check lumics_list_ipaddresses first.',
  inputSchema: {
    ipSubnetId: ipSubnetIdArgSchema,
    ipAddress: ipAddressSchema.describe('The IP address to record, e.g. 172.27.16.20.'),
    companyId: companyIdSchema,
    ...ipAddressOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { ipSubnetId, companyId: _companyId, ...fields } = args;
    // spec §8.3: singular `ipsubnet`, measured 2026-07-31; see the header.
    const created = await context.client.post<IpAddress>(
      ipAddressesWritePath(companyId, ipSubnetId),
      {
        // spec §8.3: `company` and `ipSubnet` are required *body* fields as well
        // as path segments.
        body: { company: companyId, ipSubnet: ipSubnetId, ...pruneUndefined(fields) },
      },
    );
    return result(created, {
      notes: [`The new IP address record's id is ${identify(created)}.`],
    });
  },
});

/**
 * spec §8.4 `PATCH /companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id` —
 * SINGULAR `ipsubnet`, measured 2026-07-31. The spec's plural is not routed.
 *
 * spec §8.4 makes every field optional, including `company` and `ipSubnet`, and
 * its example sends a flat partial body. `ipSubnet` is not offered as a
 * changeable field: moving a record between subnets by PATCH is not documented
 * as supported, and getting it wrong strands the record under a subnet whose
 * range does not contain it.
 */
const updateIpAddress = defineTool({
  name: 'lumics_update_ipaddress',
  title: 'Update an IP address record',
  operation: 'update',
  description:
    'Update one IP address record in place. Send only the fields you want to change. Common uses: flipping state between "used" and "reserved" as an address is assigned or released, recording the MAC address or DNS name discovered for it, or adding a note about what holds it. Use this rather than lumics_delete_ipaddress when an address is being released but the record and its scan history are worth keeping — set state to "reserved" and say why in the note. This tool cannot move a record to a different subnet. Returns the complete updated record.',
  inputSchema: {
    ipSubnetId: ipSubnetIdArgSchema,
    ipAddressId: objectIdSchema.describe('Lumics IP address record id to update.'),
    companyId: companyIdSchema,
    ipAddress: ipAddressSchema
      .optional()
      .describe(
        'Corrected IP address. It must still fall inside the same subnet — this tool cannot move a record between subnets.',
      ),
    ...ipAddressOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { ipSubnetId, ipAddressId, companyId: _companyId, ...changes } = args;
    return patchResource<IpAddress>(context, {
      // spec §8.3: singular `ipsubnet`, measured 2026-07-31; see the header.
      path: ipAddressWritePath(companyId, ipSubnetId, ipAddressId),
      operation: `PATCH ipaddress ${ipAddressId}`,
      changes,
      updatableFields: IP_ADDRESS_UPDATABLE,
    });
  },
});

/**
 * spec §8.5 `DELETE /companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id` —
 * SINGULAR `ipsubnet`, measured 2026-07-31. The spec's plural is not routed.
 */
const deleteIpAddress = defineTool({
  name: 'lumics_delete_ipaddress',
  title: 'Delete an IP address record',
  operation: 'destructive',
  description:
    'Permanently delete one IP address record from a subnet. Everything recorded about that address goes with it: its name, DNS name, MAC address, NAT mapping, description, note, and its scanHistory — the first time it was seen up, its last scan, and every status change since. That history is an observational record and cannot be reconstructed by re-scanning. If the address is simply being released, call lumics_update_ipaddress with state "reserved" instead and keep the record. Delete only when the record itself is wrong, for example an address entered into the wrong subnet. Returns the record that was deleted.',
  inputSchema: {
    ipSubnetId: ipSubnetIdArgSchema,
    ipAddressId: objectIdSchema.describe(
      'Lumics IP address record id to delete. Confirm it with lumics_get_ipaddress first.',
    ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    return deleteResource<IpAddress>(context, {
      // spec §8.3: singular `ipsubnet`, measured 2026-07-31; see the header.
      path: ipAddressWritePath(companyId, args.ipSubnetId, args.ipAddressId),
      operation: `DELETE ipaddress ${args.ipAddressId}`,
      note: (deleted) =>
        `IP address record ${identify(deleted)} has been permanently deleted, including its scan history. The address itself is now simply unrecorded in this subnet.`,
    });
  },
});

// ---------------------------------------------------------------------------
// IP Group — spec §9
// ---------------------------------------------------------------------------

/**
 * spec §14 defect 8: the vendor's body table describes `name` as "The
 * description of the group" — a copy-paste of the `description` row. `name` is
 * the group's name; the description below says so rather than repeating the
 * vendor's error.
 */
const ipGroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe('Name of the IP group as it will appear in Lumics, e.g. "Branch sites".');

/** The group fields spec §9.3 documents as optional, reused on spec §9.4's PATCH. */
const ipGroupOptionalFields = {
  description: descriptionSchema.optional(),
  type: ipGroupTypeSchema.optional(),
  parent: parentGroupSchema.optional(),
} as const;

/** Fields a caller may change with {@link updateIpGroup}, for its error text. */
const IP_GROUP_UPDATABLE = 'name, description, type or parent';

/** spec §9.1 `GET /companies/:company/ipgroups`. */
const listIpGroups = defineTool({
  name: 'lumics_list_ipgroups',
  title: 'List IP groups',
  operation: 'read',
  description:
    'List the IP groups in a company — the containers that organise the IPAM tree, each with its name, description, type ("group" or "supernet") and parent. Use this to understand how the tenant organises its address space, to find a group id for the "parent" argument on a subnet or group write, or to walk the hierarchy: call it with parent set to a group id to get that group\'s children, and pair it with lumics_list_ipsubnets using the same parent to see the subnets at that level. Groups contain no addresses themselves; the addresses live in subnets.',
  inputSchema: {
    parent: parentFilterSchema,
    companyId: companyIdSchema,
    limit: listLimitSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(ipGroupsPath(companyId), {
      query: { limit: args.limit, parent: args.parent },
    });
    const groups = expectArray<IpGroup>(response, 'GET ipgroups');
    return result(groups, {
      requestedLimit: args.limit,
      fields: args.fields,
      notes: absentBodyNotes(response),
    });
  },
});

/**
 * spec §9.2 `GET /companies/:company/ipgroups/:id`.
 * This read returns `_id` where the list returns `id` (spec §4.2, §14 defect
 * 12); the payload is passed through as it arrived and {@link identify} reads
 * whichever key is present.
 */
const getIpGroup = defineTool({
  name: 'lumics_get_ipgroup',
  title: 'Get an IP group',
  operation: 'read',
  description:
    'Retrieve one IP group by its id. Use it to confirm a group before writing to it or deleting it. It returns the group record only, not its contents — to see what the group holds, call lumics_list_ipgroups and lumics_list_ipsubnets with parent set to this group id. Note this endpoint returns the identifier as "_id" while the list returns "id"; both mean the same thing.',
  inputSchema: {
    ipGroupId: objectIdSchema.describe('Lumics IP group id. Get it from lumics_list_ipgroups.'),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const group = expectObject<IpGroup>(
      await context.client.get(ipGroupPath(companyId, args.ipGroupId)),
      `GET ipgroup ${args.ipGroupId}`,
    );
    return result(group, { fields: args.fields });
  },
});

/**
 * spec §9.3 `POST /companies/:company/ipgroups`.
 * `name` is the only required field besides `company`, which is required in the
 * body as well as the path. No default is documented for `type`, and the
 * vendor's examples always send `"group"` — so it is left unset unless asked
 * for, rather than defaulted here on a guess.
 */
const createIpGroup = defineTool({
  name: 'lumics_create_ipgroup',
  title: 'Create an IP group',
  operation: 'create',
  description:
    'Create an IP group: a container used to organise subnets and other groups into a tree, for example one group per site or per environment. Only name is required. Set parent to nest it under an existing group, or leave parent unset for a top-level group. Set type to "supernet" if the group represents an aggregating supernet rather than a plain folder; Lumics documents no default, so leave it unset unless you mean one of the two. Creating a group does not move anything into it — assign subnets afterwards with lumics_update_ipsubnet, setting parent to the id returned here.',
  inputSchema: {
    name: ipGroupNameSchema,
    companyId: companyIdSchema,
    ...ipGroupOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { companyId: _companyId, ...fields } = args;
    const created = await context.client.post<IpGroup>(ipGroupsPath(companyId), {
      // spec §9.3: `company` is a required *body* field as well as a path segment.
      body: { company: companyId, ...pruneUndefined(fields) },
    });
    return result(created, {
      notes: [
        `The new group's id is ${identify(created)}. Use it as parent on lumics_update_ipsubnet or lumics_create_ipgroup to put records inside it.`,
      ],
    });
  },
});

/**
 * spec §9.4 `PATCH /companies/:company/ipgroups/:id`.
 * All six documented fields are optional here. The vendor's example body
 * includes `id` and `company` alongside the changed fields, so both are sent —
 * `company` is the company already in the path, so it cannot move the group
 * between tenants.
 */
const updateIpGroup = defineTool({
  name: 'lumics_update_ipgroup',
  title: 'Update an IP group',
  operation: 'update',
  description:
    'Update one IP group in place. Send only the fields you want to change. Common uses: renaming a group, or setting parent to re-parent a branch of the IPAM tree (pass null to move it to the top level). Re-parenting moves the group and everything under it, so check what that is first with lumics_list_ipgroups and lumics_list_ipsubnets filtered by this group id. Returns the complete updated group.',
  inputSchema: {
    ipGroupId: objectIdSchema.describe('Lumics IP group id to update.'),
    companyId: companyIdSchema,
    name: ipGroupNameSchema.optional(),
    ...ipGroupOptionalFields,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const { ipGroupId, companyId: _companyId, ...changes } = args;
    return patchResource<IpGroup>(context, {
      path: ipGroupPath(companyId, ipGroupId),
      operation: `PATCH ipgroup ${ipGroupId}`,
      changes,
      // spec §9.4: the documented example body carries `id` and `company`
      // alongside the changed fields.
      extraBody: { id: ipGroupId, company: companyId },
      updatableFields: IP_GROUP_UPDATABLE,
    });
  },
});

/**
 * spec §9.5 `DELETE /companies/:company/ipgroups/:id`.
 *
 * spec §14 defect 10: the vendor shows an example *request body* (`{id,
 * company}`) for this DELETE while documenting no body fields at all. None is
 * sent — the path already carries both ids, and inventing a body for a DELETE on
 * the strength of an example is how a 400 becomes a mystery.
 *
 * spec §9.5 also documents no caveat about deleting a group that still contains
 * subnets or child groups, so the description says what is unknown instead of
 * guessing a cascade.
 */
const deleteIpGroup = defineTool({
  name: 'lumics_delete_ipgroup',
  title: 'Delete an IP group',
  operation: 'destructive',
  description:
    'Permanently delete an IP group from the company IPAM. Lumics does not document what happens to the subnets and child groups whose parent this group is: they may be orphaned or they may be removed with it, and this server cannot tell you which. So before calling this, list the contents with lumics_list_ipgroups and lumics_list_ipsubnets using parent set to this group id, tell the user exactly what is inside, and prefer to re-parent those records first with lumics_update_ipsubnet and lumics_update_ipgroup — then delete an empty group, where the outcome is not in doubt. Deleting a group does not delete IP address records directly; only subnets hold those. Returns the group record that was deleted.',
  inputSchema: {
    ipGroupId: objectIdSchema.describe(
      'Lumics IP group id to delete. Confirm it with lumics_get_ipgroup first.',
    ),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    return deleteResource<IpGroup>(context, {
      path: ipGroupPath(companyId, args.ipGroupId),
      operation: `DELETE ipgroup ${args.ipGroupId}`,
      note: (deleted) =>
        `IP group ${identify(deleted)} has been permanently deleted. Lumics does not document whether the subnets and child groups that named it as parent were orphaned or removed — verify with lumics_list_ipsubnets and lumics_list_ipgroups.`,
    });
  },
});

// ---------------------------------------------------------------------------
// Shared handler shape
// ---------------------------------------------------------------------------

/**
 * PATCH one IPAM record: prune the caller's omissions, refuse a no-op, send the
 * partial body, unwrap `{updated: {...}}` (spec §4.2).
 *
 * Shared by all three resources so the empty-PATCH guard and the envelope
 * handling exist once rather than three times.
 */
async function patchResource<T>(
  context: ToolContext,
  input: {
    readonly path: string;
    readonly operation: string;
    readonly changes: Record<string, unknown>;
    /** Fields the vendor's documented example carries in addition to the changes. */
    readonly extraBody?: Record<string, unknown>;
    /** Field names for the "you changed nothing" message. */
    readonly updatableFields: string;
  },
): Promise<ToolOutput> {
  const patch = pruneUndefined(input.changes);

  if (Object.keys(patch).length === 0) {
    // A no-field PATCH would return 200 and change nothing, which reads to a
    // model as "the update worked". Better to say what happened.
    throw new LumicsInputError(
      `No fields to update were supplied, so this call would change nothing. Provide at least one of ${input.updatableFields}.`,
    );
  }

  const response = await context.client.patch<unknown>(input.path, {
    body: { ...input.extraBody, ...patch },
  });
  return result(unwrapUpdated<T>(response, input.operation));
}

/**
 * DELETE one IPAM record and unwrap `{deleted: {...}}` (spec §4.2), so the
 * caller can report exactly what went. `note` states the impact concretely; it
 * receives the deleted record because the id it should quote is only knowable
 * from the response for the endpoints that return `_id`.
 */
async function deleteResource<T extends LumicsResource>(
  context: ToolContext,
  input: {
    readonly path: string;
    readonly operation: string;
    readonly note: (deleted: T) => string;
  },
): Promise<ToolOutput> {
  const response = await context.client.delete<unknown>(input.path);
  const deleted = unwrapDeleted<T>(response, input.operation);
  return result(deleted, { notes: [input.note(deleted)] });
}

/**
 * spec §4.2: IPAM list reads return `id` while the single ipgroup read and every
 * create/update/delete payload returns `_id`. `resourceId()` reads whichever
 * arrived, so nothing here assumes one or the other.
 */
function identify(resource: LumicsResource | null | undefined): string {
  return resourceId(resource) ?? 'unknown (Lumics returned no id field)';
}

/**
 * Drop keys whose value is `undefined`, so a partial write sends only what the
 * caller actually set.
 *
 * Unlike the equivalent in `./devices.ts`, `null` is **kept**: spec §9.3 and
 * §10.3 document `parent` as "the id of the parent (containing) group, or null
 * for top level", so `parent: null` is a meaningful instruction rather than an
 * accidental field wipe. No other field in this module accepts `null` — the zod
 * schemas reject it — so keeping nulls cannot widen anything else.
 */
function pruneUndefined(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The fifteen IPAM endpoints of spec §8, §9 and §10 — subnets first, because
 * every address call needs a subnet id.
 */
export const ipamTools: readonly LumicsToolDefinition[] = [
  listIpSubnets,
  getIpSubnet,
  createIpSubnet,
  updateIpSubnet,
  deleteIpSubnet,
  listIpAddresses,
  getIpAddress,
  createIpAddress,
  updateIpAddress,
  deleteIpAddress,
  listIpGroups,
  getIpGroup,
  createIpGroup,
  updateIpGroup,
  deleteIpGroup,
];

export default ipamTools;
