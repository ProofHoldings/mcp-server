import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, VERIFICATION_CHANNEL_VALUES } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_my_requests',
    'List verification requests created by the authenticated user.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/verification-requests');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_incoming_requests',
    'List incoming verification requests where the authenticated user is the subject.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/verification-requests/incoming');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_user_request',
    'Create a new verification request to ask another user to share verified assets. Each asset is an object naming its type, e.g. { "type": "email" }.',
    {
      // The enums and the string caps and patterns below are the API model's own
      // (src/models/VerificationRequest.ts), held equal by
      // src/__tests__/drift/mcp-user-request-contract.test.ts: a value outside them is a request the API
      // cannot store, and only this schema can tell the agent which field it was. The rest is compared
      // with its source by no test: the asset count and the expiry bound are the controller's own
      // checks, and the non-empty strings, the identifier and channel-list caps, the profile ID format
      // and the positive amount are the API-key route's rules for the same body
      // (`createVerificationRequestSchema`) — this route has no validator and reads an empty string as
      // the field left out.
      assets: z
        .array(
          z.object({
            type: z.enum(['phone', 'email', 'domain', 'social', 'wallet', 'telegram_bot']).describe('What to verify'),
            identifier: z.string().min(1).max(500).optional().describe('The exact value to verify (e.g. an email address); omit to let the recipient choose'),
            channel: z.enum(VERIFICATION_CHANNEL_VALUES).optional().describe('Verification channel to use for this asset'),
            allowed_channels: z.array(z.enum(VERIFICATION_CHANNEL_VALUES)).max(10).optional().describe('Channels the recipient may choose from'),
            required: z.boolean().optional().describe('Whether this asset must be verified (default: true)'),
          }),
        )
        .min(1)
        .max(10)
        .describe('Assets to request, e.g. [{ "type": "email" }, { "type": "phone", "required": false }]'),
      reference_id: z.string().min(1).max(255).optional().describe('External reference ID for tracking'),
      public_profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('Public profile ID for branding'),
      action_type: z
        .enum(['verification', '2fa', 'login', 'custom', 'confirmation', 'authorization'])
        .optional()
        .describe('Purpose of the request (default: verification); custom and confirmation also need an action_context title'),
      action_context: z
        .object({
          title: z.string().min(1).max(100),
          description: z.string().min(1).max(500),
          amount: z.number().positive(),
          currency: z.string().min(1).max(10),
          entity: z.string().min(1).max(200),
        })
        .partial()
        .optional()
        .describe('What the recipient is shown about why the assets are needed, e.g. { "title": "Confirm your contact details" }'),
      validity_requirement: z
        .string()
        .regex(/^\d+[hdwm]$/)
        .optional()
        .describe('How recently an existing proof must have been verified for the recipient to reuse it: a number and a unit, h hours, d days, w weeks or m months (30 days), e.g. "24h", "7d", "1m"'),
      partial_ok: z.boolean().optional().describe('Whether partial asset sharing is acceptable (default: false)'),
      redirect_url: z.string().url().regex(/^https:\/\//).max(2000).optional().describe('HTTPS URL to redirect the subject after completing the request'),
      callback_url: z.string().url().regex(/^https:\/\//).max(2000).optional().describe('HTTPS webhook URL for request status updates'),
      expires_in_hours: z.number().int().min(1).max(720).optional().describe('Hours until request expires (default: 168, i.e. 7 days)'),
    },
    async (args) => {
      // The API-key route refuses these (`missing_action_context` in src/middleware/validate.ts); the
      // session route does not, and would store a request that tells the recipient nothing about what
      // they are approving. A rule across two fields, so it cannot live in the schema above.
      if ((args.action_type === 'custom' || args.action_type === 'confirmation') && !args.action_context?.title) {
        return errorResult(`missing_action_context: Action type '${args.action_type}' requires action_context with at least a title`);
      }
      try {
        const result = await http.post('/api/v1/me/verification-requests', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'claim_request_assets',
    'Claim shared assets from a completed verification request.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/claim`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'cancel_user_request',
    'Cancel a pending verification request. Only the creator can cancel.',
    {
      id: z.string().describe('Verification request ID to cancel'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/verification-requests/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'extend_request',
    'Extend the expiration time of a pending verification request.',
    {
      id: z.string().describe('Verification request ID to extend'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/extend`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'share_request_email',
    'Send an email notification to the subject of a verification request.',
    {
      id: z.string().describe('Verification request ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/me/verification-requests/${encodeURIComponent(id)}/share-email`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
