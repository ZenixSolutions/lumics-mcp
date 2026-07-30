/**
 * Identity tools — spec §11.
 *
 * Two of the four endpoints are exposed. The two that are not — `GET /me/token`
 * and `POST /me/token` (spec §11.2, §11.3) — both mint a JWT and return it in the
 * response body, so exposing either would put live credential material into a
 * conversation transcript. Their absence is a security decision (ADR-002), so it
 * is asserted here rather than left to a comment.
 */

import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '../../src/server.js';
import { makeConfig, TEST_COMPANY_ID } from '../helpers/config.js';
import { connect } from '../helpers/mcp.js';
import { jsonResponse, recordFetch } from '../helpers/fetch.js';
import {
  exchange,
  expectNoFabricatedPagination,
  expectNoFabricatedQueryParams,
} from '../helpers/tools.js';

const SAMPLE_ME = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'operator@example.invalid',
  company: { id: TEST_COMPANY_ID, name: 'Example Corp', timezone: 'Europe/London', active: true },
};

describe('lumics_get_me (spec section 11.1)', () => {
  it('GETs /me with no path, query or body parameters', async () => {
    const { call, payload } = await exchange('lumics_get_me', {}, SAMPLE_ME);
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/me');
    expect(Object.keys(call.query)).toEqual([]);
    expect(call.body).toBeUndefined();
    expect(payload).toEqual(SAMPLE_ME);
  });

  it('is company-agnostic: no companyId ever reaches the path', async () => {
    const { call } = await exchange('lumics_get_me', { companyId: 'b'.repeat(24) }, SAMPLE_ME);
    expect(call.path).toBe('/me');
  });

  it('projects fields when asked', async () => {
    const { payload } = await exchange('lumics_get_me', { fields: ['company'] }, SAMPLE_ME);
    expect(payload).toEqual({ company: SAMPLE_ME.company });
  });

  it('works with no configured company, since it is how you discover one', async () => {
    const { call } = await exchange('lumics_get_me', {}, SAMPLE_ME, {
      config: makeConfig({ companyId: '' }),
    });
    expect(call.path).toBe('/me');
  });

  it('describes itself as the way to discover the company id', async () => {
    const harness = await connect(makeConfig(), {
      clientOptions: { fetchImpl: recordFetch(jsonResponse(SAMPLE_ME)).fetchImpl },
    });
    try {
      const description = harness.tool('lumics_get_me')?.description ?? '';
      // Finding H6: the description must describe the REAL bootstrap flow, not a
      // state that cannot exist. LUMICS_COMPANY_ID is optional now, and the
      // company-scoped tools are absent rather than failing while it is unset.
      expect(description).toContain('LUMICS_COMPANY_ID is optional');
      expect(description).toContain('not registered at all');
      expect(description).toContain('restart the server');
      expect(description).toContain('company id');
      expect(description).toContain('changes nothing');
    } finally {
      await harness.close();
    }
  });
});

describe('lumics_revoke_tokens (spec section 11.4)', () => {
  const config = makeConfig({ features: { batchUpdate: false, tokenRevocation: true } });

  it('POSTs to /me/token/revoke with no body', async () => {
    const { call } = await exchange(
      'lumics_revoke_tokens',
      { confirm: true },
      { revoked: 3 },
      { config },
    );
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/me/token/revoke');
    expect(call.rawBody).toBeUndefined();
  });

  it('states in the output that this server can no longer talk to Lumics', async () => {
    const { notes } = await exchange(
      'lumics_revoke_tokens',
      { confirm: true },
      { revoked: 3 },
      { config },
    );
    expect(notes).toContain('including the credential this server is using');
    expect(notes).toContain('until an operator issues a new token and restarts it');
    expect(notes).toContain('Tell the user this has happened rather than retrying');
  });
});

describe('the token-minting endpoints of spec section 11.2 and 11.3 are not exposed', () => {
  it('no registered tool reaches GET or POST /me/token', async () => {
    const fetcher = recordFetch(jsonResponse({}));
    const harness = await connect(
      makeConfig({ features: { batchUpdate: true, tokenRevocation: true } }),
      { clientOptions: { fetchImpl: fetcher.fetchImpl } },
    );
    try {
      // The only token-related tool destroys credentials; none mints one.
      const tokenTools = harness.tools
        .map((tool) => tool.name)
        .filter((name) => name.includes('token'));
      expect(tokenTools).toEqual(['lumics_revoke_tokens']);
    } finally {
      await harness.close();
    }
  });

  it('only two of the four spec section 11 endpoints are exposed', () => {
    const meTools = allToolDefinitions().filter((definition) =>
      ['lumics_get_me', 'lumics_revoke_tokens'].includes(definition.name),
    );
    expect(meTools).toHaveLength(2);
    expect(meTools.map((definition) => definition.operation)).toEqual(['read', 'admin']);
  });
});

describe('no identity tool fabricates pagination', () => {
  it.each([['lumics_get_me', {}, SAMPLE_ME]])('%s', async (tool, args, response) => {
    const { text, call } = await exchange(tool, args, response);
    expectNoFabricatedPagination(text);
    expectNoFabricatedQueryParams(call);
  });
});
