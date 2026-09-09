import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Webhook Deliveries (4 tools)', () => {
  // get_webhook_stats
  describe('get_webhook_stats', () => {
    it('returns webhook delivery statistics', async () => {
      const result = await callTool('get_webhook_stats', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // list_webhook_deliveries
  describe('list_webhook_deliveries', () => {
    it('lists deliveries without filters', async () => {
      const result = await callTool('list_webhook_deliveries', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists deliveries with status filter', async () => {
      const result = await callTool('list_webhook_deliveries', { status: 'success' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists deliveries with pagination', async () => {
      const result = await callTool('list_webhook_deliveries', { page: 1, limit: 5 });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // get_webhook_delivery
  describe('get_webhook_delivery', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_webhook_delivery', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // retry_webhook_delivery
  describe('retry_webhook_delivery', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('retry_webhook_delivery', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
