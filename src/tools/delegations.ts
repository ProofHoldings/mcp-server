import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

// Mongo ObjectId OR the public ph_dlg_* handle — mirrors delegationIdParamSchema
// in the backend validators (this package cannot import backend src/).
const DELEGATION_ID_REGEX = /^([0-9a-fA-F]{24}|ph_dlg_[a-f0-9]{32})$/;
const CONTROL_PROOF_REGEX = /^ph_ctl_[a-f0-9]{32}$/;

const delegateTypeEnum = z.enum(['url', 'purl']);
const delegationStatusEnum = z.enum(['active', 'revoked']);
const revokeReasonEnum = z.enum(['user_request', 'fraud', 'key_compromise', 'other']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_delegation',
    'Create a delegation (Proof of Delegation): a control-proven domain authorizes a typed url/purl artifact for a set of capability scopes and receives a publishable signed token. The attestation is that the domain\'s controller authorized this artifact — nothing more; it says nothing about the artifact or the business behind it. Each mint is a billable proof. A requested lifetime longer than the control proof\'s remainder is rejected, never truncated. The result carries the publishable token AND the DERIVED effective_status/is_valid — the same pair the list and get tools return, so the shape does not depend on which verb produced it.',
    {
      control_proof: z.string().regex(CONTROL_PROOF_REGEX).describe('Public handle (ph_ctl_<32 hex>) of YOUR active domain control proof'),
      delegate: z.object({
        type: delegateTypeEnum.describe('Identifier type: https URL or package URL (purl)'),
        value: z.string().min(1).max(2048).describe('The artifact identifier (canonicalized server-side)'),
      }).describe('The typed artifact being authorized'),
      scope: z.array(z.string().min(1).max(64)).min(1).max(32).describe('1-32 capability scopes: lowercase kebab-case tokens, at most 64 characters each (e.g. send-email). NOT API scopes — an API-style resource:action such as payments:read is rejected with invalid_scope.'),
      expires_in: z.number().int().positive().max(10 * 365 * 24 * 3600).optional().describe('Lifetime in seconds (must not exceed the control proof\'s remainder)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/delegations', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_delegations',
    'List your own delegations with optional filters. Each item carries the DERIVED effective_status/is_valid beside its stored status — read effective_status, since status records only whether the owner revoked the delegation themselves, so a delegation still reads active there after its domain control proof was revoked, suspended or expired, and after its OWN lifetime ran out. effective_status accounts for all of those: it reports expired once either lifetime has passed, whichever is earlier. Tokens are not included in the list — use get_delegation for the stored token. There is no public enumeration of third-party delegations.',
    {
      status: delegationStatusEnum
        .optional()
        .describe(
          "Filter by the delegation's OWN stored status (active|revoked). Does NOT filter the derived effective_status — status=active still returns delegations whose control proof died, and ones that simply ran out."
        ),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/delegations', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_delegation',
    'Get one of your delegations by Mongo id or ph_dlg_* handle. Returns the stored publishable token plus the DERIVED effective_status/is_valid — the delegation is only as live as the control proof it stands on (a revoked, suspended or expired domain proof invalidates it) and never outlives its own expires_at, whichever comes first.',
    {
      id: z.string().regex(DELEGATION_ID_REGEX).describe('Delegation ID (24-hex Mongo id or ph_dlg_<32 hex> handle)'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/delegations/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'revoke_delegation',
    'Revoke ONE delegation. The domain control proof and sibling delegations stay valid; the revocation is mirrored into the proof registry so the CRL, status list and public status lookup all see it. Idempotent: a repeat revoke answers success with the same body, both here and through revoke_proof with the ph_dlg_ handle — unlike a PROOF, where a repeat answers already_revoked. The result carries the DERIVED effective_status/is_valid beside the stored status.',
    {
      id: z.string().regex(DELEGATION_ID_REGEX).describe('Delegation ID (24-hex Mongo id or ph_dlg_<32 hex> handle)'),
      reason: revokeReasonEnum.optional().describe('Reason for revocation'),
    },
    async ({ id, reason }) => {
      try {
        const body = reason !== undefined ? { reason } : undefined;
        const result = await http.post(`/api/v1/delegations/${encodeURIComponent(id)}/revoke`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
