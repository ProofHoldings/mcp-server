import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Assets (3 tools)', () => {
  // list_assets
  describe('list_assets', () => {
    it('lists assets without filters', async () => {
      const result = await callTool('list_assets', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists assets with type filter', async () => {
      const result = await callTool('list_assets', { type: 'email' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists assets with status filter', async () => {
      const result = await callTool('list_assets', { status: 'active' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists assets with pagination', async () => {
      const result = await callTool('list_assets', { page: 1, limit: 5 });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // get_asset
  describe('get_asset', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_asset', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // revoke_asset
  describe('revoke_asset', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('revoke_asset', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
