import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_hitl_keys',
    'Get the encryption keypair for a HITL config. With `hitl:read` it returns the public key, encrypted private key, KDF salt, and key ID (kid). A key holding `confirmations:create` without `hitl:read` receives only `public_key` and `kid` — what a confirmation message is sealed to, never the private-key material.',
    {
      hitl_id: z.string().describe('HITL config ID'),
    },
    async ({ hitl_id }) => {
      try {
        const result = await http.get(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'upload_hitl_keys',
    'Upload an encryption keypair for a HITL config. The server validates the RSA-4096 public key and computes the key ID. Note: the encrypted_private_key is already encrypted client-side with the user\'s password — the server never sees the password.',
    {
      hitl_id: z.string().describe('HITL config ID'),
      public_key: z.string().describe('PEM-encoded RSA-4096 SPKI public key'),
      encrypted_private_key: z.string().describe('JSON-serialized encrypted private key envelope (PBKDF2-SHA256+AES-256-GCM)'),
      kdf_salt: z.string().describe('Base64url-encoded PBKDF2 salt'),
    },
    async ({ hitl_id, public_key, encrypted_private_key, kdf_salt }) => {
      try {
        const result = await http.put(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`, {
          public_key,
          encrypted_private_key,
          kdf_salt,
        });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_hitl_keys',
    'Delete the encryption keypair from a HITL config. WARNING: Existing ciphertexts will become permanently unreadable.',
    {
      hitl_id: z.string().describe('HITL config ID'),
    },
    async ({ hitl_id }) => {
      try {
        const result = await http.del(`/api/v1/hitl/${encodeURIComponent(hitl_id)}/keys`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
