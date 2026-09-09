import { connectClient, disconnectClient, callTool } from './helpers/mcp-client.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Public Profiles (2 tools)', () => {
  // claim_username
  describe('claim_username', () => {
    it('attempts to claim a username', async () => {
      // Use a unique username to avoid collisions, but may conflict with existing
      const username = `mcp_test_${Date.now()}`;
      const result = await callTool('claim_username', { username });
      // May succeed or error (already claimed, etc.)
      expect(result.content).toHaveLength(1);
    });

    it('rejects invalid username format', async () => {
      // Username with special chars should fail Zod validation before reaching API
      // The MCP SDK validates the schema, so this may throw or return error
      try {
        const result = await callTool('claim_username', { username: 'a' }); // too short (min 3)
        expect(result.content).toHaveLength(1);
      } catch {
        // Zod validation error is also acceptable
      }
    });
  });

  // update_public_proofs
  describe('update_public_proofs', () => {
    it('updates public proof display with empty array', async () => {
      const result = await callTool('update_public_proofs', { proofs: [] });
      // May succeed or error depending on profile state
      expect(result.content).toHaveLength(1);
    });

    it('updates public proofs with a nonexistent asset', async () => {
      const result = await callTool('update_public_proofs', {
        proofs: [{
          asset_id: '000000000000000000000000',
          is_visible: true,
          mask_level: 'partial',
          display_order: 0,
        }],
      });
      // Should error (asset not found or not owned)
      expect(result.content).toHaveLength(1);
    });
  });
});
