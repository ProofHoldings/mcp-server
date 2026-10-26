import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, BSUID_REGEX } from '../types.js';
import { ApiError } from '../http.js';

const authorizationChannelEnum = z.enum(['whatsapp', 'telegram', 'sms', 'email']);
const authorizationScopeEnum = z.enum(['confirmations']);
const authorizationStatusEnum = z.enum(['pending', 'active', 'expired', 'revoked', 'denied']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_authorization',
    'Create a new authorization request. Authorizations grant permission to send confirmations to a user via a specific channel. The user must approve the authorization before confirmations can be sent.',
    {
      hitl_id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('HITL configuration ID to link this authorization to'),
      recipient: z.string().min(1).max(255).describe('Channel-specific recipient identifier (chat_id for Telegram, phone/BSUID for WhatsApp)'),
      phone: z.string().regex(/^\+[1-9]\d{1,14}$/).describe('Target phone number in E.164 format (e.g., +15551234567)'),
      bsuid: z.string().regex(BSUID_REGEX).optional().describe('WhatsApp Business-Scoped User ID (alternative to phone for WhatsApp channel)'),
      channel: authorizationChannelEnum.describe('Channel for sending confirmations'),
      scope: authorizationScopeEnum.optional().describe('Authorization scope (default: confirmations)'),
      business_name: z.string().min(1).max(200).optional().describe("Deprecated and ignored: the consent message always names the approval setup's sub-account. Leave it out."),
      business_profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('Sub-account to record on the authorization (does not change the name the person sees)'),
      expires_in: z.number().int().positive().max(7776000).optional().describe('Expiry in seconds (max 90 days, default 90 days)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/authorizations', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_authorization',
    'Get an authorization by ID. Returns the current state of the authorization including status and usage statistics.',
    {
      id: z.string().describe('Authorization ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/authorizations/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_authorizations',
    'List authorizations with optional filters. Returns paginated results.',
    {
      status: authorizationStatusEnum.optional().describe('Filter by authorization status'),
      phone: z.string().optional().describe('Filter by phone number'),
      channel: authorizationChannelEnum.optional().describe('Filter by channel'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.phone !== undefined) query.phone = args.phone;
        if (args.channel !== undefined) query.channel = args.channel;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/authorizations', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'revoke_authorization',
    'Revoke an active or pending authorization. Only authorizations with status "active" or "pending" can be revoked.',
    {
      id: z.string().describe('Authorization ID to revoke'),
      reason: z.string().min(1).max(500).optional().describe('Reason for revocation'),
    },
    async ({ id, reason }) => {
      try {
        const body = reason !== undefined ? { reason } : undefined;
        const result = await http.del(`/api/v1/authorizations/${encodeURIComponent(id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'export_authorizations',
    'Export authorizations as CSV or JSON. Supports date range and status filtering. Maximum 10,000 records.',
    {
      format: z.enum(['csv', 'json']).optional().describe('Export format (default: json)'),
      from: z.string().optional().describe('Start date filter (ISO 8601)'),
      to: z.string().optional().describe('End date filter (ISO 8601)'),
      status: authorizationStatusEnum.optional().describe('Filter by status'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.format !== undefined) query.format = args.format;
        if (args.from !== undefined) query.from = args.from;
        if (args.to !== undefined) query.to = args.to;
        if (args.status !== undefined) query.status = args.status;
        const result = await http.get('/api/v1/authorizations/export', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
