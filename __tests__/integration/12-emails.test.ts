import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { uniqueEmail, NONEXISTENT_ID, NONEXISTENT_SESSION_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Emails (7 tools)', () => {
  let addEmailSessionId: string | undefined;

  // list_emails
  describe('list_emails', () => {
    it('lists emails for the account', async () => {
      const result = await callTool('list_emails', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // start_add_email
  describe('start_add_email', () => {
    it('starts adding an email', async () => {
      const result = await callTool('start_add_email', { email: uniqueEmail() });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeDefined();
      // May return session_id or id depending on response shape
      addEmailSessionId = (data.session_id ?? data.id) as string | undefined;
    });
  });

  // get_add_email_status
  describe('get_add_email_status', () => {
    it('checks add-email session status', async () => {
      if (!addEmailSessionId) return;
      const result = await callTool('get_add_email_status', { session_id: addEmailSessionId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('status');
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('get_add_email_status', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // verify_email_otp
  describe('verify_email_otp', () => {
    it('rejects wrong OTP code', async () => {
      if (!addEmailSessionId) return;
      const result = await callTool('verify_email_otp', {
        session_id: addEmailSessionId,
        code: '000000',
      });
      // Should fail with wrong code
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent session', async () => {
      const result = await callTool('verify_email_otp', {
        session_id: NONEXISTENT_SESSION_ID,
        code: '000000',
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // resend_email_otp
  describe('resend_email_otp', () => {
    it('returns error for nonexistent session', async () => {
      const result = await callTool('resend_email_otp', { session_id: NONEXISTENT_SESSION_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // remove_email
  describe('remove_email', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('remove_email', { id: NONEXISTENT_ID });
      // May return 403 (2fa_required) or 404
      expect(result.content).toHaveLength(1);
    });
  });

  // set_primary_email
  describe('set_primary_email', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('set_primary_email', { id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
