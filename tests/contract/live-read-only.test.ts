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
 * and the IPAM path asymmetry of spec §13 Q1. Its siblings cover the rest:
 * `live-metrics.test.ts` (spec §12, the largest and riskiest surface, plus the
 * spec §7.2 device-ownership pre-read that puts the device metric endpoints behind
 * the company pin) and `live-resources.test.ts` (spec §5, §6, §9). Shared gating,
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
  ipAddressesWritePath,
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

describe.skipIf(!RUNNABLE)('live contract: A1 — the IPAM ipsubnet/ipsubnets asymmetry', () => {
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
    'ASSERT: the SINGULAR read path for ipaddresses works (spec section 8.1, section 13 Q1)',
    async (ctx) => {
      const claim = 'the SINGULAR /ipsubnet/:id/ipaddresses path serves reads';
      const subnetId = await firstSubnetId(ctx, claim);
      const { client: api, config } = client();

      const addresses = await api.get<unknown>(ipAddressesReadPath(config.companyId, subnetId), {
        query: { limit: 1 },
      });
      expect(
        Array.isArray(addresses),
        `the SINGULAR /ipsubnet/ read path returned ${describeValue(addresses)} instead of the documented bare array. src/api/paths.ts uses the singular spelling for reads on the strength of spec section 13 Q1; if it does not work, every IPAM address read is broken.`,
      ).toBe(true);
      recordAsserted('8.1', claim, `returned ${describeValue(addresses)}`);
    },
    TIMEOUT,
  );

  it(
    'OBSERVE: whether the PLURAL path also serves reads, which the docs do not claim',
    async (ctx) => {
      const claim = 'the PLURAL /ipsubnets/:id/ipaddresses spelling is write-only';
      const subnetId = await firstSubnetId(ctx, claim);
      const { client: api, config } = client();

      // A GET against the write spelling. This is still read-only. Either outcome
      // is informative: a 404 confirms the asymmetry is real and load-bearing, a
      // 200 means the two spellings are interchangeable for reads and the code
      // could be simplified — which is an issue to raise, not a change to make.
      //
      // The previous assertion here was `expect(['accepted','rejected'])
      // .toContain(outcome)` over a value that could only be one of those two
      // strings: a tautology, in the file that is supposed to be the release
      // gate. What is actually assertable is that the API answered in a way spec
      // section 3 documents — a 500 or an undocumented status is drift, not an
      // answer — and the rest is recorded as an observation.
      const outcome = await attempt(
        api.get<unknown>(ipAddressesWritePath(config.companyId, subnetId), { query: { limit: 1 } }),
      );

      expect(
        outcome.ok || outcome.status === undefined || DOCUMENTED_STATUSES.includes(outcome.status),
        `a GET against the plural spelling produced ${describeOutcome(outcome)}. spec section 3 is explicit that its table is the only documented status set, so anything outside it is drift worth reporting.`,
      ).toBe(true);
      expect(
        outcome.ok ? undefined : outcome.status,
        'the plural spelling produced a 500 — that is a server fault rather than an answer about routing, and it tells us nothing about the asymmetry.',
      ).not.toBe(500);

      recordObserved(
        '13 Q1',
        'the docs use singular /ipsubnet/ for address reads and plural /ipsubnets/ for writes, without saying whether the plural also reads',
        outcome.ok
          ? 'the PLURAL spelling ALSO serves reads — the two are interchangeable for GET, so the split in src/api/paths.ts is defensive rather than required. Raise an issue; do not simplify the code on the strength of one tenant.'
          : `the PLURAL spelling was ${describeOutcome(outcome)} for a GET — the asymmetry is real and the singular read path in src/api/paths.ts is load-bearing.`,
      );
    },
    TIMEOUT,
  );
});

declareSkipExplanation('the identity, list-convention and IPAM contract');
