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
    'Get account settings including branding configuration (business name, logo, colors, support email, email theme).',
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
    'Update account settings. Currently supports branding configuration.',
    {
      branding: z.object({
        business_name: z.string().max(100).optional().describe('Business name displayed in verifications'),
        logo_url: z.string().url().refine((u) => u.startsWith('https://'), { message: 'Logo URL must use HTTPS' }).optional().nullable().describe('HTTPS URL to business logo'),
        primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Primary brand color (hex, e.g. #FF5733)'),
        support_email: z.string().email().optional().describe('Support email shown in verification messages'),
        email_theme: z.enum(['dark', 'light']).optional().describe('Email template theme'),
      }).optional().describe('Branding settings to update'),
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
    'Export all account data (GDPR Article 20 - Right to Data Portability). Rate limited to 1 export per 24 hours.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/export');
        return jsonResult(result);
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
    'Get per-API-key usage for a given key id: verification counts by type/channel/status, plus verification-request/confirmation/authorization totals, and attribution context (attribution_cutoff_at, attributed_fraction). Counts only — no recipient identifiers. Scoped to the authenticated account; an API-key caller may read only its own key.',
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
