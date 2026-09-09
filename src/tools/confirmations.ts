import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, pollUntilTerminal, WAIT_DEFAULT_SECONDS } from '../types.js';
import { ApiError } from '../http.js';

const confirmationStatusEnum = z.enum(['pending', 'approved', 'denied']);

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'create_confirmation',
    'Create a HITL confirmation request. Sends an approval request to the channels configured on the referenced HITL config. First response wins.\n\nAgent usage: The HITL config referenced by hitl_id must be authorized before you can create confirmations. If this returns a 403 or "not authorized" error, call request_hitl_authorization on the HITL config first, then wait for the user to approve via the messaging channel. After creating a confirmation, poll get_confirmation to check for approval/denial, or use get_confirmation_approval_link to generate a fresh link for the user.\n\nEncryption (v1 vs v2): when the HITL config has E2E encryption enabled, `message` must be a JSON ciphertext envelope, not plaintext. Choose the version by who must be able to decrypt:\n- v1 (single-recipient): wraps the content key for the config owner only. Use when there are no enrolled non-owner approvers.\n- v2 (multi-recipient): additionally wraps the content key for each enrolled approver via an `approver_ek` map, so every approver can decrypt. Use when the config has enrolled approvers — otherwise approvers get "wrong password" on the approval page. Build it with the SDK `encryptMessageV2(plaintext, ownerPublicKey, hitlId, approverKeys)` after fetching the approvers via the SDK `getApproverKeys(hitlId)` (`GET /api/v1/hitl/:id/approver-keys`). AAD is the `hitlId`.',
    {
      hitl_id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('HITL config ID whose channels will receive the approval request'),
      message: z.string().min(1).max(2000).describe('Human-readable description of what needs approval'),
      proof_expiry_days: z.number().int().optional().describe('Per-request proof expiry override in days (7, 30, 90, or 365)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/confirmations', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_confirmation',
    'Get a confirmation by ID. Returns the full confirmation including status, response, and proof token.',
    {
      id: z.string().describe('Confirmation ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/confirmations/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_confirmations',
    'List confirmations with optional filters. Returns paginated results with status and HITL config filtering.',
    {
      status: confirmationStatusEnum.optional().describe('Filter by confirmation status'),
      hitl_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('Filter by HITL config ID'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.hitl_id !== undefined) query.hitl_id = args.hitl_id;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/confirmations', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_confirmation_approval_link',
    'Generate a fresh approval link for a pending confirmation. The link expiry inherits the confirmation timeout. Only works for pending confirmations.',
    {
      id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('Confirmation ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/confirmations/${encodeURIComponent(id)}/approval-link`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'wait_for_confirmation',
    'Poll a confirmation until the approver responds. Uses exponential backoff (2s initial, 1.5x, 30s max) with jitter.\n\nAgent usage: Call this after create_confirmation with the returned confirmation ID. Terminal states: "approved" (action authorized — check the proof_token), "denied" (action rejected). While "pending", the approver has not yet responded. This poll returns no link — the approval request is delivered to the approver\'s own channel. If the approver needs one anyway, call get_confirmation_approval_link for a fresh `approval_url`; it needs the confirmation to be still pending — the state this tool waits in — and also refuses once `timeout_at` has passed, so a long wait can outlive the link even while the status has not moved.',
    {
      id: z.string().describe('Confirmation ID from create_confirmation'),
      timeout_seconds: z.number().int().min(1).max(600).optional().describe(`Maximum wait time in seconds (default: ${WAIT_DEFAULT_SECONDS}, max: 600). Keep it under your MCP client's request timeout (the SDK default is 60 s) — a longer wait is cut off by the client while the server is still polling. On timeout the tool answers status "pending"; call it again with the same identifier.`),
    },
    async ({ id, timeout_seconds }) => {
      try {
        return await pollUntilTerminal(
          () => http.get(`/api/v1/confirmations/${encodeURIComponent(id)}`) as Promise<Record<string, unknown>>,
          ['approved', 'denied'],
          timeout_seconds ?? WAIT_DEFAULT_SECONDS,
          `confirmation ${id}`,
        );
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
