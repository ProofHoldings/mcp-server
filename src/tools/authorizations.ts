import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, BSUID_REGEX, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

const authorizationChannelEnum = z.enum(['whatsapp', 'telegram', 'sms', 'email']);
const authorizationScopeEnum = z.enum(['confirmations']);
const authorizationStatusEnum = z.enum(['pending', 'active', 'expired', 'revoked', 'denied']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_authorization',
    'Create a new authorization request. Authorizations grant permission to send confirmations to a user via a specific channel. The user must approve the authorization before confirmations can be sent; get_authorization reads its status, which stays pending until they answer.',
    {
      hitl_id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('Approval channel ID to link this authorization to'),
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
        if (e instanceof ApiError) return apiErrorResult(e);
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
        if (e instanceof ApiError) return apiErrorResult(e);
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
        if (e instanceof ApiError) return apiErrorResult(e);
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
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'export_authorizations',
    `Export authorizations as CSV or JSON. Supports date range and status filtering. Maximum ${EXPORT_MAX_RECORDS.toLocaleString('en-US')} records. ` +
      'CSV comes back as `{ content_type, body, truncated }` with the file in `body`; a body over ' +
      `${EXPORT_TEXT_MAX_CHARS.toLocaleString('en-US')} characters is cut at the last full line (\`truncated: true\`, \`total_chars\`) — narrow \`from\`/\`to\` or \`status\` and export again for the rest.`,
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
        const result = await http.get<Record<string, unknown>>('/api/v1/authorizations/export', query);
        return jsonResult(typeof result.body === 'string' ? boundExportText(result as { content_type: string; body: string }) : result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}

/**
 * The most records the API puts in one export. A DELIBERATE COPY of `MAX_EXPORT_RECORDS` in the backend's
 * `src/controllers/authorizations.ts` (this package cannot import backend `src/`), held equal by
 * `src/__tests__/drift/mcp-export-cap.test.ts`, so the description states the API's cap, not a typed one.
 */
export const EXPORT_MAX_RECORDS = 10000;

/**
 * The most CSV one tool result carries. The API caps an export at 10,000 records, which is megabytes
 * of text — one tool result lands whole in the model's context, so the tool cuts it rather than the
 * client choking on it. Cut at a line boundary so the rows that arrive are whole rows.
 */
export const EXPORT_TEXT_MAX_CHARS = 100_000;

function boundExportText(result: { content_type: string; body: string }) {
  const { content_type, body } = result;
  if (body.length <= EXPORT_TEXT_MAX_CHARS) return { content_type, body, truncated: false };
  const cut = body.lastIndexOf('\n', EXPORT_TEXT_MAX_CHARS - 1);
  return {
    content_type,
    // No line break before the bound (one enormous row): cut at the bound instead of returning nothing.
    body: cut < 0 ? body.slice(0, EXPORT_TEXT_MAX_CHARS) : body.slice(0, cut + 1),
    truncated: true,
    total_chars: body.length,
    note: `Cut at ${EXPORT_TEXT_MAX_CHARS} characters, at a full line. Narrow from/to or status and export again for the remaining rows.`,
  };
}
