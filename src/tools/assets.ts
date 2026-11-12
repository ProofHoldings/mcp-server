import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_my_proofs',
    'List all verified assets for the authenticated user. Assets are verified identities (phones, emails, domains).',
    {
      type: z.enum(['phone', 'email', 'domain', 'social', 'wallet']).optional().describe('Filter by asset type'),
      status: z.enum(['active', 'revoked', 'expired']).optional().describe('Filter by status'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.type !== undefined) query.type = args.type;
        if (args.status !== undefined) query.status = args.status;
        const result = await http.get('/api/v1/me/assets', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_my_proof',
    'Get a single verified asset by ID. Returns details including type, value, status, and verification timestamps.',
    {
      id: z.string().describe('Asset ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/assets/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'revoke_my_proof',
    'Revoke EVERY proof of one of your assets (a phone, email or domain), by its asset id from list_my_proofs — the asset stays on the account. A ph_ctl_* / ph_dlg_* handle is one proof, not an asset: revoke that with revoke_proof. Owner only: sign in with start_login (a connection with only an API key is refused user_session_required — a key revokes a proof with revoke_proof instead), then one code: start_2fa_for_action with action_type revocation_bulk and targets [this asset id], wait_for_2fa, and call again. A phone or email: every proof of that number or address is revoked; signing in with it again issues a fresh proof. A domain you own: every proof of the domain and every delegation issued from it are revoked for good, and the domain needs re-verification — re-verifying does NOT bring the delegations back. Need a temporary stop for a domain proof? Use pause_proof instead. Status-checking verifiers see the revocation within about a minute; signature-only verifiers accept a token until it expires. Cannot be undone.',
    {
      // T8c: a proof handle is refused by SHAPE, naming the tool it belongs to. The other confusion — a
      // verification id here — cannot be told apart (both are ObjectIds); the backend answers it.
      id: z
        .string()
        .superRefine((value, ctx) => {
          if (/^ph_(ctl|dlg)_/.test(value)) {
            ctx.addIssue({ code: 'custom', message: 'This is a proof handle, not an asset id: use revoke_proof.' });
          } else if (!/^[0-9a-f]{24}$/i.test(value)) {
            ctx.addIssue({ code: 'custom', message: 'Expected a 24-hex asset id from list_my_proofs.' });
          }
        })
        .describe('Asset ID (24 hex characters, from list_my_proofs). A ph_ctl_* / ph_dlg_* handle is a proof: use revoke_proof.'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/assets/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
