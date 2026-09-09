import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('DNS Credentials (3 tools)', () => {
  let credentialId: string | undefined;

  // list_dns_credentials
  describe('list_dns_credentials', () => {
    it('lists stored DNS credentials', async () => {
      const result = await callTool('list_dns_credentials', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // create_dns_credential
  describe('create_dns_credential', () => {
    it('creates a DNS credential', async () => {
      const result = await callTool('create_dns_credential', {
        provider: 'cloudflare',
        credentials: { api_token: 'test_token_for_integration' },
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      credentialId = data.id as string;
    });
  });

  // delete_dns_credential
  describe('delete_dns_credential', () => {
    it('deletes a DNS credential', async () => {
      if (!credentialId) return;
      const result = await callTool('delete_dns_credential', { id: credentialId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_dns_credential', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
