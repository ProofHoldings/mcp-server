import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_current_user',
    'Get the signed-in user\'s account details, plan and settings. Needs a login session: call start_login, then wait_for_login until it reports success. An API key alone cannot read this — for the key\'s own account use get_self_api_key or get_settings.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/auth/me');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_auth_sessions',
    "List the current user's signed-in devices: every session that can still renew, idle ones included. Each shows its channel, user agent and expires_at, which is when the session stops being able to renew (not when its current access token expires). When called via API key, no session is marked is_current.",
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/auth/sessions');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'revoke_auth_session',
    "Sign out one device (session) by ID. Over a signed-in session it cannot end the current one (that is logout). Over an API key it can end any of the account's sessions.",
    {
      session_id: z.string().describe('Session ID to revoke'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.del(`/api/v1/auth/sessions/${encodeURIComponent(session_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
