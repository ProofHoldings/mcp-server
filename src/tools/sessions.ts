import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_session',
    'Create a new phone verification session. Returns deep_link, qr_code (base64 PNG), and qr_text (UTF-8 text QR for terminal display). Sessions provide a hosted verification flow with callbacks.\n\nAgent usage: After creating a session, pass the response\'s `deep_link` to render_auth_link so the user can open or scan it. Never hand `qr_text` to a link renderer — it is that link already rendered as QR art. Print it verbatim inside a fenced code block only when a real terminal needs the QR. Then use wait_for_session to poll until the session reaches a terminal state (verified, failed, or expired).\n\n' + CHALLENGE_IN_REPLY,
    {
      channel: z.enum(['sms', 'whatsapp', 'telegram']).describe('Verification channel'),
      phone_number: z.string().describe('Phone number in E.164 format'),
      callback_url: z.string().optional().describe('URL to redirect after verification'),
      external_user_id: z.string().optional().describe('Your application user ID'),
      template_id: z.string().optional().describe('Custom template ID'),
      metadata: z.record(z.string()).optional().describe('Custom key-value metadata'),
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
