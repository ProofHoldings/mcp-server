import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_phones',
    'List all phone numbers associated with the authenticated account.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/phones');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'remove_phone',
    'Remove a phone number from the account. Always requires one code: start_2fa_for_action with action_type phone_remove and targets [this phone id]. Revokes every proof of the number and your own consents naming it, declines pending confirmations waiting on it, flags approval setups left with no approver, deletes the record and its messenger links, signs out your other devices, and names the new primary phone — your Proof of Me circles then reach you there. Refused for the number you signed in with, for your only way to sign in, and for your last phone while circles are active (circles_need_phone: add another phone first, or archive the circles). Cannot be undone.',
    {
      id: z.string().describe('Phone record ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/phones/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'set_primary_phone',
    'Set a phone number as the primary phone for the account.',
    {
      id: z.string().describe('Phone record ID to set as primary'),
    },
    async ({ id }) => {
      try {
        const result = await http.put(`/api/v1/me/phones/${encodeURIComponent(id)}/primary`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'start_add_phone',
    'Start adding a new phone number by reverse OTP: the user starts the exchange themselves and nothing is sent before they do; the response\'s `instructions` field says what they do (on telegram the bot then asks them to tap a button that shares their number). Returns a session ID; on telegram/whatsapp also deep_link, qr_code (base64 PNG) and qr_text (UTF-8 text QR), and on sms sms_message and sms_dids (one entry per region; a region with no number configured has an empty `did`) with no deep_link.\n\nAgent usage: on telegram/whatsapp pass `deep_link` to render_auth_link for the link and a QR code. On sms there is no deep_link — show `sms_message` and a number from an `sms_dids` entry whose `did` is non-empty. Never hand a `qr_text` to a link renderer — it is a link already rendered as QR art. Then poll get_add_phone_status with the session ID.\n\n' + CHALLENGE_IN_REPLY,
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms']).describe('Channel for phone verification'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/phones/add', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_add_phone_status',
    'Check the status of an in-progress phone addition by session ID. Poll until terminal state.\n\n' + WAIT_AFTER_REPLY,
    {
      session_id: z.string().describe('Add-phone session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.get(`/api/v1/me/phones/add/${encodeURIComponent(session_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
