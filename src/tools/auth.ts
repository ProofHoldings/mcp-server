import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_current_user',
    'Get the current authenticated user. Returns account details, plan, and settings for the API key owner.',
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
    'List all active authentication sessions for the current user. Shows session details including channel, user agent, and expiry. When called via API key, no session is marked as is_current.',
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
    'Revoke a specific authentication session by ID. When called via JWT, cannot revoke the current session. When called via API key, any session can be revoked.',
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
