import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_SESSION_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Auth (3 tools)', () => {
  // get_current_user
  describe('get_current_user', () => {
    it('returns the authenticated user', async () => {
      const result = await callTool('get_current_user', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
      // Should have user properties
      expect(typeof data).toBe('object');
    });
  });

  // list_auth_sessions
  describe('list_auth_sessions', () => {
    it('lists active auth sessions', async () => {
      const result = await callTool('list_auth_sessions', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // revoke_auth_session
  describe('revoke_auth_session', () => {
    it('returns error for nonexistent session', async () => {
      const result = await callTool('revoke_auth_session', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
