import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
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
    'Remove a phone number from the account by ID. May require 2FA verification for sensitive operations.',
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
    'Start adding a new phone number. Uses reverse OTP: the system sends a message and the user replies. Returns a session ID, deep_link, qr_code (base64 PNG), and qr_text (UTF-8 text QR for terminal display).',
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
    'Check the status of an in-progress phone addition by session ID. Poll until terminal state.',
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
