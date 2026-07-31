/**
 * CONTRACT tests for **write-path ROUTING** against a live Lumics tenant.
 * **Opt-in only, and it creates, changes and deletes nothing.**
 *
 * **Why this file exists.** `0.1.0` shipped `lumics_create_ipaddress`,
 * `lumics_update_ipaddress` and `lumics_delete_ipaddress` addressing
 * `/ipsubnets/` (plural) — a path this API does not route for any verb — so all
 * three could never have succeeded. The release gate did not catch it and could
 * not have: D-0006 scopes the contract suite to reads, so no run of it has ever
 * issued a POST, PATCH, PUT or DELETE, and `live-read-only.test.ts` says so in
 * its own header. The defect was found by a hand-run `curl` probe on 2026-07-31,
 * prompted by a user bug report, and is recorded as spec §0.5 M13, §14 defect 26,
 * D-0014 and `docs/contract-runs/2026-07-31-run-04.md`. That run's closing
 * section states the lesson plainly: the gate's coverage was described by what it
 * ran rather than by what it could not reach. **This file is that probe, kept.**
 *
 * **How a write path is checked without writing anything.** spec §0.5 records the
 * signal the whole file rests on: this API answers an **unrouted** path with an
 * **HTML** error page and a **routed** path with **JSON**, including when the
 * routed request finds nothing to act on. Both can carry a 404, so the status
 * alone separates nothing — every claim here is a claim about the body. That
 * makes routing observable with requests that have nothing to act on:
 *
 * - `PATCH` and `DELETE` are aimed at {@link NONEXISTENT_ID}, a well-formed id no
 *   record has. A routed path answers JSON — `{"updated":null}`, a JSON 404, or
 *   even a 500 (spec §0.5 M14) — and an unrouted path answers an HTML 404.
 * - `POST` to a **nested** collection uses a nonexistent **parent** id, so nothing
 *   can be created under a real parent.
 * - Every `POST`, `PATCH` and `PUT` body is {@link EMPTY_BODY}: `{}` carries no
 *   field to apply, so even a routed request that somehow found a record would
 *   have nothing to write into it. Two independent safeguards, not one.
 *
 * **Why not one request here goes through `LumicsClient`, which is otherwise the
 * only way this repository speaks HTTP.** The discriminator above is not a
 * property of the API alone: it is a property of the API **and the `Accept`
 * header**, and the first live run of this file proved it the hard way. spec §0.5
 * was measured with `curl`, which sends the wildcard {@link WILDCARD_ACCEPT};
 * `src/api/client.ts` sends `Accept: application/json` on every request; and this
 * API content-negotiates the error page its router emits for a path it does not
 * have. Through the client, an unrouted path answers `404 {"error":"not found"}`
 * — **JSON**, from no route at all — which is byte-for-byte the shape a routed
 * path uses to say "no such record". Every negative case therefore failed on its
 * first live run, and, less visibly and much worse, **every positive case passed
 * without establishing anything**: with the HTML half of the signal negotiated
 * away, a classifier that reads "JSON 404" as "routed" says "routed" about every
 * path in existence, including ones that do not exist. So the probe transport is
 * a bare `fetch` ({@link probeRoute}) sending the header `curl` sends, for the
 * negatives and the positives alike. See {@link classifyRouting} for the
 * discriminator and its stated premise.
 *
 * Two consequences worth carrying away. The paths still come from
 * `src/api/paths.ts`, so this file still fails when a builder addresses a route
 * the API does not have — only the transport is different, and routing is a
 * property of the API rather than of the caller's headers. And the reason
 * `0.1.0`'s broken tools could not report anything diagnosable is now measured:
 * **through this server's own client, a dead route and a missing record are
 * indistinguishable.** No tool can tell a caller which of the two it hit.
 *
 * **A documentation finding, for the owner rather than for this file to fix.**
 * spec §0.5's method note states the HTML-versus-JSON discriminator without naming
 * the `Accept` header it depends on, and
 * `docs/contract-runs/2026-07-31-run-04.md` states it the same way. Both are true
 * of `curl` and false of any client that asks for JSON — which is every client
 * this repository ships. Reported rather than edited here: this branch may not
 * touch `docs/`, and the captured contract is corrected deliberately, not in
 * passing.
 *
 * **What it deliberately does NOT check, and why that is stated rather than
 * quietly omitted.** A `POST` to a **top-level** collection has no parent id to
 * falsify — the only guard left is an invalid body, and this API's rejection of
 * one is not something the suite may rely on: spec §0.5 M15 measured
 * `POST /companies/:c/ipsubnets` with `{}` answering **500 with an HTML body**
 * rather than a 400, and §0.5 M16 measured 403 on three other creates for *this
 * tenant's* token, which says nothing about what a differently-privileged token
 * would be allowed to do. A probe that would create a record under some other
 * credential is not a probe this suite may issue. So the four top-level creates
 * are **skipped and recorded UNVERIFIED**, with the reason, rather than given a
 * weaker assertion that passes — silent partial coverage is the failure this file
 * exists to fix, and repeating it here would be worse than the original.
 *
 * Nothing here checks write **semantics** either: what a successful PATCH returns,
 * whether a DELETE removed the right record, what a create's body must contain.
 * Every one of those needs a real record and a real mutation. Routing is what can
 * be established for free, and it is the whole of what this file claims.
 *
 * **The paths under test are the ones this server sends.** The positive cases call
 * the builders in `src/api/paths.ts`, so a builder that regresses to a route the
 * API does not have fails here. The plural spelling comes from
 * {@link pluralIpAddressesPath} in `harness.ts` instead, precisely because
 * `src/api/paths.ts` no longer builds it — that is the fix, and a negative case
 * cannot borrow the code it is guarding.
 *
 * Test names carry `ASSERT:`, `OBSERVE:` or `UNVERIFIED:`. The third is this
 * file's addition to the harness's two: a case that never issues a request, is
 * skipped with its reason, and appears in the evidence ledger under UNVERIFIED.
 *
 * **The token endpoints are never called.** Not `GET /me/token`, not
 * `POST /me/token`, and above all not `POST /me/token/revoke`, which revokes every
 * token on the account (spec §11.2–§11.4). There is no builder for the first two
 * and this file does not import the third.
 */

import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  collectorPath,
  componentTypesPath,
  componentUpdatePath,
  devicePath,
  deviceModuleLastDiscoveryPath,
  devicesBatchPath,
  ipAddressesWritePath,
  ipAddressWritePath,
  ipGroupPath,
  ipSubnetPath,
} from '../../src/api/paths.js';
import { expectArray, type HttpMethod } from '../../src/api/client.js';
import type { ComponentType } from '../../src/domain/index.js';
import {
  api,
  declareSkipExplanation,
  DOCUMENTED_STATUSES,
  pluralIpAddressesPath,
  pluralIpAddressPath,
  recordAsserted,
  recordObserved,
  reportEvidence,
  RUNNABLE,
  unverifiable,
} from './harness.js';

/** Live calls; the 5s default would flake on latency. */
const TIMEOUT = 60_000;

afterAll(() => {
  reportEvidence('write-path routing (spec sections 5-10, section 0.5)');
});

// ---------------------------------------------------------------------------
// The two things that make a write probe safe
// ---------------------------------------------------------------------------

/**
 * A well-formed ObjectId that addresses nothing: 24 hex zeros.
 *
 * Deliberately a constant rather than `syntheticObjectId()`, which is the
 * harness's random 24-hex value and is the right choice for the read probes that
 * use it. A **write** probe wants the opposite property. The all-zero id is the
 * canonical null ObjectId — no generator emits it, because its embedded
 * timestamp, machine, process and counter bytes are all zero — so it is not
 * "almost certainly free", it is free by construction. It is also the same value
 * on every run, which means an operator auditing what this suite sent at their
 * tenant sees one constant id in the log rather than a fresh unexplained one per
 * run. It is not a tenant value and identifies nothing, so writing it here breaks
 * no rule of this directory.
 */
const NONEXISTENT_ID = '0'.repeat(24);

/**
 * The body every POST, PATCH and PUT here carries.
 *
 * `{}` is the second safeguard, independent of {@link NONEXISTENT_ID}: a patch
 * with no fields has nothing to apply and a create with no fields has nothing to
 * create from. Routing is decided by the path and the verb, so an empty body
 * costs the probe nothing.
 */
const EMPTY_BODY: Readonly<Record<string, never>> = {};

/**
 * The module segment for the spec §7.4 `lastDiscovery` probe.
 *
 * Vendor catalogue vocabulary, like the module and component-type names the
 * evidence report prints — not a tenant value. The device it is attached to does
 * not exist, so the segment's only job is to make the path well-formed.
 */
const PROBE_MODULE = 'snmp';

// ---------------------------------------------------------------------------
// The probe transport: the one place in this repository that speaks HTTP
// without src/api/client.ts, and why
// ---------------------------------------------------------------------------

/**
 * The `Accept` header spec §0.5 was measured under, stated once.
 *
 * `curl` sends this by default and it is what makes the HTML error page appear;
 * `src/api/client.ts` sends `application/json`, under which the same unrouted
 * path answers JSON instead and the discriminator vanishes. It is a constant
 * rather than a literal at the call site because it is a **premise**, not a
 * detail: {@link classifyRouting} is only sound for a request that carried it.
 */
const WILDCARD_ACCEPT = '*/*';

/**
 * What one probe learned. Deliberately not the harness's `CallOutcome`: the only
 * facts that may leave this function are the status and the *kind* of body, never
 * its content — an unrouted path's HTML names the request line, which on these
 * routes contains the company id.
 */
type ProbeAnswer =
  | {
      readonly kind: 'answered';
      readonly status: number;
      /** Did the body look like the router's HTML error page? */
      readonly html: boolean;
      readonly hasBody: boolean;
    }
  | { readonly kind: 'no-answer'; readonly detail: string };

/** Markers of the HTML error page an unrouted path answers with (spec §0.5). */
const HTML_BODY_MARKERS: readonly string[] = ['<!doctype html', '<html'];

function looksLikeHtmlErrorPage(body: string): boolean {
  const lowered = body.toLowerCase();
  return HTML_BODY_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Issue one probe request with a bare `fetch`, and report only what may be
 * reported.
 *
 * **This bypasses `src/api/client.ts` deliberately, and it is the only code in
 * this repository permitted to.** The file header has the full argument; the
 * short form is that the client sends `Accept: application/json`, this API
 * content-negotiates its router's 404, and under JSON the answer for "no such
 * route" is identical to the answer for "no such record" — so a probe issued
 * through the client cannot establish either half of what this file asserts. The
 * measurement in spec §0.5 was taken with {@link WILDCARD_ACCEPT} and this
 * reproduces those conditions. Routing is a property of the API, not of the
 * caller's headers: what changes with the header is only how the API *renders*
 * the answer.
 *
 * What is deliberately kept from the client, because dropping it would be a
 * regression rather than a simplification:
 *
 * - **`redirect: 'error'`.** Following a redirect would replay the `Authorization`
 *   header at whatever host the response named. The client refuses redirects for
 *   that reason and so does this.
 * - **`AbortSignal.timeout`** on the configured deadline, so a hung endpoint ends
 *   as a stated UNVERIFIED rather than as a bare vitest timeout.
 * - **Path concatenation, not `new URL(path, base)`.** URL resolution would let a
 *   leading `/` escape the `/api/v1` prefix; the paths come from
 *   `src/api/paths.ts` already encoded.
 *
 * What is deliberately NOT kept: retries. One attempt per probe. A write verb
 * whose connection failed may already have been applied, which is exactly why the
 * client never replays one, and a routing probe has nothing to gain from a second
 * try. That also bounds this file's load on the tenant at one request per case.
 *
 * The credential is read from the same configuration the server validates and is
 * never returned, logged or interpolated into a message.
 */
async function probeRoute(
  method: HttpMethod,
  path: string,
  body?: Readonly<Record<string, never>>,
): Promise<ProbeAnswer> {
  const { config } = api();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: WILDCARD_ACCEPT,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    // The name only. A fetch failure message can quote the URL, and the URL
    // carries the company id.
    return {
      kind: 'no-answer',
      detail: error instanceof Error ? error.name : typeof error,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: 'no-answer', detail: 'the body never finished arriving' };
  }

  const trimmed = text.trim();
  return {
    kind: 'answered',
    status: response.status,
    html: looksLikeHtmlErrorPage(trimmed),
    hasBody: trimmed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Reading routing off the answer
// ---------------------------------------------------------------------------

/**
 * Does this path exist? `indeterminate` means the run could not tell, which is an
 * UNVERIFIED entry and never a pass.
 */
type Routing = 'routed' | 'unrouted' | 'indeterminate';

/**
 * Classify one answer by the discriminator spec §0.5 measured.
 *
 * **PREMISE, and it is not optional: the request must have been sent with
 * {@link WILDCARD_ACCEPT}.** This API content-negotiates the error page its router
 * emits for a path it does not have. Under a wildcard `Accept` that page is HTML,
 * which is what separates "no such route" from "no such record"; under
 * `Accept: application/json` — what `src/api/client.ts` sends on every request —
 * it is `404 {"error":"not found"}`, indistinguishable from a routed path
 * reporting a missing record, and this function silently returns `routed` for
 * every path in existence. That is not hypothetical: it is how the first live run
 * of this file failed, and the premise going unstated is why. Send probes through
 * {@link probeRoute} or do not use this function.
 *
 * | answer | verdict | why |
 * |---|---|---|
 * | any status other than 404 | routed | a router's 404 handler cannot answer 200, 403 or 500; spec §0.5 M15 measured a routed path answering 500 **in HTML**, so HTML alone is not the signal |
 * | 404 with an HTML body | **unrouted** | the measured signature of "no such route" |
 * | 404 with a non-HTML body | routed | an application handler reporting "no such record" |
 * | 404 with no body at all | indeterminate | the discriminator is the body, and there is none |
 * | no answer, or too slow | indeterminate | nothing was measured |
 */
function classifyRouting(answer: ProbeAnswer): Routing {
  if (answer.kind === 'no-answer') {
    return 'indeterminate';
  }
  if (answer.status !== 404) {
    return 'routed';
  }
  if (answer.html) {
    return 'unrouted';
  }
  return answer.hasBody ? 'routed' : 'indeterminate';
}

/** One clause for the ledger describing the answer's *kind*, never its content. */
function describeAnswer(answer: ProbeAnswer): string {
  if (answer.kind === 'no-answer') {
    return `produced no API answer (${answer.detail})`;
  }
  const body = answer.html
    ? 'an HTML error page'
    : answer.hasBody
      ? 'a non-HTML (JSON) body'
      : 'no body';
  return `answered HTTP ${String(answer.status)} with ${body}, asked with Accept: ${WILDCARD_ACCEPT}`;
}

/** Why a run could not tell, phrased for the UNVERIFIED line an operator reads. */
function indeterminateReason(answer: ProbeAnswer): string {
  if (answer.kind === 'no-answer') {
    return `${describeAnswer(answer)}, which is an environment finding rather than a routing one`;
  }
  return 'the answer was a 404 carrying no body, and the only thing that separates "no such route" from "no such record" on this API is whether that body is the router\'s HTML error page (spec section 0.5, and only under a wildcard Accept)';
}

// ---------------------------------------------------------------------------
// The two assertions this file makes, and the one it declines to make
// ---------------------------------------------------------------------------

/**
 * This path exists: it answered as a route, not as a router's 404.
 *
 * The answer is returned so a caller can record an **observation** on top of the
 * routing assertion — how a given verb reports "no such record" is genuinely
 * undocumented and differs between verbs on the same resource (spec §0.5 M14).
 */
async function expectRouted(
  ctx: TestContext,
  spec: string,
  claim: string,
  label: string,
  call: Promise<ProbeAnswer>,
): Promise<ProbeAnswer> {
  const answer = await call;
  const routing = classifyRouting(answer);

  if (routing === 'indeterminate') {
    unverifiable(ctx, spec, claim, `${label} ${indeterminateReason(answer)}`);
  }

  expect(
    routing,
    `${label} answered with the router's HTML error page under a 404 — this API's signature for "there is no such route" (spec section 0.5). The path came from a builder in src/api/paths.ts, so this server is addressing a route the API does not have, and every tool that uses that builder is broken in exactly the way lumics_create_ipaddress, lumics_update_ipaddress and lumics_delete_ipaddress were broken in 0.1.0 (spec section 14 defect 26, D-0014). Nothing was mutated by this probe. Correct docs/reference/lumics-api-v1.md first and let the code follow it.`,
  ).toBe('routed');

  expect(
    answer.kind === 'no-answer' || DOCUMENTED_STATUSES.includes(answer.status),
    `${label} ${describeAnswer(answer)}. spec section 3 is explicit that its table is the only documented status set, so anything outside it is drift worth reporting.`,
  ).toBe(true);

  recordAsserted(spec, claim, `${label} ${describeAnswer(answer)}`);
  return answer;
}

/**
 * This path does **not** exist, and that is the regression guard.
 *
 * The failure message matters more here than the pass: a plural ipaddress route
 * that starts answering means either someone reinstated the spelling this branch
 * removed, or the vendor added the route. Those are different findings and
 * neither one is a licence to change the code from a single tenant's answer.
 */
async function expectNotRouted(
  ctx: TestContext,
  spec: string,
  claim: string,
  label: string,
  onRouted: string,
  call: Promise<ProbeAnswer>,
): Promise<void> {
  const answer = await call;
  const routing = classifyRouting(answer);

  if (routing === 'indeterminate') {
    unverifiable(ctx, spec, claim, `${label} ${indeterminateReason(answer)}`);
  }

  expect(
    routing,
    `${label} ${describeAnswer(answer)} — an answer from a route, where spec section 0.5 measured no route at all. ${onRouted}`,
  ).toBe('unrouted');

  expect(
    answer.kind === 'no-answer' || DOCUMENTED_STATUSES.includes(answer.status),
    `${label} ${describeAnswer(answer)}. spec section 3 is explicit that its table is the only documented status set, so anything outside it is drift worth reporting.`,
  ).toBe(true);

  recordAsserted(spec, claim, `${label} ${describeAnswer(answer)}`);
}

/**
 * Record an assumption this suite may not exercise at all, with the reason.
 *
 * Not a softer assertion and not a silent omission — the case is skipped, the
 * reason is stated in the run output, and the ledger carries it under UNVERIFIED.
 * The whole defect being closed here is coverage that looked complete because
 * what it could not reach went unsaid.
 */
function notProbed(ctx: TestContext, spec: string, claim: string, reason: string): never {
  return unverifiable(ctx, spec, claim, reason);
}

// ---------------------------------------------------------------------------
// spec §5, §7, §9, §10 — the update and delete paths of every resource
// ---------------------------------------------------------------------------

interface WriteProbe {
  /** Path template and verb only. No tenant value ever appears in a label. */
  readonly label: string;
  readonly spec: string;
  readonly claim: string;
  /** Issues the request. Called inside the case, so a skip costs nothing. */
  readonly run: () => Promise<ProbeAnswer>;
}

/**
 * Every documented `PATCH`, `PUT` and `DELETE` in the captured contract, each
 * aimed at {@link NONEXISTENT_ID} and carrying {@link EMPTY_BODY}.
 *
 * spec §0.5 confirmed all of these as correctly documented on 2026-07-31. That is
 * exactly why they are here: the one route that was *not* correctly documented
 * looked no different from the outside, and the difference between "we checked"
 * and "we assumed" is this list.
 */
const routedWriteProbes: readonly WriteProbe[] = [
  {
    label: 'PATCH /companies/:c/collectors/:id',
    spec: '5.4',
    claim: 'the collector update path is routed as documented',
    run: () =>
      probeRoute('PATCH', collectorPath(api().config.companyId, NONEXISTENT_ID), EMPTY_BODY),
  },
  {
    label: 'DELETE /companies/:c/collectors/:id',
    spec: '5.5',
    claim: 'the collector delete path is routed as documented',
    run: () => probeRoute('DELETE', collectorPath(api().config.companyId, NONEXISTENT_ID)),
  },
  {
    label: 'PATCH /companies/:c/devices/:id',
    spec: '7.5',
    claim: 'the device update path is routed as documented',
    run: () => probeRoute('PATCH', devicePath(api().config.companyId, NONEXISTENT_ID), EMPTY_BODY),
  },
  {
    label: 'DELETE /companies/:c/devices/:id',
    spec: '7.7',
    claim: 'the device delete path is routed as documented',
    run: () => probeRoute('DELETE', devicePath(api().config.companyId, NONEXISTENT_ID)),
  },
  {
    label: 'PUT /companies/:c/devices/:id/modules/:module/lastDiscovery',
    spec: '7.4',
    claim: 'the device lastDiscovery path is routed for PUT, the verb the vendor documents',
    run: () =>
      probeRoute(
        'PUT',
        deviceModuleLastDiscoveryPath(api().config.companyId, NONEXISTENT_ID, PROBE_MODULE),
        EMPTY_BODY,
      ),
  },
  {
    label: 'PATCH /companies/:c/devices/:ids/batch',
    spec: '7.6',
    claim: 'the device batch update path is routed as documented',
    run: () =>
      probeRoute('PATCH', devicesBatchPath(api().config.companyId, [NONEXISTENT_ID]), EMPTY_BODY),
  },
  {
    label: 'PATCH /companies/:c/ipsubnets/:id',
    spec: '10.4',
    claim: 'the ip subnet update path is routed as documented',
    run: () =>
      probeRoute('PATCH', ipSubnetPath(api().config.companyId, NONEXISTENT_ID), EMPTY_BODY),
  },
  {
    label: 'DELETE /companies/:c/ipsubnets/:id',
    spec: '10.5',
    claim: 'the ip subnet delete path is routed as documented',
    run: () => probeRoute('DELETE', ipSubnetPath(api().config.companyId, NONEXISTENT_ID)),
  },
  {
    label: 'PATCH /companies/:c/ipgroups/:id',
    spec: '9.4',
    claim: 'the ip group update path is routed as documented',
    run: () => probeRoute('PATCH', ipGroupPath(api().config.companyId, NONEXISTENT_ID), EMPTY_BODY),
  },
  {
    label: 'DELETE /companies/:c/ipgroups/:id',
    spec: '9.5',
    claim: 'the ip group delete path is routed as documented',
    run: () => probeRoute('DELETE', ipGroupPath(api().config.companyId, NONEXISTENT_ID)),
  },
];

describe.skipIf(!RUNNABLE)('live contract: update and delete paths are routed', () => {
  // A plain loop rather than `it.each`, because each case needs its own test
  // context to report an unreadable answer as UNVERIFIED rather than as a pass.
  for (const probe of routedWriteProbes) {
    it(
      `ASSERT: ${probe.label} is a route, not an HTML 404`,
      async (ctx) => {
        await expectRouted(ctx, probe.spec, probe.claim, probe.label, probe.run());
      },
      TIMEOUT,
    );
  }
});

// ---------------------------------------------------------------------------
// spec §6.3 — the component update path, whose :component segment is real
// ---------------------------------------------------------------------------

/**
 * A component **type** id from the tenant's own catalogue, or `undefined`.
 *
 * The one segment in this file that is read live rather than falsified. Routing
 * is decided by the shape of the path, so an invented type would probably answer
 * the same — but "probably" is what put the plural ipaddress route into a shipped
 * release, and a type the API rejects outright could produce an error from a
 * *different* handler and teach the run nothing. The component id under it stays
 * {@link NONEXISTENT_ID}, so there is still no record to change. Component type
 * ids are vendor catalogue vocabulary (spec §6.4), not tenant data.
 *
 * This one read goes through `LumicsClient`, because it is an ordinary read and
 * not a routing probe: it wants the parsed catalogue, and the `Accept` argument
 * in the file header has nothing to say about a 200.
 */
let componentType: string | undefined;

beforeAll(async () => {
  if (!RUNNABLE) {
    return;
  }
  const { client, config } = api();
  const types = expectArray<ComponentType>(
    await client.get(componentTypesPath(config.companyId)),
    'GET componenttypes',
  );
  componentType = types.find((type) => typeof type.id === 'string' && type.id.length > 0)?.id;
}, TIMEOUT);

describe.skipIf(!RUNNABLE)('live contract: spec 6.3 — the component update path', () => {
  it(
    'ASSERT: PATCH /companies/:c/component/:component/:id is a route, not an HTML 404',
    async (ctx) => {
      const claim = 'the component update path is routed as documented';
      // Copied to a local before the guard: narrowing a module-scoped `let` that
      // another function assigns is not something to depend on for a value that
      // ends up inside a URL.
      const probeType = componentType;
      if (probeType === undefined) {
        unverifiable(
          ctx,
          '6.3',
          claim,
          'this tenant returned no component types, so there is no :component segment to build a well-formed update path from',
        );
      }
      await expectRouted(
        ctx,
        '6.3',
        claim,
        'PATCH /companies/:c/component/:component/:id',
        probeRoute(
          'PATCH',
          componentUpdatePath(api().config.companyId, probeType, NONEXISTENT_ID),
          EMPTY_BODY,
        ),
      );
    },
    TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// spec §7.4 — PUT is the only verb on lastDiscovery
// ---------------------------------------------------------------------------

/**
 * The other half of the §7.4 claim, and the reason it is worth a case of its own.
 *
 * spec §0.5 measured `PATCH` and `POST` against this path both answering an HTML
 * 404: `PUT` is not the vendor being inconsistent with the neighbouring device
 * writes, it is the only verb there is. A contributor normalising it to `PATCH`
 * for consistency would reach nothing, and would be doing precisely what §13 Q1's
 * plural spelling did to `lumics_create_ipaddress`. This is the test that says so.
 */
const unroutedLastDiscoveryVerbs: readonly ['PATCH' | 'POST', string][] = [
  ['PATCH', '7.4'],
  ['POST', '7.4'],
];

describe.skipIf(!RUNNABLE)('live contract: spec 7.4 — lastDiscovery answers to PUT alone', () => {
  for (const [verb, spec] of unroutedLastDiscoveryVerbs) {
    it(
      `ASSERT: ${verb} against the lastDiscovery path is NOT routed`,
      async (ctx) => {
        const path = deviceModuleLastDiscoveryPath(
          api().config.companyId,
          NONEXISTENT_ID,
          PROBE_MODULE,
        );
        await expectNotRouted(
          ctx,
          spec,
          `${verb} is not routed on the lastDiscovery path — PUT is the only verb it answers to`,
          `${verb} /companies/:c/devices/:id/modules/:module/lastDiscovery`,
          'Either the vendor has added the verb or this tenant differs from the one spec section 0.5 measured. Report it; do not change src/api/paths.ts or src/tools/devices.ts on the strength of one tenant, and note that PUT working is what the server depends on and is asserted separately.',
          probeRoute(verb, path, EMPTY_BODY),
        );
      },
      TIMEOUT,
    );
  }
});

// ---------------------------------------------------------------------------
// spec §8.3-§8.5 — the IPAM address writes, and the plural that shipped
// ---------------------------------------------------------------------------

describe.skipIf(!RUNNABLE)(
  'live contract: spec 8.3-8.5 — the SINGULAR ipaddress write paths are the routed ones',
  () => {
    it(
      'ASSERT: POST to the singular address collection is a route, not an HTML 404',
      async (ctx) => {
        // The parent subnet does not exist and the body is empty: a create has
        // neither a parent to attach to nor a field to create from. This is the
        // nested-collection case — a top-level POST has no parent to falsify,
        // which is why those four are UNVERIFIED at the end of this file.
        await expectRouted(
          ctx,
          '8.3',
          'the ipaddress CREATE path is the singular /ipsubnet/ spelling this server now sends',
          'POST /companies/:c/ipsubnet/:s/ipaddresses (nonexistent parent subnet)',
          probeRoute(
            'POST',
            ipAddressesWritePath(api().config.companyId, NONEXISTENT_ID),
            EMPTY_BODY,
          ),
        );
      },
      TIMEOUT,
    );

    it(
      'ASSERT: PATCH on the singular address path is a route, not an HTML 404',
      async (ctx) => {
        const answer = await expectRouted(
          ctx,
          '8.4',
          'the ipaddress UPDATE path is the singular /ipsubnet/ spelling this server now sends',
          'PATCH /companies/:c/ipsubnet/:s/ipaddresses/:id (nonexistent id)',
          probeRoute(
            'PATCH',
            ipAddressWritePath(api().config.companyId, NONEXISTENT_ID, NONEXISTENT_ID),
            EMPTY_BODY,
          ),
        );
        // spec §0.5 M14: this verb answers 200 {"updated":null} where its
        // neighbour answers 500, and §8.4 documents neither. Recorded, not
        // asserted — a vendor that starts returning a documented 404 here would
        // be fixing something, and a release gate must not fail on that.
        recordObserved(
          '8.4',
          'how the ipaddress update path reports an id that does not exist (spec section 8.4 documents nothing; spec section 0.5 M14 measured 200 with a null "updated" envelope)',
          `${describeAnswer(answer)} — unwrapUpdated() in src/api/client.ts refuses a null envelope rather than reporting the record as changed`,
        );
      },
      TIMEOUT,
    );

    it(
      'ASSERT: DELETE on the singular address path is a route, not an HTML 404',
      async (ctx) => {
        const answer = await expectRouted(
          ctx,
          '8.5',
          'the ipaddress DELETE path is the singular /ipsubnet/ spelling this server now sends',
          'DELETE /companies/:c/ipsubnet/:s/ipaddresses/:id (nonexistent id)',
          probeRoute(
            'DELETE',
            ipAddressWritePath(api().config.companyId, NONEXISTENT_ID, NONEXISTENT_ID),
          ),
        );
        // spec §0.5 M14 / §14 defect 27: a 500 for "no such record", where the
        // PATCH above answers 200. Observed rather than asserted for the same
        // reason, and because the 500 is the vendor's defect, not this server's.
        recordObserved(
          '8.5',
          'how the ipaddress delete path reports an id that does not exist (spec section 0.5 M14 measured 500, not the 404 spec section 3 offers — spec section 14 defect 27)',
          `${describeAnswer(answer)} — 500 is not in this client's retryable set, so a delete of an already-absent address fails once rather than three times`,
        );
      },
      TIMEOUT,
    );
  },
);

/**
 * The regression guard. Each entry is a verb the captured contract documented
 * against the PLURAL spelling and 0.1.0 shipped sending.
 *
 * These are the cases that failed on the first live run — not because the plural
 * had become routed, but because they were asked through a client that requests
 * JSON, and the API answers "no such route" in JSON when asked in JSON. They are
 * the reason {@link probeRoute} exists. See the file header.
 */
const pluralWriteProbes: readonly WriteProbe[] = [
  {
    label: 'POST /companies/:c/ipsubnets/:s/ipaddresses',
    spec: '8.3',
    claim: 'the PLURAL ipaddress create path is not routed',
    run: () =>
      probeRoute('POST', pluralIpAddressesPath(api().config.companyId, NONEXISTENT_ID), EMPTY_BODY),
  },
  {
    label: 'PATCH /companies/:c/ipsubnets/:s/ipaddresses/:id',
    spec: '8.4',
    claim: 'the PLURAL ipaddress update path is not routed',
    run: () =>
      probeRoute(
        'PATCH',
        pluralIpAddressPath(api().config.companyId, NONEXISTENT_ID, NONEXISTENT_ID),
        EMPTY_BODY,
      ),
  },
  {
    label: 'DELETE /companies/:c/ipsubnets/:s/ipaddresses/:id',
    spec: '8.5',
    claim: 'the PLURAL ipaddress delete path is not routed',
    run: () =>
      probeRoute(
        'DELETE',
        pluralIpAddressPath(api().config.companyId, NONEXISTENT_ID, NONEXISTENT_ID),
      ),
  },
];

describe.skipIf(!RUNNABLE)(
  'live contract: spec 8.3-8.5 — the PLURAL ipaddress spelling is not routed',
  () => {
    for (const probe of pluralWriteProbes) {
      it(
        `ASSERT: ${probe.label} is NOT routed`,
        async (ctx) => {
          await expectNotRouted(
            ctx,
            probe.spec,
            probe.claim,
            probe.label,
            'This is the spelling spec section 13 Q1 documented, told implementers not to "fix", and 0.1.0 shipped — three IPAM write tools addressing nothing (spec section 14 defect 26, D-0014). Three readings, and they are different findings: someone has reinstated the plural in src/api/paths.ts, or the vendor has since added the route, or this probe stopped sending the wildcard Accept header the discriminator depends on and is reading a JSON "not found" as a route. Check the last one first — it is what broke this case on its first live run. Neither of the others is a licence to change the code, and note that the singular is asserted routed separately, so if BOTH now answer the spellings are interchangeable rather than swapped.',
            probe.run(),
          );
        },
        TIMEOUT,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// The top-level creates, which this suite may not probe at all
// ---------------------------------------------------------------------------

/**
 * Why there is no `POST /companies/:c/collectors` case, and three like it.
 *
 * A nested create can be pointed at a parent that does not exist, so a routed
 * request has nothing to attach a new record to. A **top-level** create has no
 * such handle: the collection is real, the token is real, and the only remaining
 * guard is that the API rejects an incomplete body. This suite may not rely on
 * that, for two measured reasons and one unmeasured one:
 *
 * - spec §0.5 M15 measured `POST /companies/:c/ipsubnets` with `{}` answering
 *   **500 with an HTML body** — not the 400 a required-field table implies, and
 *   not something a JSON client can classify at all. An API whose rejection is
 *   unusable is not an API whose rejection can be a safety mechanism.
 * - spec §0.5 M16 measured **403** on collectors, devices and ipgroups for *this*
 *   tenant's token. A probe that is safe only because one credential lacks a
 *   permission is not safe; it is untested. The suite must be safe under the
 *   token it is handed, and it is handed whatever the operator exports.
 * - Nothing has ever measured what this API does with a partial create body under
 *   a token that *is* permitted to create. "It will surely reject it" is the
 *   shape of reasoning that shipped the plural route.
 *
 * So these four are skipped, and the ledger says so. A pass with silent partial
 * coverage is the defect this file exists to close, and inventing a weaker
 * assertion that passes would reproduce it one release later. An operator who
 * wants the create paths proved can do what run 04 did — probe by hand, against a
 * record they are prepared to own, and record it.
 */
const unprobedCreates: readonly { readonly label: string; readonly spec: string }[] = [
  { label: 'POST /companies/:c/collectors', spec: '5.3' },
  { label: 'POST /companies/:c/devices', spec: '7.3' },
  { label: 'POST /companies/:c/ipgroups', spec: '9.3' },
  { label: 'POST /companies/:c/ipsubnets', spec: '10.3' },
];

describe.skipIf(!RUNNABLE)(
  'live contract: top-level create paths are NOT probed by this suite',
  () => {
    for (const { label, spec } of unprobedCreates) {
      it(`UNVERIFIED: ${label} routing is not checked, and this says so`, (ctx) => {
        notProbed(
          ctx,
          spec,
          `${label} is routed as documented`,
          'a top-level create has no parent id to falsify, so the only guard against creating a record would be that the API rejects an empty body — which spec section 0.5 M15 measured answering 500 in HTML rather than 400, and which spec section 0.5 M16 shows was only ever "safe" on this tenant because its token is refused create rights (403) on three of these four. This suite will not issue a request whose safety depends on a permission the next operator may hold. Nested creates ARE probed, against a parent that does not exist: see the section 8.3 case above',
        );
      });
    }
  },
);

declareSkipExplanation('the write-path routing contract');
