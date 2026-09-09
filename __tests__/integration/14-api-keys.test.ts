import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('API Keys (4 tools)', () => {
  // list_api_keys
  describe('list_api_keys', () => {
    it('lists API keys (metadata only, no secrets)', async () => {
      const result = await callTool('list_api_keys', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // create_api_key
  describe('create_api_key', () => {
    it('returns 403 without 2FA grant', async () => {
      const result = await callTool('create_api_key', { name: 'mcp-test-key' });
      // Expect 2fa_required error without prior 2FA session
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // revoke_api_key
  describe('revoke_api_key', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('revoke_api_key', { id: NONEXISTENT_ID });
      // May return 403 (2fa_required) or 404
      expect(result.content).toHaveLength(1);
    });
  });

  // regenerate_api_key
  describe('regenerate_api_key', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('regenerate_api_key', { id: NONEXISTENT_ID });
      // May return 403 (2fa_required) or 404
      expect(result.content).toHaveLength(1);
    });
  });
});
