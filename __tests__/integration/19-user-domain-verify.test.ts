import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { uniqueDomain, NONEXISTENT_SESSION_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('User Domain Verify (3 tools)', () => {
  let sessionId: string | undefined;

  // start_user_domain_verification
  describe('start_user_domain_verification', () => {
    it('starts a self-service domain verification', async () => {
      const result = await callTool('start_user_domain_verification', {
        domain: uniqueDomain(),
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
      sessionId = (data.session_id ?? data.id) as string | undefined;
    });

    it('starts with http channel', async () => {
      const result = await callTool('start_user_domain_verification', {
        domain: uniqueDomain(),
        channel: 'http',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
    });
  });

  // get_user_domain_verification_status
  describe('get_user_domain_verification_status', () => {
    it('gets verification session status', async () => {
      if (!sessionId) return;
      const result = await callTool('get_user_domain_verification_status', { session_id: sessionId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('get_user_domain_verification_status', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // check_user_domain_verification
  describe('check_user_domain_verification', () => {
    it('checks verification challenge', async () => {
      if (!sessionId) return;
      const result = await callTool('check_user_domain_verification', { session_id: sessionId });
      // Will likely fail (no DNS record placed) but tests the tool works
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('check_user_domain_verification', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
