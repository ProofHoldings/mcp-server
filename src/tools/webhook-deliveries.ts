import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_webhook_stats',
    'Get webhook delivery statistics including total deliveries, success/failure counts, and recent activity.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/webhook-deliveries/stats');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'list_webhook_deliveries',
    'List webhook delivery attempts with pagination and filtering. Shows delivery status, response codes, and timestamps.',
    {
      status: z.enum(['pending', 'success', 'failed']).optional().describe('Filter by delivery status'),
      event_type: z.string().optional().describe('Filter by event type (e.g. verification.completed)'),
      page: z.number().int().positive().optional().describe('Page number'),
      limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.status !== undefined) query.status = args.status;
        if (args.event_type !== undefined) query.event_type = args.event_type;
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/webhook-deliveries', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_webhook_delivery',
    'Get details of a single webhook delivery attempt including request/response payloads and retry history.',
    {
      id: z.string().describe('Webhook delivery ID'),
    },
    async ({ id }) => {
      try {
        const result = await http.get(`/api/v1/webhook-deliveries/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'retry_webhook_delivery',
    'Retry a failed webhook delivery. Creates a new delivery attempt with the same payload to the configured endpoint.',
    {
      id: z.string().describe('Webhook delivery ID to retry'),
    },
    async ({ id }) => {
      try {
        const result = await http.post(`/api/v1/webhook-deliveries/${encodeURIComponent(id)}/retry`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
