import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('HITL (5 tools)', () => {
  let hitlId: string | undefined;

  // create_hitl
  describe('create_hitl', () => {
    it('creates a HITL config', async () => {
      const result = await callTool('create_hitl', {
        name: 'Integration Test HITL',
        channels: [{ type: 'telegram', config: { chat_id: '123456789' } }],
        timeout_seconds: 1800,
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status', 'active');
      expect(data).toHaveProperty('name', 'Integration Test HITL');
      expect(data).toHaveProperty('channels');
      hitlId = data.id as string;
    });

    it('creates a HITL config without optional name', async () => {
      const result = await callTool('create_hitl', {
        channels: [{ type: 'whatsapp', config: { phone_number: '+15551234567' } }],
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status', 'active');
      // Clean up
      if (data.id) {
        await callTool('delete_hitl', { id: data.id as string });
      }
    });
  });

  // get_hitl
  describe('get_hitl', () => {
    it('gets a HITL config by ID', async () => {
      expect(hitlId).toBeDefined();
      const result = await callTool('get_hitl', { id: hitlId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', hitlId);
      expect(data).toHaveProperty('name', 'Integration Test HITL');
      expect(data).toHaveProperty('channels');
      expect(data).toHaveProperty('timeout_seconds');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_hitl', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_hitls
  describe('list_hitls', () => {
    it('lists HITL configs without filters', async () => {
      const result = await callTool('list_hitls', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data).toHaveProperty('pagination');
    });

    it('lists HITL configs with status filter', async () => {
      const result = await callTool('list_hitls', { status: 'active' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // update_hitl
  describe('update_hitl', () => {
    it('updates a HITL config', async () => {
      expect(hitlId).toBeDefined();
      const result = await callTool('update_hitl', {
        id: hitlId!,
        name: 'Updated HITL Name',
        timeout_seconds: 900,
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', hitlId);
      expect(data).toHaveProperty('name', 'Updated HITL Name');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('update_hitl', {
        id: NONEXISTENT_ID,
        name: 'Should fail',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // delete_hitl
  describe('delete_hitl', () => {
    it('archives a HITL config', async () => {
      expect(hitlId).toBeDefined();
      const result = await callTool('delete_hitl', { id: hitlId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', hitlId);
      expect(data).toHaveProperty('status', 'archived');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_hitl', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
