import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_approval_channel_keys',
    'Get the encryption keypair for an approval channel. With `hitl:read` it returns the public key, encrypted private key, KDF salt, and key ID (kid). A key holding `confirmations:create` without `hitl:read` receives only `public_key` and `kid` — what a confirmation message is sealed to, never the private-key material.',
    {
      hitl_id: z.string().describe('Approval channel ID'),
    },
    async ({ hitl_id }) => {
      try {
        const result = await http.get(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'upload_approval_channel_keys',
    'Upload an encryption keypair for an approval channel. The server validates the RSA-4096 public key and computes the key ID. Note: the encrypted_private_key is already encrypted client-side with the user\'s password — the server never sees the password. The owner sets that password in the dashboard under Settings → Approvals password (https://proof.holdings/dev).',
    {
      hitl_id: z.string().describe('Approval channel ID'),
      public_key: z.string().describe('PEM-encoded RSA-4096 SPKI public key'),
      encrypted_private_key: z.string().describe('JSON-serialized encrypted private key envelope (PBKDF2-SHA256+AES-256-GCM)'),
      kdf_salt: z.string().describe('Base64url-encoded PBKDF2 salt'),
      wrapped_dek: z.string().min(1).max(500).optional().describe('v2 envelope: the data key wrapped under the master key'),
      dek_iv: z.string().min(1).max(64).optional().describe('v2 envelope: the IV of that wrapping'),
      dek_tag: z.string().min(1).max(64).optional().describe('v2 envelope: the GCM tag of that wrapping'),
      backup_wrapped_dek: z.string().min(1).max(500).optional().describe('v2 envelope: the data key wrapped under the recovery code'),
      backup_dek_iv: z.string().min(1).max(64).optional().describe('v2 envelope: the IV of the recovery wrapping'),
      backup_dek_tag: z.string().min(1).max(64).optional().describe('v2 envelope: the GCM tag of the recovery wrapping'),
    },
    async ({ hitl_id, ...body }) => {
      try {
        const result = await http.put(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'delete_approval_channel_keys',
    'Delete the encryption keypair from an approval channel. WARNING: Existing ciphertexts will become permanently unreadable.',
    {
      hitl_id: z.string().describe('Approval channel ID'),
    },
    async ({ hitl_id }) => {
      try {
        const result = await http.del(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
