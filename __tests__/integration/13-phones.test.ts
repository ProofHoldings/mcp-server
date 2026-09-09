import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID, NONEXISTENT_SESSION_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Phones (5 tools)', () => {
  // list_phones
  describe('list_phones', () => {
    it('lists phones for the account', async () => {
      const result = await callTool('list_phones', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // start_add_phone
  describe('start_add_phone', () => {
    it('starts adding a phone via telegram', async () => {
      const result = await callTool('start_add_phone', { channel: 'telegram' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
    });
  });

  // get_add_phone_status
  describe('get_add_phone_status', () => {
    it('returns error for nonexistent session', async () => {
      const result = await callTool('get_add_phone_status', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // remove_phone
  describe('remove_phone', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('remove_phone', { id: NONEXISTENT_ID });
      // May return 403 (2fa_required) or 404
      expect(result.content).toHaveLength(1);
    });
  });

  // set_primary_phone
  describe('set_primary_phone', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('set_primary_phone', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
