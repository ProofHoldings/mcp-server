import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Confirmations (3 tools)', () => {
  let hitlId: string | undefined;
  let confirmationId: string | undefined;

  // Setup: create a HITL config to use for confirmations
  beforeAll(async () => {
    const result = await callTool('create_hitl', {
      name: 'Confirmation Test HITL',
      channels: [{ type: 'telegram', config: { chat_id: '123456789' } }],
    });
    const data = parseJsonResult(result) as Record<string, unknown>;
    hitlId = data.id as string;
  });

  // Cleanup: archive the HITL config
  afterAll(async () => {
    if (hitlId) {
      await callTool('delete_hitl', { id: hitlId });
    }
  });

  // create_confirmation
  describe('create_confirmation', () => {
    it('creates a confirmation request', async () => {
      expect(hitlId).toBeDefined();
      const result = await callTool('create_confirmation', {
        hitl_id: hitlId!,
        message: 'Approve this integration test?',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status', 'pending');
      expect(data).toHaveProperty('hitl_id', hitlId);
      confirmationId = data.id as string;
    });

    it('returns error for nonexistent HITL ID', async () => {
      const result = await callTool('create_confirmation', {
        hitl_id: NONEXISTENT_ID,
        message: 'Should fail',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_confirmation
  describe('get_confirmation', () => {
    it('gets a confirmation by ID', async () => {
      expect(confirmationId).toBeDefined();
      const result = await callTool('get_confirmation', { id: confirmationId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', confirmationId);
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('message', 'Approve this integration test?');
      expect(data).toHaveProperty('hitl_id', hitlId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_confirmation', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_confirmations
  describe('list_confirmations', () => {
    it('lists confirmations without filters', async () => {
      const result = await callTool('list_confirmations', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data).toHaveProperty('pagination');
    });

    it('lists confirmations with status filter', async () => {
      const result = await callTool('list_confirmations', { status: 'pending' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists confirmations filtered by HITL ID', async () => {
      expect(hitlId).toBeDefined();
      const result = await callTool('list_confirmations', { hitl_id: hitlId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      const items = data.data as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });
});
