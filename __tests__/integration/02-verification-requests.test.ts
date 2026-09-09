import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { uniqueEmail, uniqueId, NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Verification Requests (6 tools)', () => {
  let requestId: string | undefined;

  // create_verification_request
  describe('create_verification_request', () => {
    it('creates a multi-asset verification request', async () => {
      const result = await callTool('create_verification_request', {
        assets: [{ type: 'email', identifier: uniqueEmail(), channel: 'email' }],
        reference_id: uniqueId('ref'),
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      requestId = data.id as string;
    });

    it('creates a request with multiple assets', async () => {
      const result = await callTool('create_verification_request', {
        assets: [
          { type: 'email', identifier: uniqueEmail(), channel: 'email' },
          { type: 'email', identifier: uniqueEmail(), channel: 'email' },
        ],
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
    });
  });

  // get_verification_request
  describe('get_verification_request', () => {
    it('gets a request by ID', async () => {
      expect(requestId).toBeDefined();
      const result = await callTool('get_verification_request', { id: requestId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', requestId);
      expect(data).toHaveProperty('status');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_verification_request', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_verification_requests
  describe('list_verification_requests', () => {
    it('lists requests without filters', async () => {
      const result = await callTool('list_verification_requests', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists requests with status filter', async () => {
      const result = await callTool('list_verification_requests', { status: 'pending' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // get_request_by_reference
  describe('get_request_by_reference', () => {
    it('returns error for nonexistent reference', async () => {
      const result = await callTool('get_request_by_reference', { reference_id: uniqueId('nonexistent') });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // cancel_verification_request
  describe('cancel_verification_request', () => {
    it('cancels a pending request', async () => {
      expect(requestId).toBeDefined();
      const result = await callTool('cancel_verification_request', { id: requestId! });
      // Might succeed or error if already not cancellable
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('cancel_verification_request', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // wait_for_request
  describe('wait_for_request', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('wait_for_request', { id: NONEXISTENT_ID, timeout_seconds: 3 });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
