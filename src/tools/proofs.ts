import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'validate_proof',
    'Validate a proof token online. Checks the token signature, expiry, and revocation status against the server, and optionally that the proof is about the identifier you expect. Public endpoint — no API key required.',
    {
      proof_token: z.string().describe('The JWT proof token to validate'),
      identifier: z
        .string()
        .optional()
        .describe(
          'Optional: the identifier this proof should be about (phone, email, domain, ...). When supplied, a proof about anything else answers valid:false with reason "identifier_mismatch"; a proof of an encrypted decision answers "identifier_unverifiable".'
        ),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/proofs/validate', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_proof_status',
    'Get the status of a proof by its public handle (ph_ctl_* / ph_dlg_*) or a verification ID. Returns whether the proof is active, suspended, expired, or revoked — a live proof reads "active".',
    {
      id: z.string().describe('Public proof handle (ph_ctl_* / ph_dlg_*) or verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/proofs/${encodeURIComponent(id)}/status`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'revoke_proof',
    'Revoke a proof by its public handle (ph_ctl_* / ph_dlg_*) or a verification ID — the same addresses get_proof_status takes. The proof token will no longer validate anywhere: the status endpoint, the public validator, the revocation list and the Token Status List all report it revoked. This action is irreversible. It revokes the PROOF only — the asset, consent or delegation the proof is about is not withdrawn.',
    {
      id: z.string().describe('Public proof handle (ph_ctl_* / ph_dlg_*) or verification ID'),
      reason: z.string().optional().describe('Reason for revocation'),
    },
    async ({ id, reason }) => {
      try {
        const result = await http.post(`/api/v1/proofs/${encodeURIComponent(id)}/revoke`, {
          ...(reason !== undefined ? { reason } : {}),
        });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_revoked_proofs',
    'Get the revocation list for offline proof validation. Returns a signed list of all revoked proof IDs, cacheable for 5 minutes.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/proofs/revoked');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
