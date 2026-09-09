import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'start_user_domain_verification',
    'Start a self-service domain verification session. The user proves ownership of a domain via DNS or HTTP challenge.',
    {
      domain: z.string().min(1).max(255).describe('Domain name to verify (e.g. example.com)'),
      channel: z.enum(['dns', 'http']).optional().describe('Verification channel (default: dns)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/verify/domain', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_user_domain_verification_status',
    'Get the current status of a domain verification session, including challenge details.',
    {
      session_id: z.string().describe('Domain verification session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.get(`/api/v1/me/verify/domain/${encodeURIComponent(session_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'check_user_domain_verification',
    'Trigger a check on the domain verification challenge. Call after placing DNS record or HTTP file.',
    {
      session_id: z.string().describe('Domain verification session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.post(`/api/v1/me/verify/domain/${encodeURIComponent(session_id)}/check`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
