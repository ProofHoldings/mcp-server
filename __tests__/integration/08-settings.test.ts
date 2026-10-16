import { connectClient, disconnectClient, callTool, parseJsonResult } from './helpers/mcp-client.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Settings (4 tools)', () => {
  // get_usage
  describe('get_usage', () => {
    it('returns usage metrics', async () => {
      const result = await callTool('get_usage', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });

    it('returns usage for a specific period', async () => {
      const result = await callTool('get_usage', { period: '2026-01' });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });

    it('returns usage history for multiple months', async () => {
      const result = await callTool('get_usage', { months: 3 });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // get_settings
  describe('get_settings', () => {
    it('returns account settings', async () => {
      const result = await callTool('get_settings', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // update_settings
  describe('update_settings', () => {
    // Branding is no longer an account setting (h-subaccount-branding-per-project), so this writes
    // the default proof lifetime back as it found it rather than changing anything.
    it('writes the default proof lifetime back unchanged', async () => {
      const current = parseJsonResult(await callTool('get_settings', {})) as { proof_expiry_days?: number | null };
      const result = await callTool(
        'update_settings',
        current.proof_expiry_days ? { proof_expiry_days: current.proof_expiry_days } : {},
      );
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // export_data
  describe('export_data', () => {
    it('exports account data', async () => {
      const result = await callTool('export_data', {});
      // May succeed or return rate-limit error (1 per 24h)
      expect(result.content).toHaveLength(1);
    });
  });
});
