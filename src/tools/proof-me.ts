import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const proofMeChannel = z.enum(['telegram', 'whatsapp']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_identity_challenge',
    'Create a Proof-Me cross-channel identity challenge (CONFIRM) for an enrolled Circle member. The account holder approves/denies on a channel different from the one the suspicious contact reached the member on.\n\nAgent usage: poll get_identity_challenge with the returned ID until it leaves pending (confirmed, denied, cancelled, failed, expired or revoked).',
    {
      circle_id: objectId.describe('Circle that holds the member'),
      member_id: objectId.describe('Enrolled Circle member initiating the check'),
      suspicious_channel: proofMeChannel.optional().describe('Channel the suspicious contact reached the member on; defaults to the member channel'),
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
    'Get a Proof-Me identity challenge by ID. Returns its status (pending, confirmed, denied, cancelled, failed, expired, revoked or suspended), the channel the CONFIRM ran on, and — once the person being checked decided — the proof token and its proof_id. Poll this for resolution.',
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
