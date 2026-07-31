/**
 * CONTRACT tests against a live Lumics tenant. **Opt-in only.**
 *
 * These validate RFC-001 assumption **A1** — that the captured contract in
 * `docs/reference/lumics-api-v1.md` matches live behaviour. `vitest.config.ts`
 * excludes this directory unless `LUMICS_CONTRACT_TESTS` is set, so `npm test`
 * never needs a token and never touches the network. Run them with:
 *
 *     npm run test:contract
 *
 * **READ-ONLY, without exception.** Nothing here creates, updates or deletes,
 * and nothing here calls the token or revoke endpoints — `GET /me/token` and
 * `POST /me/token` mint credentials, and `POST /me/token/revoke` would revoke the
 * operator's own working token. If you add a case, it is a GET or it does not
 * belong in this file.
 *
 * Credentials come from the environment. Never write one into this file, and
 * never write a tenant value — a company id, device id, address or hostname —
 * into an assertion. Everything here compares shapes, or compares two values
 * both read at runtime.
 *
 * This file covers identity (spec §11.1), the list conventions of spec §4.2/§4.3
 * and the IPAM address READ paths of spec §8.1. Its siblings cover the rest:
 * `live-metrics.test.ts` (spec §12, the largest and riskiest surface, plus the
 * spec §7.2 device-ownership pre-read that puts the device metric endpoints behind
 * the company pin), `live-resources.test.ts` (spec §5, §6, §9) and
 * `live-write-routes.test.ts`, which checks whether the POST, PATCH, PUT and
 * DELETE paths this server sends are **routed at all** — without writing anything.
 * That last one exists because this file could not have found the defect it now
 * guards: a read-only run establishes the spelling of a read path and nothing
 * whatever about a write path (spec §0.5 M13, §14 defect 26, D-0014). Shared gating,
 * the evidence ledger, the sparse-tenant mechanism and the one sanctioned source
 * of a device id live in `harness.ts`; read its header before adding a case.
 *
 * A failure here is a **documentation defect to report**, not a licence to change
 * the code: CLAUDE.md is explicit that if the spec is wrong about live behaviour,
 * that is a contract-test finding and an issue.
 */

import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import {
  componentTypesPath,
  devicesPath,
  ipAddressesReadPath,
  ipSubnetsPath,
  mePath,
} from '../../src/api/paths.js';
import { expectArray } from '../../src/api/client.js';
import type { Device, IpSubnet, Me } from '../../src/domain/index.js';
import {
  api as client,
  attempt,
  declareSkipExplanation,
  describeOutcome,
  describeValue,
  DOCUMENTED_STATUSES,
  isObjectIdShaped,
  isRecord,
  keysOf,
  pluralIpAddressesPath,
  recordAsserted,
  recordObserved,
  reportEvidence,
  RUNNABLE,
  unverifiable,
} from './harness.js';

/** Live calls plus client-side retry; the 5s default would flake on latency. */
const TIMEOUT = 60_000;

afterAll(() => {
  reportEvidence('identity, list conventions and IPAM paths (spec sections 4, 8, 11)');
});

describe.skipIf(!RUNNABLE)('live contract: identity and scope', () => {
  it(
    'ASSERT: GET /me returns a user carrying the company id the docs say to read',
    async () => {
      const { client: api } = client();
      const me = await api.get<Me>(mePath());

      // The original form of this test asserted only `typeof me === 'object'`,
      // which a bare `{}` satisfies. spec §11.1 documents this endpoint as the
      // way to "obtain your company", and README tells first-run operators to
      // use lumics_get_me for exactly that, so the company id is the part worth
      // asserting. Shape only — no tenant value is written here or compared
      // against a literal.
      expect(
        isRecord(me),
        `spec section 11.1 documents a bare user object; GET /me returned ${describeValue(me)}.`,
      ).toBe(true);
      expect(
        isRecord(me.company),
        `GET /me returned no "company" object (keys: ${keysOf(me).join(',')}). spec section 11.1 documents it, and it is the documented route to a company id — without it the first-run instructions in README cannot be followed.`,
      ).toBe(true);
      expect(
        isObjectIdShaped(me.company?.id),
        `the company on GET /me carries no 24-character hex id (${describeValue(me.company?.id)}); LUMICS_COMPANY_ID is validated against that shape at startup.`,
      ).toBe(true);

      recordAsserted(
        '11.1',
        'GET /me returns a user object whose company carries an ObjectId-shaped id',
        `user keys: ${keysOf(me).join(',')}; company keys: ${keysOf(me.company).join(',')}`,
      );
    },
    TIMEOUT,
  );

  it(
    'ASSERT: the configured company id is one this token may read',
    async () => {
      const { client: api, config } = client();
      // The original form asserted `Array.isArray(expectArray(...))`, which
      // cannot fail — expectArray returns an array or throws. The real assertion
      // is that the call is *authorised*: a token scoped to another tenant
      // answers 401/403 here (spec §3), and that is what this is checking.
      const outcome = await attempt(
        api.get<unknown>(devicesPath(config.companyId), { query: { limit: 1 } }),
      );
      expect(
        outcome.ok,
        `reading devices for the configured LUMICS_COMPANY_ID was ${describeOutcome(outcome)}. A 401 or 403 means the token and the company id do not belong together; every company-scoped tool in this server would fail the same way, and the rest of this suite would be measuring nothing.`,
      ).toBe(true);
      recordAsserted(
        '4.1',
        'the configured company id is readable with the configured token',
        'GET devices for LUMICS_COMPANY_ID was authorised',
      );
    },
    TIMEOUT,
  );
});

describe.skipIf(!RUNNABLE)(
  'live contract: A1 — list responses are bare arrays with no pagination',
  () => {
    it(
      'ASSERT: GET devices returns a bare array, not an envelope with a total',
      async () => {
        const { client: api, config } = client();
        const response = await api.get<unknown>(devicesPath(config.companyId), {
          query: { limit: 2 },
        });

        expect(
          Array.isArray(response),
          `spec section 4.2 documents a bare array; the body was ${describeValue(response)}. If the live API has grown an envelope, expectArray() throws and every list tool fails.`,
        ).toBe(true);
        // A bare array has no top level on which a total, cursor or next link
        // could be carried, so the shape check IS the no-pagination check
        // (spec §4.3). Asserted against the raw body, not through expectArray,
        // which would make the assertion unfalsifiable.
        expect(
          JSON.stringify(response).startsWith('['),
          'the serialised body does not begin with "[", so it is not the documented bare array.',
        ).toBe(true);

        recordAsserted(
          '4.2',
          'list responses are bare JSON arrays with no envelope, total, cursor or next link',
          `GET devices returned ${describeValue(response)}`,
        );
      },
      TIMEOUT,
    );

    it(
      'ASSERT: limit is honoured on GET devices, the only result control the API has',
      async (ctx) => {
        const { client: api, config } = client();
        const two = expectArray<Device>(
          await api.get(devicesPath(config.companyId), { query: { limit: 2 } }),
          'GET devices',
        );
        if (two.length < 2) {
          unverifiable(
            ctx,
            '4.3',
            'limit is honoured on GET devices',
            `this tenant returned ${String(two.length)} device(s) for limit=2, so a honoured limit cannot be told from a small estate`,
          );
        }

        const one = expectArray<Device>(
          await api.get(devicesPath(config.companyId), { query: { limit: 1 } }),
          'GET devices',
        );
        expect(
          one.length,
          `limit=1 returned ${String(one.length)} device(s) on a tenant with at least two. spec section 4.3: limit is the ONLY result control in this API. If it is ignored, every list tool's truncation disclosure describes a parameter that does nothing.`,
        ).toBe(1);

        recordAsserted(
          '4.3',
          'limit is honoured on GET devices',
          'limit=1 returned exactly one record on a tenant with two or more',
        );
      },
      TIMEOUT,
    );

    it(
      'ASSERT: an offset parameter is ignored, confirming no pagination exists',
      async (ctx) => {
        const { client: api, config } = client();
        // Sent deliberately, once, to check the documented absence. If a future API
        // version starts honouring it, this test fails and the finding is an issue —
        // production code must still never send it.
        const withoutOffset = expectArray<Device>(
          await api.get(devicesPath(config.companyId), { query: { limit: 2 } }),
          'GET devices',
        );
        if (withoutOffset.length < 2) {
          unverifiable(
            ctx,
            '4.3',
            'offset is not a parameter this API has — sending it changes nothing',
            `this tenant returned ${String(withoutOffset.length)} device(s), so an honoured offset would be indistinguishable from an ignored one`,
          );
        }
        const withOffset = expectArray<Device>(
          await api.get(devicesPath(config.companyId), { query: { limit: 2, offset: 1 } }),
          'GET devices',
        );

        expect(
          JSON.stringify(withOffset),
          'offset appears to be honoured — spec section 4.3 says no pagination exists anywhere in this API, and CLAUDE.md forbids this server from emitting any paging field on the strength of that. If offset works, the no-pagination decision needs revisiting. Report this.',
        ).toBe(JSON.stringify(withoutOffset));

        recordAsserted(
          '4.3',
          'sending offset does not change the result — the API has no pagination',
          `identical bodies for limit=2 with and without offset=1 (${String(withoutOffset.length)} record(s))`,
        );
      },
      TIMEOUT,
    );

    it(
      'ASSERT: componenttypes returns a bare array with no result control at all',
      async () => {
        const { client: api, config } = client();
        // Asserted on the RAW body. The earlier form of this test ran the body
        // through expectArray and then asserted Array.isArray on the result,
        // which cannot fail — expectArray returns an array or throws — and it
        // asserted nothing about the "accepts no limit" claim in its own name.
        // The limit-absence half now lives in live-resources.test.ts, which
        // sends one and reports whether it was ignored.
        const response = await api.get<unknown>(componentTypesPath(config.companyId));
        expect(
          Array.isArray(response),
          `spec section 6.4 documents a bare array of component types; the body was ${describeValue(response)}.`,
        ).toBe(true);
        recordAsserted(
          '6.4',
          'GET componenttypes returns a bare array (no envelope, and no limit is sent)',
          `${describeValue(response)}`,
        );
      },
      TIMEOUT,
    );
  },
);

// The heading used to say "asymmetry", which the 2026-07-31 measurement reduced
// to a property of the vendor's documentation and of nothing else: on the
// deployed API every ipaddress route is singular (spec §0.5 M13).
describe.skipIf(!RUNNABLE)('live contract: A1 — the IPAM ipsubnet/ipsubnets spellings', () => {
  /** First subnet id on the tenant, or an UNVERIFIED skip. spec §10.1. */
  async function firstSubnetId(ctx: TestContext, claim: string): Promise<string> {
    const { client: api, config } = client();
    const subnets = expectArray<IpSubnet>(
      await api.get(ipSubnetsPath(config.companyId), { query: { limit: 1 } }),
      'GET ipsubnets',
    );
    const first = subnets[0];
    if (first === undefined) {
      // Previously a bare `return`, which reported a pass on any tenant with no
      // IPAM data — the assumption went unchecked and looked checked.
      unverifiable(
        ctx,
        '8.1',
        claim,
        'this tenant has no IP subnets, so no address path can be exercised',
      );
    }
    const subnetId = first.id ?? first._id;
    if (typeof subnetId !== 'string') {
      unverifiable(
        ctx,
        '8.1',
        claim,
        `the subnet list carried no id or _id (keys: ${keysOf(first).join(',')})`,
      );
    }
    return subnetId;
  }

  it(
    'ASSERT: the SINGULAR read path for ipaddresses works (spec section 8.1)',
    async (ctx) => {
      const claim = 'the SINGULAR /ipsubnet/:id/ipaddresses path serves reads';
      const subnetId = await firstSubnetId(ctx, claim);
      const { client: api, config } = client();

      const addresses = await api.get<unknown>(ipAddressesReadPath(config.companyId, subnetId), {
        query: { limit: 1 },
      });
      expect(
        Array.isArray(addresses),
        `the SINGULAR /ipsubnet/ read path returned ${describeValue(addresses)} instead of the documented bare array. src/api/paths.ts now uses the singular spelling for EVERY ipaddress call, reads included, on the strength of the 2026-07-31 measurement (spec section 0.5 M13); if it does not work, every IPAM address tool is broken.`,
      ).toBe(true);
      recordAsserted('8.1', claim, `returned ${describeValue(addresses)}`);
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: whether the PLURAL spelling answers a GET at all (spec section 0.5 M13)',
    async (ctx) => {
      const claim = 'the PLURAL /ipsubnets/:id/ipaddresses spelling does not serve reads';
      const subnetId = await firstSubnetId(ctx, claim);
      const { client: api, config } = client();

      // WITHDRAWN INFERENCE, kept visible because how it happened is the useful
      // part. Until 2026-07-31 this case was titled "whether the PLURAL path
      // ALSO serves reads", its claim read "the plural spelling is write-only",
      // and it reported a 404 here as evidence that "the asymmetry is real and
      // the singular read path is load-bearing". Every word of the measurement
      // was right and the inference was wrong: a 404 on a GET is equally
      // consistent with "this spelling is reserved for writes" and with "this
      // spelling is not routed at all", and spec §0.5 M13 measured the second —
      // the plural answers an HTML 404 for GET, POST, PATCH and DELETE alike.
      // That withdrawn reading is what `src/api/paths.ts` was built on, and it
      // shipped: `lumics_create_ipaddress`, `lumics_update_ipaddress` and
      // `lumics_delete_ipaddress` in 0.1.0 addressed a route that does not exist
      // (spec §14 defect 26, D-0014, `docs/contract-runs/2026-07-31-run-04.md`).
      //
      // The lesson is narrow and is why this comment survives: a read-only case
      // can establish the spelling of a READ path and nothing whatever about a
      // write path. The write verbs are checked in `live-write-routes.test.ts`,
      // which reads routing off the body — HTML means no such route, JSON means
      // no such record — and this case must not be read as saying anything about
      // them.
      //
      // The path is built by `pluralIpAddressesPath` in the harness rather than
      // by `src/api/paths.ts`, which no longer produces the plural at all. Before
      // the fix this case called `ipAddressesWritePath`, which now returns the
      // singular: it was silently GETting the same path as the case above and
      // recording the answer as evidence about the plural.
      //
      // Still read-only, and still an observation rather than an assertion: the
      // vendor could route the plural tomorrow, and a release gate should report
      // that rather than fail on it. What IS asserted is that the API answered in
      // a way spec section 3 documents.
      const outcome = await attempt(
        api.get<unknown>(pluralIpAddressesPath(config.companyId, subnetId), {
          query: { limit: 1 },
        }),
      );

      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `a GET against the plural spelling produced ${describeOutcome(outcome)}. spec section 3 is explicit that its table is the only documented status set, so anything outside it is drift worth reporting.`,
      ).toBe(true);
      expect(
        outcome.ok ? undefined : outcome.status,
        'the plural spelling produced a 500 — that is a server fault rather than an answer about routing, and it tells us nothing about whether the route exists.',
      ).not.toBe(500);

      recordObserved(
        '0.5 M13',
        'the docs spell the ipaddress writes with a plural /ipsubnets/ that the live API does not route for any verb; this case checks the GET half of that',
        outcome.ok
          ? 'the PLURAL spelling SERVES READS on this tenant, which spec section 0.5 M13 measured it not doing on 2026-07-31 — either the vendor has added the route or this tenant differs. Raise an issue; do not change src/api/paths.ts on the strength of one tenant, and note that live-write-routes.test.ts is what would tell you whether the write verbs moved with it.'
          : `the PLURAL spelling was ${describeOutcome(outcome)} for a GET. That is consistent with the plural being NOT ROUTED (spec section 0.5 M13), and it does NOT mean the plural is "write-only" — the inference this case used to record, and which shipped as a defect in 0.1.0 (section 14 defect 26, D-0014). Two limits on what this line is worth. It is read off the STATUS, because this case asks through LumicsClient, which sends Accept: application/json — and under that header this API answers an unrouted path with a JSON 404 indistinguishable from a routed path reporting no such record. It is readable at all only because the subnet id here is a real one, so a routed collection read would have answered 200. The direct evidence, asked with a wildcard Accept so the router's HTML error page survives, is in live-write-routes.test.ts — which is also the only place the write verbs are established.`,
      );
    },
    TIMEOUT,
  );
});

declareSkipExplanation('the identity, list-convention and IPAM contract');
