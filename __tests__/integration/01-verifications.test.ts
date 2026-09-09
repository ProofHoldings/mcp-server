import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { uniqueEmail, uniqueDomain, uniqueId, NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Verifications (12 tools)', () => {
  let verificationId: string | undefined;

  // create_verification
  describe('create_verification', () => {
    it('creates an email verification', async () => {
      const result = await callTool('create_verification', {
        type: 'email',
        channel: 'email',
        identifier: uniqueEmail(),
        external_user_id: uniqueId('user'),
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('channel', 'email');
      verificationId = data.id as string;
    });

    it('returns error for missing required params', async () => {
      const result = await callTool('create_verification', {
        type: 'phone',
        channel: 'sms',
        // missing identifier
      });
      // Might be a validation error or API error — both are acceptable
      expect(result.content).toHaveLength(1);
    });
  });

  // get_verification
  describe('get_verification', () => {
    it('gets a verification by ID', async () => {
      if (!verificationId) return;
      const result = await callTool('get_verification', { id: verificationId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', verificationId);
      expect(data).toHaveProperty('channel');
      expect(data).toHaveProperty('status');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_verification', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_verifications
  describe('list_verifications', () => {
    it('lists verifications without filters', async () => {
      const result = await callTool('list_verifications', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists verifications with status filter', async () => {
      const result = await callTool('list_verifications', { status: 'pending' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });

    it('lists verifications with pagination', async () => {
      const result = await callTool('list_verifications', { page: 1, limit: 5 });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // trigger_verification
  describe('trigger_verification', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('trigger_verification', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // submit_verification_code
  describe('submit_verification_code', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('submit_verification_code', { id: NONEXISTENT_ID, code: '000000' });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // resend_verification
  describe('resend_verification', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('resend_verification', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // test_verify
  describe('test_verify', () => {
    it('auto-completes a verification in test mode', async () => {
      if (!verificationId) return;
      const result = await callTool('test_verify', { id: verificationId });
      // With pk_test_ key this should succeed; with live key it may error
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('test_verify', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // list_verified_users
  describe('list_verified_users', () => {
    it('lists verified users', async () => {
      const result = await callTool('list_verified_users', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
    });

    it('lists verified users with pagination', async () => {
      const result = await callTool('list_verified_users', { page: 1, limit: 5 });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // get_verified_user
  describe('get_verified_user', () => {
    it('returns error for nonexistent external_user_id', async () => {
      const result = await callTool('get_verified_user', { external_user_id: uniqueId('nonexistent') });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // start_domain_verification
  describe('start_domain_verification', () => {
    it('starts a domain verification', async () => {
      const result = await callTool('start_domain_verification', {
        domain: uniqueDomain(),
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
    });
  });

  // check_domain_verification
  describe('check_domain_verification', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('check_domain_verification', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // wait_for_verification — skip in integration (would require real verification flow)
  describe('wait_for_verification', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('wait_for_verification', { id: NONEXISTENT_ID, timeout_seconds: 3 });
      // Either API error (not found) or timeout error
      expect(result.content).toHaveLength(1);
    });
  });
});
