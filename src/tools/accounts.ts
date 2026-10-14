import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_account',
    'Create an account-bootstrap session for agent-driven onboarding. Public endpoint (no API key required). Returns a session id, channel-specific instructions, and — FOR TELEGRAM AND WHATSAPP ONLY — deep_link, qr_code (base64 PNG) and qr_text (UTF-8 text QR).\n\nThe endpoint is safe to call regardless of whether the submitted identity is new: completing verification transparently creates a User when none exists, or logs the user in when one already does. The response is intentionally uniform — the server does NOT reveal whether the identity is already registered (this would be a user-enumeration oracle). If the agent needs to distinguish new-vs-returning users, call `get_current_user` after verification and inspect the user\'s `created_at`.\n\nEMAIL CHANNEL SENDS NOTHING HERE. The response carries email_sent=false and send_required=true: confirm with the user that the address is theirs, then call send_account_email. The other channels dispatch nothing either way — the user sends the first message themselves (reverse OTP).\n\nAgent usage: (1) Call create_account with the user\'s chosen channel. (2) For email, confirm with the user and call send_account_email. On telegram/whatsapp pass `deep_link` to render_auth_link, which returns the clickable link with a QR code beneath it to you. On sms `deep_link` is an EMPTY STRING and render_auth_link will reject it — show `sms_message`, which is what the user sends; this response carries no destination number, so do not invent one. Do not hand `qr_text` to a link renderer either — it is the link already rendered as QR art; print it verbatim inside a fenced code block if a real terminal needs the QR. (3) Once your reply shows the user the challenge, call wait_for_account_creation with the session id until verification completes. (4) On verified, JWT + refresh cookies are set; proceed with whatever follow-up the agent was asked to do.\n\n' + CHALLENGE_IN_REPLY,
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Authentication channel the user will verify through'),
      phone_number: z.string().optional().describe('E.164 phone number. Required for SMS channel (determines DID routing).'),
      email: z.string().email().optional().describe('Email address. Required for email channel.'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/accounts', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'send_account_email',
    'Deliver the verification email for an account-bootstrap session created with channel "email". Public endpoint (no API key required).\n\nWhy this is a separate call: create_account deliberately sends NOTHING. A message from proof.holdings arriving in someone\'s inbox is an act with a person on the other end, so it takes an explicit second step rather than being a side effect of creating a session. ASK THE USER to confirm the address is theirs before calling this — do not call it automatically after create_account.\n\nThe other channels (telegram, whatsapp, sms) never need this: the user sends the first message themselves (reverse OTP), so nothing is dispatched to them at all.\n\nOne session sends at most one email, including under concurrent calls. A repeat answers 410 already_sent, which means the material backing the send is gone: usually because the email went out, occasionally because an attempt was interrupted mid-send and nothing was delivered. Do not tell the user a message was sent on the strength of a 410 — create a new session instead. (A session the recipient cancelled via the decline link, or an expired one, answers 404, not 410.) If delivery fails the response carries email_sent=false and the call can be retried.',
    {
      id: z.string().describe('Account session id from create_account'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/accounts/${encodeURIComponent(id)}/send`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_account_creation',
    'Poll an account-bootstrap session until the user completes verification. Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nAgent usage: Call this after create_account with the returned session id. Terminal states: "verified" (this server keeps the session for this connection; the `user_id` field in the terminal body identifies the authenticated user), "expired". A result with status "pending" means the wait ran out before the user finished — call this tool again with the same id. Works identically whether the underlying flow created a new User or logged in an existing one.\n\n' + WAIT_AFTER_REPLY,
    {
      id: z.string().describe('Account session id from create_account'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 600). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/accounts/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          ['verified', 'expired'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `account session ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'start_2fa_for_action',
    'Start a 2FA challenge that grants the authenticated user permission to perform a sensitive action. The 2FA must complete on a channel DIFFERENT from the user\'s last login channel (the backend enforces this). On success a grant is stored keyed by the user id and action_type; middleware on the protected endpoint reads the grant and allows the mutation.\n\nDestructive action types (api_key_create, api_key_revoke, api_key_regenerate, api_key_view, account_delete, phone_remove, email_remove, phone_primary, email_primary, revocation_bulk, domain_remove, profile_delete) are capped at 5min TTL and forced single-use by server policy. A step-up for revocation_bulk, phone_remove, email_remove, domain_remove, profile_delete or account_delete is bound to `targets` — the exact ids the protected call will carry. Configuration scopes (settings_write, profile_update, templates_write) allow up to 24h TTL and caller-chosen single_use — useful for agents making multiple settings mutations in one session.\n\nAgent usage: (1) Attempt the sensitive call; if you get `403 2fa_required` note the `action_type`. (2) Call start_2fa_for_action with that action_type and a channel different from the login channel. (3) Present the challenge: on telegram/whatsapp pass `deep_link` to render_auth_link; on sms show `sms_message` and the number to send it to; on email check the response first: with more than one verified email and no `email_id` given, it answers 200 with `requires_email_selection: true` and `available_emails` — NO session was started and nothing was sent, so ask the user which address and call again with `email_id` rather than telling them to open a mailbox. Never hand `qr_text` to a link renderer — it is the link already rendered as QR art. Print it verbatim inside a fenced code block only when a real terminal needs the QR. (4) Call wait_for_2fa until the session is verified. (5) Retry the original sensitive call.\n\n' + CHALLENGE_IN_REPLY,
    {
      action_type: z.enum([
        'api_key_create', 'api_key_revoke', 'api_key_regenerate', 'api_key_view',
        'phone_remove', 'email_remove',
        'account_delete', 'revocation_bulk',
        'domain_remove', 'profile_delete', 'phone_primary', 'email_primary',
        'settings_write', 'profile_update', 'templates_write',
      ]).describe('The sensitive action the 2FA grant will authorize. Destructive scopes (api_key_*, account_delete, phone_remove, email_remove, phone_primary, email_primary, revocation_bulk, domain_remove, profile_delete) are capped at 5 min TTL + forced single-use. Configuration scopes (settings_write, profile_update, templates_write) allow up to 24h TTL with caller-chosen single_use. See config/twoFAPolicy.ts on the backend for the canonical policy.'),
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Channel for the 2FA challenge — must differ from the user\'s last login channel'),
      email_id: z.string().optional().describe('Optional: specific UserEmail id for email-channel 2FA'),
      phone_id: z.string().optional().describe('Optional: specific UserPhone id for phone-channel 2FA'),
      ttl_seconds: z.number().int().min(60).max(86400).optional().describe('Requested grant lifetime in seconds. Server caps to 300s for destructive action types, 86400s for configuration scopes. Defaults to 300 if omitted.'),
      single_use: z.boolean().optional().describe('Whether the grant is consumed on first use. Server forces true for destructive action types. Defaults to true.'),
      targets: z.array(z.string().min(1).max(256)).min(1).max(25).optional().describe('The ids the step-up is FOR — the grant is bound to exactly these and refused for any other request (`reason: target_mismatch`). revocation_bulk: the asset id you will pass to revoke_asset (one code per asset); phone_remove / email_remove: the phone or email record id; domain_remove: the domain id; profile_delete: the project id; account_delete: your own user id (get_current_user). Leave out for the other action types.'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/2fa/start', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
