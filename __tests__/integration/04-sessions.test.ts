import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Sessions (3 tools)', () => {
  let sessionId: string | undefined;

  // create_session
  describe('create_session', () => {
    it('creates a phone verification session', async () => {
      const result = await callTool('create_session', {
        channel: 'sms',
        phone_number: '+15555550100',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      sessionId = data.id as string;
    });

    it('creates a session with metadata', async () => {
      const result = await callTool('create_session', {
        channel: 'sms',
        phone_number: '+15555550101',
        external_user_id: 'test-user-1',
        metadata: { source: 'integration-test' },
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
    });
  });

  // get_session
  describe('get_session', () => {
    it('gets a session by ID', async () => {
      if (!sessionId) return;
      const result = await callTool('get_session', { id: sessionId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', sessionId);
      expect(data).toHaveProperty('status');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_session', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // wait_for_session
  describe('wait_for_session', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('wait_for_session', { id: NONEXISTENT_ID, timeout_seconds: 3 });
      expect(result.content).toHaveLength(1);
    });
  });
});
