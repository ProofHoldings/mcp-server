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
    'Revoke a verified asset by ID. The asset will be marked as revoked and associated proofs will no longer validate.',
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
