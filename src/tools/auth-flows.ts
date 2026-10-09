import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'start_login',
    'Start a login session by sending an authentication challenge to the user\'s chosen channel (Telegram, WhatsApp, SMS, or email). Returns a session ID and, FOR TELEGRAM AND WHATSAPP ONLY, deep_link, qr_code (base64 PNG) and qr_text (UTF-8 text QR for terminal display); on sms it returns sms_message with sms_dids instead, and on email nothing to display.\n\nAgent usage: (1) Call start_login with the desired channel and phone_number (for SMS) or email (for email). (2) Present the challenge, and WHICH FIELD depends on the channel. On telegram/whatsapp pass `deep_link` to render_auth_link, which returns the clickable link and a QR code to you; in a chat client the link is what the user acts on, since they are usually on the same machine. On sms `deep_link` is an EMPTY STRING and render_auth_link will reject it — show `sms_message` and let the user pick a number from `sms_dids`. `suggested_region` is always set, but the matching ENTRY in `sms_dids` may be missing (europe and israel appear only when a number is configured) or present with an empty `did`, so offer that region first only when `sms_dids[suggested_region]` exists and carries a number, and otherwise offer whatever the object does. On email there is nothing to display at all, and nothing to check either: a result means the mail was accepted for delivery, so tell the user to open their inbox. A delivery failure is an ERROR here, not a field — the tool answers `challenge_delivery_failed` and NO session exists, so do not call wait_for_login; retry, or offer another channel. Never hand `qr_text` to a link renderer — it is the link already rendered as QR art, so print it verbatim inside a fenced code block or not at all, because its rows stop scanning the moment one wraps or a blank line lands between them. (3) Once your reply shows the user the challenge, call wait_for_login with the returned session ID to poll until the user completes authentication. Terminal states: "verified" (login succeeded), "failed", "expired".\n\n' + CHALLENGE_IN_REPLY,
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Authentication channel'),
      phone_number: z.string().optional().describe('Phone number in E.164 format (required for SMS channel)'),
      email: z.string().email().optional().describe('Email address (required for email channel)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/auth/sessions', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_login',
    'Poll a login session until the user completes authentication. Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nAgent usage: Call this after start_login with the returned session ID. Terminal states: "verified" (login succeeded — this server keeps the session for this connection and signs your own account records with it: emails, phones, domains, API keys, 2FA, DNS credentials, verification requests, your public profile\'s username and proof list), "failed", "expired". A result with status "pending" means the wait ran out before the user finished — call this tool again with the same id.\n\n' + WAIT_AFTER_REPLY,
    {
      id: z.string().describe('Auth session ID from start_login'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 600). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/auth/sessions/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          ['verified', 'failed', 'expired'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `login session ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
