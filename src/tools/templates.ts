import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_templates',
    'List all custom message templates for the authenticated account. Returns templates organized by channel and message type.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/templates');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_default_templates',
    'Get all default message templates. These are the built-in templates used when no custom template is set.',
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
    'Get a specific template by channel and message type. Returns the custom template if set, otherwise the default.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
    },
    async ({ channel, message_type }) => {
      try {
        const result = await http.get(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_template',
    'Create or update a custom template for a specific channel and message type. Replaces the default template.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
      subject: z.string().max(200).optional().describe('Email subject line (email channel only)'),
      body: z.string().min(1).max(2000).describe('Template body text with variable placeholders'),
      button_text: z.string().max(50).optional().describe('Button text (email channel only)'),
      button_url_template: z.string().max(500).optional().describe('Button URL template with placeholders'),
    },
    async ({ channel, message_type, ...body }) => {
      try {
        const result = await http.put(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_template',
    'Delete a custom template, reverting to the default template for that channel and message type.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type (e.g. verification_request, login_request)'),
    },
    async ({ channel, message_type }) => {
      try {
        const result = await http.del(`/api/v1/templates/${encodeURIComponent(channel)}/${encodeURIComponent(message_type)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'preview_template',
    'Preview a template with sample data before saving. Shows how the message will look with placeholder variables filled in.',
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
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/templates/preview', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'render_template',
    'Render a template with provided variables. Returns the fully rendered message content.',
    {
      channel: z.enum(['telegram', 'whatsapp', 'sms', 'email']).describe('Message channel'),
      message_type: z.string().describe('Message type'),
      variables: z.object({
        code: z.string().optional().describe('Verification or login code'),
        expires_in: z.string().optional().describe('Expiry duration text (e.g. "10 minutes")'),
        user_identifier: z.string().optional().describe('User identifier (phone, email, or domain)'),
        callback_url: z.string().optional().describe('Callback URL for the action'),
      }).optional().describe('Variables to substitute into the template'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/templates/render', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
