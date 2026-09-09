import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_my_requests',
    'List verification requests created by the authenticated user.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/verification-requests');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_incoming_requests',
    'List incoming verification requests where the authenticated user is the subject.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/verification-requests/incoming');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_user_request',
    'Create a new verification request to ask another user to share verified assets.',
    {
      assets: z.array(z.string()).min(1).max(10).describe('Asset type identifiers to request (e.g. email, phone, identity)'),
      reference_id: z.string().optional().describe('External reference ID for tracking'),
      public_profile_id: z.string().optional().describe('Public profile ID for branding'),
      action_type: z.enum(['verification', 'onboarding', 'compliance']).optional().describe('Purpose of the request (default: verification)'),
      action_context: z.string().optional().describe('Additional context about why assets are needed'),
      validity_requirement: z.string().optional().describe('Required validity level for shared assets'),
      partial_ok: z.boolean().optional().describe('Whether partial asset sharing is acceptable (default: false)'),
      redirect_url: z.string().url().optional().describe('URL to redirect the subject after completing the request'),
      callback_url: z.string().url().optional().describe('Webhook URL for request status updates'),
      expires_in_hours: z.number().int().min(1).max(720).optional().describe('Hours until request expires (default: 24)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/verification-requests', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'claim_request_assets',
    'Claim shared assets from a completed verification request.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/claim`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'cancel_user_request',
    'Cancel a pending verification request. Only the creator can cancel.',
    {
      id: z.string().describe('Verification request ID to cancel'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/verification-requests/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'extend_request',
    'Extend the expiration time of a pending verification request.',
    {
      id: z.string().describe('Verification request ID to extend'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/extend`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'share_request_email',
    'Send an email notification to the subject of a verification request.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/share-email`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
