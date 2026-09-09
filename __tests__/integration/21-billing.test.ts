import { connectClient, disconnectClient, callTool, parseJsonResult } from './helpers/mcp-client.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Billing (1 tool)', () => {
  // get_subscription
  describe('get_subscription', () => {
    it('returns subscription details', async () => {
      const result = await callTool('get_subscription', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });
});
