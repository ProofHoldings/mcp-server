import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';

type QueryValue = string | number | boolean | undefined;
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

/**
 * The cheapest plan that includes Lookalike Watch, as the refusal copy names it. A DELIBERATE COPY of
 * `LOOKALIKE_WATCH_FROM_PLAN` in the backend's `src/constants/plans.ts` (this package cannot import
 * backend `src/`), held equal by `src/__tests__/drift/mcp-lookalike-plan.test.ts`, so the description
 * below is derived from it rather than carrying a typed price.
 */
export const LOOKALIKE_WATCH_FROM_PLAN = '€29';

const page = {
  page: z.number().int().positive().optional().describe('Page number'),
  limit: z.number().int().min(1).max(100).optional().describe('Items per page'),
};

function pageQuery(args: { page?: number; limit?: number }): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  if (args.page !== undefined) query.page = args.page;
  if (args.limit !== undefined) query.limit = args.limit;
  return query;
}

/** Lookalike Watch (audit §5a A8, m-fix-mcp-tool-contract-drift SC-9): `/api/v1/lookalike-watch*`. */
export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'subscribe_lookalike_watch',
    `Turn on Lookalike Watch: newly published npm, PyPI, Packagist, Go module and MCP-registry artifacts are watched for names confusable with your brand tokens, with alerts and a monthly report (list_lookalike_alerts, list_lookalike_reports). Not a billed proof: no quota is charged. Lookalike Watch is part of the ${LOOKALIKE_WATCH_FROM_PLAN} plan and above (enforced while billing is live). Refused 422 when not eligible, with the reason as the code: plan_upgrade_required, no_verified_domain, no_active_delegation, delegation_sample_exhausted, account_scheduled_for_deletion, or for the delivery address notify_email_not_owned / no_notify_email; 409 when already on; 503 eligibility_unavailable means unknown, not no, so retry. Needs lookalike-watch:write on an account-wide key (a key bound to one sub-account is refused).`,
    {
      brand_tokens: z.array(z.string().min(1).max(64)).min(1).max(20).describe('The names to watch for (1-20, each up to 64 characters)'),
      owned_namespaces: z.array(z.string().min(1).max(128)).max(50).optional().describe('Namespaces you publish under yourself, so your own artifacts raise no alert (up to 50)'),
      notify_email: z.string().email().optional().describe('Where alerts go: an email address the account owns (otherwise notify_email_not_owned)'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/lookalike-watch', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_lookalike_watch',
    'Get the Lookalike Watch subscription, in the shape subscribe_lookalike_watch returned it. 404 when the account never subscribed.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/lookalike-watch');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'cancel_lookalike_watch',
    'Turn Lookalike Watch off. The subscription is kept as canceled and returned in the same shape get_lookalike_watch reads; past alerts and reports stay readable. 404 when not subscribed. Needs lookalike-watch:write on an account-wide key.',
    {},
    async () => {
      try {
        const result = await http.del('/api/v1/lookalike-watch');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_lookalike_alerts',
    'List Lookalike Watch alerts, newest first: artifacts whose names resemble one of your brand tokens, with the evidence for each. A caller who never subscribed gets an empty page, not a 404.',
    page,
    async (args) => {
      try {
        const result = await http.get('/api/v1/lookalike-watch/alerts', pageQuery(args));
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_lookalike_reports',
    'List the monthly Lookalike Watch reports, newest first. A month with no alerts still has a report, carrying the per-source coverage figures. A caller who never subscribed gets an empty page, not a 404.',
    page,
    async (args) => {
      try {
        const result = await http.get('/api/v1/lookalike-watch/reports', pageQuery(args));
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
