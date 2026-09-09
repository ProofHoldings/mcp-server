import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult, credentialsSchema } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'list_dns_credentials',
    'List all stored DNS provider credentials for the authenticated account. Returns credential metadata (not secret values).',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/dns-credentials');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_dns_credential',
    'Store DNS provider credentials for automated domain verification. Note: credentials will be visible in the AI conversation context.',
    {
      provider: z.string().min(1).max(50).describe('DNS provider identifier (e.g. cloudflare, route53, digitalocean)'),
      credentials: credentialsSchema,
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/dns-credentials', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_dns_credential',
    'Delete a stored DNS provider credential. Domains using this credential will need new credentials for automated verification.',
    {
      id: z.string().describe('DNS credential ID to delete'),
    },
    async ({ id }) => {
      try {
        const result = await http.del(`/api/v1/me/dns-credentials/${encodeURIComponent(id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
