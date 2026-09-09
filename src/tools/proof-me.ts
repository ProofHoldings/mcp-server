import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const proofMeChannel = z.enum(['telegram', 'whatsapp']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'add_challenger',
    'Pre-enroll a Proof-Me challenger (a trusted contact) on a HITL config. Enabling the first challenger opts the config into Proof-Me. A telegram challenger captures its chat_id later at enrollment; a whatsapp challenger must pre-declare its phone.\n\nAgent usage: After adding a challenger, call invite_challenger to mint the single-use enrollment link the challenger taps to bind their messenger identity.',
    {
      hitl_id: objectId.describe('HITL config ID to enroll the challenger on'),
      name: z.string().min(1).max(100).describe('Display name of the challenger'),
      channel: proofMeChannel.describe('Messenger channel the challenger uses'),
      whatsapp_phone: z.string().optional().describe('E.164 phone with country code (required for the whatsapp channel)'),
    },
    async ({ hitl_id, ...body }) => {
      try {
        const result = await http.post(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/challengers`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_challengers',
    'List the Proof-Me challengers enrolled on a HITL config.',
    {
      hitl_id: objectId.describe('HITL config ID'),
    },
    async ({ hitl_id }) => {
      try {
        const result = await http.get(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/challengers`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'remove_challenger',
    'Remove a Proof-Me challenger from a HITL config. Removing the last challenger disables Proof-Me on the config.',
    {
      hitl_id: objectId.describe('HITL config ID'),
      challenger_id: objectId.describe('Challenger ID to remove'),
    },
    async ({ hitl_id, challenger_id }) => {
      try {
        const result = await http.del(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/challengers/${encodeURIComponent(challenger_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'invite_challenger',
    'Mint a single-use Proof-Me enrollment invite for a challenger. Returns Telegram + WhatsApp deep links and a QR code; the challenger taps the channel-matched link to bind their messenger identity to the config.',
    {
      hitl_id: objectId.describe('HITL config ID'),
      challenger_id: objectId.describe('Challenger ID to invite'),
    },
    async ({ hitl_id, challenger_id }) => {
      try {
        const result = await http.post(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/challengers/invite`, { challenger_id });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'trigger_drill',
    'Fire an on-demand Proof-Me drill against one enrolled challenger — a real cross-channel identity challenge carrying the scheduled-safety-check label. Complements the automated daily drill + monthly reinforcement sweeps.',
    {
      hitl_id: objectId.describe('HITL config ID'),
      challenger_id: objectId.describe('Challenger ID to drill'),
    },
    async ({ hitl_id, challenger_id }) => {
      try {
        const result = await http.post(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/challengers/${encodeURIComponent(challenger_id)}/drill`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_identity_challenge',
    'Create a Proof-Me cross-channel identity challenge (CONFIRM) for an enrolled challenger. The account holder approves/denies on a channel different from the one the suspicious contact reached the challenger on.\n\nAgent usage: poll get_identity_challenge with the returned ID until it reaches a terminal state (active = confirmed, denied, expired).',
    {
      hitl_id: objectId.describe('HITL config that holds the challenger'),
      challenger_id: objectId.describe('Enrolled challenger initiating the check'),
      suspicious_channel: proofMeChannel.optional().describe('Channel the suspicious contact reached the challenger on; defaults to the challenger channel'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/identity-challenges', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_identity_challenge',
    'Get a Proof-Me identity challenge by ID. Returns status, the channel the CONFIRM ran on, and the proof token once confirmed. Poll this for resolution.',
    {
      id: objectId.describe('Identity challenge ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/identity-challenges/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
