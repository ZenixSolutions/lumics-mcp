/**
 * Identity tools — spec §11.
 *
 * Two of the four endpoints in spec §11 are exposed. The other two are withheld
 * deliberately; see the comment above {@link revokeTokens}.
 *
 * `GET /me` matters more than its size suggests: it is the only way to discover
 * the company id every other tool needs, so its description says so in as many
 * words. `POST /me/token/revoke` is the single most dangerous operation in the
 * whole API surface, and its description says that in as many words too.
 */

import { expectObject } from '../api/client.js';
import { mePath, meTokenRevokePath } from '../api/paths.js';
import type { Me, RevokeTokensResponse } from '../domain/index.js';
import { defineTool, result, type LumicsToolDefinition } from './factory.js';
import { fieldsSchema } from './schemas.js';

/**
 * spec §11.1 `GET /me`. No path, query or body parameters.
 *
 * The vendor's own description is "can be used to obtain your company", which is
 * exactly how this tool is meant to be used.
 */
const getMe = defineTool({
  name: 'lumics_get_me',
  title: 'Get the current user and company',
  operation: 'read',
  description:
    'Return the Lumics user this server authenticates as, together with the company that user belongs to — the company id, name, IANA timezone and active flag. This is the tool that bootstraps the rest of the server: LUMICS_COMPANY_ID is optional, and when the operator has not set it the company-scoped tools (devices, collectors, components, IPAM, company metrics) are not registered at all, so this may be almost the only tool you can see. In that state, call this tool, then tell the operator to set LUMICS_COMPANY_ID to the "company.id" value it returns and restart the server — passing the id as a companyId argument will not help, because those tools are absent rather than failing. It is also the cheapest way to check that the configured credential works at all. Takes no arguments and changes nothing.',
  inputSchema: {
    fields: fieldsSchema,
  },
  async handler(args, context) {
    const me = expectObject<Me>(await context.client.get(mePath()), 'GET me');
    return result(me, { fields: args.fields });
  },
});

/**
 * spec §11.4 `POST /me/token/revoke`. No parameters, no body.
 *
 * Classified `admin` and gated behind `LUMICS_ENABLE_TOKEN_REVOCATION`
 * (ADR-002 decision 4, RFC-001 D6). Both gates are deliberate: this revokes every
 * token issued to the account, so the blast radius is the whole account rather
 * than one record, and there is no per-token revoke and no endpoint that lists
 * outstanding tokens — so nobody, model or human, can see what will be destroyed
 * before destroying it.
 *
 * **`GET /api/v1/me/token` (spec §11.2) and `POST /api/v1/me/token` (spec §11.3)
 * are deliberately not exposed as tools, and must not be added.** Both mint a JWT
 * and return it in the response body: returning that to a model puts live
 * credential material into a conversation transcript, which is a credential leak
 * by design and not something a redaction layer can fix after the fact.
 * `POST /me/token` additionally requires the user's password as an argument, so
 * exposing it would invite a model to solicit one. `standards/security-standard.md`
 * ("never commit, log, echo, or expose secrets") and ADR-002 govern; operators mint
 * tokens themselves, out of band, as the README describes. `../api/paths.js`
 * deliberately carries no builder for that endpoint either, and no domain type
 * models its response, so nothing in this repository is one import away from
 * returning credential material to a model.
 */
const revokeTokens = defineTool({
  name: 'lumics_revoke_tokens',
  title: 'Revoke all API tokens',
  operation: 'admin',
  featureFlag: 'tokenRevocation',
  description:
    'Revoke every JWT token ever issued to this Lumics user account. The Lumics API has no way to revoke a single token, so this is all or nothing, and it includes the token this server is currently using: the moment it succeeds, this server can no longer talk to Lumics and every subsequent tool call will fail with an authentication error until a human mints a new token and restarts the server. It also breaks every other integration, script, dashboard or browser session authenticating as the same account, immediately and without warning. There is no undo, and because Lumics offers no endpoint that lists outstanding tokens, there is no way to find out what will be destroyed before destroying it. Only call this when a human has explicitly asked for it — for example because a token has leaked — and only after telling them plainly that this server will stop working and that anything else using the account will break too.',
  inputSchema: {},
  async handler(_args, context) {
    const response = await context.client.post<RevokeTokensResponse>(meTokenRevokePath());
    return result(response, {
      notes: [
        'Every JWT for this Lumics user has been revoked, including the credential this server is using. Further Lumics calls from this server will fail until an operator issues a new token and restarts it. Any other integration or session using the same account is also broken as of now and must be re-issued by hand. Tell the user this has happened rather than retrying.',
      ],
    });
  },
});

/**
 * The two exposed endpoints of spec §11. `GET /me/token` and `POST /me/token` are
 * intentionally absent — see the comment on {@link revokeTokens}.
 */
export const meTools: readonly LumicsToolDefinition[] = [getMe, revokeTokens];

export default meTools;
