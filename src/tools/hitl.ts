import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, BSUID_REGEX, WAIT_DEFAULT_SECONDS } from '../types.js';
import { ApiError } from '../http.js';

const hitlStatusEnum = z.enum(['active', 'archived']);

const telegramChannelConfig = z.object({
  type: z.literal('telegram'),
  config: z.object({ chat_id: z.string().min(1).max(50) }),
});

const whatsappChannelConfig = z.object({
  type: z.literal('whatsapp'),
  config: z.object({
    phone_number: z.string().regex(/^\+?[1-9]\d{6,14}$/).optional().describe('Phone number in E.164 format'),
    bsuid: z.string().regex(BSUID_REGEX).optional().describe('WhatsApp Business-Scoped User ID (e.g. US.abc123...)'),
  }).refine(
    (data) => data.phone_number || data.bsuid,
    { message: 'At least one of phone_number or bsuid is required' }
  ),
});

const hitlChannelSchema = z.discriminatedUnion('type', [telegramChannelConfig, whatsappChannelConfig]);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_hitl',
    'Create a HITL (Human-in-the-Loop) config. Defines which messaging channels receive approval requests and the default timeout.\n\nAgent usage: After creating a HITL config, you must call request_hitl_authorization before it can be used with create_confirmation. For Telegram channels, use create_chat_id_discovery first to discover the user\'s chat ID, then include it in the channel config.',
    {
      name: z.string().min(1).max(200).describe('Human-readable name for this HITL config'),
      channels: z.array(hitlChannelSchema).min(1).describe('Messaging channels for approval requests (telegram or whatsapp)'),
      timeout_seconds: z.number().int().min(60).max(86400).optional().describe('Default timeout in seconds (60–86400, default: 3600)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/hitl', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_hitl',
    'Get a HITL config by ID. Returns the config including channels, timeout, and status.',
    {
      id: z.string().describe('HITL config ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/hitl/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_hitls',
    'List HITL configs with optional filters. Returns paginated results.',
    {
      status: hitlStatusEnum.optional().describe('Filter by status (active or archived)'),
      environment: z.enum(['production', 'test']).optional().describe('Filter by environment (production or test)'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.environment !== undefined) query.environment = args.environment;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/hitl', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_hitl',
    'Update a HITL config. Can change name, channels, or timeout.',
    {
      id: z.string().describe('HITL config ID'),
      name: z.string().min(1).max(200).nullable().optional().describe('New name (null to clear)'),
      channels: z.array(hitlChannelSchema).min(1).optional().describe('Updated channels'),
      timeout_seconds: z.number().int().min(60).max(86400).optional().describe('Updated timeout in seconds (60–86400)'),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.patch(`/api/v1/hitl/${encodeURIComponent(id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_hitl',
    'Delete (archive) a HITL config. Sets status to archived. Cannot be used for new confirmations after deletion.',
    {
      id: z.string().describe('HITL config ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/hitl/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'request_hitl_authorization',
    'Request authorization for a HITL config. Sends consent requests to all configured channels (Telegram/WhatsApp). Users must approve before confirmations can be sent.\n\nAgent usage: This must be completed before create_confirmation will work for this HITL config. The consent request is DELIVERED to each channel — the response carries no link to show. It returns `authorizations` — one entry per resolved recipient, each with its `channel`, `recipient`, `authorization_id` and `status` — plus a `message`. Read the entries rather than assuming: `status: \'pending\'` means consent was just sent and the user must approve in Telegram/WhatsApp itself, while `status: \'active\'` means that recipient had already authorized and nothing was sent to them. An EMPTY array does not mean everyone is authorized — it means no recipient could be resolved at all (usually a HITL config bound to a missing or inactive circle, or channels whose recipient is blank), so nobody was asked and waiting for an approval would hang forever. Do not relay `message` on that branch: it reads \'All channels already have active or pending authorizations\', which is exactly the wrong conclusion. Read the array. After requesting, you can proceed once the user confirms they have approved.',
    {
      id: z.string().describe('HITL config ID to request authorization for'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/hitl/${encodeURIComponent(id)}/authorize`, {});
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_chat_id_discovery',
    'Create a Telegram chat ID discovery token. Returns a deep_link, qr_code (base64 PNG), and qr_text (UTF-8 text QR for terminal display). The user opens the link in Telegram, which reveals their chat ID for HITL config setup.\n\nAgent usage: pass the response\'s `deep_link` to render_auth_link so the user can click or scan it. Never hand `qr_text` to a link renderer — it is that same link already rendered as QR art. Print it verbatim inside a fenced code block only when a real terminal needs the QR. Then poll poll_chat_id_discovery with the returned token until the chat_id appears. Use the discovered chat_id when creating a HITL config with a Telegram channel.',
    {},
    async () => {
      try {
        const result = await http.post('/api/v1/hitl/chat-id-discovery', {});
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'poll_chat_id_discovery',
    'Poll a chat ID discovery token. Returns the discovered Telegram chat ID, user ID, and username once the user interacts with the bot.',
    {
      token: z.string().describe('Discovery token from create_chat_id_discovery'),
    },
    async ({ token }) => {
      try {
        const result = await http.get(`/api/v1/hitl/chat-id-discovery/${encodeURIComponent(token)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_chat_id_discovery',
    'Poll a chat ID discovery token until the user interacts with the Telegram bot. Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nAgent usage: Call this after create_chat_id_discovery. Present the discovery response\'s `deep_link` with render_auth_link first, then poll with the returned token. Terminal states: "completed" (chat_id discovered — use it when creating a HITL config with a Telegram channel), "expired". While "pending", the user has not yet opened the Telegram link.',
    {
      token: z.string().describe('Discovery token from create_chat_id_discovery'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 600). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ token, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/hitl/chat-id-discovery/${encodeURIComponent(token)}`) as Promise<Record<string, unknown>>,
          ['completed', 'expired'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `chat ID discovery ${token}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
