import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

// Mirrors validApiKeyScopes — the canonical scope taxonomy in the backend's
// src/constants/apiKeyScopes.ts. This package is published to npm and cannot import
// backend src/, so it carries its own copy; the backend drift test
// src/__tests__/drift/api-key-scopes.test.ts fails CI if this list diverges. Exported for
// `proof-mcp login` (src/cli.ts), whose default key carries every resource group of this list.
export const validScopes = [
  'verifications:read', 'verifications:write', 'verifications:create', 'verifications:*',
  'proofs:read', 'proofs:*',
  'delegations:read', 'delegations:write', 'delegations:create', 'delegations:*',
  'lookalike-watch:read', 'lookalike-watch:write', 'lookalike-watch:*',
  'templates:read', 'templates:write', 'templates:*',
  'authorizations:read', 'authorizations:write', 'authorizations:create', 'authorizations:*',
  'hitl:read', 'hitl:write', 'hitl:create', 'hitl:*',
  'confirmations:read', 'confirmations:write', 'confirmations:create', 'confirmations:*',
  'circles:read', 'circles:write', 'circles:create', 'circles:*',
  'profiles:read', 'profiles:write', 'profiles:*',
  'billing:read', 'billing:write', 'billing:*',
  'settings:read', 'settings:write', 'settings:*',
  'assets:read', 'assets:write', 'assets:*',
  'webhooks:read', 'webhooks:write', 'webhooks:*',
  'auth:read', 'auth:write', 'auth:*',
] as const;

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_api_keys',
    'List all API keys for the authenticated account. Returns key metadata (not the secret key values).',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/api-keys');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'create_api_key',
    'Create a new API key. The secret key value is returned ONLY in this response — store it securely. Note: the secret will be visible in the AI conversation context. Optionally bind the key to a sub-account via profile_id — outbound messages sent with the key are then branded as that sub-account. Optionally give it an end date with expires_at (ISO 8601 with offset, at least 5 minutes ahead); leave it out and the key never expires. Ask the user when the key should stop working rather than choosing for them. A date in the past or less than 5 minutes ahead is refused (validation_error) and nothing is created.\n\nAgent usage: This operation requires 2FA bound to the key it creates — its environment, scopes, sub-account and end date: a code confirmed for one key does not create another. (1) Call create_api_key with what the user chose; nothing is created, and its 2fa_required refusal lists the exact targets for that key. (2) Call start_2fa with action_type "api_key_create" and exactly those targets (none if the refusal lists none); the user is shown the key they are approving. (3) Wait for the user to verify the code and poll get_2fa_status until "verified". (4) Call create_api_key again with the SAME arguments. One code creates one key.',
    {
      name: z.string().min(1).max(100).optional().describe('Human-readable key name'),
      environment: z.enum(['production', 'test']).optional().describe('Key environment (default: production)'),
      scopes: z.array(z.enum(validScopes)).max(20).optional().describe('Permission scopes for the key'),
      profile_id: z.string().optional().describe('Bind the new key to a sub-account you own (24-hex id). Immutable after creation; omit for an unbound account-wide key.'),
      expires_at: z.string().optional().describe('When the key stops working, ISO 8601 with offset (e.g. 2027-02-13T23:59:59+01:00), at least 5 minutes ahead. Omit for a key that never expires.'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/api-keys', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'revoke_api_key',
    'Revoke an API key by ID. The key will immediately stop working. This action cannot be undone.\n\nAgent usage: This operation requires 2FA. Before calling, complete the 2FA flow: (1) call start_2fa with action_type "api_key_revoke", (2) wait for user to verify the code, (3) poll get_2fa_status until "verified", (4) then call revoke_api_key.',
    {
      id: z.string().describe('API key ID to revoke'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/api-keys/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'regenerate_api_key',
    'Regenerate an API key: issues a new key (a new id and secret) with the same name, environment, scopes and sub-account. Pass expires_at to choose when the new key stops working — a date, or null for never; leave it out and the new key keeps the old key\'s end date (or none). Ask the user rather than choosing. The answer\'s expires_at is when the new key stops working (carried from the old key when you send none); with no expires_at the new key never expires. A key whose expires_at has passed (see list_api_keys) is refused (api_key_expired) and a new date does not revive it, so check it before starting 2FA: for a key an MCP sign-in minted the message reads "This key stopped working on <day> and can\'t be turned back on. Connect your AI client again to get a new one."; for any other key, "This key stopped working on <day> and can\'t be turned back on. Create a new key." The old key stops working immediately; use the id in this response from now on. The new key lists the old one in replaced_key_ids, so its requests and usage stay with it. The new secret is returned ONLY in this response. Note: the secret will be visible in the AI conversation context.\n\nAgent usage: This operation requires 2FA bound to this key and to the end date sent (none sent, a date, and null are three different confirmations). (1) Call regenerate_api_key with the end date the user chose, or none; its 2fa_required refusal lists the exact targets — ["<this key id>"] with no expires_at, ["<this key id>", "act:expires_at:<the instant as UTC ISO 8601 with milliseconds>"] for a date, "act:expires_at:never" for null. (2) Call start_2fa with action_type "api_key_regenerate" and exactly those targets; the user is shown the new end date (or "never") they are approving. (3) Wait for the user to verify the code and poll get_2fa_status until "verified". (4) Call regenerate_api_key again with the SAME expires_at.',
    {
      id: z.string().describe('API key ID to regenerate'),
      expires_at: z.string().nullable().optional().describe('When the new key stops working, ISO 8601 with offset, at least 5 minutes ahead — or null for a key that never expires. Leave it out to keep the old key\'s end date.'),
    },
    async ({ id, expires_at }) => {
      try {
        const path = `/api/v1/me/api-keys/${encodeURIComponent(id)}/regenerate`;
        // No date sent: no body at all, the request a released client sends, so its [id] grant still applies.
        const result = expires_at === undefined ? await http.post(path) : await http.post(path, { expires_at });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'set_api_key_expiry',
    'Change when an API key stops working: set an end date on a key that has none, move it earlier or later, or pass expires_at null so the key never expires. The key keeps its id, secret, scopes and sub-account; only the date changes, and nothing extends it later. Answers the key as list_api_keys shows it.\n\nRefused before any 2FA code is asked for: a key that is not one of the account\'s live keys (not_found); a key whose expires_at has passed (api_key_expired — it cannot be revived, create a new key instead); a key an MCP sign-in renews itself (api_key_managed_by_sign_in — list_api_keys shows managed_by_sign_in: true; the user disconnects the AI client to end it). Check list_api_keys first so you do not start 2FA for a refused change.\n\nAgent usage: This operation requires 2FA bound to this key AND this exact value, shortening included: a code confirmed for one date does not set another date or "never". (1) Call set_api_key_expiry with the value the user chose; its 2fa_required refusal lists the exact targets — ["<this key id>", "act:expires_at:<the instant as UTC ISO 8601 with milliseconds, e.g. 2027-02-09T14:59:59.999Z>"], or "act:expires_at:never" for null. (2) Call start_2fa with action_type "api_key_expiry" and exactly those targets; the user is shown the date (or "never") they are approving. (3) Wait for the user to verify the code and poll get_2fa_status until "verified". (4) Call set_api_key_expiry again with the SAME value. One code covers one change.',
    {
      id: z.string().describe('API key ID'),
      expires_at: z.string().nullable().describe('The new end date, ISO 8601 with offset, at least 5 minutes ahead — or null for a key that never expires. Ask the user rather than choosing.'),
    },
    async ({ id, expires_at }) => {
      try {
        const result = await http.put(`/api/v1/me/api-keys/${encodeURIComponent(id)}/expiry`, { expires_at });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
