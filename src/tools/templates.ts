import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

/**
 * A template belongs to one sub-account (project), never to the account
 * (h-subaccount-branding-per-project, D1). Every operation but the platform defaults takes the
 * project as `?profile_id=`; a project-bound key may name only its own (403 `profile_mismatch`).
 */
const profileId = z.string().regex(/^[0-9a-fA-F]{24}$/).optional()
  .describe('The sub-account (project) to act on; omitted → your key\'s project, or the primary project for an account-wide key');

/** `path` for one project, or untouched when none is named so the server's own choice applies. */
function forProject(path: string, profile_id: string | undefined): string {
  return profile_id === undefined ? path : `${path}?profile_id=${encodeURIComponent(profile_id)}`;
}

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_templates',
    'List the custom message templates of one sub-account (project), organized by channel and message type. Templates belong to a project, not to the account: profile_id picks it — omitted, a project-bound key lists its own project and an account-wide key the primary project.',
    {
      profile_id: profileId,
    },
    async ({ profile_id }) => {
      try {
        const result = await http.get(forProject('/api/v1/templates', profile_id));
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_default_templates',
    'Get all default message templates. These are the built-in templates a project sends when it has no custom template of its own.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/templates/defaults');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_template',
    'Get the template a sub-account (project) sends for a channel and message type: its custom template if set (scope "project"), otherwise the default (scope "default"). The response names the project in profile_id.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
      profile_id: profileId,
    },
    async ({ channel, message_type, profile_id }) => {
      try {
        const result = await http.get(forProject(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`, profile_id));
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_template',
    'Create or update a sub-account\'s (project\'s) custom template for a channel and message type, replacing the default for that project only. Name the brand with {{business_name}}: a template spelling out a project\'s own name is refused (template_hardcoded_name).',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
      subject: z.string().max(200).optional().describe('Email subject line (email channel only)'),
      body: z.string().min(1).max(2000).describe('Template body text with variable placeholders'),
      button_text: z.string().max(50).optional().describe('Button text (email channel only)'),
      button_url_template: z.string().max(500).optional().describe('Button URL template with placeholders'),
      profile_id: profileId,
    },
    async ({ channel, message_type, profile_id, ...body }) => {
      try {
        const result = await http.put(forProject(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`, profile_id), body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_template',
    'Delete a sub-account\'s (project\'s) custom template, reverting that project to the default template for the channel and message type.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
      profile_id: profileId,
    },
    async ({ channel, message_type, profile_id }) => {
      try {
        const result = await http.del(forProject(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`, profile_id));
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'preview_template',
    'Preview a template with sample data before saving, as a sub-account (project) would send it. Shows how the message will look with placeholder variables filled in.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.enum([
        'verification_request', 'verification_success', 'verification_expired',
        'login_request', 'login_success', '2fa_request', '2fa_success',
      ]).describe('Message type'),
      subject: z.string().max(200).optional().describe('Email subject line'),
      body: z.string().min(1).max(2000).describe('Template body text'),
      button_text: z.string().max(50).optional().describe('Button text'),
      button_url_template: z.string().max(500).optional().describe('Button URL template'),
      profile_id: profileId,
    },
    async ({ profile_id, ...body }) => {
      try {
        const result = await http.post(forProject('/api/v1/templates/preview', profile_id), body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'render_template',
    'Render the template a sub-account (project) sends — its custom template, otherwise the default — with provided variables. Returns the fully rendered message content.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type'),
      variables: z.object({
        code: z.string().optional().describe('Verification or login code'),
        expires_in: z.string().optional().describe('Expiry duration text (e.g. "10 minutes")'),
        user_identifier: z.string().optional().describe('User identifier (phone, email, or domain)'),
        callback_url: z.string().optional().describe('Callback URL for the action'),
      }).optional().describe('Variables to substitute into the template'),
      profile_id: profileId,
    },
    async ({ profile_id, ...body }) => {
      try {
        const result = await http.post(forProject('/api/v1/templates/render', profile_id), body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
