import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_session',
    'Create a new phone verification session. Returns deep_link, qr_code (base64 PNG), and qr_text (UTF-8 text QR for terminal display). Sessions provide a hosted verification flow with callbacks.\n\nAgent usage: After creating a session, pass the response\'s `deep_link` to render_auth_link so the user can open or scan it. Never hand `qr_text` to a link renderer — it is that link already rendered as QR art. Print it verbatim inside a fenced code block only when a real terminal needs the QR. On sms the person texts a short code from the number being proven, as in SMS login: `deep_link` is an `sms:` link to our default number with the message pre-filled, so render it the same way, and also show `sms_message` (what they send) with the numbers in `sms_dids` (one per region, each with its own QR), because a person reading on a computer texts from their phone. They get no reply SMS. An SMS proof can still be revoked about a minute after the session completes, if the delayed spoof check finds the sender was not a real mobile line, so before relying on it check it with validate_proof. Then use wait_for_session to poll until the session reaches a terminal state (verified, failed, or expired).\n\n' + CHALLENGE_IN_REPLY,
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms']).describe('How the person proves the number: telegram or whatsapp (the bot reads it from their account) or sms (they text a short code from it). No phone number is sent'),
      client_metadata: z.record(z.string(), z.unknown()).optional().describe('Your own key-value data, stored with the session'),
      profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('Sub-account (project) whose name and templates the bot uses; omitted: the key\'s project, else the primary'),
      context: z.object({
        action: z.enum(['login', '2fa', 'verification', 'recovery']).optional().describe('Picks the bot\'s wording: log in, 2FA, account recovery, or plain verification (the default)'),
      }).optional(),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/sessions', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_session',
    'Get a session by ID. Returns the session status, verification details, and proof token if verified.',
    {
      id: z.string().describe('Session ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/sessions/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_session',
    'Poll a session until it reaches a terminal state (verified, failed, or expired). Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\n' + WAIT_AFTER_REPLY,
    {
      id: z.string().describe('Session ID to poll'),
      timeout_seconds: z.number().int().min(1).max(300).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 300). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/sessions/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          ['verified', 'failed', 'expired'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `session ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
