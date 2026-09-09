import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Authorizations (5 tools)', () => {
  let authorizationId: string | undefined;

  // create_authorization
  describe('create_authorization', () => {
    it('creates an authorization request', async () => {
      const result = await callTool('create_authorization', {
        phone: '+15551234567',
        channel: 'email',
        business_name: 'Integration Test Corp',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('authorization_url');
      authorizationId = data.id as string;
    });

    it('returns error for invalid phone format', async () => {
      const result = await callTool('create_authorization', {
        phone: 'not-a-phone',
        channel: 'whatsapp',
        business_name: 'Test',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_authorization
  describe('get_authorization', () => {
    it('gets an authorization by ID', async () => {
      expect(authorizationId).toBeDefined();
      const result = await callTool('get_authorization', { id: authorizationId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', authorizationId);
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('phone');
      expect(data).toHaveProperty('channel');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_authorization', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_authorizations
  describe('list_authorizations', () => {
    it('lists authorizations without filters', async () => {
      const result = await callTool('list_authorizations', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data).toHaveProperty('pagination');
    });

    it('lists authorizations with status filter', async () => {
      const result = await callTool('list_authorizations', { status: 'pending' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // export_authorizations
  describe('export_authorizations', () => {
    it('exports authorizations as JSON', async () => {
      const result = await callTool('export_authorizations', { format: 'json' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('total');
    });
  });

  // revoke_authorization
  describe('revoke_authorization', () => {
    it('revokes an authorization', async () => {
      expect(authorizationId).toBeDefined();
      const result = await callTool('revoke_authorization', {
        id: authorizationId!,
        reason: 'Integration test cleanup',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', authorizationId);
      expect(data).toHaveProperty('status', 'revoked');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('revoke_authorization', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
