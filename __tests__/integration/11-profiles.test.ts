import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Profiles (10 tools)', () => {
  let profileId: string | undefined;

  // list_sub_accounts
  describe('list_sub_accounts', () => {
    it('lists user profiles', async () => {
      const result = await callTool('list_sub_accounts', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // create_sub_account
  describe('create_sub_account', () => {
    it('creates a profile', async () => {
      const result = await callTool('create_sub_account', {
        display_name: 'MCP Test Profile',
        bio: 'Created by integration test',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      profileId = data.id as string;
    });

    it('creates a profile with theme', async () => {
      const result = await callTool('create_sub_account', {
        display_name: 'Themed Profile',
        theme: { primary_color: '#FF5733' },
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      // Clean up extra profile
      if (data.id) await callTool('delete_sub_account', { profile_id: data.id as string });
    });
  });

  // get_sub_account
  describe('get_sub_account', () => {
    it('gets a profile by ID', async () => {
      if (!profileId) return;
      const result = await callTool('get_sub_account', { profile_id: profileId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', profileId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_sub_account', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // update_sub_account
  describe('update_sub_account', () => {
    it('updates a profile', async () => {
      if (!profileId) return;
      const result = await callTool('update_sub_account', {
        profile_id: profileId,
        bio: 'Updated by integration test',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', profileId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('update_sub_account', { profile_id: NONEXISTENT_ID, bio: 'x' });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // set_primary_sub_account
  describe('set_primary_sub_account', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('set_primary_sub_account', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // update_sub_account_page_proofs
  describe('update_sub_account_page_proofs', () => {
    it('returns error for nonexistent profile ID', async () => {
      const result = await callTool('update_sub_account_page_proofs', {
        profile_id: NONEXISTENT_ID,
        proofs: [],
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_current_sub_account
  describe('get_current_sub_account', () => {
    it('gets the current user primary profile', async () => {
      const result = await callTool('get_current_sub_account', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // update_public_page
  describe('update_public_page', () => {
    it('updates the current user primary profile', async () => {
      const result = await callTool('update_public_page', {
        bio: 'Updated via MCP integration test',
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // list_public_page_proof_options
  describe('list_public_page_proof_options', () => {
    it('gets assets available for profile display', async () => {
      const result = await callTool('list_public_page_proof_options', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // delete_sub_account (cleanup)
  describe('delete_sub_account', () => {
    it('deletes a profile', async () => {
      if (!profileId) return;
      const result = await callTool('delete_sub_account', { profile_id: profileId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_sub_account', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
