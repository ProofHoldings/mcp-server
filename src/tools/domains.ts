import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, credentialsSchema, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

const EMAIL_PREFIXES = ['admin', 'administrator', 'webmaster', 'hostmaster', 'postmaster'] as const;

/**
 * The next step an agent needs when a provider connection PUBLISHED the record but the domain is not
 * verified yet (h-fix-provider-domain-verification-evidence): a provider accepting the record is not
 * proof of control; the domain is verified once the record is served in public DNS, which the server
 * keeps re-checking for about ten minutes. The structured result is the API's answer, untouched.
 */
export const PUBLISHED_RECORD_NEXT_STEP =
  'The verification record is published but not yet live in public DNS, so the domain is not verified yet. ' +
  'The server keeps checking for about 10 minutes and verifies it as soon as the record is served — usually within a minute. ' +
  'Call get_domain to see the status, or verify_domain to check now. If it stays unverified, the domain\'s DNS is served by ' +
  'another host (provider_name in the result): publish the record there, or connect that host.';

/**
 * For a published row the server is NOT re-checking on its own (the account's limit on background
 * checks, or no queue) — the API marks such a row by setting `error_message`; its presence decides.
 */
export const NO_AUTO_RECHECK_NEXT_STEP =
  'The verification record is published but not yet live in public DNS, and the server is not checking this domain automatically right now. ' +
  'Call verify_domain once the record is live to verify it. If it stays unverified, the domain\'s DNS is served by another host ' +
  '(provider_name in the result): publish the record there, or connect that host.';

function publishedRow(data: unknown): Record<string, unknown> | null {
  const row = (data as { data?: unknown } | null)?.data && typeof (data as { data?: unknown }).data === 'object'
    ? (data as { data: Record<string, unknown> }).data
    : (data as Record<string, unknown> | null);
  return row && row.status === 'verifying' && row.verification_method === 'auto_dns' ? row : null;
}

/** `jsonResult`, plus the next step when the domain is published-but-not-yet-served. */
export function domainResult(data: unknown) {
  const base = jsonResult(data);
  const row = publishedRow(data);
  if (!row) return base;
  const text = row.error_message ? NO_AUTO_RECHECK_NEXT_STEP : PUBLISHED_RECORD_NEXT_STEP;
  return { ...base, content: [...base.content, { type: 'text' as const, text }] };
}

const dnsProviderSchema = {
  id: z.string().describe('Domain ID'),
  provider: z.string().min(1).max(50).describe('DNS provider identifier'),
  credentials: credentialsSchema,
};

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_domains',
    'List all domains for the authenticated account. Returns domain metadata including verification status.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/domains');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'add_domain',
    'Add a new domain to verify ownership. Optionally specify email sending intent and verification method.',
    {
      domain: z.string().min(1).max(255).describe('Domain name to add (e.g. example.com)'),
      for_email_sending: z.boolean().optional().describe('Whether this domain is for email sending'),
      verification_method: z.enum(['auto_dns', 'manual_dns', 'http_file', 'email']).optional().describe('Preferred verification method'),
      profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('The sub-account (24 hex characters) whose email settings this domain is for'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/domains', args);
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_domain',
    'Get details of a specific domain by ID, including verification status, DNS records, and provider connections.',
    {
      id: z.string().describe('Domain ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/domains/${encodeURIComponent(id)}`);
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'delete_domain',
    'Remove a domain from the account. Revokes every proof of the domain and every delegation issued from it (for good — re-adding the domain does not bring them back), deletes the domain and its records, and removes our _proof TXT record and the Resend sending domain where we can; the response lists what is left for you to remove by hand. Owner only, in a start_login session, with one code: start_2fa_for_action with action_type domain_remove and targets [this domain id]. Need only a fresh proof? Revoke the proofs instead (revoke_my_proof), which keeps the domain. Cannot be undone.',
    {
      id: z.string().describe('Domain ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/domains/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'verify_domain',
    'Trigger domain verification. Checks DNS records or other verification method to confirm domain ownership.',
    {
      id: z.string().describe('Domain ID to verify'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify`);
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'connect_cloudflare',
    'Connect a Cloudflare API token to a domain: the server publishes the verification record through it. The domain is verified once that record is live in public DNS — often at once, else status "verifying" while the server keeps checking (call get_domain). Note: the API token will be visible in the AI conversation context.',
    {
      id: z.string().describe('Domain ID'),
      api_token: z.string().min(1).describe('Cloudflare API token with DNS edit permissions'),
    },
    async ({ id, api_token }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/cloudflare`, { api_token });
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'connect_godaddy',
    'Connect GoDaddy credentials to a domain: a Personal Access Token (api_token, permissions domains.domain:read and domains.dns:update), or a Production API key with its secret. The server publishes the verification record through it; the domain is verified once that record is live in public DNS — often at once, else status "verifying" while the server keeps checking (call get_domain). Note: the credentials will be visible in the AI conversation context.',
    {
      id: z.string().describe('Domain ID'),
      api_token: z.string().min(1).max(500).optional().describe('GoDaddy Personal Access Token (send this, or api_key with api_secret)'),
      api_key: z.string().min(1).max(500).optional().describe('GoDaddy Production API key (requires api_secret)'),
      api_secret: z.string().min(1).max(500).optional().describe('GoDaddy Production API secret, sent with api_key'),
    },
    async ({ id, api_token, api_key, api_secret }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/godaddy`, { api_token, api_key, api_secret });
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'connect_dns_provider',
    'Connect a generic DNS provider to a domain using provider-specific credentials. The server publishes the verification record through it; the domain is verified once that record is live in public DNS — often at once, else status "verifying" while the server keeps checking (call get_domain). Note: credentials will be visible in the AI conversation context.',
    dnsProviderSchema,
    async ({ id, provider, credentials }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/${encodeURIComponent(provider)}`, { credentials });
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'add_verification_provider',
    'Add an additional DNS provider for verification to an already-verified domain. Note: credentials will be visible in the AI conversation context.',
    dnsProviderSchema,
    async ({ id, provider, credentials }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/add-provider/${encodeURIComponent(provider)}`, { credentials });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_dns_providers',
    'Get metadata for all supported DNS providers, including required credential fields and documentation links.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/dns-providers');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'verify_domain_with_credentials',
    'Publish a pending domain\'s verification record using previously stored DNS credentials. The domain is verified once that record is live in public DNS — often at once, else status "verifying" while the server keeps checking (call get_domain). Use when credentials are already connected.',
    {
      id: z.string().describe('Domain ID to verify'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify-with-credentials`);
        return domainResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'check_domain_credentials',
    'Check if stored DNS credentials have access to a domain. Use before triggering verification to confirm the credentials work.',
    {
      id: z.string().describe('Domain ID to check credentials for'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/domains/${encodeURIComponent(id)}/check-credentials`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'start_domain_email_verification',
    'Start domain verification via corporate email. Sends a verification code to a standard admin email address at the domain.',
    {
      id: z.string().describe('Domain ID'),
      email_prefix: z.enum(EMAIL_PREFIXES).optional().describe('Email prefix to send verification to (default: admin)'),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify-email`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'confirm_domain_email_code',
    'Confirm domain email verification by submitting the code sent to the corporate email address.',
    {
      id: z.string().describe('Domain ID'),
      code: z.string().min(1).max(10).describe('Verification code from the email'),
    },
    async ({ id, code }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify-email/confirm`, { code });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'resend_domain_email',
    'Resend the domain verification email. Rate limited to 3 requests per minute.',
    {
      id: z.string().describe('Domain ID'),
      email_prefix: z.enum(EMAIL_PREFIXES).optional().describe('Email prefix to resend verification to'),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify-email/resend`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'setup_domain_email',
    'Register a verified domain with Proof\'s email provider (Resend) for sending. The result carries the DKIM/SPF DNS records to publish (`resend.dkim_records`) and their status. `from_email`, if given, must be on this domain and is stored as the preferred sender. Proof does not send from customer domains yet: verification emails still come from Proof\'s own address, and the stored `from_email` is not used.',
    {
      id: z.string().describe('Domain ID'),
      from_email: z.string().email().optional().describe('Custom from email address for the domain'),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/email-setup`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'check_domain_email_status',
    'Check the email sending setup status for a domain, including DNS record configuration progress.',
    {
      id: z.string().describe('Domain ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/domains/${encodeURIComponent(id)}/email-status`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
