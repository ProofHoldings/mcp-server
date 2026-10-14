import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, credentialsSchema } from '../types.js';
import { ApiError } from '../http.js';

const EMAIL_PREFIXES = ['admin', 'administrator', 'webmaster', 'hostmaster', 'postmaster'] as const;

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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/domains', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_domain',
    'Remove a domain from the account. Revokes every proof of the domain and every delegation issued from it (for good — re-adding the domain does not bring them back), deletes the domain and its records, and removes our _proof TXT record and the Resend sending domain where we can; the response lists what is left for you to remove by hand. Owner only, in a start_login session, with one code: start_2fa_for_action with action_type domain_remove and targets [this domain id]. Need only a fresh proof? Revoke the proofs instead (revoke_asset), which keeps the domain. Cannot be undone.',
    {
      id: z.string().describe('Domain ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/domains/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'connect_cloudflare',
    'Connect a Cloudflare API token to a domain for automated DNS record management. Note: the API token will be visible in the AI conversation context.',
    {
      id: z.string().describe('Domain ID'),
      api_token: z.string().min(1).describe('Cloudflare API token with DNS edit permissions'),
    },
    async ({ id, api_token }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/cloudflare`, { api_token });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'connect_godaddy',
    'Connect GoDaddy API credentials to a domain for automated DNS record management. Note: the API key and secret will be visible in the AI conversation context.',
    {
      id: z.string().describe('Domain ID'),
      api_key: z.string().min(1).describe('GoDaddy API key'),
      api_secret: z.string().min(1).describe('GoDaddy API secret'),
    },
    async ({ id, api_key, api_secret }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/godaddy`, { api_key, api_secret });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'connect_dns_provider',
    'Connect a generic DNS provider to a domain using provider-specific credentials. Note: credentials will be visible in the AI conversation context.',
    dnsProviderSchema,
    async ({ id, provider, credentials }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/connect/${encodeURIComponent(provider)}`, { credentials });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'verify_domain_with_credentials',
    'Verify a pending domain using previously stored DNS credentials. Use when credentials are already connected.',
    {
      id: z.string().describe('Domain ID to verify'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/domains/${encodeURIComponent(id)}/verify-with-credentials`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
