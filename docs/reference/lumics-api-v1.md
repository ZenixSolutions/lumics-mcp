# Lumics REST API v1.0 — Extracted Specification

**Source:** `https://app.lumics.io/#/documentation/api/*` (vendor's own in-app API Reference, authenticated session).
**Extracted:** 2026-07-29. **API Version:** 1.0 (every endpoint page reports `API Version 1.0`, `Login Required true`, `Response Format application/json`).
**Base URL:** `https://app.lumics.io`

**Coverage:** Overview, Authentication, Errors, Resources index, and all 41 endpoint detail pages (slug ids 680 → 1480 in steps of 20). No page failed to load.

> **Redaction note:** all example ObjectIds, IP addresses, hostnames, e-mail addresses and tokens from the documentation examples have been replaced with placeholders. Identifier *shapes* are preserved: every `hex id` in this API is a 24-character hex MongoDB ObjectId (e.g. `5628b8174b6cf000001bf163` shape → written here as `<objectId>`).

---

## 1. Overview (verbatim)

> The Lumics API is used to power the Lumics monitoring application, and also to enable user access to the data.
>
> Most resources follow the REST pattern to support Create/Read/Update/Delete operations.
>
> The API uses JSON as its data format.

---

## 2. Authentication (verbatim, credentials redacted)

> You authenticate to the Lumics API by providing a JWT token in the request headers.
>
> JWT tokens are an open standard to represent claims securely between two parties, using a digital signature to guarantee integrity. You can read more about the JWT spec in the RFC. Your JWT tokens identify your API requests as your user, so be sure to keep them secret. If exposed, there is an api endpoint to revoke existing tokens.
>
> To get a token for your user, login to the application in a browser and go to /api/v1/me/token. Alternatively you can also get one directly by POSTing to the same api with your username and password, e.g.:
>
> `curl -v -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data 'username=<email>&password=<password>' https://app.lumics.io/api/v1/me/token`
>
> By default the token expires in one day. You can request a longer expiry time using the expiresIn query parameter on the api request, where expiresIn is in seconds. See the token api resource documentation for more details.
>
> The api token will look something like this example (but much longer): `<jwt>`
>
> You can then use that token in API requests by adding a header to your http request like this:
>
> `Authorization: Bearer <jwt>`
>
> e.g. here's a full example curl command:
>
> `curl -X GET -v --header 'Content-Type: application/json; charset=utf-8' --header 'Authorization: Bearer <jwt>' https://app.lumics.io/api/v1/me`

Notes for implementers:
- Two content types are demonstrated for the token endpoint: `application/x-www-form-urlencoded` (curl example on the Authentication page) and `application/json` (the token endpoint's own page declares `Content-Type: application/json` and a JSON body).
- Auth header format: `Authorization: Bearer <jwt>`.

---

## 3. Errors — HTTP status codes (verbatim table)

> The API attempts to return appropriate HTTP status codes for every request.

| Code | Text | Description |
|---|---|---|
| 200 | OK | Success |
| 304 | Not Modified | There was no new data to return |
| 400 | Bad Request | The request was invalid or cannot be otherwise served - indicates a problem with the parameters supplied |
| 401 | Unauthorized | This indicates that the request is not authenticated - probably a problem with the token |
| 403 | Forbidden | You receive this error if you try to access data that your user does not have access to |
| 404 | Not found | Resource could not be found |
| 409 | Conflict | Occurs if you try to create a resource which would be a duplicate of an existing resource |
| 423 | Locked | The resource could not be modified because another process or user has locked it |
| 429 | Too Many Requests | Some API requests are rate limited, this error indicates you have exceeded the limit |
| 500 | Server Error | Something went wrong on the server side |

**Important:** these are the *only* documented status codes. **No endpoint detail page documents per-endpoint status codes, error bodies, or error shapes.** Rate limiting exists (429) but no limits, windows or headers are documented anywhere.

---

## 4. Cross-cutting conventions

### 4.1 The `:context` / `:contextId` path parameters

`:context` is a literal path segment naming the tenancy scope. Documented accepted values vary **per endpoint** (see §12, Q2):

| Documented value set | Endpoints |
|---|---|
| `admingroups \| companies` | all collector endpoints; component list/read; componenttypes |
| `admingroups \| companies \| system` | `GET /devices`, `GET /devices/:id` |
| `companies` only | `POST /devices`, `PUT /devices/:id/modules/:module/lastDiscovery`, `PATCH /devices/:id`, `PATCH /devices/:ids/batch`, `DELETE /devices/:id` |
| "Context - admingroups or companies" | `GET /:context/:contextId/metrics/summaries/:moduleType` |

`:contextId` is documented on every one of those endpoints as `required, type: hex id` ("Context ID"). There is **no documented exception allowing `system` without a contextId.**

The IPAM resources (ipaddress, ipgroup, ipsubnet), the component PATCH, and the company-scoped metric endpoints do **not** use `:context`; they hard-code `companies` and take a `:company` / `:companyId` path parameter instead.

### 4.2 Response envelopes

| Operation | Shape |
|---|---|
| GET list | **bare JSON array** (no envelope, no total/count, no paging metadata) |
| GET single | **bare JSON object** |
| POST create | **bare created object** (no envelope) |
| PATCH single / PUT | `{ "updated": { ...full object... } }` |
| PATCH batch | `{ "updated": [ {...}, {...} ] }` |
| DELETE | `{ "deleted": { ...full object... } }` |
| Metric list/summarize | `{ "data": [ ... ], <timing + time-range metadata> }` |
| Metric summaries | `{ "data": { "devices": [ ... ] }, "count": n, <timing + time-range metadata> }` |
| `POST /me/token/revoke` | `{ "message": "all tokens revoked" }` |

Object identity keys are inconsistent in examples: reads/updates of collectors, devices, ipgroup list, ipsubnet list and ipaddress list return `id`; ipgroup single read, ipgroup/ipsubnet/ipaddress create-update-delete payloads and component reads return `_id`. Some documents also expose `__t` (discriminator) and `__v` (Mongoose version key) — component objects do.

### 4.3 Pagination

**There is no pagination in this API as documented.** Across all 41 endpoint pages the *only* result-control parameter is `limit` (`optional, type: integer`). There is **no** `offset`, `page`, `skip`, `cursor`, `after`, `sort`, or `order` parameter documented anywhere, and no response envelope carries a total count or next-page link for list endpoints. `limit` appears on:

- `GET /:context/:contextId/collectors` — "Amount of results"
- `GET /:context/:contextId/devices` — "Limits the amount of results returned." (listed under the *URL Parameters* heading on the page — a docs formatting quirk; it is a query parameter)
- `GET /companies/:company/ipsubnet/:ipSubnet/ipaddresses` — "Amount of results"
- `GET /companies/:company/ipgroups` — "Amount of results"
- `GET /companies/:company/ipsubnets` — "Amount of results"
- all four metric-data endpoints — "Maximum number of results to return"

List endpoints with **no documented pagination or limit at all**: `GET /:context/:contextId/component/:component/`, `GET /:context/:contextId/componenttypes/`, `GET /api/v1/system/deviceDefinitions/components`, `GET /:context/:contextId/metrics/summaries/:moduleType`.

---

## 5. Collector

Slug ids 680–760. All collector endpoints declare header `Content-Type: application/json` and `:context` accepted values `admingroups | companies`.

### 5.1 `GET /api/v1/:context/:contextId/collectors`
Description (verbatim): *"List all collectors for a given context."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | Accepted values: `admingroups \| companies` |
| `contextId` | path | required | hex id | Context ID |
| `limit` | query | optional | integer | Amount of results |

Response: bare array of collector objects. Example fields: `company`, `adminGroup`, `user`, `name`, `description`, `location`, `ipAddress`, `version`, `needsRestart` (false), `osConfig.ntpServers[]`, `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `id`.

### 5.2 `GET /api/v1/:context/:contextId/collectors/:id`
Description: *"Retrieve a single collector."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | `admingroups \| companies` |
| `contextId` | path | required | hex id | Context ID |
| `id` | path | required | hex id | ID of the collector to retrieve |

No query parameters. Response: bare collector object (same fields as above).

### 5.3 `POST /api/v1/:context/:contextId/collectors`
Description: *"Create a new collector."*

Path: `context` (required, `admingroups | companies`), `contextId` (required, hex id).

Body:

| Field | Req | Type | Description (verbatim) |
|---|---|---|---|
| `_id` | optional | hex id | Collector ID |
| `company` | required | hex id | Company ID |
| `adminGroup` | optional | hex id | Admin group ID |
| `user` | optional | hex id | User ID for the collector account. A collector user is created automatically if omitted |
| `name` | required | string | Collector name |
| `description` | optional | string | Collector description |
| `location` | optional | string | Collector location |
| `ipAddress` | optional | string | Collector IP address. This should only be updated by the collector itself |
| `version` | optional | string | Collector software version. This should only be updated by the collector itself |
| `needsRestart` | optional | Date | Date the collector was marked as needing a restart, or false if a restart is not needed |
| `osConfig` | optional | object | Operating system configuration for the collector |

`osConfig` nested shape seen in examples: `{ "ntpServers": [ "<host>", "<host>" ] }`. No other nested keys documented.

Response: bare created collector object (server fills `user`, `needsRestart: false`, `osConfig.ntpServers: []`, `id`).

### 5.4 `PATCH /api/v1/:context/:contextId/collectors/:id`
Description: *"Modify an existing collector."*

Path: `context` (required), `contextId` (required), `id` (required, hex id, "ID of the collector").

Body — same field list as POST **except** `_id` is not listed and **all fields are optional**: `company`, `adminGroup`, `user` ("User ID for the collector account"), `name`, `description`, `location`, `ipAddress`, `version`, `needsRestart`, `osConfig` (descriptions identical to POST).

Response: `{ "updated": { ...full collector... } }`.

### 5.5 `DELETE /api/v1/:context/:contextId/collectors/:id`
Description (verbatim, includes the caveat): *"Delete a collector. A collector cannot be deleted while devices are assigned to it."*

Path: `context`, `contextId`, `id` (all required). No query params, no body.
Response: `{ "deleted": { ...full collector... } }`.

---

## 6. Component

### 6.1 `GET /api/v1/:context/:contextId/component/:component/`
Description: *"Get a list of components of the specified component type."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | Accepted values: `admingroups \| companies` |
| `contextId` | path | required | hex id | Context ID |
| `component` | path | required | string | The component type. |

**No query parameters documented — no `limit`, no pagination.** Note the trailing slash in the documented path template.

Response: bare array. Example component object: `_id`, `__t` (e.g. `"pingtcp.Port"`), `__v`, `adminGroup`, `company`, `device`, `index`, `isMonitored` (bool), `name`, plus type-specific fields (`port`).

### 6.2 `GET /api/v1/:context/:contextId/component/:component/:id`
Description: *"Get a single component with the component type and id."*

Path: `context` (required, `admingroups | companies`), `contextId` (required, hex id), `component` (required, string, "The component type."), `id` (required, hex id, "The component ID").
No query params. Response: bare component object.

### 6.3 `PATCH /api/v1/companies/:companyId/component/:component/:id`
Description: *"Update a single component."*
**Company-scoped only — there is no `:context` variant of the component update.**

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `companyId` | path | required | hex id | Company ID |
| `component` | path | required | string | The component type. |
| `id` | path | **optional** | hex id | The component ID *(documented as optional — almost certainly a docs error, since the path segment cannot be omitted)* |

**Body: no field list is documented.** Only an example request is given:
```json
{ "name": "component-name", "company": "<objectId>" }
```
Response: `{ "updated": { ...full component... } }`.

### 6.4 `GET /api/v1/:context/:contextId/componenttypes/`
Description: *"List all the component types."*

Path params documented: `context` (required, `admingroups | companies`), `contextId` (required, hex id), and — spuriously — `component` (required, string, "The component type."), which does not appear in the path template. Treat `component` as a documentation error.

No query params, no pagination. Response: bare array of `{ "id": "<module>_<group>_<type>", "module": "...", "group": "...", "type": "..." }`, e.g. `{"id":"cisco_ast_devices","module":"cisco","group":"ast","type":"devices"}`.

### 6.5 `GET /api/v1/system/deviceDefinitions/components`
Description: *"Get device definitions for components."*

**No path, query or body parameters documented at all.** Note the literal `system` segment and the *absence of any contextId*.

Response: bare array of definition objects:
```json
[{
  "includes": [],
  "filePath": "/components/cisco/ast/Device.yml",
  "data": {
    "enabled": true,
    "modelName": "Device",
    "itemType": "device",
    "componentAlias": "devices",
    "isDefaultMonitored": true,
    "schema": { "index": { "type": "String", "required": true } },
    "nameProperty": "index",
    "componentManagement": { "title": "Cisco Ast Devices", "displayProp": "index", "canManage": false }
  },
  "shas": {},
  "precompiled": false
}]
```
`data.schema` values may be plain type strings (`"name": "String"`) or objects (`{"type":"Schema.Types.Mixed"}`); `componentManagement` may omit `canManage`.

---

## 7. Device

All device endpoints declare header `Content-Type: application/json`.

### 7.1 `GET /api/v1/:context/:contextId/devices`
Description: *"List all the devices for a given context."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | **Accepted values: `admingroups \| companies \| system`** |
| `contextId` | path | required | hex id | Context ID |
| `limit` | query | optional | integer | "Limits the amount of results returned." (page lists it under *URL Parameters*, but it is a query param) |

Response: bare array of device objects. Documented example fields: `createdAt`, `createdBy`, `updatedAt`, `updatedBy`, `version`, `model`, `deviceType` (`switch`, `default`, …), `location`, `description`, `name`, `collector` (hex id), `ipAddress`, `company`, `adminGroup`, `priority` (0), `maintenanceType` (`disable-polling`), `maintenanceMode` (bool), `enabled` (bool), `customProperties: [{ customProperty: <objectId>, value: <any> }]`, `id`, and `modules` (map keyed by module instance name):

- `modules.snmp`: `module: "snmp"`, `snmpVersion` (`"2c"`), `credential` (hex id), `enabled`, `primary`, `name`, `description`, `location`, `sysObjectID`, `lastDiscovery` (ISO date), `useIfXTable` (bool)
- `modules.ping`: `module: "ping"`, `intervalMs`, `timeoutMs`, `packetSize`, `packetCount`, `advancedOptions` (bool), `enabled`, `primary`, `lastDiscovery`
- `modules.deviceConfigs`: `module: "snapshots"`, `credential`, `enableCredential`, `enabled`, `snapshotItems: [{ _id, snapshotType: "startup"|"running", enabled, arguments: { dashboardVisible, eventsEnabled, captureTimeout, initialPromptTimeout, telnetPort, protocol: "ssh", interval } }]` (argument values are strings in the example)

Note the module *key* need not equal `module` (`deviceConfigs` → `module: "snapshots"`).

### 7.2 `GET /api/v1/:context/:contextId/devices/:id`
Description: *"Retrieve a single device."*

Documented path params: `context` (required, `admingroups | companies | system`), `contextId` (required, hex id). **The page omits `:id` from its parameter list even though the path template contains it** — `id` is a required 24-char hex ObjectId.

No query params documented. Response: bare device object.

### 7.3 `POST /api/v1/:context/:contextId/devices`
Description: *"Create a single device."*

Path: `context` (required, string, **Accepted values: `companies`**), `contextId` (required, hex id).

Body:

| Field | Req | Type | Description |
|---|---|---|---|
| `company` | required | hex id | Company ID |
| `name` | required | string | Device name |
| `ipAddress` | required | string | Device ip address |
| `collector` | required | hex id | Collector ID |
| `deviceType` | required | string | Device Type |

No optional body fields documented; no enumeration of legal `deviceType` values (examples show `default` and `switch`). Response: bare created device, server-populated with `priority: 0`, `maintenanceMode: false`, `maintenanceType: "disable-polling"`, `enabled: true`, `location`, `modules.ping` (`enabled: true, primary: true, lastDiscovery: null`), `customProperties: []`, `createdAt`, `createdBy`, `adminGroup`, `id`.

### 7.4 `PUT /api/v1/:context/:contextId/devices/:id/modules/:module/lastDiscovery`
Description: *"Update the last discovery time for a module of a device."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | Accepted values: `companies` |
| `contextId` | path | required | hex id | Context ID |
| `id` | path | required | hex id | Device ID |
| `module` | path | required | string | Module to be updated |
| `date` | body | required | Date | The date that lastDiscovery will be updated to. |

Example request: `{ "date": "2021-03-30T14:14:41.000Z" }` (ISO-8601 UTC). Response: `{ "updated": { ...full device, with modules.<module>.lastDiscovery set... } }`.

### 7.5 `PATCH /api/v1/:context/:contextId/devices/:id`
Description: *"Update a single device."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | Accepted values: `companies` |
| `contextId` | path | required | hex id | Context ID |
| `id` | path | required | hex id | Device ID |
| `device` | body | required | Object | "An object with the device properties that need to be updated. **Must include the device ID.**" |

Caveat: the documented body field is named `device` but the example request is a *flat* object, not wrapped: `{ "name": "new-name", "id": "<objectId>" }`. Follow the example (flat body including `id`); the field list is not enumerated.

Response: `{ "updated": { ...full device... } }`.

### 7.6 `PATCH /api/v1/:context/:contextId/devices/:ids/batch`
Description: *"Update multiple devices."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `context` | path | required | string | Accepted values: `companies` |
| `contextId` | path | required | hex id | Context ID |
| `ids` | path | **optional** | string | "A string of comma delimited IDs" *(documented optional; it is a path segment, so in practice required)* |
| `device` | body | optional | Object | "The device properties that will be updated." |

Example request (flat, again not wrapped): `{ "location": "new-location" }`. No documented cap on how many ids may be passed.
Response: `{ "updated": [ {...device...}, {...device...} ] }` — an array inside the `updated` envelope.

### 7.7 `DELETE /api/v1/:context/:contextId/devices/:id`
Description: *"Delete a single device."*

Path: `context` (required, `companies`), `contextId` (required, hex id), `id` (required, hex id, "Device ID"). No query params/body.
Response: `{ "deleted": { ...full device... } }`.

---

## 8. IP Address (IPAM)

> ⚠️ **Path asymmetry is real in the docs:** the two GET endpoints use the **singular** `ipsubnet` segment; POST/PATCH/DELETE use the **plural** `ipsubnets`. See §12 Q1.

### 8.1 `GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses`
Description: *"Retrieve a list of all ip addresses for a subnet."*

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `company` | path | required | hex id | Company ID |
| `ipSubnet` | path | required | hex id | ID of the subnet |
| `limit` | query | optional | integer | Amount of results |

No `parent` filter here (unlike ipgroups/ipsubnets). Response: bare array of ip address objects: `company`, `ipAddress`, `ipSubnet`, `dnsName`, `macAddress`, `nat`, `description`, `note`, `state` (`"used"` / `"reserved"`), `id`, and
`scanHistory: { firstUp: <date>, lastScan: <date>, lastStatus: "up"|"down", statusChanges: [ { newStatus: "up"|"down", time: <date> } ] }`.

### 8.2 `GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id`
Description: *"Retrieve a single IP address by id."*
Path: `company` (required, hex id), `ipSubnet` (required, hex id, "ID of the subnet"), `id` (required, hex id, "ID of the IP address"). No query params. Response: bare ip address object.

### 8.3 `POST /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses`
Description: *"Create a new IP address."*

Path: `company` (required, hex id, "Company ID"), `ipSubnet` (required, hex id, "ID of the subnet the IP address belongs to").

Body:

| Field | Req | Type | Description (verbatim) |
|---|---|---|---|
| `_id` | optional | hex id | IP address id |
| `company` | required | hex id | Company ID |
| `ipSubnet` | required | hex id | ID of the subnet the IP address belongs to |
| `ipAddress` | required | string | The IP address |
| `dnsName` | optional | string | Name of the address found via reverse DNS lookup |
| `name` | optional | string | Name of the address given by the user |
| `macAddress` | optional | string | Hardware MAC address |
| `description` | optional | string | Description for the IP address |
| `nat` | optional | string | Can be used to record a NAT address e.g. public address |
| `note` | optional | string | Notes for the IP address |
| `state` | optional | string | Used or reserved |
| `scanHistory` | optional | object | Scan status and history for the IP address |

`state` values are described only as "Used or reserved"; examples use the lowercase literals `"used"` and `"reserved"`. Note `company`/`ipSubnet` must be repeated in the body even though both are in the path.

Response: bare created object (`_id`, `company`, `ipSubnet`, `ipAddress`, `name`, `state: "reserved"`, `scanHistory: { statusChanges: [] }`). Note: `state` defaulted to `"reserved"` in the example although not sent — no default is documented.

### 8.4 `PATCH /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id`
Description: *"Modify an existing IP address."*
Path: `company`, `ipSubnet`, `id` (all required, hex id).
Body: same 12 fields as POST, but **every field is optional** (including `company`, `ipSubnet`, `ipAddress`); descriptions identical.
Example request `{ "ipAddress": "<ip>", "name": "<name>" }`. Response: `{ "updated": { ...full ip address... } }`.

### 8.5 `DELETE /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id`
Description (verbatim, typo in original): *"Remove am IP address from the database."*
Path: `company`, `ipSubnet`, `id` (all required, hex id). No body/query.
Response: `{ "deleted": { ...full ip address... } }`.

---

## 9. IP Group (IPAM)

### 9.1 `GET /api/v1/companies/:company/ipgroups`
Description: *"List all the stored ip groups."* Header `Content-Type: application/json`.

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `company` | path | required | hex id | Company ID |
| `parent` | query | optional | hex id | Find groups with this group as their parent |
| `limit` | query | optional | integer | Amount of results |

Response: bare array of `{ type: "group", company, parent: <objectId>|null, name, description, id }`.

### 9.2 `GET /api/v1/companies/:company/ipgroups/:id`
Description: *"Retrieve a single ip group."* Path: `company` (required), `id` (required, hex id, "ID of the ip group to retrieve"). No query params.
Response: bare object — note it returns **`_id`**, not `id`, unlike the list endpoint.

### 9.3 `POST /api/v1/companies/:company/ipgroups`
Description: *"Create a new group."* Path: `company` (required, hex id).

| Field | Req | Type | Description (verbatim) |
|---|---|---|---|
| `_id` | optional | hex id | ip group id |
| `company` | required | hex id | Company ID |
| `name` | required | string | The description of the group *(copy-paste error in docs; this is the group name)* |
| `description` | optional | string | The description of the group |
| `type` | optional | string | group or supernet |
| `parent` | optional | hex id | The id of the parent (containing) group, or null for top level |

Response: bare created object (`_id`, `company`, `name`, `description`, `type`, `parent`). No default documented for `type` (examples always send `"group"`).

### 9.4 `PATCH /api/v1/companies/:company/ipgroups/:id`
Description: *"Modify an existing group."* Path: `company` (required), `id` (required, hex id, "ID of the group").
Body: same six fields as POST, **all optional** (`company` becomes optional). Example request includes `id` and `company` in the body: `{ "id": "<objectId>", "company": "<objectId>", "description": "..." }`.
Response: `{ "updated": { ... } }`.

### 9.5 `DELETE /api/v1/companies/:company/ipgroups/:id`
Description: *"Remove a group from the database."* Path: `company`, `id` (both required, hex id).
An **Example Request body is shown for this DELETE**: `{ "id": "<objectId>", "company": "<objectId>" }` — no body fields are formally documented.
Response: `{ "deleted": { ... } }`. No caveat is documented about deleting a group that still contains subnets/child groups.

---

## 10. IP Subnet (IPAM)

### 10.1 `GET /api/v1/companies/:company/ipsubnets`
Description: *"List all the stored ip subnets."* Header `Content-Type: application/json`.

| Param | In | Req | Type | Notes |
|---|---|---|---|---|
| `company` | path | required | hex id | Company ID |
| `parent` | query | optional | hex id | Find subnets with this group as their parent |
| `limit` | query | optional | integer | Amount of results |

Response: bare array. Fields seen: `network`, `netmask`, `cidr` (integer), `description`, `company`, `component`, `collector`, `ipamDiscoveryRule`, `scanProgress`, `lastScan`, `addressCount`, `usedCount`, `excludeFromScheduledScan`, `scanNetworkAndBroadcast`, `parent`, `customProperties: [{customProperty, value}]`, `id`. Minimal subnets omit the scan/collector fields entirely.

### 10.2 `GET /api/v1/companies/:company/ipsubnets/:id`
Description: *"Retrieve a single ip subnet."* Path: `company` (required), `id` (required, hex id, "ID of the ip subnet to retrieve"). No query params. Response: bare subnet object (with `id`).

### 10.3 `POST /api/v1/companies/:company/ipsubnets`
Description: *"Create a new subnet."* Path: `company` (required, hex id).

| Field | Req | Type | Description (verbatim) |
|---|---|---|---|
| `_id` | optional | hex id | ip subnet id |
| `company` | required | hex id | Company ID |
| `network` | required | string | The network IP address e.g. 172.27.16.0 |
| `netmask` | required | string | The netmask e.g. 255.255.255.0 |
| `cidr` | required | integer | The CIDR e.g. 24 |
| `description` | optional | string | The description of the subnet |
| `vlan` | optional | string | Optional VLAN name |
| `vrf` | optional | string | Optional VRF |
| `component` | optional | hex id | If the subnet is related to a network component discovered by SNMP, this id refers to that component |
| `collector` | optional | hex id | The id for the collector which will scan this subnet |
| `excludeFromScheduledScan` | optional | boolean | Set to true to tell the collector not to scan this subnet when performing a scheduled scan |
| `scanNetworkAndBroadcast` | optional | boolean | Set to true to include the network and broadcast addresses when scanning this subnet |
| `ipamDiscoveryRule` | optional | hex id | The IPAM discovery rule this subnet is assigned to |
| `lastScan` | optional | Date | Date the last scan ran for the subnet |
| `scanProgress` | optional | integer | Percent progress for a scan |
| `addressCount` | optional | integer | Number of usable addresses in the subnet |
| `usedCount` | optional | integer | Number of usable addresses which are assigned/responding |
| `parent` | optional | hex id | The id of the parent (containing) group, or null for top level |
| `customProperties` | optional | array | Custom property values assigned to the subnet |

`customProperties` element shape (from examples): `{ "customProperty": "<objectId>", "value": <any> }`.
Response: bare created object echoing only the supplied fields plus `_id`.

### 10.4 `PATCH /api/v1/companies/:company/ipsubnets/:id`
Description: *"Modify an existing subnet."* Path: `company` (required), `id` (required, hex id, "ID of the subnet").
Body: identical field list to POST — **and the docs still mark `company`, `network`, `netmask` and `cidr` as `required` on the PATCH**, even though the example request sends only `{ "netmask": "...", "cidr": 16 }`. Treat "required" here as a docs artefact; the example is authoritative for partial updates.
Response: `{ "updated": { ... } }`.

### 10.5 `DELETE /api/v1/companies/:company/ipsubnets/:id`
Description: *"Remove a subnet from the database."* Path: `company`, `id` (both required, hex id). No body/query documented.
Response: `{ "deleted": { ... } }`. No documented caveat about contained IP addresses.

---

## 11. Me / Tokens

All four endpoints declare header `Content-Type: application/json`, `Login Required true`.

### 11.1 `GET /api/v1/me`
Description: *"Get information about your user - can be used to obtain your company."*
No path/query/body parameters. Response shape:
```json
{
  "id": "<objectId>",
  "email": "<email>",
  "company": { "timezone": "<IANA tz>", "name": "<string>", "isActive": true, "id": "<objectId>" },
  "firstName": "<string>",
  "lastName": "<string>",
  "role": "user",
  "adminGroup": null
}
```
`role` example value `"user"`; no enum documented. `adminGroup` is `null` for a company user (hex id otherwise, by inference).

### 11.2 `GET /api/v1/me/token`
Description: *"Get a JWT token for your user."*

| Param | In | Req | Type | Description (verbatim) |
|---|---|---|---|---|
| `expiresIn` | query | optional | integer | "Time to live of the token in seconds (default 86400 i.e. 1 day)" |

No body. Response:
```json
{ "token": "<jwt>", "expiresIn": 86400 }
```
`expiresIn` in the response is the effective TTL in seconds. **No maximum value is documented** (see §12 Q3).

### 11.3 `POST /api/v1/me/token`
Description: *"Login and get a JWT token for your user."*

| Param | In | Req | Type | Description (verbatim) |
|---|---|---|---|---|
| `expiresIn` | query | optional | integer | "Time to live of the token in seconds (default 86400 i.e. 1 day)" |
| `username` | body | required | string | User's email address |
| `password` | body | required | string | User's password |

Example request: `{ "username": "<email>", "password": "<password>" }`. Response: `{ "token": "<jwt>", "expiresIn": 86400 }`.
The Authentication page also documents an `application/x-www-form-urlencoded` variant with the same two fields. Note the page still says `Login Required true` although this is the login endpoint.

### 11.4 `POST /api/v1/me/token/revoke`
Description: *"Revoke all previously issued JWT tokens for your user."*
No path/query/body parameters documented. Response: `{ "message": "all tokens revoked" }`. Caveat: this revokes **all** tokens for the user, not a single token — there is no single-token revoke and no token-listing endpoint.

---

## 12. Metrics

Four endpoints across three "resources". Three of them (company, company/summarize, device) share an identical 13-parameter query surface; `summarize` adds `sum`; the per-item device endpoint drops the component-selection params; `metrics/summaries` has a completely different, much smaller surface.

### 12.0 The shared metric query parameters (verbatim descriptions)

| Param | Req | Type | Description (verbatim) |
|---|---|---|---|
| `dataPoints` | **required** | integer | "The number of data points to return. Should be used in conjunction with aggregate=true to get an appropriate amount of data. Either dataPoints or width must be set, if both are set, width takes priority" |
| `width` | **required** | integer | "The width of the graph in pixels, used to infer the number of data points to return. Should be used in conjunction with aggregate=true to get an appropriate amount of data. Either dataPoints or width must be set, if both are set, width takes priority" |
| `aggregate` | optional | boolean | "Enable/disable on-the-fly aggregation of results" |
| `alignTimeRange` | optional | boolean | "If true, forces time range to snap to natural time boundaries (eg hours/days/months)" |
| `componentQuery` | optional | object | "A mongo query expression to limit the components for which metrics will be returned" |
| `filters` | optional | object | "A filter object which can be converted into a mongo query to limit the components for which metrics will be returned" |
| `fromMs` | optional | integer | "Used in conjunction with toMs to control the time range for which data is returned, expressed in epoch milliseconds. Defaults to one hour ago if not specified" |
| `interval` | optional | string | "Can be used to override the time interval of the metric rollups queried. If not set, this will be chosen automatically to provide the appropriate amount of data considering the time range and number of data points requested. Valid options: minute / fiveMin / hour / day" |
| `isMonitored` | optional | boolean | "If true, will limit the components for which metrics are returned to ones which are monitored, i.e. to filter out empty results" |
| `itemType` | optional | string | "Can be used to limit the type of component for which metrics are returned" |
| `lastMetric` | optional | boolean | "If set, limits the results to only include the most recent metric matching the rest of the criteria (including the time params), useful for getting status of an item" |
| `limit` | optional | integer | "Maximum number of results to return" |
| `minIntervals` | optional | integer | "Overrides how many intervals must fall into the time range in order for a particular metric rollup collection to be used. Defaults to 40" |
| `properties` | optional | string | "A comma separated list of metric properties to be included in the results" |
| `toMs` | optional | integer | "Used in conjunction with fromMs to control the time range for which data is returned, expressed in epoch milliseconds. Defaults to the current time if not specified" |
| `sum` | optional | string | *(summarize only)* "Which property to use when summing the data for each component - min, max, or avg" |

Key facts:
- **Time window = `fromMs` / `toMs`** (epoch **milliseconds**, integers). There is no `start`/`end`/`from`/`to`/`since`/`duration` query parameter. Defaults: `fromMs` = one hour ago, `toMs` = now.
- **Bucket/interval size** is *not* set directly in seconds. It is derived from the requested resolution (`dataPoints` **or** `width`, with `width` winning) combined with the time range; `interval` overrides the rollup granularity with one of exactly **`minute` / `fiveMin` / `hour` / `day`**; `minIntervals` (default **40**) governs whether a given rollup collection is eligible; `alignTimeRange` snaps the range to natural boundaries; `aggregate` toggles on-the-fly aggregation.
- **Item selection**: `itemType` (component type string, e.g. `snmp_f5_f5pools`), `isMonitored`, `componentQuery` (raw Mongo query), `filters` (filter object convertible to a Mongo query), and `properties` (comma-separated metric property paths, e.g. `aggr-space-attributes.size-used` or `status,Integer.statusEnabledState`).
- **Top-N / limit behaviour**: the only knob is `limit` — "Maximum number of results to return". **There is no `top`, `topN`, `sort`, `order`, `orderBy` or `direction` parameter on any metric endpoint**, and `metrics/summaries` (the endpoint whose own description advertises "top X lists of devices") documents **no `limit` at all** — see §12.4.
- `properties` on `summarize` is documented as a list, but the example passes a single property; nothing documents behaviour with multiple properties + `sum`.

### 12.1 `GET /api/v1/metrics/companies/:companyId/modules/:moduleType`
Description (verbatim): *"Gets metrics for one or more items (components), returning stats for each item separately"*

Path: `companyId` (required, hex id, "Company ID"), `moduleType` (required, string, "Name of the module" — e.g. `snmp`, `netapp`).
Query: the full shared set in §12.0 **without** `sum`.

Example request (as documented — note it is shown as a JSON blob although these are query params):
```json
{ "companyId": "<objectId>", "moduleType": "snmp", "fromMs": 1680184403601, "isMonitored": true,
  "itemType": "snmp_f5_f5pools", "lastMetric": true,
  "properties": "status,Integer.statusEnabledState,Integer.statusAvailState,OctetString.statusDetailReason,OctetString.statusName",
  "width": 1 }
```
Response envelope:
```json
{
  "data": [
    { "_id": "<objectId>", "item": "<objectId>", "type": "snmp_f5_f5pools", "timeMs": 1680185276731,
      "stats": { "OctetString": { "statusName": "...", "statusDetailReason": "..." },
                 "Integer": { "statusAvailState": 1, "statusEnabledState": 1 },
                 "status": { "statusAvailState": { "status": "ok", "text": "green" } } } }
  ],
  "preQueryMs": 18, "queryMs": 13,
  "timeInterval": 3688696, "timeIncrement": 60000,
  "fromMs": 1680184403601, "toMs": 1680185325775,
  "from": "2023-03-30T13:53:23.601Z", "to": "2023-03-30T14:08:45.775Z",
  "type": "standard"
}
```
`stats` is a two-level map: SNMP/other type bucket → property → value; `status` sub-objects carry `{status, text}`. `type` on the envelope indicates the aggregation mode actually used (`standard` here; `minMaxAvg` and `summed` seen elsewhere). The echoed `fromMs`/`toMs` show the effective, possibly adjusted, window.

### 12.2 `GET /api/v1/metrics/companies/:companyId/modules/:moduleType/summarize`
Description (verbatim): *"Gets metrics for one or more components, aggregating across all components by summarizing them into time buckets. With the sum query param the metric will be summed across all the components in each bucket, without it, the metrics will be averaged."*

Path: `companyId` (required, hex id), `moduleType` (required, string).
Query: the full shared set in §12.0 **including `sum`** (`optional, type: string` — "Which property to use when summing the data for each component - min, max, or avg").

Semantics worth pinning down for a client: presence of `sum` switches the cross-component reduction from *average* to *sum*, and its **value** selects which per-component rollup property (`min`, `max`, `avg`) feeds that sum.

Example request:
```json
{ "alignTimeRange": true, "fromMs": 1675684433000, "toMs": 1675717905000,
  "itemType": "netapp_ontap_dataaggregate", "minIntervals": 4,
  "properties": "aggr-space-attributes.size-used", "sum": "max", "width": 357 }
```
Response:
```json
{
  "data": [
    { "_id": 5, "type": "netapp_ontap_dataaggregate", "timeMs": 1675699200000,
      "count": 236, "countAggDocs": 4,
      "stats": { "aggr-space-attributes": { "size-used": { "sum": 98573026832384 } } } }
  ],
  "preQueryMs": 23, "queryMs": 3, "timeInterval": 3600000, "timeIncrement": 3600000,
  "fromMs": 1675681200000, "toMs": 1675717200000,
  "from": "2023-02-06T11:00:00.000Z", "to": "2023-02-06T21:00:00.000Z",
  "type": "summed", "components": 7
}
```
Note: here `data[]._id` is an **integer bucket index**, not an ObjectId; there is no `item` field (aggregated across components); `count`/`countAggDocs` describe the bucket; the envelope adds `components` (number of components aggregated) and `type: "summed"`. With `alignTimeRange: true` the returned `fromMs`/`toMs` are snapped and differ from the requested values. Buckets with no data are omitted (`_id` 5, 6, 8 in the example — 7 missing).

### 12.3 Metric Device
#### `GET /api/v1/metrics/devices/:id/modules/:moduleType`
Description: *"Get metrics for many components for a particular device"*
Path: `id` (required, hex id, "Device ID"), `moduleType` (required, string, "Name of the module").
Query: the full shared set in §12.0 **without** `sum` (includes `componentQuery`, `filters`, `itemType`).
Example: `{ "id": "<objectId>", "moduleType": "snmp", "fromMs": 1680531164306, "isMonitored": true, "itemType": "snmp_cisco_envmonfan", "lastMetric": true, "properties": "status", "width": 1 }`
Response: same envelope as §12.1 (`type: "standard"`, each `data[]` has `_id`, `item`, `type`, `timeMs`, `stats`).

#### `GET /api/v1/metrics/devices/:id/modules/:moduleType/:item`
Description: *"Get metrics for a single item (the device itself, or a component) for a particular device"*
Path: `id` (required, hex id, "Device ID"), `moduleType` (required, string), `item` (required, hex id, **"Item ID (device ID or component ID)"** — pass the device's own id for device-level metrics).

Query parameters — **reduced set**; `componentQuery`, `filters` and `itemType` are *not* documented here (they are meaningless for a single item). Documented: `dataPoints` (required), `width` (required), `aggregate`, `alignTimeRange`, `fromMs`, `interval`, `isMonitored`, `lastMetric`, `limit`, `minIntervals`, `properties`, `toMs` — descriptions identical to §12.0.

Example: `{ "id": "<objectId>", "moduleType": "netapp", "item": "<objectId>", "fromMs": 1675684433000, "toMs": 1675717905000, "properties": "aggr-space-attributes.size-used", "width": 357 }`
Response (`type: "minMaxAvg"`):
```json
{
  "data": [
    { "_id": 39, "type": "netapp_ontap_dataaggregate", "timeMs": 1675699200000,
      "count": 5, "countAggDocs": 1,
      "parentId": "<objectId>", "parentName": "<device name>", "item": "<objectId>",
      "stats": { "aggr-space-attributes": { "size-used": { "avg": 4.7e13, "min": 4.7e13, "max": 4.7e13 } } } }
  ],
  "preQueryMs": 10, "queryMs": 7,
  "timeInterval": 375036.41456582636, "timeIncrement": 300000,
  "fromMs": 1675684433000, "toMs": 1675717905000,
  "from": "2023-02-06T11:53:53.000Z", "to": "2023-02-06T21:11:45.000Z",
  "type": "minMaxAvg"
}
```
Here each bucket carries `min`/`max`/`avg` per property plus `parentId`/`parentName` (owning device). `timeInterval` can be fractional.

### 12.4 `GET /api/v1/:context/:contextId/metrics/summaries/:moduleType`
Description (verbatim): *"Get a summary of a set of metrics across all the relevant devices or components which report those metrics. Useful for e.g. top X lists of devices"*

| Param | In | Req | Type | Description (verbatim) |
|---|---|---|---|---|
| `context` | path | required | string | "Context - admingroups or companies" |
| `contextId` | path | required | hex id | "Group ID or Company ID" |
| `moduleType` | path | required | string | Name of the module |
| `itemType` | query | optional | string | "Can be used to limit the type of component for which summary metrics are returned" |
| `properties` | query | optional | string | "A comma separated list of metric properties to be included in the results" |
| `fromMs` | query | optional | integer | "Used in conjunction with toMs to control the time range for which data is returned, expressed in epoch milliseconds. Defaults to one hour ago if not specified" |
| `toMs` | query | optional | integer | "Used in conjunction with fromMs to control the time range for which data is returned, expressed in epoch milliseconds. Defaults to the current time if not specified" |

**Only four query parameters.** Explicitly **not supported/documented here:** `dataPoints`, `width`, `aggregate`, `alignTimeRange`, `interval`, `minIntervals`, `componentQuery`, `filters`, `isMonitored`, `lastMetric`, **`limit`**, `sum`. Despite the "top X lists" wording there is no top-N, sort or limit parameter — a client must retrieve the whole set and rank locally.

Example request: `{ "context": "companies", "contextId": "<objectId>", "moduleType": "snmp", "fromMs": 1677943497713, "itemType": "device", "toMs": 1680535498338 }` — note `itemType: "device"` selects device-level rather than component-level summaries.

Response — **`data` is an object, not an array** (keyed by item class):
```json
{
  "data": { "devices": [
      { "parents": [], "_id": "<objectId>", "name": "<device name>",
        "stats": { "Calculated": { "mem": { "avg": 60.3, "max": 62.85 },
                                   "cpu": { "avg": 10.33, "max": 37 } },
                   "TimeTicks": { "sysUpTime": { "avg": 2.96e9, "max": 3.04e9 } } } }
  ] },
  "count": 7, "preQueryMs": 8, "queryMs": 10, "combineMs": 0,
  "timeInterval": 86400000,
  "fromMs": 1677943497713, "toMs": 1680535498338,
  "from": "2023-03-04T15:24:57.713Z", "to": "2023-04-03T15:24:58.338Z"
}
```
Only `avg` and `max` are returned per property in the documented example (no `min`, no `sum`). `count` is the total number of items summarised (7) even though 3 are shown. Envelope adds `combineMs`. The `data` key seen is `devices`; other keys presumably appear for component item types but none are documented.

---

## 13. Answers to the three open questions

### Q1 — ipaddress singular vs plural `ipsubnet(s)`: the asymmetry is real in the documentation

The detail pages confirm the index page. Quoting the detail pages' own path headings:

- `GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses` — *"Retrieve a list of all ip addresses for a subnet."* (**singular**)
- `GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id` — *"Retrieve a single IP address by id."* (**singular**)
- `POST /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses` — *"Create a new IP address."* (**plural**)
- `PATCH /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id` — *"Modify an existing IP address."* (**plural**)
- `DELETE /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id` — *"Remove am IP address from the database."* (**plural**)

Additional corroboration: the generated documentation anchors/slugs themselves encode the segment, and they match — `_api_v1_companies_company_ipsubnet_ipSubnet_ipaddresses_get_1020`, `..._ipsubnet_ipSubnet_ipaddresses_id_get_1040` vs `..._ipsubnets_ipSubnet_ipaddresses_post_1060`, `..._ipsubnets_..._patch_1080`, `..._ipsubnets_..._delete_1100`. Since these slugs are derived from the route strings the docs are generated from, the split is present **in the route definitions**, not just in prose.

**Verdict:** real and consistent in the docs, but nothing in the docs calls it intentional — no note, no rationale, and the same pages contain other obvious typos ("Remove am IP address", `name` described as "The description of the group"). Read it as an upstream route inconsistency that has been faithfully documented. **Recommendation for the MCP server:** send `ipsubnet` (singular) for the two GETs and `ipsubnets` (plural) for POST/PATCH/DELETE exactly as documented; optionally retry with the other spelling on a 404, and flag it to the vendor.

### Q2 — legal values of `:context`, and whether `system` takes a `contextId`

There is no single global answer; the accepted set is documented per endpoint:

- Collectors (all 5), component list/read, componenttypes: *"context — required, type: string — Accepted values: admingroups | companies"*
- `GET /devices` and `GET /devices/:id`: *"Accepted values: admingroups | companies | system"*
- `POST /devices`, `PUT .../lastDiscovery`, `PATCH /devices/:id`, `PATCH /devices/:ids/batch`, `DELETE /devices/:id`: *"Accepted values: companies"*
- `GET /:context/:contextId/metrics/summaries/:moduleType`: *"context — required, type: string — Context - admingroups or companies"* with *"contextId — required, type: hex id — Group ID or Company ID"*

So: **`companies` is universal; `admingroups` is accepted for all reads and for collector writes but not for device writes; `system` is documented only on the two device read endpoints.**

Does `system` take a contextId? **The docs say yes, implicitly and without exception.** On both endpoints that accept `system`, the very next parameter is *"contextId — required, type: hex id — Context ID"*; no page documents a `system` form of the path without a contextId, and no page gives a sentinel value to use. The only genuinely system-scoped endpoint in the whole API takes a *different, literal* path with no contextId at all: `GET /api/v1/system/deviceDefinitions/components` ("Get device definitions for components", zero documented parameters). Treat `GET /system/<contextId>/devices` as documented-but-unspecified: the docs never say what hex id to supply for `system`, so a client should not rely on it, and `/api/v1/system/deviceDefinitions/components` is the one contextId-free system route.

### Q3 — the `me` token endpoints

**`GET /api/v1/me/token`** — *"Get a JWT token for your user."* Header `Content-Type: application/json`. One query parameter:
> `expiresIn` — *optional, type: integer* — *"Time to live of the token in seconds (default 86400 i.e. 1 day)"*

Response: `{ "token": "<jwt>", "expiresIn": 86400 }`.

**`POST /api/v1/me/token`** — *"Login and get a JWT token for your user."* Same `expiresIn` query parameter with the identical description. Body: `username` (*required, type: string* — "User's email address"), `password` (*required, type: string* — "User's password"). Example request `{"username": "<email>", "password": "<password>"}`; the Authentication page shows the same call as `application/x-www-form-urlencoded`. Response: `{ "token": "<jwt>", "expiresIn": 86400 }`.

- **Units:** seconds (integer). Confirmed twice — the parameter description and the Authentication page: *"You can request a longer expiry time using the expiresIn query parameter on the api request, where expiresIn is in seconds."*
- **Default:** `86400` (1 day). Also stated on the Authentication page: *"By default the token expires in one day."*
- **Maximum allowed value:** **not documented anywhere.** Neither token page, nor the Authentication page, nor the Errors page states any cap, clamping behaviour, or error for an oversized `expiresIn`. The only related statement is that a *longer* expiry may be requested. Do not assume a ceiling; treat over-large values as undefined behaviour (likely 400, per the generic error table).
- **Response shape:** exactly two fields, `token` (JWT string) and `expiresIn` (integer seconds, echoing the effective TTL). No issued-at, no expiry timestamp, no refresh token, no token id.
- Related: **`POST /api/v1/me/token/revoke`** — *"Revoke all previously issued JWT tokens for your user."* No parameters; response `{ "message": "all tokens revoked" }`. All-or-nothing; there is no per-token revoke and no way to list outstanding tokens.

> These endpoints were documented from the API Reference pages only. Per instruction, no request was issued to `/api/v1/me/token` or any other live API endpoint, so no token was minted or observed.

---

## 14. Documentation defects and caveats to carry into the implementation

1. `GET /:context/:contextId/devices/:id` — the parameter list **omits `id`** entirely.
2. `GET /:context/:contextId/componenttypes/` — lists a `component` path parameter that does not exist in the path template.
3. `PATCH /companies/:companyId/component/:component/:id` — `id` marked **optional** though it is a path segment; **no body field list at all**, only an example.
4. `PATCH /:context/:contextId/devices/:ids/batch` — `ids` marked **optional** though it is a path segment.
5. `PATCH /:context/:contextId/devices/:id` and `.../batch` — body documented as a single field named `device` of type `Object`, but both examples send a **flat** object. Also "Must include the device ID" for the single PATCH (id in both path and body).
6. `PATCH /companies/:company/ipsubnets/:id` — repeats POST's `required` markers on `company`/`network`/`netmask`/`cidr` while the example performs a genuine partial update.
7. `GET /:context/:contextId/devices` — `limit` documented under *URL Parameters* rather than *Query Parameters*.
8. IP group POST/PATCH — `name` described as *"The description of the group"* (copy-paste of `description`).
9. `DELETE .../ipaddresses/:id` — description typo: *"Remove am IP address from the database."*
10. `DELETE /companies/:company/ipgroups/:id` — shows an example **request body** for a DELETE, with no body fields documented.
11. `POST /api/v1/me/token` reports `Login Required true` although it is the login endpoint.
12. Identifier field name is inconsistent across responses (`id` vs `_id`); some component/device docs leak Mongoose internals (`__t`, `__v`).
13. No endpoint documents its own status codes, error bodies, rate limits, `ETag`/`If-Modified-Since` behaviour (despite the documented 304), or locking semantics (despite the documented 423).
14. No enumerations are given for `deviceType`, `role`, `moduleType`, or component `itemType`; component/module type strings must be discovered via `GET /:context/:contextId/componenttypes/` and `GET /api/v1/system/deviceDefinitions/components`.
15. `state` on ip addresses is described only as "Used or reserved"; examples use lowercase `"used"` / `"reserved"`.
16. Metric `Example Request` blocks render path and query parameters together as one JSON object; they are not request bodies (all four metric endpoints are GET).

---

## 15. Endpoint inventory (41 endpoints, doc slug ids)

| # | Method & path | Doc slug |
|---|---|---|
| 1 | GET /api/v1/:context/:contextId/collectors | `_api_v1_context_contextId_collectors_get_680` |
| 2 | GET /api/v1/:context/:contextId/collectors/:id | `..._collectors_id_get_700` |
| 3 | POST /api/v1/:context/:contextId/collectors | `..._collectors_post_720` |
| 4 | PATCH /api/v1/:context/:contextId/collectors/:id | `..._collectors_id_patch_740` |
| 5 | DELETE /api/v1/:context/:contextId/collectors/:id | `..._collectors_id_delete_760` |
| 6 | GET /api/v1/:context/:contextId/component/:component/ | `..._component_component__get_780` |
| 7 | GET /api/v1/:context/:contextId/component/:component/:id | `..._component_component_id_get_800` |
| 8 | PATCH /api/v1/companies/:companyId/component/:component/:id | `_api_v1_companies_companyId_component_component_id_patch_820` |
| 9 | GET /api/v1/:context/:contextId/componenttypes/ | `..._componenttypes__get_840` |
| 10 | GET /api/v1/system/deviceDefinitions/components | `_api_v1_system_deviceDefinitions_components_get_860` |
| 11 | GET /api/v1/:context/:contextId/devices | `..._devices_get_880` |
| 12 | GET /api/v1/:context/:contextId/devices/:id | `..._devices_id_get_900` |
| 13 | POST /api/v1/:context/:contextId/devices | `..._devices_post_920` |
| 14 | PUT /api/v1/:context/:contextId/devices/:id/modules/:module/lastDiscovery | `..._devices_id_modules_module_lastDiscovery_put_940` |
| 15 | PATCH /api/v1/:context/:contextId/devices/:id | `..._devices_id_patch_960` |
| 16 | PATCH /api/v1/:context/:contextId/devices/:ids/batch | `..._devices_ids_batch_patch_980` |
| 17 | DELETE /api/v1/:context/:contextId/devices/:id | `..._devices_id_delete_1000` |
| 18 | GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses | `_api_v1_companies_company_ipsubnet_ipSubnet_ipaddresses_get_1020` |
| 19 | GET /api/v1/companies/:company/ipsubnet/:ipSubnet/ipaddresses/:id | `..._ipsubnet_ipSubnet_ipaddresses_id_get_1040` |
| 20 | POST /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses | `..._ipsubnets_ipSubnet_ipaddresses_post_1060` |
| 21 | PATCH /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id | `..._ipsubnets_ipSubnet_ipaddresses_id_patch_1080` |
| 22 | DELETE /api/v1/companies/:company/ipsubnets/:ipSubnet/ipaddresses/:id | `..._ipsubnets_ipSubnet_ipaddresses_id_delete_1100` |
| 23 | GET /api/v1/companies/:company/ipgroups | `..._ipgroups_get_1120` |
| 24 | GET /api/v1/companies/:company/ipgroups/:id | `..._ipgroups_id_get_1140` |
| 25 | POST /api/v1/companies/:company/ipgroups | `..._ipgroups_post_1160` |
| 26 | PATCH /api/v1/companies/:company/ipgroups/:id | `..._ipgroups_id_patch_1180` |
| 27 | DELETE /api/v1/companies/:company/ipgroups/:id | `..._ipgroups_id_delete_1200` |
| 28 | GET /api/v1/companies/:company/ipsubnets | `..._ipsubnets_get_1220` |
| 29 | GET /api/v1/companies/:company/ipsubnets/:id | `..._ipsubnets_id_get_1240` |
| 30 | POST /api/v1/companies/:company/ipsubnets | `..._ipsubnets_post_1260` |
| 31 | PATCH /api/v1/companies/:company/ipsubnets/:id | `..._ipsubnets_id_patch_1280` |
| 32 | DELETE /api/v1/companies/:company/ipsubnets/:id | `..._ipsubnets_id_delete_1300` |
| 33 | GET /api/v1/me | `_api_v1_me_get_1320` |
| 34 | GET /api/v1/me/token | `_api_v1_me_token_get_1340` |
| 35 | POST /api/v1/me/token | `_api_v1_me_token_post_1360` |
| 36 | POST /api/v1/me/token/revoke | `_api_v1_me_token_revoke_post_1380` |
| 37 | GET /api/v1/metrics/companies/:companyId/modules/:moduleType | `_api_v1_metrics_companies_companyId_modules_moduleType_get_1400` |
| 38 | GET /api/v1/metrics/companies/:companyId/modules/:moduleType/summarize | `..._moduleType_summarize_get_1420` |
| 39 | GET /api/v1/metrics/devices/:id/modules/:moduleType | `_api_v1_metrics_devices_id_modules_moduleType_get_1440` |
| 40 | GET /api/v1/metrics/devices/:id/modules/:moduleType/:item | `_api_v1_metrics_devices_id_modules_moduleType_item_get_1460` |
| 41 | GET /api/v1/:context/:contextId/metrics/summaries/:moduleType | `_api_v1_context_contextId_metrics_summaries_moduleType_get_1480` |

Doc pages visited outside the endpoint list: `/documentation/api/overview`, `/authentication`, `/index` (Resources), `/errors`. All loaded successfully.
