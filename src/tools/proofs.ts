import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
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
        if (e instanceof ApiError) return apiErrorResult(e);
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
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'revoke_proof',
    'Revoke a proof by its public handle (ph_ctl_* / ph_dlg_*) or a verification ID — the same addresses get_proof_status takes. The proof token will no longer validate anywhere: the status endpoint, the public validator, the revocation list and the Token Status List all report it revoked. A domain CONTROL proof (a ph_ctl_* of a domain) also revokes, for good, every delegation issued from it; for a domain you own, every proof of the domain is revoked and the domain needs re-verification. The API key needs proofs:write, plus delegations:write while the revocation reaches live delegations — for a domain you own, any live delegation of the domain, whichever of its handles you name (the refusal names the scope and the count). A handle revoked before the domain was verified again does not reach the new proof: revoke that one by its own handle. Otherwise it revokes the PROOF only — the asset or consent it is about stays. Need a temporary stop? Use pause_proof instead. Cannot be undone.',
    {
      id: z.string().describe('Public proof handle (ph_ctl_* / ph_dlg_*) or verification ID'),
      reason: z.string().optional().describe('Why the proof is revoked, one of: user_request, fraud, key_compromise, asset_transferred, other. A delegation proof (ph_dlg_*) refuses asset_transferred. The API refuses any other value. Defaults to user_request.'),
    },
    async ({ id, reason }) => {
      try {
        const result = await http.post(`/api/v1/proofs/${encodeURIComponent(id)}/revoke`, {
          ...(reason !== undefined ? { reason } : {}),
        });
        return jsonResult(result);
      } catch (e) {
        // T8c: an asset id and a verification id are both ObjectIds, so only the backend's 404 can say
        // which was meant — and it answers an asset id with exactly that (pinned in
        // src/__tests__/routes/proofs-domain-control.test.ts). A handle can never be an asset id.
        if (e instanceof ApiError && e.code === 'not_found' && /^[0-9a-f]{24}$/i.test(id)) {
          return apiErrorResult({
            code: e.code,
            message: `${e.message} If this id came from list_my_proofs, it is an asset id: use revoke_my_proof.`,
            details: e.details,
            requestId: e.requestId,
            topUpUrl: e.topUpUrl,
          });
        }
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  // A1 (m-fix-mcp-tool-contract-drift SC-8): the dashboard's Pause / Resume (/domains, /delegations), in its words.
  tool(
    'pause_proof',
    'Pause a proof by its public handle (ph_ctl_* / ph_dlg_*) or a verification ID — a reversible stop, undone with resume_proof. While paused the proof is invalid: the status endpoint, the public validator and the Token Status List report it suspended; it is deliberately NOT put on the revocation list. Only an active proof can be paused (already_suspended, proof_expired or proof_revoked otherwise). Pausing a delegation (ph_dlg_*) stops a live publisher\'s tools: an MCP server running the Proof delegation gate refuses its tool calls once its next status check sees the pause (self-refusal). Pausing a domain CONTROL proof hides every delegation issued from it until it is resumed; nothing is revoked. The API key needs proofs:write, plus delegations:write for a ph_dlg_* or while delegations under a control proof are live.',
    {
      id: z.string().describe('Public proof handle (ph_ctl_* / ph_dlg_*) or verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/proofs/${encodeURIComponent(id)}/suspend`, {});
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'resume_proof',
    'Resume a proof paused with pause_proof, by the same handle (ph_ctl_* / ph_dlg_*) or verification ID: it validates again everywhere, and a resumed delegation is honoured again by gated publishers on their next status check. Only the paused row flips back — a proof revoked while paused stays revoked, and a handle whose own row is not the paused one answers not_suspended. The API key needs proofs:write, plus delegations:write for a ph_dlg_*.',
    {
      id: z.string().describe('Public proof handle (ph_ctl_* / ph_dlg_*) or verification ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/proofs/${encodeURIComponent(id)}/unsuspend`, {});
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_revoked_proofs',
    'Get the revocation list for offline proof validation. Returns a signed list of all revoked proof IDs. Reuse a fetched list for up to 5 minutes (its cache lifetime), then fetch it again to see new revocations; if you cannot, its signature stays verifiable offline for 1 hour.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/proofs/revoked');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_proof_token',
    'Get the current token of a proof you own, by its public ph_ctl_* handle. After a signing-key rotation this is the re-signed token, which replaces any older copy you hold. Each read is audited. A revoked or expired proof answers proof_not_live; a suspended one is still served. The proof of one of the account\'s own verified assets (a domain, phone or email verified on the account itself) answers owner_session_required here whatever its status (with a live key; a test key gets not_found): this tool sends the API key, and such a token is read by the signed-in owner in the dashboard. A key bound to a sub-account reads only that sub-account\'s proofs; another\'s answers not_found. For a delegation (ph_dlg_*) use get_delegation_token or get_delegation instead.',
    {
      id: z.string().describe('Public proof handle (ph_ctl_<32 hex>)'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/proofs/${encodeURIComponent(id)}/token`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_reissued_proofs',
    'List your proofs whose token was re-signed at or after an instant, oldest first — what to re-fetch after a signing-key rotation, for example when a webhook was missed. Items are references {proof_id, reissued_at, token_url}, never tokens: pull a ph_ctl_* item with get_proof_token and a ph_dlg_* item with get_delegation_token. Proofs of the account\'s own verified assets are not listed here (the API key cannot read their tokens); the dashboard shows them. A key bound to a sub-account lists only that sub-account\'s proofs and the account\'s delegations.',
    {
      since: z
        .string()
        .datetime({ offset: true })
        .describe('ISO-8601 instant with an offset, e.g. 2026-10-01T00:00:00Z'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {
          reissued_since: args.since,
        };
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/proofs', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_delegation_token',
    'Get the current token of an active delegation by its public ph_dlg_* handle — after a signing-key rotation, the re-signed token to publish in place of the old one. Public endpoint — no API key required, since the token is already published with the delegation. Any handle that is not an active delegation (revoked, suspended, expired or unknown) answers the same not_found.',
    {
      handle: z
        .string()
        .min(1)
        .refine((value) => value !== '.' && value !== '..', 'must not be a dot segment')
        .describe('Public delegation handle (ph_dlg_<32 hex>)'),
    },
    async ({ handle }) => {
      try {
        const result = await http.get(`/api/v1/proofs/delegation-token/${encodeURIComponent(handle)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
