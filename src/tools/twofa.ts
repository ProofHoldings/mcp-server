import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'start_2fa',
    'Start a two-factor authentication challenge for a sensitive operation. Sends a verification code via the chosen channel. Returns a session ID, and for messaging channels: deep_link, qr_code (base64 PNG), and qr_text (UTF-8 text QR for terminal display).\n\nAgent usage — full 2FA flow: (1) Call start_2fa with the appropriate action_type and channel. (2) Present the challenge, and do NOT announce a message the server did not send: email is the ONLY channel it dispatches on. On telegram/whatsapp the user opens `deep_link` and sends the message themselves; on sms they send `sms_message` to a number from `sms_dids`; the response\'s own `instructions` field says which. On email, a 200 carrying `requires_email_selection: true` and `available_emails` means nothing was sent and no session exists — ask which address and call again with `email_id`. For telegram/whatsapp, pass `deep_link` to render_auth_link; for sms, show `sms_message`. Never hand `qr_text` to a link renderer — it is the link already rendered as QR art, so print it verbatim inside a fenced code block only when a real terminal needs the QR. (3) Poll get_2fa_status with the returned session_id until status is "verified" (the user enters the code on their device) or "expired". (4) If verified, proceed with the protected operation (e.g. create_api_key). If expired, inform the user and offer to restart. Typical channels: "telegram" or "email". For email, the user may receive a magic link instead of a code — the backend handles this automatically.\n\n' + CHALLENGE_IN_REPLY,
    {
      action_type: z.enum([
        'api_key_view',
        'api_key_create',
        'api_key_revoke',
        'api_key_regenerate',
        'phone_add',
        'phone_remove',
        'email_add',
        'email_remove',
        'account_delete',
      ]).describe('The sensitive action requiring 2FA'),
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Channel to receive the verification code'),
      email_id: z.string().optional().describe('Specific email ID for email channel (optional)'),
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

  tool(
    'get_2fa_status',
    'Check the status of a 2FA session by session ID. Returns whether the challenge has been completed, is pending, or has expired.\n\nAgent usage: Poll this after calling start_2fa. Check every few seconds. Terminal states: "verified" (proceed with protected operation), "expired" (restart with start_2fa). While "pending", the user has not yet entered their code.\n\n' + WAIT_AFTER_REPLY,
    {
      session_id: z.string().describe('2FA session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.get(`/api/v1/me/2fa/${encodeURIComponent(session_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'verify_2fa',
    'Submit a verification code to complete a 2FA challenge. Rate limited to 10 attempts per minute.',
    {
      session_id: z.string().describe('2FA session ID'),
      code: z.string().min(1).max(10).describe('Verification code'),
    },
    async ({ session_id, code }) => {
      try {
        const result = await http.post(`/api/v1/me/2fa/${encodeURIComponent(session_id)}/verify`, { code });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'verify_2fa_magic_link',
    'Complete a 2FA challenge using a magic link token (received via email). No code submission needed — the token itself is the proof.',
    {
      token: z.string().describe('Magic link token from the verification email'),
    },
    async ({ token }) => {
      try {
        const result = await http.post(`/api/v1/me/2fa/magic/${encodeURIComponent(token)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_2fa',
    'Poll a 2FA session until the user completes the challenge. Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nAgent usage: Call this after start_2fa with the returned session_id. Terminal states: "verified" (challenge completed — proceed with the protected operation), "expired" (offer to restart with start_2fa). Before polling, present start_2fa\'s challenge: pass its `deep_link` to render_auth_link on telegram/whatsapp, or show its `sms_message` on sms.\n\n' + CHALLENGE_IN_REPLY,
    {
      session_id: z.string().describe('2FA session ID from start_2fa'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 600). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ session_id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/me/2fa/${encodeURIComponent(session_id)}`) as Promise<Record<string, unknown>>,
          ['verified', 'expired'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `2FA session ${session_id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
