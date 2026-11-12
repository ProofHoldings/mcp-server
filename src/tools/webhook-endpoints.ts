import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

// Webhook endpoints (#421). Limits mirror `createWebhookEndpointSchema` / `updateWebhookEndpointSchema`
// in the backend's `src/middleware/validate.ts`. The cross-field scope rule (`selected` needs at least
// one profile id, `all` takes none) and the HTTPS / private-address checks stay server-side: a raw
// tool shape cannot carry a refinement, and the server answers `validation_error` with the reason.
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const url = z.string().url().max(2000).describe('HTTPS URL deliveries are sent to, at most 2000 characters. Private, loopback and link-local addresses are refused.');
const events = z.array(z.string()).max(32).describe('Subscription patterns (at most 32): an exact event type, a family wildcard such as "proof.*", or "*". An empty list means every event.');
const scope = z.enum(['all', 'selected']).describe('"all" serves every sub-account, present and future, plus account-level events; "selected" serves only the sub-accounts in profile_ids');
const profileIds = z.array(objectId).max(100).describe('Sub-account ids, 24 hex characters each, at most 100. At least one when scope is "selected"; none when scope is "all".');
const status = z.enum(['active', 'disabled']).describe('A disabled endpoint receives nothing');
const description = z.string().max(200).nullable().describe('Your own label for the endpoint, at most 200 characters; null clears it');

const SECRET_ONCE =
  'The response carries the endpoint\'s signing secret — this and rotate_webhook_endpoint_secret are the only times it is returned, so store it now. Deliveries carry an HMAC-SHA256 X-Proof-Signature over "<X-Proof-Timestamp>.<body>" made with it.';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_webhook_endpoints',
    'List the account\'s webhook endpoints (URL, events, scope, sub-accounts, status). Secrets are never listed. A sub-account key sees only the endpoints scoped to exactly its own sub-account.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/webhook-endpoints');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_webhook_endpoint',
    'Get one webhook endpoint by ID. The signing secret is not returned (only create_webhook_endpoint and rotate_webhook_endpoint_secret return it).',
    {
      id: objectId.describe('Webhook endpoint ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'create_webhook_endpoint',
    `Add a webhook endpoint. An event reaches every active endpoint whose scope includes the event's sub-account and whose events match; an account-level event reaches "all"-scope endpoints only. An account still delivering to the single webhook URL in its settings is moved onto endpoints by this call (that URL becomes an "all"-scope endpoint with the same secret and events). ${SECRET_ONCE}`,
    {
      url,
      events: events.optional(),
      scope,
      profile_ids: profileIds.optional(),
      status: status.optional(),
      description: description.optional(),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/webhook-endpoints', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'update_webhook_endpoint',
    'Update a webhook endpoint: its URL, events, scope, sub-accounts, status or description. Every field is optional, but send at least one. Changing the scope to "selected" without profile_ids keeps the stored list. The signing secret is unchanged (rotate it with rotate_webhook_endpoint_secret).',
    {
      id: objectId.describe('Webhook endpoint ID'),
      url: url.optional(),
      events: events.optional(),
      scope: scope.optional(),
      profile_ids: profileIds.optional(),
      status: status.optional(),
      description: description.optional(),
    },
    async ({ id, ...body }) => {
      try {
        const result = await http.patch(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'delete_webhook_endpoint',
    'Delete a webhook endpoint. It receives no new events; deliveries already queued to it are still attempted, signed with the secret they were queued with. Cannot be undone.',
    {
      id: objectId.describe('Webhook endpoint ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'rotate_webhook_endpoint_secret',
    'Replace a webhook endpoint\'s signing secret and return the new one — this and create_webhook_endpoint are the only times a secret is returned, so store it now. New deliveries are signed with the new secret; deliveries already queued keep the secret they were queued with.',
    {
      id: objectId.describe('Webhook endpoint ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
