import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, VERIFICATION_TYPE_VALUES, VERIFICATION_CHANNEL_VALUES, WAIT_DEFAULT_SECONDS } from '../types.js';
import { ApiError } from '../http.js';

const channelEnum = z.enum(VERIFICATION_CHANNEL_VALUES);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_verification_request',
    'Create a multi-asset verification request. Allows verifying multiple assets (phone, email, domain, social, wallet, account, telegram_bot) in a single flow.',
    {
      assets: z.array(z.object({
        type: z.enum(VERIFICATION_TYPE_VALUES).describe('Asset type to verify'),
        identifier: z.string().optional().describe('The identifier to verify (phone number, email, domain, etc.). If omitted, the user provides their own.'),
        channel: channelEnum.optional().describe('Preferred verification channel'),
        required: z.boolean().optional().describe('Whether this asset must be verified for the request to complete (default: true)'),
        allowed_channels: z.array(channelEnum).optional().describe('Restrict to specific channels for this asset'),
      })).min(1).max(10).describe('Array of assets to verify (1-10)'),
      reference_id: z.string().optional().describe('Your unique reference ID for this request'),
      action_type: z.enum(['verification', '2fa', 'login', 'custom', 'confirmation']).optional().describe('Purpose of the verification (default: verification)'),
      action_context: z.object({
        title: z.string().optional().describe('Action title shown to user (required for custom/confirmation)'),
        description: z.string().optional().describe('Action description shown to user'),
      }).optional().describe('Context displayed to user during verification'),
      partial_ok: z.boolean().optional().describe('Allow partial completion (default: false)'),
      redirect_url: z.string().optional().describe('URL to redirect user after verification completes (HTTPS only)'),
      callback_url: z.string().optional().describe('Webhook URL for status updates (HTTPS only)'),
      expires_in: z.number().int().positive().optional().describe('Request expiry in seconds (default: 86400, max: 604800)'),
      public_profile_id: z.string().optional().describe('Public profile ID for branding'),
      proof_expiry_days: z.number().int().optional().describe('Per-request proof expiry override in days (7, 30, 90, or 365)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/verification-requests', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_verification_request',
    'Get a verification request by ID. Returns the request with all its asset verification statuses.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/verification-requests/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_request_proofs',
    'Get proof tokens for verified assets in a verification request. Returns proof tokens that can be used for offline verification.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/verification-requests/${encodeURIComponent(id)}/proofs`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_verification_requests',
    'List verification requests with optional filters. Returns paginated results.',
    {
      status: z.enum(['pending', 'partial', 'completed', 'expired', 'cancelled', 'active']).optional().describe("Filter by status. 'active' = live (not-yet-expired) pending or partial requests; persisted statuses are time-aware."),
      reference_id: z.string().optional().describe('Filter by reference ID'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.reference_id !== undefined) query.reference_id = args.reference_id;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/verification-requests', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_request_by_reference',
    'Get a verification request by its reference ID (your unique identifier).',
    {
      reference_id: z.string().describe('Your unique reference ID'),
    },
    async ({ reference_id }) => {
      try {
        const result = await http.get(`/api/v1/verification-requests/by-reference/${encodeURIComponent(reference_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'cancel_verification_request',
    'Cancel a pending verification request. Only pending requests can be cancelled.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/verification-requests/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_request',
    'Poll a verification request until it reaches a terminal state (completed, expired, or cancelled). Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.',
    {
      id: z.string().describe('Verification request ID to poll'),
      timeout_seconds: z.number().int().min(1).max(300).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 300). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/verification-requests/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          ['completed', 'expired', 'cancelled'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `verification request ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
