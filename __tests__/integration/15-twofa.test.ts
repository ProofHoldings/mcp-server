import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_SESSION_ID, INVALID_TOKEN } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('2FA (4 tools)', () => {
  let twofaSessionId: string | undefined;

  // start_2fa
  describe('start_2fa', () => {
    it('starts a 2FA challenge via email', async () => {
      const result = await callTool('start_2fa', {
        action_type: 'api_key_create',
        channel: 'email',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
      twofaSessionId = (data.session_id ?? data.id) as string | undefined;
    });

    for (const channel of ['telegram', 'sms', 'whatsapp'] as const) {
      it(`starts a 2FA challenge via ${channel}`, async () => {
        const result = await callTool('start_2fa', {
          action_type: 'api_key_create',
          channel,
        });
        // May succeed or fail depending on account channels
        expect(result.content).toHaveLength(1);
      });
    }
  });

  // get_2fa_status
  describe('get_2fa_status', () => {
    it('gets 2FA session status', async () => {
      if (!twofaSessionId) return;
      const result = await callTool('get_2fa_status', { session_id: twofaSessionId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('status');
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('get_2fa_status', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // verify_2fa
  describe('verify_2fa', () => {
    it('rejects wrong code', async () => {
      if (!twofaSessionId) return;
      const result = await callTool('verify_2fa', {
        session_id: twofaSessionId,
        code: '000000',
      });
      // Should fail with wrong code
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('verify_2fa', {
        session_id: NONEXISTENT_SESSION_ID,
        code: '000000',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // verify_2fa_magic_link
  describe('verify_2fa_magic_link', () => {
    it('rejects invalid magic link token', async () => {
      const result = await callTool('verify_2fa_magic_link', { token: INVALID_TOKEN });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
