import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_assets',
    'List all verified assets for the authenticated user. Assets are verified identities (phones, emails, domains).',
    {
      type: z.enum(['phone', 'email', 'domain', 'social', 'wallet']).optional().describe('Filter by asset type'),
      status: z.enum(['active', 'revoked', 'expired']).optional().describe('Filter by status'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.type !== undefined) query.type = args.type;
        if (args.status !== undefined) query.status = args.status;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/me/assets', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_asset',
    'Get a single verified asset by ID. Returns details including type, value, status, and verification timestamps.',
    {
      id: z.string().describe('Asset ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/assets/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'revoke_asset',
    'Revoke the proofs of one of your assets (a phone, email or domain) — the asset stays on the account. Owner only: sign in with start_login (a connection with only an API key is refused user_session_required — a key revokes a proof with revoke_proof instead), then one code: start_2fa_for_action with action_type revocation_bulk and targets [this asset id], wait_for_2fa, and call again. A phone or email: every proof of that number or address is revoked; signing in with it again issues a fresh proof. A domain you own: every proof of the domain and every delegation issued from it are revoked for good, and the domain needs re-verification — re-verifying does NOT bring the delegations back. Need a temporary stop for a domain proof? Use suspend_proof instead. Status-checking verifiers see the revocation within about a minute; signature-only verifiers accept a token until it expires. Cannot be undone.',
    {
      id: z.string().describe('Asset ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/assets/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
