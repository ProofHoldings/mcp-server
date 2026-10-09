import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

// Mirrors validApiKeyScopes — the canonical scope taxonomy in the backend's
// src/constants/apiKeyScopes.ts. This package is published to npm and cannot import
// backend src/, so it carries its own copy; the backend drift test
// src/__tests__/drift/api-key-scopes.test.ts fails CI if this list diverges.
const validScopes = [
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_api_key',
    'Create a new API key. The secret key value is returned ONLY in this response — store it securely. Note: the secret will be visible in the AI conversation context. Optionally bind the key to a sub-account (project) via profile_id — outbound messages sent with the key are then branded as that project.\n\nAgent usage: This operation requires 2FA. Before calling, complete the 2FA flow: (1) call start_2fa with action_type "api_key_create" and the user\'s preferred channel, (2) tell the user a code was sent and wait for them to verify, (3) poll get_2fa_status until status is "verified", (4) then call create_api_key — the backend session will be elevated. If you get a 403, the 2FA session has expired — restart the flow.',
    {
      name: z.string().min(1).max(100).optional().describe('Human-readable key name'),
      environment: z.enum(['production', 'test']).optional().describe('Key environment (default: production)'),
      scopes: z.array(z.enum(validScopes)).max(20).optional().describe('Permission scopes for the key'),
      profile_id: z.string().optional().describe('Bind the new key to a sub-account (PublicProfile) project you own (24-hex id). Immutable after creation; omit for an unbound account-wide key.'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/api-keys', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'regenerate_api_key',
    'Regenerate an API key: issues a new key (a new id and secret) with the same name, environment, scopes and project. The old key stops working immediately; use the id in this response from now on. The new key lists the old one in replaced_key_ids, so its requests and usage stay with it. The new secret is returned ONLY in this response. Note: the secret will be visible in the AI conversation context.\n\nAgent usage: This operation requires 2FA. Before calling, complete the 2FA flow: (1) call start_2fa with action_type "api_key_regenerate", (2) wait for user to verify the code, (3) poll get_2fa_status until "verified", (4) then call regenerate_api_key.',
    {
      id: z.string().describe('API key ID to regenerate'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/api-keys/${encodeURIComponent(id)}/regenerate`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
