import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'get_subscription',
    'Get the current subscription details including plan, status, billing period, and usage limits.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/billing/subscription');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_balance',
    'Get the prepaid balance (in euro cents and mills), the low-balance threshold, the top-up amounts on offer and the auto top-up setting. Proofs past the plan\'s included amount are drawn from this balance; once billing is live, an account whose balance is at or below zero is refused new proof requests (402 balance_empty) until it tops up. billing_enabled says whether billing is live. Topping up and changing auto top-up are done by the owner in the dashboard, on the Billing page (https://proof.holdings/billing).',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/billing/balance');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_balance_ledger',
    'List the prepaid balance history, newest first: every top-up, refund and adjustment, and one usage row per month for that month\'s deductions. Amounts are signed euro cents (credits positive).',
    {
      page: z.number().int().positive().max(10000).optional().describe('Page number (default 1)'),
      limit: z.number().int().min(1).max(100).optional().describe('Rows per page (default 20, max 100)'),
    },
    async (args) => {
      try {
        const query: Record<string, number> = {};
        if (args.page !== undefined) query.page = args.page;
        if (args.limit !== undefined) query.limit = args.limit;
        const result = await http.get('/api/v1/billing/balance/ledger', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
