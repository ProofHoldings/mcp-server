import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Assets (3 tools)', () => {
  // list_my_proofs
  describe('list_my_proofs', () => {
    it('lists assets without filters', async () => {
      const result = await callTool('list_my_proofs', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists assets with type filter', async () => {
      const result = await callTool('list_my_proofs', { type: 'email' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists assets with status filter', async () => {
      const result = await callTool('list_my_proofs', { status: 'active' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists assets with pagination', async () => {
      const result = await callTool('list_my_proofs', { page: 1, limit: 5 });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // get_my_proof
  describe('get_my_proof', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_my_proof', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // revoke_my_proof
  describe('revoke_my_proof', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('revoke_my_proof', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
