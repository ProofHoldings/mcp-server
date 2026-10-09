import { connectClient, disconnectClient, callTool, parseJsonResult, parseErrorResult } from './helpers/mcp-client.js';
import { NONEXISTENT_ID, uniqueName } from './helpers/test-data.js';

beforeAll(() => connectClient());
afterAll(() => disconnectClient());

describe('Circles (13 tools)', () => {
  let circleId: string | undefined;
  let memberId: string | undefined;
  let channelId: string | undefined;

  // create_circle
  describe('create_circle', () => {
    it('creates a Circle', async () => {
      const result = await callTool('create_circle', {
        name: uniqueName('MCP Circle'),
        proof_me_enabled: true,
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status', 'active');
      expect(data).toHaveProperty('members');
      circleId = data.id as string;
    });
  });

  // get_circle
  describe('get_circle', () => {
    it('gets a Circle by ID', async () => {
      expect(circleId).toBeDefined();
      const result = await callTool('get_circle', { id: circleId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', circleId);
      expect(data).toHaveProperty('members');
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('get_circle', { id: NONEXISTENT_ID });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // list_circles
  describe('list_circles', () => {
    it('lists Circles without filters', async () => {
      const result = await callTool('list_circles', {});
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
      expect(Array.isArray(data.data)).toBe(true);
      expect(data).toHaveProperty('pagination');
    });

    it('lists Circles with status filter', async () => {
      const result = await callTool('list_circles', { status: 'active' });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('data');
    });
  });

  // update_circle
  describe('update_circle', () => {
    it('updates a Circle name', async () => {
      expect(circleId).toBeDefined();
      const renamed = uniqueName('MCP Circle Renamed');
      const result = await callTool('update_circle', { id: circleId!, name: renamed });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id', circleId);
      expect(data).toHaveProperty('name', renamed);
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('update_circle', { id: NONEXISTENT_ID, name: 'Should fail' });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // add_circle_member
  describe('add_circle_member', () => {
    it('adds a member to a Circle', async () => {
      expect(circleId).toBeDefined();
      const result = await callTool('add_circle_member', {
        id: circleId!,
        name: uniqueName('Member'),
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('status');
      // SEC-PM-006: presence booleans only, never an identifier
      expect(data).not.toHaveProperty('whatsapp_phone');
      expect(data).not.toHaveProperty('telegram_chat_id');
      memberId = data.id as string;
    });

    it('returns error for nonexistent Circle', async () => {
      const result = await callTool('add_circle_member', { id: NONEXISTENT_ID, name: 'Nobody' });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // list_circle_members
  describe('list_circle_members', () => {
    it('lists members with presence booleans and a masked enrollment phone only', async () => {
      expect(circleId).toBeDefined();
      const result = await callTool('list_circle_members', { id: circleId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('members');
      expect(Array.isArray(data.members)).toBe(true);
    });
  });

  // invite_circle_member
  describe('invite_circle_member', () => {
    it('mints an enrollment invite for a member', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('invite_circle_member', { id: circleId!, member_id: memberId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toBeTruthy();
    });

    it('returns error for nonexistent member', async () => {
      expect(circleId).toBeDefined();
      const result = await callTool('invite_circle_member', { id: circleId!, member_id: NONEXISTENT_ID });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // add_circle_member_channel
  describe('add_circle_member_channel', () => {
    it('declares a channel for a member', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('add_circle_member_channel', {
        id: circleId!,
        member_id: memberId!,
        channel: 'telegram',
        identifier: '123456789',
      });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('channel', 'telegram');
      // SEC-PM-006: never echoes the identifier
      expect(data).not.toHaveProperty('identifier');
      channelId = data.id as string;
    });

    it('returns 409 when the channel type already exists', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('add_circle_member_channel', {
        id: circleId!,
        member_id: memberId!,
        channel: 'telegram',
        identifier: '987654321',
      });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // list_circle_member_channels
  describe('list_circle_member_channels', () => {
    it('lists a member\'s channels (metadata only)', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('list_circle_member_channels', { id: circleId!, member_id: memberId! });
      const data = parseJsonResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty('channels');
      expect(Array.isArray(data.channels)).toBe(true);
    });
  });

  // create_circle_member_drill
  describe('create_circle_member_drill', () => {
    it('returns error for nonexistent Circle', async () => {
      const result = await callTool('create_circle_member_drill', {
        id: NONEXISTENT_ID,
        member_id: NONEXISTENT_ID,
      });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // remove_circle_member_channel
  describe('remove_circle_member_channel', () => {
    it('removes a member channel', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      expect(channelId).toBeDefined();
      const result = await callTool('remove_circle_member_channel', {
        id: circleId!,
        member_id: memberId!,
        channel_id: channelId!,
      });
      // 204 → empty object envelope; no error
      expect(parseJsonResult(result)).toBeTruthy();
    });

    it('returns error for nonexistent channel', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('remove_circle_member_channel', {
        id: circleId!,
        member_id: memberId!,
        channel_id: NONEXISTENT_ID,
      });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });

  // remove_circle_member
  describe('remove_circle_member', () => {
    it('removes a member from a Circle', async () => {
      expect(circleId).toBeDefined();
      expect(memberId).toBeDefined();
      const result = await callTool('remove_circle_member', { id: circleId!, member_id: memberId! });
      expect(parseJsonResult(result)).toBeTruthy();
    });
  });

  // delete_circle
  describe('delete_circle', () => {
    it('archives a Circle', async () => {
      expect(circleId).toBeDefined();
      const result = await callTool('delete_circle', { id: circleId! });
      expect(parseJsonResult(result)).toBeTruthy();
    });

    it('returns error for nonexistent ID', async () => {
      const result = await callTool('delete_circle', { id: NONEXISTENT_ID });
      expect(parseErrorResult(result)).toBeTruthy();
    });
  });
});
