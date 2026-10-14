import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_usage',
    'Get usage metrics for the authenticated account. Shows verification counts, API calls, and quota usage.',
    {
      period: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Month to query in YYYY-MM format (e.g. 2026-01)'),
      months: z.number().int().min(1).max(12).optional().describe('Number of months of history'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.period !== undefined) query.period = args.period;
        if (args.months !== undefined) query.months = args.months;
        const result = await http.get('/api/v1/me/usage', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_platform_summary',
    'Get a one-call account snapshot: quota with end-of-month projection, request health (pending/completed/expired counts + success rate), per-channel completion rates, HITL counts, and active API key count. The same data the dashboard home renders. The hitl_channels sub-object requires the hitl:read scope.',
    {
      environment: z.enum(['production', 'test']).optional().describe('Scope request/channel/HITL metrics to test or production data (default: production)'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.environment !== undefined) query.environment = args.environment;
        const result = await http.get('/api/v1/me/summary', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_settings',
    'Get account settings: branding (business name, logo, colors, support email, email theme), the outbound webhook endpoint with its event subscriptions, and the default proof lifetime. The webhook signing secret is NOT returned to an API key — the response reports webhook.secret_set instead, and the value itself is visible only in the dashboard or in the update_settings response that created or rotated it.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/settings');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_settings',
    'Update account settings: branding, the outbound webhook endpoint with its event subscriptions, and the default proof lifetime. Setting the first webhook endpoint creates the signing secret and returns it in this response; the value is returned only when this call created or rotated it, so record it then.',
    {
      branding: z.object({
        business_name: z.string().max(100).optional().describe('Business name displayed in verifications'),
        logo_url: z.string().url().refine((u) => u.startsWith('https://'), { message: 'Logo URL must use HTTPS' }).optional().nullable().describe('HTTPS URL to business logo'),
        primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Primary brand color (hex, e.g. #FF5733)'),
        support_email: z.string().email().optional().describe('Support email shown in verification messages'),
        email_theme: z.enum(['dark', 'light']).optional().describe('Email template theme'),
      }).optional().describe('Branding settings to update'),
      webhook: z.object({
        url: z.string().url().max(2000).nullable().optional().describe('HTTPS endpoint outbound webhooks are delivered to, at most 2000 characters; null removes it. Private, loopback and link-local addresses are refused.'),
        events: z.array(z.string()).max(32).optional().describe('Subscription patterns: an exact event type, a family wildcard such as "proof.*", or "*". An empty list means every event.'),
        rotate_secret: z.boolean().optional().describe('Replace the signing secret and return the new value. The previous value stops verifying immediately.'),
      }).optional().describe('Outbound webhook configuration. Deliveries carry an HMAC-SHA256 X-Proof-Signature over "<X-Proof-Timestamp>.<body>".'),
      proof_expiry_days: z.number().int().min(1).max(365).optional().describe('Default proof-token lifetime in days for newly issued proofs'),
    },
    async (args) => {
      try {
        const result = await http.patch('/api/v1/me/settings', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'export_data',
    'Export a complete copy of your account\'s data (GDPR Articles 15 and 20), or check on one. Owner only: sign in with start_login first (a connection with only an API key is refused user_session_required). The first call starts the export; it is prepared in the background, and the account owner is told by email (or on their login channel) with a link that downloads it only while they are signed in — this tool never returns the data itself. Call again to see whether it is ready: an export already preparing or ready is reported instead of starting another. One new export per 24 hours (no limit while the account is scheduled for deletion); the file is kept for 7 days. Pass export_id to read one export\'s status.',
    {
      export_id: z.string().regex(/^[a-f0-9]{24}$/i, 'an export id is 24 hex characters').optional().describe('Read this export\'s status instead of the latest one'),
    },
    async ({ export_id }) => {
      try {
        if (export_id) {
          return jsonResult(await http.get(`/api/v1/me/export/${encodeURIComponent(export_id)}`));
        }
        // An export already under way, or ready to download, is the answer — starting another
        // would only meet the daily limit.
        const { latest } = (await http.get('/api/v1/me/export')) as { latest: { status?: string } | null };
        if (latest && (latest.status === 'preparing' || latest.status === 'ready')) return jsonResult(latest);
        return jsonResult(await http.post('/api/v1/me/export'));
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'search',
    'Prefix-anchored global account search across six resource buckets (verification_requests, verifications, hitl, confirmations, authorizations, api_keys). Case-sensitive prefix match over indexed plaintext fields only; recipient identifiers are masked. Results are scoped to the authenticated account.',
    {
      q: z.string().min(3).max(100).describe('Prefix-anchored search query (minimum 3 characters)'),
      type: z.enum(['verification_requests', 'verifications', 'hitl', 'confirmations', 'authorizations', 'api_keys']).optional().describe('Narrow the search to a single result bucket'),
      environment: z.enum(['production', 'test']).optional().describe('Scope results to test or production data (default: production)'),
      limit: z.number().int().positive().max(25).optional().describe('Max results per bucket (default 10, max 25)'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.q !== undefined) query.q = args.q;
        if (args.type !== undefined) query.type = args.type;
        if (args.environment !== undefined) query.environment = args.environment;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/me/search', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_self_api_key',
    "Get the calling API key's own redacted metadata (id, name, key_prefix, environment, scopes, last_used_at, revoked_at, created_at) for agent self-inspection. Never returns the key hash or full secret. Requires API-key auth — a JWT session has no single-key context (returns 400 api_key_required).",
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/api-key');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_api_key_usage',
    'Get per-API-key usage for a given key id: verification counts by type/channel/status, plus verification-request/confirmation/authorization totals, and attribution context (attribution_cutoff_at, attributed_fraction). The counts cover the key and every key it replaced (api_key.replaced_key_ids). Counts only — no recipient identifiers. Scoped to the authenticated account; an API-key caller may read only its own key.',
    {
      id: z.string().describe('The API key id to fetch usage for'),
      environment: z.enum(['production', 'test']).optional().describe('Scope metrics to test or production data (default: production)'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.environment !== undefined) query.environment = args.environment;
        const result = await http.get(`/api/v1/me/api-keys/${encodeURIComponent(args.id)}/usage`, query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
