/**
 * Component tools — all five endpoints of spec §6.
 *
 * Structure follows `./devices.ts`, which is the reference pattern. Three things
 * are specific to components and worth reading before changing anything here.
 *
 * **1. The `:component` path segment cannot be guessed, so discovery is a tool.**
 * spec §6.1/§6.2 take a free-form component-type key (`<module>_<group>_<type>`,
 * e.g. `cisco_ast_devices`) and spec §14 defect 14 records that no enumeration is
 * documented anywhere. A wrong key produces a 404 that looks identical to "no such
 * component", which a model cannot diagnose. `lumics_list_component_types`
 * (spec §6.4) exists for exactly that lookup, so the list and get descriptions
 * point at it and its own description says that is its purpose.
 *
 * **2. Three of these five endpoints accept no `limit` at all** (spec §4.3 names
 * `component/:component/`, `componenttypes/` and `system/deviceDefinitions/components`
 * among the endpoints with "no documented pagination or limit at all"). With no
 * `limit` there is nothing to pass as `requestedLimit`, so the factory's
 * completeness heuristic — "returned exactly the limit, so more may exist" —
 * cannot fire. Each of those tools therefore passes an explicit `notes` entry
 * saying the endpoint takes no limit or pagination parameter, so the response is
 * whatever Lumics returned in full and cannot be paged. Silent truncation reading
 * as completeness is the exact failure mode this project designs against.
 *
 * **3. Component objects are Mongoose documents.** spec §4.2/§6.1: identity is in
 * `_id`, not `id`, and `__t` (discriminator, e.g. `"pingtcp.Port"`) and `__v`
 * (version key) come along with it. Code here reads identity through
 * {@link resourceId} rather than picking a key, and the descriptions tell the
 * model what those two underscore fields are so it neither reports `__v` as data
 * nor loses `__t`, which is the only thing naming a component's concrete type.
 *
 * spec §6.1/§6.2/§6.4 document `:context` as `admingroups | companies` and
 * spec §6.3 is company-scoped only; v0.1 is `companies`-only throughout
 * (RFC-001 open question 3, owner-approved), so these tools take an optional
 * `companyId` and never a `context` pair. spec §6.5 is the one genuinely
 * system-scoped route and takes no company at all.
 */

import { z } from 'zod';
import { absentBodyNotes, expectArray, expectObject, unwrapUpdated } from '../api/client.js';
import {
  componentPath,
  componentTypesPath,
  componentUpdatePath,
  componentsPath,
  deviceDefinitionComponentsPath,
} from '../api/paths.js';
import {
  resourceId,
  type Component,
  type ComponentType,
  type DeviceDefinitionComponent,
} from '../domain/index.js';
import { defineTool, result, type LumicsToolDefinition } from './factory.js';
import { companyIdSchema, fieldsSchema, objectIdSchema } from './schemas.js';

/**
 * spec §6.1: `component` is "The component type", a free-form string. The id
 * format comes from spec §6.4's response example (`<module>_<group>_<type>`), and
 * it is deliberately not an enum: spec §14 defect 14 says no enumeration exists,
 * and a guessed enum would reject valid keys a tenant really has.
 */
const componentTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe(
    'Component type key, spelled exactly as the "id" field of a lumics_list_component_types record — the form is <module>_<group>_<type>, e.g. "cisco_ast_devices" or "snmp_f5_f5pools". Lumics documents no list of valid keys, so do not guess: call lumics_list_component_types first and copy a value from it. An unrecognised key returns 404, which is indistinguishable from a component type that simply has no members.',
  );

/**
 * The note every limit-less endpoint in this module attaches.
 *
 * spec §4.3 lists these endpoints as having no documented pagination or limit at
 * all, which means `requestedLimit` is unavailable and the factory cannot emit its
 * usual "this equalled your limit, so more may exist" disclosure. Saying nothing
 * would leave the model to assume the silence means completeness.
 */
function noLimitNote(endpoint: string): string {
  return (
    `NOTE ON COMPLETENESS: the Lumics endpoint behind this tool (${endpoint}) accepts NO limit, offset, page, ` +
    'cursor or sort parameter at all (spec section 4.3), so this response is the entire set Lumics returned for ' +
    'the request and there is no mechanism to ask for more, to page, or to change how many records come back. ' +
    'Narrow the request instead — a more specific component type, or a fields projection. If the response was ' +
    'additionally cut to fit the output budget, that is disclosed as a separate note; absent such a note, what ' +
    'you see is what Lumics sent.'
  );
}

/**
 * spec §6.1 `GET /:context/:contextId/component/:component/` — singular
 * `component` segment and a trailing slash, both preserved by
 * `componentsPath()`.
 */
const listComponents = defineTool({
  name: 'lumics_list_components',
  title: 'List components of one type',
  operation: 'read',
  description:
    'List every component of a single component type across the company — components are the sub-parts Lumics monitors inside devices, such as interfaces, TCP ports, fan sensors or F5 pools. Each record carries "_id" (components use _id, not id), the parent "device" id, "name", "index", "isMonitored", "__t" naming its concrete type (e.g. "pingtcp.Port"), the Mongoose version key "__v", and fields specific to the type. You must know the component type key before calling this: get it from lumics_list_component_types, because Lumics publishes no list and a wrong key returns 404. Costs: this endpoint accepts no limit and returns every component of the type in the whole company, which on a large tenant is a big response — pass "fields" to keep only what you need, and expect no way to page. Components are not filtered by device here, so filter the result locally on "device" if you want one device\'s components.',
  inputSchema: {
    componentType: componentTypeSchema,
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(componentsPath(companyId, args.componentType));
    const components = expectArray<Component>(response, `GET components ${args.componentType}`);
    // spec §4.3: no `limit` exists on this endpoint, so `requestedLimit` is
    // deliberately not set and the disclosure is made explicitly instead.
    return result(components, {
      fields: args.fields,
      notes: [
        noLimitNote('GET /companies/:companyId/component/:component/'),
        ...absentBodyNotes(response),
      ],
    });
  },
});

/**
 * spec §6.2 `GET /:context/:contextId/component/:component/:id`. No query
 * parameters. Both the type key and the id are required path segments.
 */
const getComponent = defineTool({
  name: 'lumics_get_component',
  title: 'Get a component',
  operation: 'read',
  description:
    'Retrieve one component by its component type and its id, returning the full object including the type-specific fields. Prefer this over lumics_list_components whenever you already have the id — the list form has no limit and returns every component of the type in the company, so it is far more expensive. You need two things first: the component type key from lumics_list_component_types, and the component id, which appears as "_id" (not "id") in a list result or as the item id in a metric response. Supplying the right id under the wrong component type returns 404.',
  inputSchema: {
    componentType: componentTypeSchema,
    componentId: objectIdSchema.describe(
      'Lumics component id — the "_id" field of a component record, not "id".',
    ),
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const component = expectObject<Component>(
      await context.client.get(componentPath(companyId, args.componentType, args.componentId)),
      `GET component ${args.componentId}`,
    );
    return result(component, { fields: args.fields });
  },
});

/**
 * spec §6.3 `PATCH /companies/:companyId/component/:component/:id` — company
 * scoped only; there is no `:context` variant of the component update.
 *
 * **Capability reduction, deliberate.** spec §6.3 documents *no body field list
 * whatsoever* (spec §14 defect 3); the only guidance is one example body,
 * `{ "name": "component-name", "company": "<objectId>" }`. The prototype exposed
 * a free-form `changes` object here, which lets a model write any key into any
 * component — including `device` (re-parenting a component onto another device),
 * `company` (moving it between tenants) and `__t` (rewriting its discriminator,
 * which would make the document unreadable to Mongoose). Narrowed instead to the
 * one field the documented example actually sets. `company` is sent from the
 * resolved company, matching the example, and is never a model-supplied argument.
 * Anything beyond renaming is a Lumics UI operation until the vendor documents a
 * field list.
 */
const updateComponent = defineTool({
  name: 'lumics_update_component',
  title: 'Rename a component',
  operation: 'update',
  description:
    'Rename one component. Lumics documents no other writable field on a component — the only documented update body sets "name" — so this tool changes the name and nothing else: it cannot move a component to another device, change its type, or turn monitoring on or off. Requires the component type key (from lumics_list_component_types) and the component id (the "_id" of a component record). The name is usually discovered rather than chosen: components are created by discovery, so renaming one only changes its label in Lumics and does not touch the device. Returns the complete updated component.',
  inputSchema: {
    componentType: componentTypeSchema,
    componentId: objectIdSchema.describe(
      'Lumics component id to update — the "_id" field of a component record. Confirm it with lumics_get_component first.',
    ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe('New name for the component. This is the only field Lumics documents as writable.'),
    companyId: companyIdSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const operation = `PATCH component ${args.componentType}/${args.componentId}`;
    const response = await context.client.patch<unknown>(
      componentUpdatePath(companyId, args.componentType, args.componentId),
      {
        // spec §6.3's example body is `{ name, company }`; `company` is filled
        // from the resolved company rather than accepted as an argument.
        body: { name: args.name, company: companyId },
      },
    );
    const updated = unwrapUpdated<Component>(response, operation);
    // Components identify themselves with `_id` (spec §4.2), so read the id back
    // through the helper rather than assuming either key.
    const updatedId = resourceId(updated) ?? args.componentId;
    return result(updated, {
      notes: [`Component ${updatedId} was renamed. No other field was changed.`],
    });
  },
});

/**
 * spec §6.4 `GET /:context/:contextId/componenttypes/` — trailing slash
 * preserved. The `component` path parameter the vendor documents does not exist
 * in the template (spec §14 defect 2) and `componentTypesPath()` does not accept
 * one.
 */
const listComponentTypes = defineTool({
  name: 'lumics_list_component_types',
  title: 'List component types',
  operation: 'read',
  description:
    'List the component type keys available in this company, each as {id, module, group, type} — for example {"id":"cisco_ast_devices","module":"cisco","group":"ast","type":"devices"}. This tool exists specifically so the component type key can be looked up rather than guessed: lumics_list_components, lumics_get_component and lumics_update_component all take that key as a path segment, Lumics publishes no enumeration of valid values, and an invented key fails with a bare 404 that gives no hint it was the key that was wrong. Call this first whenever you are about to work with components, and copy an "id" value verbatim. "module" is what the metric tools accept as moduleType. But do NOT use these "id" values as a metric itemType: a live contract run on 2026-07-30 measured that this endpoint returns the PLURAL alias while the metric API demands the SINGULAR component id, and 213 of 246 ids are rejected as a result — "snmp_common_cpus" fails with "Unknown component", "snmp_common_cpu" succeeds. See spec section 12.5 M3; the metric tools\' own itemType descriptions carry the construction rule. Cheap and small: no limit parameter exists and the response is the full list.',
  inputSchema: {
    companyId: companyIdSchema,
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const companyId = context.resolveCompanyId(args.companyId);
    const response = await context.client.get(componentTypesPath(companyId));
    const componentTypes = expectArray<ComponentType>(response, 'GET componenttypes');
    return result(componentTypes, {
      fields: args.fields,
      notes: [
        noLimitNote('GET /companies/:companyId/componenttypes/'),
        ...absentBodyNotes(response),
      ],
    });
  },
});

/**
 * spec §6.5 `GET /system/deviceDefinitions/components` — the one genuinely
 * system-scoped route in this module: a literal `system` segment, no contextId,
 * and no documented path, query or body parameter at all (spec §13 Q2). It
 * therefore takes no `companyId` and `resolveCompanyId` is not called.
 */
const getDeviceDefinitionComponents = defineTool({
  name: 'lumics_get_device_definition_components',
  title: 'Get component definitions',
  operation: 'read',
  description:
    'Return the platform-wide component definitions that describe what each component type looks like: filePath, and a "data" block with modelName, itemType, componentAlias, isDefaultMonitored, nameProperty, the field "schema" (which property names a component of that type carries, and their types), and componentManagement. Use this when you need to know what fields a component type has or how it is defined — for instance to interpret an unfamiliar component. Its "schema" is the INVENTORY schema and carries no metric property names, so do NOT use it to find values for a metric tool\'s "properties" argument: a live contract run on 2026-07-30 grepped the whole payload and found zero occurrences of any metric type group. Use lumics_get_metric_summary for that instead (spec section 12.5 M6). This endpoint IS the source for a metric itemType, which is built as the filePath module/group path plus "data.itemType" joined by "_" — for example /components/snmp/common/Cpu.yml with itemType "cpu" gives "snmp_common_cpu". This is Lumics platform metadata, not tenant data: it is the same for every company, describes every type the product supports rather than the types this tenant uses, and takes no company id. It is also large, and it accepts no limit — if you only need a valid component type key for this tenant, call lumics_list_component_types instead, which is much smaller. Pass "fields" (e.g. ["filePath"]) to keep the response manageable.',
  inputSchema: {
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const response = await context.client.get(deviceDefinitionComponentsPath());
    const definitions = expectArray<DeviceDefinitionComponent>(
      response,
      'GET system deviceDefinitions components',
    );
    return result(definitions, {
      fields: args.fields,
      notes: [
        noLimitNote('GET /system/deviceDefinitions/components'),
        ...absentBodyNotes(response),
      ],
    });
  },
});

/** All five component endpoints of spec §6, in spec order. */
export const componentTools: readonly LumicsToolDefinition[] = [
  listComponents,
  getComponent,
  updateComponent,
  listComponentTypes,
  getDeviceDefinitionComponents,
];

export default componentTools;
