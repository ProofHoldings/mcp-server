import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('User Requests (7 tools)', () => {
  let requestId: string | undefined;

  // list_my_requests
  describe('list_my_requests', () => {
    it('lists outgoing user requests', async () => {
      const result = await callTool('list_my_requests', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // list_incoming_requests
  describe('list_incoming_requests', () => {
    it('lists incoming user requests', async () => {
      const result = await callTool('list_incoming_requests', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // create_user_request
  describe('create_user_request', () => {
    it('creates a verification request', async () => {
      const result = await callTool('create_user_request', {
        assets: ['email'],
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      requestId = data.id as string;
    });

    it('creates a request with options', async () => {
      const result = await callTool('create_user_request', {
        assets: ['email', 'phone'],
        action_type: 'verification',
        expires_in_hours: 48,
        partial_ok: true,
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      // Clean up
      if (data.id) await callTool('cancel_user_request', { id: data.id as string });
    });
  });

  // claim_request_assets
  describe('claim_request_assets', () => {
    it('returns error for nonexistent request', async () => {
      const result = await callTool('claim_request_assets', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // extend_request
  describe('extend_request', () => {
    it('extends a request expiration', async () => {
      if (!requestId) return;
      const result = await callTool('extend_request', { id: requestId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent request', async () => {
      const result = await callTool('extend_request', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // share_request_email
  describe('share_request_email', () => {
    it('returns error for nonexistent request', async () => {
      const result = await callTool('share_request_email', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // cancel_user_request (cleanup)
  describe('cancel_user_request', () => {
    it('cancels a request', async () => {
      if (!requestId) return;
      const result = await callTool('cancel_user_request', { id: requestId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent request', async () => {
      const result = await callTool('cancel_user_request', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
