import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, credentialsSchema, VERIFICATION_TYPE_VALUES, VERIFICATION_CHANNEL_VALUES, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_verification',
    'Create a new identity verification. Initiates a verification flow for an asset identifier (phone number, email, domain, social handle, wallet address, account, or Telegram bot).\n\nAgent usage: pass the asset `type`, the delivery `channel`, and the `identifier` (e.g. type "phone", channel "sms", identifier "+37060000000"; or type "email", channel "email", identifier "user@example.com"). The response carries a `challenge` object with the instruction for the chosen channel — except a `telegram_bot` verification made with a LIVE key, which the server completes on the spot and answers with `status: verified` plus a proof token and no challenge at all; with a `pk_test_` key that same call stays pending and does carry a challenge. On the messenger channels it also carries `challenge.deep_link` — pass THAT to render_auth_link to give the user a clickable link and a QR code. This endpoint returns no `qr_text` at all. For OTP-based flows (sms/email), the user receives a code — poll get_verification or use wait_for_verification to track completion. For Telegram/WhatsApp, the user clicks the deep link to verify.\n\n' + CHALLENGE_IN_REPLY,
    {
      type: z.enum(VERIFICATION_TYPE_VALUES).describe('Asset type being verified'),
      channel: z.enum(VERIFICATION_CHANNEL_VALUES).describe('Verification channel (must match the asset type, e.g. sms/whatsapp/telegram for phone)'),
      identifier: z.string().min(1).max(500).describe('The asset identifier to verify (E.164 phone, email address, domain, handle, wallet address, ...)'),
      external_user_id: z.string().min(1).max(255).optional().describe('Your application user ID for grouping verifications'),
      client_metadata: z.record(z.string()).optional().describe('Custom key-value metadata'),
      dns_provider: credentialsSchema.optional().describe('DNS provider credentials (required for channel "auto")'),
      email_prefix: z.enum(['admin', 'administrator', 'webmaster', 'hostmaster', 'postmaster']).optional().describe('Mailbox prefix for domain email verification'),
      bot_token: z.string().min(1).max(500).optional().describe('Telegram bot token (required for channel "telegram_bot_token")'),
      proof_expiry_days: z.number().int().min(1).max(365).optional().describe('Per-request proof expiry override in days (1-365)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/verifications', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_verification',
    'Get a verification by ID. Returns the full verification object including status, channel, and proof token if verified.\n\n' + WAIT_AFTER_REPLY,
    {
      id: z.string().describe('Verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/verifications/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_verifications',
    'List verifications with optional filters. Returns paginated results.',
    {
      status: z.enum(['pending', 'verified', 'failed', 'expired', 'revoked']).optional().describe('Filter by status'),
      channel: z.enum(['sms', 'whatsapp', 'telegram', 'email']).optional().describe('Filter by channel'),
      external_user_id: z.string().optional().describe('Filter by external user ID'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.channel !== undefined) query.channel = args.channel;
        if (args.external_user_id !== undefined) query.external_user_id = args.external_user_id;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/verifications', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'trigger_verification',
    'Trigger a DNS/HTTP verification check for a pending domain verification.',
    {
      id: z.string().describe('Verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/verifications/${encodeURIComponent(id)}/verify`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'submit_verification_code',
    'Submit an OTP/challenge code for a pending verification. Accepted ONLY where we delivered the '
      + 'code out-of-band to the party being verified: type "email", and type "domain" with channel '
      + '"email". Any other pair answers 400 unsupported_for_type and completes elsewhere — use '
      + 'trigger_verification (POST /verifications/:id/verify) for a domain over dns/http/auto; a '
      + 'phone completes when the code reaches us FROM that number; social completes through its '
      + 'OAuth callback; a telegram_bot is already verified at creation.',
    {
      id: z.string().describe('Verification ID'),
      code: z.string().describe('The OTP or challenge code to submit'),
    },
    async ({ id, code }) => {
      try {
        const result = await http.post(`/api/v1/verifications/${encodeURIComponent(id)}/submit`, { code });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'resend_verification',
    'Resend a verification message (email channel only). Generates and sends a new code.',
    {
      id: z.string().describe('Verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/verifications/${encodeURIComponent(id)}/resend`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'test_verify',
    'Auto-complete a verification in test mode (pk_test_* API keys only). Useful for testing flows without real OTP delivery.',
    {
      id: z.string().describe('Verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/verifications/${encodeURIComponent(id)}/test-verify`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_verified_users',
    'List verified users grouped by external_user_id. Shows all verifications per user.',
    {
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/verifications/users', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_verified_user',
    'Get a single verified user and their verifications by external user ID.',
    {
      external_user_id: z.string().describe('The external user ID'),
    },
    async ({ external_user_id }) => {
      try {
        const result = await http.get(`/api/v1/verifications/users/${encodeURIComponent(external_user_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'start_domain_verification',
    'Start a B2B domain verification. Creates a verification record and returns DNS/HTTP instructions for the customer to complete.',
    {
      domain: z.string().min(1).max(255).describe('Domain to verify (e.g. example.com)'),
      customer_id: z.string().optional().describe('Customer identifier for B2B tracking'),
      verification_method: z.enum(['manual_dns', 'http_file']).optional().describe('Verification method (default: manual_dns)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/verifications/domain', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'check_domain_verification',
    'Check the status of a pending domain verification. Triggers a DNS/HTTP check and returns the updated status.',
    {
      id: z.string().describe('Domain verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/verifications/domain/${encodeURIComponent(id)}/check`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_domain_verification',
    'Delete a domain verification that has not been verified (pending or failed). A verified domain is refused with domain_verified: removing it would revoke its control proof and every delegation issued from it, so that is done from the dashboard.',
    {
      // Validated here rather than left to the REST 400: this tool is destructive, so a malformed
      // id never leaves the client.
      id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('Domain verification ID (24 hex characters)'),
    },
    async ({ id }) => {
      try {
        await http.del(`/api/v1/verifications/domain/${encodeURIComponent(id)}`);
        return jsonResult({ deleted: true, id });
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_verification',
    'Poll a verification until it reaches a terminal state (verified, failed, expired, revoked, or cancelled). Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nA multi-channel verification that lost the race is "cancelled" and one whose proof was withdrawn is "revoked"; both are final, so the wait returns rather than polling on.\n\n' + WAIT_AFTER_REPLY,
    {
      id: z.string().describe('Verification ID to poll'),
      timeout_seconds: z.number().int().min(1).max(300).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 300). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/verifications/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          // The verification model's full vocabulary, minus the one non-terminal value:
          // pending | verified | failed | expired | revoked | cancelled. `revoked` and `cancelled`
          // were missing and both are reachable and irreversible — a losing sibling of a
          // multi-channel group is set `cancelled` the instant another channel wins, and revoking
          // an asset's proof writes `revoked`. Polling through them wasted the whole budget, and
          // once the timeout stopped being an error it started telling the caller to try again
          // forever.
          ['verified', 'failed', 'expired', 'revoked', 'cancelled'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `verification ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_multi_channel_verification',
    'Create a multi-channel phone verification: one phone number challenged over several channels at once (OR / first-wins). The first channel the user completes wins, yields a single proof token, and cancels the losing siblings. Exactly one proof is billed, at the winning channel\'s completion — not one per channel, and nothing at creation.\n\nAgent usage: the response includes a `group_id` (format vg_<hex>) and a `channels` array — each block carries a `deep_link` (WhatsApp/Telegram) or an `sms_message` to present to the user — pass the `deep_link` to render_auth_link. A block\'s `qr_text` is that same link already rendered as QR art, not an alternative address: print it verbatim inside a fenced code block or leave it out. Poll get_multi_channel_verification_status with the group_id to track completion and retrieve the proof token when a channel verifies.\n\n' + CHALLENGE_IN_REPLY,
    {
      type: z.enum(['phone']).describe('Asset type — only "phone" is supported'),
      identifier: z.string().min(1).max(500).describe('Phone number in E.164 format'),
      channels: z.array(z.enum(['whatsapp', 'telegram', 'sms'])).min(1).max(4).describe('1-4 unique channels attempted in parallel (first to complete wins)'),
      external_user_id: z.string().min(1).max(255).optional().describe('Your application user ID for grouping verifications'),
      client_metadata: z.record(z.string()).optional().describe('Custom key-value metadata'),
      proof_expiry_days: z.number().int().min(1).max(365).optional().describe('Per-request proof expiry override in days (1-365)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/verifications/multi-channel', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_multi_channel_verification_status',
    'Get the status of a multi-channel verification group by its group_id. Returns the aggregate status (pending/verified/expired), the winning_channel once one completes, per-channel statuses, and the proof token (with expires_at) when the group is verified.\n\n' + WAIT_AFTER_REPLY,
    {
      group_id: z.string().describe('Multi-channel verification group ID (format vg_<hex>)'),
    },
    async ({ group_id }) => {
      try {
        const result = await http.get(`/api/v1/verifications/multi-channel/${encodeURIComponent(group_id)}/status`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
