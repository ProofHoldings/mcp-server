import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Profiles (10 tools)', () => {
  let profileId: string | undefined;

  // list_profiles
  describe('list_profiles', () => {
    it('lists user profiles', async () => {
      const result = await callTool('list_profiles', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // create_profile
  describe('create_profile', () => {
    it('creates a profile', async () => {
      const result = await callTool('create_profile', {
        display_name: 'MCP Test Profile',
        bio: 'Created by integration test',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      profileId = data.id as string;
    });

    it('creates a profile with theme', async () => {
      const result = await callTool('create_profile', {
        display_name: 'Themed Profile',
        theme: { primary_color: '#FF5733' },
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      // Clean up extra profile
      if (data.id) await callTool('delete_profile', { profile_id: data.id as string });
    });
  });

  // get_profile
  describe('get_profile', () => {
    it('gets a profile by ID', async () => {
      if (!profileId) return;
      const result = await callTool('get_profile', { profile_id: profileId });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', profileId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_profile', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // update_profile
  describe('update_profile', () => {
    it('updates a profile', async () => {
      if (!profileId) return;
      const result = await callTool('update_profile', {
        profile_id: profileId,
        bio: 'Updated by integration test',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', profileId);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('update_profile', { profile_id: NONEXISTENT_ID, bio: 'x' });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // set_primary_profile
  describe('set_primary_profile', () => {
    it('returns error for nonexistent ID', async () => {
      const result = await callTool('set_primary_profile', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // update_profile_proofs
  describe('update_profile_proofs', () => {
    it('returns error for nonexistent profile ID', async () => {
      const result = await callTool('update_profile_proofs', {
        profile_id: NONEXISTENT_ID,
        proofs: [],
      });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });

  // get_my_profile
  describe('get_my_profile', () => {
    it('gets the current user primary profile', async () => {
      const result = await callTool('get_my_profile', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // update_my_profile
  describe('update_my_profile', () => {
    it('updates the current user primary profile', async () => {
      const result = await callTool('update_my_profile', {
        bio: 'Updated via MCP integration test',
      });
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // get_profile_assets
  describe('get_profile_assets', () => {
    it('gets assets available for profile display', async () => {
      const result = await callTool('get_profile_assets', {});
      const data = parseJsonResult(result);
      expect(data).toBeDefined();
    });
  });

  // delete_profile (cleanup)
  describe('delete_profile', () => {
    it('deletes a profile', async () => {
      if (!profileId) return;
      const result = await callTool('delete_profile', { profile_id: profileId });
      expect(result.content).toHaveLength(1);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_profile', { profile_id: NONEXISTENT_ID });
      const msg = parseErrorResult(result);
      expect(msg).toBeTruthy();
    });
  });
});
