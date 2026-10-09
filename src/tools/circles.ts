import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const circleChannel = z.enum(['telegram', 'whatsapp']);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'must be E.164 with a leading +');

const ownerName = z.string().max(100).nullable().optional().describe(
  'How this Circle\'s members know its owner ("Dad", "Giorgi"). The bots name the owner by it; while it is empty they name nobody — the Circle\'s name labels the group, never the person. Trimmed by the API; null or an empty value clears it.',
);

// A contact at create time: name + OPTIONAL flat channel identifiers (mirrors the backend
// circleMemberInputSchema). A member may be added by name only and enrolled later.
const circleMemberInput = z.object({
  name: z.string().min(1).max(100).describe('Display name of the member'),
  telegram_chat_id: z.string().max(50).optional().describe('Telegram chat id (declared; usually captured at enrollment instead)'),
  whatsapp_phone: e164.optional().describe('E.164 WhatsApp phone with a leading + (declared)'),
});

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_circle',
    'Create a Circle — a named group of trusted contacts (the people-primitive powering Proof-Me and Approvals-on-Circle). Optionally seed initial members; each member\'s declared channels are stored so they can be invited to enroll.\n\nAgent usage: after creating a Circle, add members with add_circle_member (or seed them here), then invite_circle_member to mint the enrollment deep link each contact taps to bind their messenger identity.',
    {
      name: z.string().min(1).max(200).describe('Human-readable name for the Circle'),
      owner_name: ownerName,
      profile_id: objectId.optional().describe('Public profile (sub-account) to bind for branded messages — create-only'),
      proof_me_enabled: z.boolean().optional().describe('Enable Proof-Me drills for this Circle'),
      members: z.array(circleMemberInput).max(100).optional().describe('Initial members (name + optional declared channels)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/circles', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_circles',
    'List Circles with optional filters. Archived Circles are excluded by default; pass status="archived" to surface them. Returns paginated results.',
    {
      status: z.enum(['active', 'archived']).optional().describe('Filter by status (archived excluded unless requested)'),
      environment: z.enum(['production', 'test']).optional().describe('Filter by environment (production or test)'),
      profile_id: objectId.optional().describe('Filter by bound public profile (sub-account)'),
      page: z.number().int().positive().max(10000).optional().describe('Page number (default 1)'),
      limit: z.number().int().positive().max(100).optional().describe('Items per page (default 20, max 100)'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.environment !== undefined) query.environment = args.environment;
        if (args.profile_id !== undefined) query.profile_id = args.profile_id;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/circles', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_circle',
    'Get a Circle by ID. Returns the Circle including its members and per-member channel presence booleans (an identifier is NEVER returned — SEC-PM-006).',
    {
      id: objectId.describe('Circle ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/circles/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_circle',
    'Update a Circle\'s name and/or owner name. Omitted fields are left unchanged; the profile/identity binding is create-only.',
    {
      id: objectId.describe('Circle ID'),
      name: z.string().min(1).max(200).optional().describe('New name for the Circle'),
      owner_name: ownerName,
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.patch(`/api/v1/circles/${encodeURIComponent(id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_circle',
    'Archive a Circle (soft delete — sets status to archived). It stops appearing in the default list but is recoverable via list_circles with status="archived".',
    {
      id: objectId.describe('Circle ID to archive'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/circles/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'add_circle_member',
    'Add a pending member to a Circle by name, with an optional pre-declared WhatsApp phone. The Telegram chat id is captured later when the member taps the enrollment deep link.\n\nAgent usage: after adding a member, call invite_circle_member to mint the single-use enrollment link the member taps to bind their messenger identity.',
    {
      id: objectId.describe('Circle ID to add the member to'),
      name: z.string().min(1).max(100).describe('Display name of the member'),
      whatsapp_phone: e164.optional().describe('E.164 WhatsApp phone with a leading + (optional, declared)'),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.post(`/api/v1/circles/${encodeURIComponent(id)}/members`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_circle_members',
    'List a Circle\'s members. Each member carries channel-presence booleans (has_telegram / has_whatsapp) and the masked phone they enrolled from (enrolled_phone_hint, e.g. +9••••••4171) — a full identifier is NEVER returned (SEC-PM-006).',
    {
      id: objectId.describe('Circle ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/circles/${encodeURIComponent(id)}/members`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'invite_circle_member',
    'Mint a single-use enrollment invite for a Circle member. Returns Telegram + WhatsApp deep links and a QR code; the member taps the channel-matched link to bind their messenger identity to the Circle.',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID to invite'),
    },
    async ({ id, member_id }) => {
      try {
        const result = await http.post(`/api/v1/circles/${encodeURIComponent(id)}/members/invite`, { member_id });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_circle_member_drill',
    'Fire an on-demand Proof-Me drill against one enrolled member — a real cross-channel identity challenge carrying the scheduled-safety-check label (the account owner practices confirming). Complements the automated daily drill + monthly reinforcement sweeps.',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID to drill'),
    },
    async ({ id, member_id }) => {
      try {
        const result = await http.post(
          `/api/v1/circles/${encodeURIComponent(id)}/members/${encodeURIComponent(member_id)}/drill`,
        );
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'remove_circle_member',
    'Remove a member from a Circle. Deletes the member\'s channels and revokes any live authorizations that routed through them.',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID to remove'),
    },
    async ({ id, member_id }) => {
      try {
        const result = await http.del(
          `/api/v1/circles/${encodeURIComponent(id)}/members/${encodeURIComponent(member_id)}`,
        );
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'add_circle_member_channel',
    'Declare a channel for a Circle member. Returns 409 if that channel type already exists on the member. The identifier is a Telegram chat id or an E.164 WhatsApp phone (per-channel format validated server-side).',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID to add the channel to'),
      channel: circleChannel.describe('Channel type (telegram or whatsapp)'),
      identifier: z.string().min(1).max(100).describe('Telegram chat id, or E.164 WhatsApp phone with a leading +'),
    },
    async ({ id, member_id, ...body }) => {
      try {
        const result = await http.post(
          `/api/v1/circles/${encodeURIComponent(id)}/members/${encodeURIComponent(member_id)}/channels`,
          body,
        );
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_circle_member_channels',
    'List a Circle member\'s channels. Returns channel metadata only (channel, status, verified_at) — an identifier is NEVER returned (SEC-PM-006).',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID'),
    },
    async ({ id, member_id }) => {
      try {
        const result = await http.get(
          `/api/v1/circles/${encodeURIComponent(id)}/members/${encodeURIComponent(member_id)}/channels`,
        );
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'remove_circle_member_channel',
    'Remove a channel from a Circle member. Removing the last channel is allowed (the member simply becomes unreachable).',
    {
      id: objectId.describe('Circle ID'),
      member_id: objectId.describe('Member ID'),
      channel_id: objectId.describe('Channel ID to remove'),
    },
    async ({ id, member_id, channel_id }) => {
      try {
        const result = await http.del(
          `/api/v1/circles/${encodeURIComponent(id)}/members/${encodeURIComponent(member_id)}/channels/${encodeURIComponent(channel_id)}`,
        );
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
