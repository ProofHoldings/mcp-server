import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_emails',
    'List all email addresses associated with the authenticated account.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/emails');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'remove_email',
    'Remove an email address from the account. Always requires one code: start_2fa_for_action with action_type email_remove and targets [this email id]. Revokes every proof of the address and your own consents naming it, declines pending confirmations waiting on it, moves Lookalike Watch alerts to your remaining primary email (or stops the watch when none is left), deletes the record, signs out your other devices, and names the new primary email. Refused for the address you signed in with and for your only way to sign in. Cannot be undone.',
    {
      id: z.string().describe('Email record ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/emails/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'set_primary_email',
    'Set an email address as the primary email for the account. Always requires one code: start_2fa_for_action with action_type email_primary (no targets); without it the call answers 403 2fa_required.',
    {
      id: z.string().describe('Email record ID to set as primary'),
    },
    async ({ id }) => {
      try {
        const result = await http.put(`/api/v1/me/emails/${encodeURIComponent(id)}/primary`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'start_add_email',
    'Start adding a new email address. Sends an OTP code to the email. Returns a session ID: when the user has the code, pass it with that session ID to verify_email_otp (resend_email_otp if it did not arrive; get_add_email_status reads the session).',
    {
      email: z.string().email().describe('Email address to add'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/emails/add', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_add_email_status',
    'Check the status of an in-progress email addition by session ID.',
    {
      session_id: z.string().describe('Add-email session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.get(`/api/v1/me/emails/add/${encodeURIComponent(session_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'verify_email_otp',
    'Submit the OTP code to verify an email addition. Completes the add-email flow if the code is correct.',
    {
      session_id: z.string().describe('Add-email session ID'),
      code: z.string().min(1).max(10).describe('OTP code received via email'),
    },
    async ({ session_id, code }) => {
      try {
        const result = await http.post(`/api/v1/me/emails/add/${encodeURIComponent(session_id)}/verify`, { code });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'resend_email_otp',
    'Resend the OTP code for an in-progress email addition.',
    {
      session_id: z.string().describe('Add-email session ID'),
    },
    async ({ session_id }) => {
      try {
        const result = await http.post(`/api/v1/me/emails/add/${encodeURIComponent(session_id)}/resend`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'preview_email_removal',
    'Preview what remove_email would do to one email address, without changing anything: the counts the dashboard Remove dialog shows, or the reason removal would be refused. Needs a signed-in session, like remove_email.',
    {
      id: z.string().regex(/^[0-9a-f]{24}$/i, 'Expected a 24-hex id').describe('Email record ID (24 hex characters)'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/me/emails/${encodeURIComponent(id)}/removal-preview`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
