import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID, INVALID_TOKEN } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Proofs (4 tools)', () => {
  // validate_proof
  describe('validate_proof', () => {
    it('rejects an invalid proof token', async () => {
      const result = await callTool('validate_proof', { proof_token: INVALID_TOKEN });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });

    it('rejects an invalid token with identifier check', async () => {
      const result = await callTool('validate_proof', {
        proof_token: INVALID_TOKEN,
        identifier: 'test@example.com',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_proof_status
  describe('get_proof_status', () => {
    it('returns error for nonexistent verification ID', async () => {
      const result = await callTool('get_proof_status', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // revoke_proof
  describe('revoke_proof', () => {
    it('returns error for nonexistent verification ID', async () => {
      const result = await callTool('revoke_proof', { id: NONEXISTENT_ID, reason: 'test' });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_revoked_proofs
  describe('list_revoked_proofs', () => {
    it('returns the revocation list', async () => {
      const result = await callTool('list_revoked_proofs', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      // Returns a signed revocation list
      expect(data).toBeDefined();
    });
  });
});
