import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { HttpClient, ApiError } from '../src/http.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { pollUntilTerminal, WAIT_DEFAULT_SECONDS } from '../src/types.js';
import { authorizationRequiredBody, serverInstructions } from '../src/authBoundary.js';

// Helper to create a mock HttpClient
function createMockHttp() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
    baseUrl: 'https://api.proof.holdings',
  } as unknown as HttpClient;
}

// Helper to capture tool registrations
interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function captureTools(registerFn: (tool: unknown, http?: HttpClient) => void, http?: HttpClient): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const mockTool = (name: string, description: string, schema: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    if (!description || description.trim().length === 0) {
      throw new Error(`Tool '${name}' registered with empty description`);
    }
    tools.push({ name, description, schema, handler });
  };
  registerFn(mockTool as unknown, http);
  return tools;
}

function findTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found. Available: ${tools.map(t => t.name).join(', ')}`);
  return tool;
}

// ============================================================
// VERIFICATIONS
// ============================================================
describe('verifications tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/verifications.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 15 verification tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('create_verification');
    expect(names).toContain('get_verification');
    expect(names).toContain('list_verifications');
    expect(names).toContain('trigger_verification');
    expect(names).toContain('submit_verification_code');
    expect(names).toContain('resend_verification');
    expect(names).toContain('test_verify');
    expect(names).toContain('list_verified_users');
    expect(names).toContain('get_verified_user');
    expect(names).toContain('start_domain_verification');
    expect(names).toContain('check_domain_verification');
    expect(names).toContain('delete_domain_verification');
    expect(names).toContain('wait_for_verification');
    expect(names).toContain('create_multi_channel_verification');
    expect(names).toContain('get_multi_channel_verification_status');
    expect(tools).toHaveLength(15);
  });

  it('create_verification schema mirrors the REST contract (type/channel/identifier)', () => {
    const tool = findTool(tools, 'create_verification');
    const keys = Object.keys(tool.schema).sort();
    expect(keys).toEqual([
      'bot_token',
      'channel',
      'client_metadata',
      'dns_provider',
      'email_prefix',
      'external_user_id',
      'identifier',
      'proof_expiry_days',
      'type',
    ]);
  });

  it('create_verification calls POST /api/v1/verifications', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_123', status: 'pending' });
    const tool = findTool(tools, 'create_verification');
    const result = await tool.handler({ type: 'phone', channel: 'sms', identifier: '+1234567890' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications', {
      type: 'phone',
      channel: 'sms',
      identifier: '+1234567890',
    });
    expect(result).toHaveProperty('content');
  });

  it('get_verification calls GET /api/v1/verifications/:id', async () => {
    http.get.mockResolvedValueOnce({ id: 'ver_123', status: 'verified' });
    const tool = findTool(tools, 'get_verification');
    await tool.handler({ id: 'ver_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications/ver_123');
  });

  it('list_verifications calls GET with query params', async () => {
    http.get.mockResolvedValueOnce({ data: [], total: 0 });
    const tool = findTool(tools, 'list_verifications');
    await tool.handler({ status: 'pending', page: 1, limit: 10 });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications', {
      status: 'pending',
      page: 1,
      limit: 10,
    });
  });

  it('trigger_verification calls POST /api/v1/verifications/:id/verify', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_123', status: 'verified' });
    const tool = findTool(tools, 'trigger_verification');
    await tool.handler({ id: 'ver_123' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/ver_123/verify');
  });

  it('submit_verification_code calls POST with code', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_123', status: 'verified' });
    const tool = findTool(tools, 'submit_verification_code');
    await tool.handler({ id: 'ver_123', code: '123456' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/ver_123/submit', { code: '123456' });
  });

  it('resend_verification calls POST /resend', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'resend_verification');
    await tool.handler({ id: 'ver_123' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/ver_123/resend');
  });

  it('test_verify calls POST /test-verify', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_123', status: 'verified' });
    const tool = findTool(tools, 'test_verify');
    await tool.handler({ id: 'ver_123' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/ver_123/test-verify');
  });

  it('list_verified_users calls GET /verifications/users', async () => {
    http.get.mockResolvedValueOnce({ data: [], total: 0 });
    const tool = findTool(tools, 'list_verified_users');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications/users', {});
  });

  it('get_verified_user calls GET with encoded user ID', async () => {
    http.get.mockResolvedValueOnce({ external_user_id: 'user/123' });
    const tool = findTool(tools, 'get_verified_user');
    await tool.handler({ external_user_id: 'user/123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications/users/user%2F123');
  });

  it('start_domain_verification calls POST /verifications/domain', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_d1', status: 'pending', domain: 'example.com' });
    const tool = findTool(tools, 'start_domain_verification');
    await tool.handler({ domain: 'example.com', verification_method: 'manual_dns' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/domain', {
      domain: 'example.com',
      verification_method: 'manual_dns',
    });
  });

  it('check_domain_verification calls POST /verifications/domain/:id/check', async () => {
    http.post.mockResolvedValueOnce({ id: 'ver_d1', status: 'verified' });
    const tool = findTool(tools, 'check_domain_verification');
    await tool.handler({ id: 'ver_d1' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/domain/ver_d1/check');
  });

  it('delete_domain_verification calls DELETE /verifications/domain/:id', async () => {
    http.del.mockResolvedValueOnce(undefined);
    const tool = findTool(tools, 'delete_domain_verification');
    const result = await tool.handler({ id: '65f0c0ffee0123456789abcd' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/verifications/domain/65f0c0ffee0123456789abcd');
    expect(result.isError).toBeFalsy();
  });

  it('delete_domain_verification takes only a domain id — a destructive call never leaves on a malformed one', () => {
    const tool = findTool(tools, 'delete_domain_verification');
    const input = z.object(tool.schema as z.ZodRawShape);

    expect(input.safeParse({ id: '65f0c0ffee0123456789abcd' }).success).toBe(true);
    for (const id of ['', 'dom_1', '../circles', '65f0c0ffee0123456789abc', '65f0c0ffee0123456789abcdz']) {
      expect(input.safeParse({ id }).success).toBe(false);
    }
  });

  it('delete_domain_verification reports a refused delete as an error', async () => {
    const { ApiError } = await import('../src/http.js');
    http.del.mockRejectedValueOnce(new ApiError('A verified domain cannot be deleted with an API key', 'domain_verified', 409));
    const tool = findTool(tools, 'delete_domain_verification');
    const result = await tool.handler({ id: '65f0c0ffee0123456789abcd' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('domain_verified');
  });

  it('wait_for_verification polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ id: 'ver_123', status: 'pending' })
      .mockResolvedValueOnce({ id: 'ver_123', status: 'verified' });
    const tool = findTool(tools, 'wait_for_verification');
    const result = await tool.handler({ id: 'ver_123', timeout_seconds: 10 });

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications/ver_123');
    expect(result).toHaveProperty('content');
  });

  it.each(['revoked', 'cancelled'])(
    'wait_for_verification stops on %s — a permanently terminal state it used to poll through',
    async (status) => {
      // Both are real, reachable and irreversible. `cancelled` is written to every losing sibling
      // of a multi-channel group the moment another channel wins
      // (src/services/channels/verificationGroup.ts), and `revoked` is what revoking an asset's
      // proof writes (src/controllers/me.ts). Neither was in the terminal list, so the tool polled
      // its whole budget and — since the timeout stopped being an error (h-fix-mcp-refusal-roads
      // SC-5) — answered "still running, call this tool again", which an agent obeys forever. The
      // envelope carried `last_status: "cancelled"`, contradicting its own message.
      http.get.mockResolvedValueOnce({ id: 'ver_123', status });
      const tool = findTool(tools, 'wait_for_verification');
      const result = await tool.handler({ id: 'ver_123', timeout_seconds: 10 });

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'ver_123', status });
    },
  );

  it('create_multi_channel_verification calls POST /api/v1/verifications/multi-channel', async () => {
    http.post.mockResolvedValueOnce({ group_id: 'vg_abc', status: 'pending' });
    const tool = findTool(tools, 'create_multi_channel_verification');
    await tool.handler({ type: 'phone', identifier: '+37060000000', channels: ['whatsapp', 'telegram'] });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/multi-channel', {
      type: 'phone',
      identifier: '+37060000000',
      channels: ['whatsapp', 'telegram'],
    });
  });

  // The backend's createMultiChannelVerificationSchema takes a profile_id (24 hex) and any
  // client_metadata value; the tool must not refuse what the API accepts (l-fix-mcp-1-7-1-followups).
  it('create_multi_channel_verification takes the sub-account profile_id and forwards it', async () => {
    http.post.mockResolvedValueOnce({ group_id: 'vg_abc', status: 'pending' });
    const tool = findTool(tools, 'create_multi_channel_verification');
    const input = z.object(tool.schema as z.ZodRawShape);
    const args = { type: 'phone', identifier: '+37060000000', channels: ['sms'], profile_id: '65f0c0ffee0123456789abcd' };

    expect(input.safeParse(args).success).toBe(true);
    for (const profile_id of ['', 'prof_1', '65f0c0ffee0123456789abc', '65f0c0ffee0123456789abcz']) {
      expect(input.safeParse({ ...args, profile_id }).success).toBe(false);
    }
    await tool.handler(args);
    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/multi-channel', args);
  });

  it('create_multi_channel_verification passes client_metadata values of any type through unchanged', async () => {
    http.post.mockResolvedValueOnce({ group_id: 'vg_abc', status: 'pending' });
    const tool = findTool(tools, 'create_multi_channel_verification');
    const input = z.object(tool.schema as z.ZodRawShape);
    const args = {
      type: 'phone', identifier: '+37060000000', channels: ['whatsapp'],
      client_metadata: { attempt: 2, trusted: true, order: { id: 'o_1', items: [1, 2] }, note: 'x' },
    };

    const parsed = input.safeParse(args);
    expect(parsed.success).toBe(true);
    await tool.handler(parsed.data!);
    expect(http.post).toHaveBeenCalledWith('/api/v1/verifications/multi-channel', args);
  });

  it('get_multi_channel_verification_status calls GET with encoded group_id', async () => {
    http.get.mockResolvedValueOnce({ group_id: 'vg_abc', status: 'verified' });
    const tool = findTool(tools, 'get_multi_channel_verification_status');
    await tool.handler({ group_id: 'vg/abc' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verifications/multi-channel/vg%2Fabc/status');
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Invalid channel', 'validation_error', 400));
    const tool = findTool(tools, 'create_verification');
    const result = await tool.handler({ type: 'phone', channel: 'sms', identifier: '+1234567890' }) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// VERIFICATION REQUESTS
// ============================================================
describe('verification-requests tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/verification-requests.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 7 verification request tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('create_verification_request');
    expect(names).toContain('get_verification_request');
    expect(names).toContain('get_request_proofs');
    expect(names).toContain('list_verification_requests');
    expect(names).toContain('get_request_by_reference');
    expect(names).toContain('cancel_verification_request');
    expect(names).toContain('wait_for_request');
    expect(tools).toHaveLength(7);
  });

  it('create_verification_request calls POST', async () => {
    http.post.mockResolvedValueOnce({ id: 'req_123' });
    const tool = findTool(tools, 'create_verification_request');
    await tool.handler({ assets: [{ type: 'phone', identifier: '+1234', channel: 'sms' }] });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verification-requests', {
      assets: [{ type: 'phone', identifier: '+1234', channel: 'sms' }],
    });
  });

  it('create_verification_request passes all optional params', async () => {
    http.post.mockResolvedValueOnce({ id: 'req_456' });
    const tool = findTool(tools, 'create_verification_request');
    await tool.handler({
      assets: [{ type: 'email', identifier: 'a@b.com', channel: 'email', required: true, allowed_channels: ['email'] }],
      reference_id: 'ref-1',
      action_type: 'confirmation',
      action_context: { title: 'Approve Transfer', description: 'Wire $50k' },
      partial_ok: true,
      redirect_url: 'https://example.com/done',
      callback_url: 'https://example.com/hook',
      expires_in: 3600,
      public_profile_id: 'prof_1',
    });

    expect(http.post).toHaveBeenCalledWith('/api/v1/verification-requests', expect.objectContaining({
      action_type: 'confirmation',
      action_context: { title: 'Approve Transfer', description: 'Wire $50k' },
      partial_ok: true,
      redirect_url: 'https://example.com/done',
      expires_in: 3600,
      public_profile_id: 'prof_1',
    }));
  });

  it('get_verification_request calls GET with ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'req_123' });
    const tool = findTool(tools, 'get_verification_request');
    await tool.handler({ id: 'req_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests/req_123');
  });

  it('get_request_proofs calls GET with ID/proofs', async () => {
    http.get.mockResolvedValueOnce({ proofs: [{ type: 'phone', identifier: '+37069199199', proof_token: 'jwt_proof' }] });
    const tool = findTool(tools, 'get_request_proofs');
    await tool.handler({ id: 'req_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests/req_123/proofs');
  });

  it('list_verification_requests calls GET with query', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_verification_requests');
    await tool.handler({ status: 'pending' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests', { status: 'pending' });
  });

  it('list_verification_requests supports partial status and reference_id', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_verification_requests');
    await tool.handler({ status: 'partial', reference_id: 'ref-1' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests', { status: 'partial', reference_id: 'ref-1' });
  });

  it('list_verification_requests forwards the synthetic active status', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_verification_requests');
    await tool.handler({ status: 'active' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests', { status: 'active' });
  });

  it('get_request_by_reference calls GET with encoded reference', async () => {
    http.get.mockResolvedValueOnce({ id: 'req_123' });
    const tool = findTool(tools, 'get_request_by_reference');
    await tool.handler({ reference_id: 'ref/123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests/by-reference/ref%2F123');
  });

  it('cancel_verification_request calls DELETE', async () => {
    http.del.mockResolvedValueOnce({ id: 'req_123', status: 'cancelled' });
    const tool = findTool(tools, 'cancel_verification_request');
    await tool.handler({ id: 'req_123' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/verification-requests/req_123');
  });

  it('wait_for_request polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ id: 'req_123', status: 'pending' })
      .mockResolvedValueOnce({ id: 'req_123', status: 'completed' });
    const tool = findTool(tools, 'wait_for_request');
    const result = await tool.handler({ id: 'req_123', timeout_seconds: 10 });
    expect(http.get).toHaveBeenCalledWith('/api/v1/verification-requests/req_123');
    expect(result).toHaveProperty('content');
  });
});

// ============================================================
// PROOFS
// ============================================================
describe('proofs tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/proofs.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 4 proof tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('validate_proof');
    expect(names).toContain('get_proof_status');
    expect(names).toContain('revoke_proof');
    expect(names).toContain('list_revoked_proofs');
    expect(tools).toHaveLength(4);
  });

  it('validate_proof calls POST with token', async () => {
    http.post.mockResolvedValueOnce({ valid: true });
    const tool = findTool(tools, 'validate_proof');
    await tool.handler({ proof_token: 'eyJhbG...' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/proofs/validate', {
      proof_token: 'eyJhbG...',
    });
  });

  it('get_proof_status calls GET with ID', async () => {
    http.get.mockResolvedValueOnce({ status: 'active' });
    const tool = findTool(tools, 'get_proof_status');
    await tool.handler({ id: 'ver_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/proofs/ver_123/status');
  });

  it('revoke_proof calls POST with optional reason', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'revoke_proof');
    await tool.handler({ id: 'ver_123', reason: 'compromised' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/proofs/ver_123/revoke', { reason: 'compromised' });
  });

  it('revoke_proof omits reason when not provided', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'revoke_proof');
    await tool.handler({ id: 'ver_123' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/proofs/ver_123/revoke', {});
  });

  it('list_revoked_proofs calls GET /api/v1/proofs/revoked', async () => {
    http.get.mockResolvedValueOnce({ revoked: [] });
    const tool = findTool(tools, 'list_revoked_proofs');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/proofs/revoked');
  });
});

// ============================================================
// SESSIONS
// ============================================================
describe('sessions tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/sessions.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 3 session tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('create_session');
    expect(names).toContain('get_session');
    expect(names).toContain('wait_for_session');
    expect(tools).toHaveLength(3);
  });

  it('create_session calls POST', async () => {
    http.post.mockResolvedValueOnce({ id: 'ses_123' });
    const tool = findTool(tools, 'create_session');
    await tool.handler({ channel: 'telegram', profile_id: '507f1f77bcf86cd799439011', context: { action: 'login' } });

    expect(http.post).toHaveBeenCalledWith('/api/v1/sessions', {
      channel: 'telegram',
      profile_id: '507f1f77bcf86cd799439011',
      context: { action: 'login' },
    });
  });

  // POST /api/v1/sessions takes exactly these three: sms works like SMS login (a short code texted to
  // one of our numbers), so an agent can offer it to a person with neither messenger.
  it('create_session accepts telegram, whatsapp and sms, and nothing else', () => {
    const input = z.object(findTool(tools, 'create_session').schema as z.ZodRawShape);
    for (const channel of ['telegram', 'whatsapp', 'sms']) {
      expect(input.safeParse({ channel }).success).toBe(true);
    }
    expect(input.safeParse({ channel: 'email' }).success).toBe(false);
  });

  it('create_session tells the agent what to show for sms', () => {
    const { description } = findTool(tools, 'create_session');
    expect(description).toContain('sms_message');
    expect(description).toContain('sms_dids');
  });

  it('get_session calls GET with ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'ses_123', status: 'pending' });
    const tool = findTool(tools, 'get_session');
    await tool.handler({ id: 'ses_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/sessions/ses_123');
  });

  it('wait_for_session polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ id: 'ses_123', status: 'pending' })
      .mockResolvedValueOnce({ id: 'ses_123', status: 'verified' });
    const tool = findTool(tools, 'wait_for_session');
    const result = await tool.handler({ id: 'ses_123', timeout_seconds: 10 });
    expect(http.get).toHaveBeenCalledWith('/api/v1/sessions/ses_123');
    expect(result).toHaveProperty('content');
  });
});

// ============================================================
// ASSETS
// ============================================================
describe('assets tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/assets.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 3 asset tools', () => {
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name);
    expect(names).toContain('list_assets');
    expect(names).toContain('get_asset');
    expect(names).toContain('revoke_asset');
  });

  it('list_assets calls GET with query params', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_assets');
    await tool.handler({ type: 'phone', status: 'active' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/assets', {
      type: 'phone',
      status: 'active',
    });
  });

  it('list_assets sends empty query for no filters', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_assets');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/assets', {});
  });

  it('get_asset calls GET with encoded ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'asset_123', type: 'phone' });
    const tool = findTool(tools, 'get_asset');
    await tool.handler({ id: 'asset_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/assets/asset_123');
  });

  it('revoke_asset calls DELETE with encoded ID', async () => {
    http.del.mockResolvedValueOnce({ id: 'asset_123', status: 'revoked' });
    const tool = findTool(tools, 'revoke_asset');
    await tool.handler({ id: 'asset_123' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/me/assets/asset_123');
  });
});

// ============================================================
// AUTH
// ============================================================
describe('auth tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/auth.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 3 auth tools', () => {
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name);
    expect(names).toContain('get_current_user');
    expect(names).toContain('list_auth_sessions');
    expect(names).toContain('revoke_auth_session');
  });

  it('get_current_user calls GET /api/v1/auth/me', async () => {
    http.get.mockResolvedValueOnce({ id: 'user_123', email: 'test@example.com' });
    const tool = findTool(tools, 'get_current_user');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/auth/me');
  });

  it('list_auth_sessions calls GET /api/v1/auth/sessions', async () => {
    http.get.mockResolvedValueOnce({ sessions: [], total: 0 });
    const tool = findTool(tools, 'list_auth_sessions');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/auth/sessions');
  });

  it('revoke_auth_session calls DELETE /api/v1/auth/sessions/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true, message: 'Session revoked' });
    const tool = findTool(tools, 'revoke_auth_session');
    await tool.handler({ session_id: 'sess_abc' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/auth/sessions/sess_abc');
  });
});

// ============================================================
// SETTINGS
// ============================================================
describe('settings tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/settings.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 8 settings tools', () => {
    expect(tools).toHaveLength(8);
    const names = tools.map(t => t.name);
    expect(names).toContain('get_usage');
    expect(names).toContain('get_platform_summary');
    expect(names).toContain('get_settings');
    expect(names).toContain('update_settings');
    expect(names).toContain('export_data');
    expect(names).toContain('search');
    expect(names).toContain('get_self_api_key');
    expect(names).toContain('get_api_key_usage');
  });

  it('get_usage calls GET with query params', async () => {
    http.get.mockResolvedValueOnce({ verifications: 100 });
    const tool = findTool(tools, 'get_usage');
    await tool.handler({ period: '2026-01', months: 3 });

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/usage', {
      period: '2026-01',
      months: 3,
    });
  });

  it('get_usage sends empty query for no params', async () => {
    http.get.mockResolvedValueOnce({ verifications: 0 });
    const tool = findTool(tools, 'get_usage');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/usage', {});
  });

  it('get_settings calls GET /api/v1/me/settings', async () => {
    http.get.mockResolvedValueOnce({ proof_expiry_days: null });
    const tool = findTool(tools, 'get_settings');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/settings');
  });

  it('update_settings PATCHes the default proof lifetime through', async () => {
    http.patch.mockResolvedValueOnce({ proof_expiry_days: 30 });
    const tool = findTool(tools, 'update_settings');
    await tool.handler({ proof_expiry_days: 30 });

    expect(http.patch).toHaveBeenCalledWith('/api/v1/me/settings', { proof_expiry_days: 30 });
  });

  it('update_settings accepts the webhook object the REST endpoint accepts', () => {
    // The parity map records settings.update as `mcp: available`, and `parity:validate` compares
    // tool NAMES and routes — never request shapes — so without this case the tool could stay
    // narrower than the endpoint with every check green. No `branding`: it lives on each project
    // now (h-subaccount-branding-per-project), so create_profile / update_profile carry it.
    const tool = findTool(tools, 'update_settings');
    expect(Object.keys(tool.schema).sort()).toEqual(['proof_expiry_days', 'webhook']);

    const webhook = tool.schema.webhook as unknown as { safeParse: (v: unknown) => { success: boolean } };
    const parsed = webhook.safeParse({
      url: 'https://receiver.example/hook',
      events: ['proof.*'],
      rotate_secret: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('update_settings PATCHes the webhook block through', async () => {
    http.patch.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'update_settings');
    await tool.handler({ webhook: { url: 'https://receiver.example/hook' } });

    expect(http.patch).toHaveBeenCalledWith('/api/v1/me/settings', {
      webhook: { url: 'https://receiver.example/hook' },
    });
  });

  // h-implement-proper-deletion ACC-2: the export is prepared in the background; the tool starts
  // one only when none is preparing or ready, and never returns the data.
  it('export_data starts an export when there is none', async () => {
    http.get.mockResolvedValueOnce({ latest: null });
    http.post.mockResolvedValueOnce({ id: 'e1', status: 'preparing' });
    const tool = findTool(tools, 'export_data');
    const result = await tool.handler({}) as { content: { text: string }[] };

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/export');
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/export');
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'e1', status: 'preparing' });
  });

  it.each(['preparing', 'ready'])('export_data reports an export already %s instead of starting another', async (status) => {
    http.get.mockResolvedValueOnce({ latest: { id: 'e1', status } });
    const tool = findTool(tools, 'export_data');
    const result = await tool.handler({}) as { content: { text: string }[] };

    expect(http.post).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'e1', status });
  });

  it('export_data starts a new export after a failed one, and reads one export by id', async () => {
    http.get.mockResolvedValueOnce({ latest: { id: 'e0', status: 'failed' } });
    http.post.mockResolvedValueOnce({ id: 'e1', status: 'preparing' });
    const tool = findTool(tools, 'export_data');
    await tool.handler({});
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/export');

    http.get.mockResolvedValueOnce({ id: '0123456789abcdef01234567', status: 'ready' });
    await tool.handler({ export_id: '0123456789abcdef01234567' });
    expect(http.get).toHaveBeenLastCalledWith('/api/v1/me/export/0123456789abcdef01234567');
  });

  it('export_data takes only an export id shaped like one', () => {
    const tool = findTool(tools, 'export_data');
    const schema = z.object(tool.schema as z.ZodRawShape);
    expect(schema.safeParse({ export_id: '../../me/api-keys' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(true);
  });
});

// ============================================================
// TEMPLATES
// ============================================================
describe('templates tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/templates.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 7 template tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('list_templates');
    expect(names).toContain('get_default_templates');
    expect(names).toContain('get_template');
    expect(names).toContain('update_template');
    expect(names).toContain('delete_template');
    expect(names).toContain('preview_template');
    expect(names).toContain('render_template');
    expect(tools).toHaveLength(7);
  });

  it('list_templates calls GET /api/v1/templates', async () => {
    http.get.mockResolvedValueOnce({ templates: [] });
    const tool = findTool(tools, 'list_templates');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/templates');
  });

  it('get_default_templates calls GET /api/v1/templates/defaults', async () => {
    http.get.mockResolvedValueOnce({ defaults: [] });
    const tool = findTool(tools, 'get_default_templates');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/templates/defaults');
  });

  it('get_template calls GET with channel and message_type', async () => {
    http.get.mockResolvedValueOnce({ channel: 'email', body: '...' });
    const tool = findTool(tools, 'get_template');
    await tool.handler({ channel: 'email', message_type: 'verification_request' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/templates/email/verification_request');
  });

  it('update_template calls PUT with template fields', async () => {
    http.put.mockResolvedValueOnce({ channel: 'email', message_type: 'verification_request', body: 'Hello {{name}}' });
    const tool = findTool(tools, 'update_template');
    await tool.handler({
      channel: 'email',
      message_type: 'verification_request',
      subject: 'Verify your identity',
      body: 'Hello {{name}}',
      button_text: 'Verify Now',
      button_url_template: 'https://example.com/verify/{{token}}',
    });

    expect(http.put).toHaveBeenCalledWith('/api/v1/templates/email/verification_request', {
      subject: 'Verify your identity',
      body: 'Hello {{name}}',
      button_text: 'Verify Now',
      button_url_template: 'https://example.com/verify/{{token}}',
    });
  });

  it('delete_template calls DELETE with channel and message_type', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'delete_template');
    await tool.handler({ channel: 'email', message_type: 'verification_request' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/templates/email/verification_request');
  });

  it('preview_template calls POST /api/v1/templates/preview', async () => {
    http.post.mockResolvedValueOnce({ rendered: '...' });
    const tool = findTool(tools, 'preview_template');
    await tool.handler({ channel: 'email', message_type: 'verification_request', body: 'Test' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/templates/preview', {
      channel: 'email',
      message_type: 'verification_request',
      body: 'Test',
    });
  });

  it('render_template calls POST /api/v1/templates/render', async () => {
    http.post.mockResolvedValueOnce({ rendered: 'Hello World' });
    const tool = findTool(tools, 'render_template');
    await tool.handler({ channel: 'sms', message_type: 'login_request', variables: { code: '123456', expires_in: '10 minutes' } });

    expect(http.post).toHaveBeenCalledWith('/api/v1/templates/render', {
      channel: 'sms',
      message_type: 'login_request',
      variables: { code: '123456', expires_in: '10 minutes' },
    });
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'list_templates');
    const result = await tool.handler({}) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  // h-subaccount-branding-per-project (D1): a template belongs to one sub-account (project), and
  // every operation but the platform defaults names it through `?profile_id=`. The cases above call
  // without one and pin that nothing is appended then, so the server's own choice applies.
  const PROJECT = '6650f1a2b3c4d5e6f7a8b9c0';

  it('takes an optional 24-hex profile_id on every tool but get_default_templates', () => {
    const scoped = tools.filter((t) => 'profile_id' in t.schema).map((t) => t.name).sort();
    expect(scoped).toEqual([
      'delete_template', 'get_template', 'list_templates', 'preview_template', 'render_template', 'update_template',
    ]);
    for (const name of scoped) {
      const profileId = findTool(tools, name).schema.profile_id as z.ZodTypeAny;
      expect(profileId.safeParse(undefined).success).toBe(true);
      expect(profileId.safeParse(PROJECT).success).toBe(true);
      expect(profileId.safeParse('primary').success).toBe(false);
    }
  });

  it('list_templates and get_template send profile_id as a query parameter', async () => {
    http.get.mockResolvedValue({});
    await findTool(tools, 'list_templates').handler({ profile_id: PROJECT });
    await findTool(tools, 'get_template').handler({ channel: 'email', message_type: 'verification_request', profile_id: PROJECT });

    expect(http.get).toHaveBeenNthCalledWith(1, `/api/v1/templates?profile_id=${PROJECT}`);
    expect(http.get).toHaveBeenNthCalledWith(2, `/api/v1/templates/email/verification_request?profile_id=${PROJECT}`);
  });

  it('update_template and delete_template send profile_id as a query parameter, never in the body', async () => {
    http.put.mockResolvedValueOnce({});
    http.del.mockResolvedValueOnce({});
    await findTool(tools, 'update_template').handler({
      channel: 'sms', message_type: 'login_request', body: '{{business_name}}: your code is {{code}}', profile_id: PROJECT,
    });
    await findTool(tools, 'delete_template').handler({ channel: 'sms', message_type: 'login_request', profile_id: PROJECT });

    expect(http.put).toHaveBeenCalledWith(`/api/v1/templates/sms/login_request?profile_id=${PROJECT}`, {
      body: '{{business_name}}: your code is {{code}}',
    });
    expect(http.del).toHaveBeenCalledWith(`/api/v1/templates/sms/login_request?profile_id=${PROJECT}`);
  });

  it('preview_template and render_template send profile_id as a query parameter, never in the body', async () => {
    http.post.mockResolvedValue({});
    await findTool(tools, 'preview_template').handler({
      channel: 'email', message_type: 'verification_request', body: 'Test', profile_id: PROJECT,
    });
    await findTool(tools, 'render_template').handler({ channel: 'sms', message_type: 'login_request', profile_id: PROJECT });

    expect(http.post).toHaveBeenNthCalledWith(1, `/api/v1/templates/preview?profile_id=${PROJECT}`, {
      channel: 'email', message_type: 'verification_request', body: 'Test',
    });
    expect(http.post).toHaveBeenNthCalledWith(2, `/api/v1/templates/render?profile_id=${PROJECT}`, {
      channel: 'sms', message_type: 'login_request',
    });
  });
});

// ============================================================
// WEBHOOK DELIVERIES
// ============================================================
describe('webhook-deliveries tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/webhook-deliveries.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 4 webhook delivery tools', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('get_webhook_stats');
    expect(names).toContain('list_webhook_deliveries');
    expect(names).toContain('get_webhook_delivery');
    expect(names).toContain('retry_webhook_delivery');
    expect(tools).toHaveLength(4);
  });

  it('get_webhook_stats calls GET /api/v1/webhook-deliveries/stats', async () => {
    http.get.mockResolvedValueOnce({ total: 100, success: 95 });
    const tool = findTool(tools, 'get_webhook_stats');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/webhook-deliveries/stats');
  });

  it('list_webhook_deliveries calls GET with query params', async () => {
    http.get.mockResolvedValueOnce({ data: [], total: 0 });
    const tool = findTool(tools, 'list_webhook_deliveries');
    await tool.handler({ status: 'failed', page: 1, limit: 20 });

    expect(http.get).toHaveBeenCalledWith('/api/v1/webhook-deliveries', {
      status: 'failed',
      page: 1,
      limit: 20,
    });
  });

  it('list_webhook_deliveries sends empty query for no filters', async () => {
    http.get.mockResolvedValueOnce({ data: [] });
    const tool = findTool(tools, 'list_webhook_deliveries');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/webhook-deliveries', {});
  });

  it('get_webhook_delivery calls GET with ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'del_123' });
    const tool = findTool(tools, 'get_webhook_delivery');
    await tool.handler({ id: 'del_123' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/webhook-deliveries/del_123');
  });

  it('retry_webhook_delivery calls POST with ID', async () => {
    http.post.mockResolvedValueOnce({ id: 'del_123', status: 'pending' });
    const tool = findTool(tools, 'retry_webhook_delivery');
    await tool.handler({ id: 'del_123' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/webhook-deliveries/del_123/retry');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Forbidden', 'forbidden', 403));
    const tool = findTool(tools, 'get_webhook_stats');
    const result = await tool.handler({}) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// BILLING
// ============================================================
describe('billing tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/billing.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers get_subscription tool', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_subscription');
  });

  it('get_subscription calls GET /api/v1/billing/subscription', async () => {
    http.get.mockResolvedValueOnce({ plan: 'pro', status: 'active' });
    const tool = findTool(tools, 'get_subscription');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/billing/subscription');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Unauthorized', 'unauthorized', 401));
    const tool = findTool(tools, 'get_subscription');
    const result = await tool.handler({}) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// PROFILE TEMPLATES (tested within profiles tools block below)
// ============================================================

// ============================================================
// PROFILES
// ============================================================
describe('profiles tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/profiles.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 10 profile tools', () => {
    expect(tools).toHaveLength(10);
    const names = tools.map(t => t.name);
    expect(names).toContain('list_profiles');
    expect(names).toContain('create_profile');
    expect(names).toContain('get_profile');
    expect(names).toContain('update_profile');
    expect(names).toContain('delete_profile');
    expect(names).toContain('set_primary_profile');
    expect(names).toContain('update_profile_proofs');
    expect(names).toContain('get_my_profile');
    expect(names).toContain('update_my_profile');
    expect(names).toContain('get_profile_assets');
  });

  // h-subaccount-branding-per-project (D7): `/api/v1/me/profiles/:id/templates` answers 410
  // `endpoint_retired`; a project's templates are the template tools with `profile_id`.
  it('no longer registers the retired per-profile template tools', () => {
    const names = tools.map(t => t.name);
    for (const retired of ['list_profile_templates', 'update_profile_template', 'delete_profile_template', 'preview_profile_template']) {
      expect(names).not.toContain(retired);
    }
  });

  it('create_profile and update_profile declare the project\'s email branding the endpoint accepts', () => {
    for (const name of ['create_profile', 'update_profile']) {
      const shape = findTool(tools, name).schema;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['email_theme', 'support_email']));
      const schema = z.object(shape as z.ZodRawShape);
      expect(schema.safeParse({ profile_id: 'p', email_theme: 'light', support_email: 'support@proof.holdings' }).success).toBe(true);
      expect(schema.safeParse({ profile_id: 'p', email_theme: 'sepia' }).success).toBe(false);
      expect(schema.safeParse({ profile_id: 'p', support_email: 'not-an-address' }).success).toBe(false);
    }
    // Only an update clears the address; a create simply leaves it out.
    const update = z.object(findTool(tools, 'update_profile').schema as z.ZodRawShape);
    expect(update.safeParse({ profile_id: 'p', support_email: null }).success).toBe(true);
  });

  it('list_profiles calls GET /api/v1/me/profiles', async () => {
    http.get.mockResolvedValueOnce([]);
    const tool = findTool(tools, 'list_profiles');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/profiles');
  });

  it('create_profile calls POST /api/v1/me/profiles', async () => {
    http.post.mockResolvedValueOnce({ id: 'prof_1', display_name: 'Test' });
    const tool = findTool(tools, 'create_profile');
    await tool.handler({ display_name: 'Test', is_public: true });

    expect(http.post).toHaveBeenCalledWith('/api/v1/me/profiles', {
      display_name: 'Test',
      is_public: true,
    });
  });

  it('get_profile calls GET /api/v1/me/profiles/:id', async () => {
    http.get.mockResolvedValueOnce({ id: 'prof_1' });
    const tool = findTool(tools, 'get_profile');
    await tool.handler({ profile_id: 'prof_1' });

    expect(http.get).toHaveBeenCalledWith('/api/v1/me/profiles/prof_1');
  });

  it('update_profile calls PATCH with body (excluding profile_id)', async () => {
    http.patch.mockResolvedValueOnce({ id: 'prof_1', display_name: 'Updated' });
    const tool = findTool(tools, 'update_profile');
    await tool.handler({ profile_id: 'prof_1', display_name: 'Updated', bio: 'New bio' });

    expect(http.patch).toHaveBeenCalledWith('/api/v1/me/profiles/prof_1', {
      display_name: 'Updated',
      bio: 'New bio',
    });
  });

  it('delete_profile calls DELETE /api/v1/me/profiles/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'delete_profile');
    await tool.handler({ profile_id: 'prof_1' });

    expect(http.del).toHaveBeenCalledWith('/api/v1/me/profiles/prof_1');
  });

  it('set_primary_profile calls POST /api/v1/me/profiles/:id/primary', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'set_primary_profile');
    await tool.handler({ profile_id: 'prof_1' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/me/profiles/prof_1/primary');
  });

  it('update_profile_proofs calls PUT /profiles/profiles/:id/proofs', async () => {
    http.put.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'update_profile_proofs');
    await tool.handler({
      profile_id: 'prof_1',
      proofs: [{ asset_id: 'asset_1', is_visible: true, mask_level: 'partial' }],
    });

    expect(http.put).toHaveBeenCalledWith('/api/v1/profiles/profiles/prof_1/proofs', {
      proofs: [{ asset_id: 'asset_1', is_visible: true, mask_level: 'partial' }],
    });
  });

  it('get_my_profile calls GET /api/v1/profiles/me', async () => {
    http.get.mockResolvedValueOnce({ id: 'prof_1', display_name: 'Me' });
    const tool = findTool(tools, 'get_my_profile');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/profiles/me');
  });

  it('update_my_profile calls PUT /api/v1/profiles/me', async () => {
    http.put.mockResolvedValueOnce({ id: 'prof_1', display_name: 'Updated' });
    const tool = findTool(tools, 'update_my_profile');
    await tool.handler({ display_name: 'Updated', is_public: false });

    expect(http.put).toHaveBeenCalledWith('/api/v1/profiles/me', {
      display_name: 'Updated',
      is_public: false,
    });
  });

  it('get_profile_assets calls GET /api/v1/profiles/me/assets', async () => {
    http.get.mockResolvedValueOnce([]);
    const tool = findTool(tools, 'get_profile_assets');
    await tool.handler({});

    expect(http.get).toHaveBeenCalledWith('/api/v1/profiles/me/assets');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'get_profile');
    const result = await tool.handler({ profile_id: 'bad' }) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// EMAILS
// ============================================================
describe('emails tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/emails.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 7 email tools', () => {
    expect(tools).toHaveLength(7);
    expect(tools.map(t => t.name)).toEqual([
      'list_emails', 'remove_email', 'set_primary_email',
      'start_add_email', 'get_add_email_status', 'verify_email_otp', 'resend_email_otp',
    ]);
  });

  it('list_emails calls GET /api/v1/me/emails', async () => {
    http.get.mockResolvedValueOnce([]);
    const tool = findTool(tools, 'list_emails');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/emails');
  });

  it('remove_email calls DELETE /api/v1/me/emails/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'remove_email');
    await tool.handler({ id: 'em_1' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/emails/em_1');
  });

  it('set_primary_email calls PUT /api/v1/me/emails/:id/primary', async () => {
    http.put.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'set_primary_email');
    await tool.handler({ id: 'em_1' });
    expect(http.put).toHaveBeenCalledWith('/api/v1/me/emails/em_1/primary');
  });

  it('start_add_email calls POST /api/v1/me/emails/add', async () => {
    http.post.mockResolvedValueOnce({ session_id: 'sess_1' });
    const tool = findTool(tools, 'start_add_email');
    await tool.handler({ email: 'test@example.com' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/emails/add', { email: 'test@example.com' });
  });

  it('get_add_email_status calls GET /api/v1/me/emails/add/:sessionId', async () => {
    http.get.mockResolvedValueOnce({ status: 'pending' });
    const tool = findTool(tools, 'get_add_email_status');
    await tool.handler({ session_id: 'sess_1' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/emails/add/sess_1');
  });

  it('verify_email_otp calls POST /api/v1/me/emails/add/:sessionId/verify', async () => {
    http.post.mockResolvedValueOnce({ status: 'verified' });
    const tool = findTool(tools, 'verify_email_otp');
    await tool.handler({ session_id: 'sess_1', code: '123456' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/emails/add/sess_1/verify', { code: '123456' });
  });

  it('resend_email_otp calls POST /api/v1/me/emails/add/:sessionId/resend', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'resend_email_otp');
    await tool.handler({ session_id: 'sess_1' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/emails/add/sess_1/resend');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'list_emails');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// PHONES
// ============================================================
describe('phones tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/phones.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 5 phone tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map(t => t.name)).toEqual([
      'list_phones', 'remove_phone', 'set_primary_phone',
      'start_add_phone', 'get_add_phone_status',
    ]);
  });

  it('list_phones calls GET /api/v1/me/phones', async () => {
    http.get.mockResolvedValueOnce([]);
    const tool = findTool(tools, 'list_phones');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/phones');
  });

  it('remove_phone calls DELETE /api/v1/me/phones/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'remove_phone');
    await tool.handler({ id: 'ph_1' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/phones/ph_1');
  });

  it('set_primary_phone calls PUT /api/v1/me/phones/:id/primary', async () => {
    http.put.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'set_primary_phone');
    await tool.handler({ id: 'ph_1' });
    expect(http.put).toHaveBeenCalledWith('/api/v1/me/phones/ph_1/primary');
  });

  it('start_add_phone calls POST /api/v1/me/phones/add', async () => {
    http.post.mockResolvedValueOnce({ session_id: 'sess_1' });
    const tool = findTool(tools, 'start_add_phone');
    await tool.handler({ channel: 'sms' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/phones/add', { channel: 'sms' });
  });

  it('get_add_phone_status calls GET /api/v1/me/phones/add/:sessionId', async () => {
    http.get.mockResolvedValueOnce({ status: 'pending' });
    const tool = findTool(tools, 'get_add_phone_status');
    await tool.handler({ session_id: 'sess_1' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/phones/add/sess_1');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Forbidden', 'forbidden', 403));
    const tool = findTool(tools, 'list_phones');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// API KEYS
// ============================================================
describe('api keys tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/api-keys.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 4 api key tools', () => {
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual([
      'list_api_keys', 'create_api_key', 'revoke_api_key', 'regenerate_api_key',
    ]);
  });

  it('list_api_keys calls GET /api/v1/me/api-keys', async () => {
    http.get.mockResolvedValueOnce([]);
    const tool = findTool(tools, 'list_api_keys');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/api-keys');
  });

  it('create_api_key calls POST /api/v1/me/api-keys', async () => {
    http.post.mockResolvedValueOnce({ id: 'key_1', secret: 'sk_...' });
    const tool = findTool(tools, 'create_api_key');
    await tool.handler({ name: 'Test Key', environment: 'test' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/api-keys', { name: 'Test Key', environment: 'test' });
  });

  it('create_api_key schema accepts optional profile_id (sub-account binding)', () => {
    const tool = findTool(tools, 'create_api_key');
    expect(Object.keys(tool.schema)).toContain('profile_id');
  });

  it('create_api_key passes profile_id through to the POST body', async () => {
    http.post.mockResolvedValueOnce({ id: 'key_1', secret: 'sk_...' });
    const tool = findTool(tools, 'create_api_key');
    await tool.handler({ name: 'Proj Key', profile_id: '507f1f77bcf86cd799439011' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/api-keys', { name: 'Proj Key', profile_id: '507f1f77bcf86cd799439011' });
  });

  it('revoke_api_key calls DELETE /api/v1/me/api-keys/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'revoke_api_key');
    await tool.handler({ id: 'key_1' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/api-keys/key_1');
  });

  it('regenerate_api_key calls POST /api/v1/me/api-keys/:id/regenerate', async () => {
    http.post.mockResolvedValueOnce({ id: 'key_1', secret: 'sk_new_...' });
    const tool = findTool(tools, 'regenerate_api_key');
    await tool.handler({ id: 'key_1' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/api-keys/key_1/regenerate');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Unauthorized', 'unauthorized', 401));
    const tool = findTool(tools, 'list_api_keys');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// 2FA
// ============================================================
describe('twofa tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/twofa.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 5 2FA tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map(t => t.name)).toEqual([
      'start_2fa', 'get_2fa_status', 'verify_2fa', 'verify_2fa_magic_link', 'wait_for_2fa',
    ]);
  });

  it('start_2fa calls POST /api/v1/me/2fa/start', async () => {
    http.post.mockResolvedValueOnce({ session_id: '2fa_1' });
    const tool = findTool(tools, 'start_2fa');
    await tool.handler({ action_type: 'api_key_create', channel: 'email' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/2fa/start', { action_type: 'api_key_create', channel: 'email' });
  });

  // h-implement-proper-deletion MCP-1: the new action types, and the targets a grant is bound to.
  it('start_2fa offers the 1.5.0 action types and passes the targets through', async () => {
    const tool = findTool(tools, 'start_2fa');
    const schema = z.object(tool.schema as z.ZodRawShape);
    for (const action_type of ['revocation_bulk', 'domain_remove', 'profile_delete', 'phone_primary', 'email_primary']) {
      expect(schema.safeParse({ action_type, channel: 'telegram' }).success).toBe(true);
    }
    expect(schema.safeParse({ action_type: 'revocation_bulk', channel: 'telegram', targets: [] }).success).toBe(false);
    expect(schema.safeParse({ action_type: 'revocation_bulk', channel: 'telegram', targets: Array.from({ length: 26 }, (_, i) => `a${i}`) }).success).toBe(false);

    http.post.mockResolvedValueOnce({ session_id: '2fa_2' });
    await tool.handler({ action_type: 'domain_remove', channel: 'telegram', targets: ['dom_1'] });
    expect(http.post).toHaveBeenLastCalledWith('/api/v1/me/2fa/start', { action_type: 'domain_remove', channel: 'telegram', targets: ['dom_1'] });
  });

  it('get_2fa_status calls GET /api/v1/me/2fa/:sessionId', async () => {
    http.get.mockResolvedValueOnce({ status: 'pending' });
    const tool = findTool(tools, 'get_2fa_status');
    await tool.handler({ session_id: '2fa_1' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/2fa/2fa_1');
  });

  it('verify_2fa calls POST /api/v1/me/2fa/:sessionId/verify', async () => {
    http.post.mockResolvedValueOnce({ status: 'verified' });
    const tool = findTool(tools, 'verify_2fa');
    await tool.handler({ session_id: '2fa_1', code: '123456' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/2fa/2fa_1/verify', { code: '123456' });
  });

  it('verify_2fa_magic_link calls POST /api/v1/me/2fa/magic/:token', async () => {
    http.post.mockResolvedValueOnce({ status: 'verified' });
    const tool = findTool(tools, 'verify_2fa_magic_link');
    await tool.handler({ token: 'magic_token_abc' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/2fa/magic/magic_token_abc');
  });

  it('wait_for_2fa polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'verified', session_id: '2fa_1' });
    const tool = findTool(tools, 'wait_for_2fa');
    const result = await tool.handler({ session_id: '2fa_1', timeout_seconds: 30 }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('verified');
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/2fa/2fa_1');
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Rate limited', 'rate_limited', 429));
    const tool = findTool(tools, 'start_2fa');
    const result = await tool.handler({ action_type: 'api_key_create', channel: 'email' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// DOMAINS
// ============================================================
describe('domains tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/domains.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 17 domain tools', () => {
    expect(tools).toHaveLength(17);
    expect(tools.map(t => t.name)).toEqual([
      'list_domains', 'add_domain', 'get_domain', 'delete_domain', 'verify_domain',
      'connect_cloudflare', 'connect_godaddy', 'connect_dns_provider', 'add_verification_provider',
      'get_dns_providers', 'verify_domain_with_credentials', 'check_domain_credentials',
      'start_domain_email_verification', 'confirm_domain_email_code', 'resend_domain_email',
      'setup_domain_email', 'check_domain_email_status',
    ]);
  });

  it('list_domains calls GET /api/v1/me/domains', async () => {
    http.get.mockResolvedValueOnce([{ id: 'dom_1', domain: 'example.com' }]);
    const tool = findTool(tools, 'list_domains');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/domains');
  });

  it('add_domain calls POST /api/v1/me/domains', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_1', domain: 'example.com', status: 'pending' });
    const tool = findTool(tools, 'add_domain');
    await tool.handler({ domain: 'example.com', verification_method: 'auto_dns' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains', { domain: 'example.com', verification_method: 'auto_dns' });
  });

  it('get_domain calls GET /api/v1/me/domains/:id', async () => {
    http.get.mockResolvedValueOnce({ id: 'dom_123', domain: 'example.com', status: 'verified' });
    const tool = findTool(tools, 'get_domain');
    await tool.handler({ id: 'dom_123' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/domains/dom_123');
  });

  it('delete_domain calls DELETE /api/v1/me/domains/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'delete_domain');
    await tool.handler({ id: 'dom_123' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/domains/dom_123');
  });

  it('verify_domain calls POST /api/v1/me/domains/:id/verify', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', status: 'verified' });
    const tool = findTool(tools, 'verify_domain');
    await tool.handler({ id: 'dom_123' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/verify');
  });

  it('connect_cloudflare calls POST /api/v1/me/domains/:id/connect/cloudflare', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', provider: 'cloudflare', connected: true });
    const tool = findTool(tools, 'connect_cloudflare');
    await tool.handler({ id: 'dom_123', api_token: 'cf_token' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/connect/cloudflare', { api_token: 'cf_token' });
  });

  it('connect_godaddy calls POST /api/v1/me/domains/:id/connect/godaddy', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', provider: 'godaddy', connected: true });
    const tool = findTool(tools, 'connect_godaddy');
    await tool.handler({ id: 'dom_123', api_key: 'gd_key', api_secret: 'gd_secret' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/connect/godaddy', { api_key: 'gd_key', api_secret: 'gd_secret' });
  });

  it('connect_dns_provider calls POST /api/v1/me/domains/:id/connect/:provider', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', provider: 'route53', connected: true });
    const tool = findTool(tools, 'connect_dns_provider');
    await tool.handler({ id: 'dom_123', provider: 'route53', credentials: { access_key: 'ak', secret_key: 'sk' } });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/connect/route53', { credentials: { access_key: 'ak', secret_key: 'sk' } });
  });

  it('add_verification_provider calls POST /api/v1/me/domains/:id/add-provider/:provider', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', provider: 'cloudflare', added: true });
    const tool = findTool(tools, 'add_verification_provider');
    await tool.handler({ id: 'dom_123', provider: 'cloudflare', credentials: { api_token: 'tok' } });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/add-provider/cloudflare', { credentials: { api_token: 'tok' } });
  });

  it('get_dns_providers calls GET /api/v1/me/dns-providers', async () => {
    http.get.mockResolvedValueOnce([{ id: 'cloudflare', name: 'Cloudflare' }]);
    const tool = findTool(tools, 'get_dns_providers');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/dns-providers');
  });

  it('verify_domain_with_credentials calls POST /api/v1/me/domains/:id/verify-with-credentials', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', status: 'verified' });
    const tool = findTool(tools, 'verify_domain_with_credentials');
    await tool.handler({ id: 'dom_123' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/verify-with-credentials');
  });

  it('check_domain_credentials calls GET /api/v1/me/domains/:id/check-credentials', async () => {
    http.get.mockResolvedValueOnce({ id: 'dom_123', credentials_valid: true });
    const tool = findTool(tools, 'check_domain_credentials');
    await tool.handler({ id: 'dom_123' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/check-credentials');
  });

  it('start_domain_email_verification calls POST /api/v1/me/domains/:id/verify-email', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', email_sent: true });
    const tool = findTool(tools, 'start_domain_email_verification');
    await tool.handler({ id: 'dom_123', email_prefix: 'admin' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/verify-email', { email_prefix: 'admin' });
  });

  it('confirm_domain_email_code calls POST /api/v1/me/domains/:id/verify-email/confirm', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', status: 'verified' });
    const tool = findTool(tools, 'confirm_domain_email_code');
    await tool.handler({ id: 'dom_123', code: '123456' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/verify-email/confirm', { code: '123456' });
  });

  it('resend_domain_email calls POST /api/v1/me/domains/:id/verify-email/resend', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'resend_domain_email');
    await tool.handler({ id: 'dom_123', email_prefix: 'postmaster' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/verify-email/resend', { email_prefix: 'postmaster' });
  });

  it('setup_domain_email calls POST /api/v1/me/domains/:id/email-setup', async () => {
    http.post.mockResolvedValueOnce({ id: 'dom_123', email_configured: true });
    const tool = findTool(tools, 'setup_domain_email');
    await tool.handler({ id: 'dom_123', from_email: 'noreply@example.com' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/email-setup', { from_email: 'noreply@example.com' });
  });

  it('check_domain_email_status calls GET /api/v1/me/domains/:id/email-status', async () => {
    http.get.mockResolvedValueOnce({ id: 'dom_123', email_status: 'active' });
    const tool = findTool(tools, 'check_domain_email_status');
    await tool.handler({ id: 'dom_123' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/domains/dom_123/email-status');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'list_domains');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// DNS CREDENTIALS
// ============================================================
describe('dns credentials tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/dns-credentials.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 3 dns credential tools', () => {
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name)).toEqual([
      'list_dns_credentials', 'create_dns_credential', 'delete_dns_credential',
    ]);
  });

  it('list_dns_credentials calls GET /api/v1/me/dns-credentials', async () => {
    http.get.mockResolvedValueOnce([{ id: 'cred_1', provider: 'cloudflare' }]);
    const tool = findTool(tools, 'list_dns_credentials');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/dns-credentials');
  });

  it('create_dns_credential calls POST /api/v1/me/dns-credentials', async () => {
    http.post.mockResolvedValueOnce({ id: 'cred_1', provider: 'cloudflare' });
    const tool = findTool(tools, 'create_dns_credential');
    await tool.handler({ provider: 'cloudflare', credentials: { api_token: 'tok' } });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/dns-credentials', { provider: 'cloudflare', credentials: { api_token: 'tok' } });
  });

  it('delete_dns_credential calls DELETE /api/v1/me/dns-credentials/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'delete_dns_credential');
    await tool.handler({ id: 'cred_123' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/dns-credentials/cred_123');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Forbidden', 'forbidden', 403));
    const tool = findTool(tools, 'list_dns_credentials');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// USER REQUESTS
// ============================================================
describe('user requests tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/user-requests.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 6 user request tools', () => {
    expect(tools).toHaveLength(6);
    expect(tools.map(t => t.name)).toEqual([
      'list_my_requests', 'list_incoming_requests', 'create_user_request',
      'cancel_user_request', 'extend_request', 'share_request_email',
    ]);

  });

  it('list_my_requests calls GET /api/v1/me/verification-requests', async () => {
    http.get.mockResolvedValueOnce([{ id: 'req_1' }]);
    const tool = findTool(tools, 'list_my_requests');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/verification-requests');
  });

  it('list_incoming_requests calls GET /api/v1/me/verification-requests/incoming', async () => {
    http.get.mockResolvedValueOnce([{ id: 'req_1' }]);
    const tool = findTool(tools, 'list_incoming_requests');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/verification-requests/incoming');
  });

  // The body the controller stores, shared with the backend suite that answers it 201
  // (`src/__tests__/controllers/me-agent-attribution.test.ts`).
  const CREATE_USER_REQUEST_EXAMPLE = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'create-user-request.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('create_user_request calls POST /api/v1/me/verification-requests', async () => {
    http.post.mockResolvedValueOnce({ id: 'req_1', status: 'pending' });
    const tool = findTool(tools, 'create_user_request');
    await tool.handler(CREATE_USER_REQUEST_EXAMPLE);
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verification-requests', CREATE_USER_REQUEST_EXAMPLE);
  });

  it('create_user_request takes the body the API stores', () => {
    const input = z.object(findTool(tools, 'create_user_request').schema as z.ZodRawShape);
    expect(input.safeParse(CREATE_USER_REQUEST_EXAMPLE).success).toBe(true);
  });

  it.each([
    ['asset types as bare strings', { assets: ['email'] }],
    ['an asset type the API does not have', { assets: [{ type: 'passport' }] }],
    ['an action type the API does not have', { assets: [{ type: 'email' }], action_type: 'onboarding' }],
    ['a string action_context', { assets: [{ type: 'email' }], action_context: 'why we ask' }],
    ['a validity requirement outside <n>h|d|w|m', { assets: [{ type: 'email' }], validity_requirement: 'recent' }],
    ['a channel the API does not have', { assets: [{ type: 'email', channel: 'carrier-pigeon' }] }],
    ['an allowed channel the API does not have', { assets: [{ type: 'phone', allowed_channels: ['sms', 'fax'] }] }],
    ['an action_context title over 100 characters', { assets: [{ type: 'email' }], action_context: { title: 't'.repeat(101) } }],
    ['an action_context description over 500 characters', { assets: [{ type: 'email' }], action_context: { description: 'd'.repeat(501) } }],
    ['an action_context currency over 10 characters', { assets: [{ type: 'email' }], action_context: { currency: 'c'.repeat(11) } }],
    ['an action_context entity over 200 characters', { assets: [{ type: 'email' }], action_context: { entity: 'e'.repeat(201) } }],
    ['a reference_id over 255 characters', { assets: [{ type: 'email' }], reference_id: 'r'.repeat(256) }],
    ['a redirect_url that is not https', { assets: [{ type: 'email' }], redirect_url: 'http://proof.holdings/done' }],
    ['a callback_url that is not https', { assets: [{ type: 'email' }], callback_url: 'http://proof.holdings/hook' }],
    ['a redirect_url over 2000 characters', { assets: [{ type: 'email' }], redirect_url: `https://proof.holdings/${'p'.repeat(1978)}` }],
    ['a callback_url over 2000 characters', { assets: [{ type: 'email' }], callback_url: `https://proof.holdings/${'p'.repeat(1978)}` }],
  ])('create_user_request refuses %s, which the API cannot store', (_label, body) => {
    const input = z.object(findTool(tools, 'create_user_request').schema as z.ZodRawShape);
    expect(input.safeParse(body).success).toBe(false);
  });

  // The API-key route's schema for the same body (`createVerificationRequestSchema`) holds these; the
  // session route has no validator and reads an empty string as the field left out, so an empty
  // identifier would ask the recipient for ANY email instead of the one meant.
  it.each([
    ['an empty identifier', { assets: [{ type: 'email', identifier: '' }] }],
    ['an identifier over 500 characters', { assets: [{ type: 'email', identifier: 'i'.repeat(501) }] }],
    ['more than 10 allowed channels', { assets: [{ type: 'phone', allowed_channels: Array(11).fill('sms') }] }],
    ['an empty reference_id', { assets: [{ type: 'email' }], reference_id: '' }],
    ['an empty public_profile_id', { assets: [{ type: 'email' }], public_profile_id: '' }],
    ['a public_profile_id that is not a profile ID', { assets: [{ type: 'email' }], public_profile_id: 'not-an-object-id' }],
    ['an empty action_context title', { assets: [{ type: 'email' }], action_context: { title: '' } }],
    ['an action_context amount that is not positive', { assets: [{ type: 'email' }], action_context: { amount: 0 } }],
  ])('create_user_request refuses %s, as the API-key route does', (_label, body) => {
    const input = z.object(findTool(tools, 'create_user_request').schema as z.ZodRawShape);
    expect(input.safeParse(body).success).toBe(false);
  });

  // The API-key route refuses these (`missing_action_context`); the session route does not, and would
  // store a request that tells the recipient nothing about what they are approving.
  it.each([
    ['custom', undefined],
    ['custom', {}],
    ['confirmation', { description: 'Release 2.4 to production' }],
  ])('create_user_request refuses a %s request whose action_context has no title, without calling the API', async (actionType, context) => {
    const tool = findTool(tools, 'create_user_request');
    const result = await tool.handler({ assets: [{ type: 'email' }], action_type: actionType, action_context: context }) as {
      isError?: boolean; content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^missing_action_context: /);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('create_user_request sends a custom request that carries a title', async () => {
    http.post.mockResolvedValueOnce({ id: 'req_1', status: 'pending' });
    const body = { assets: [{ type: 'email' }], action_type: 'custom', action_context: { title: 'Approve the release' } };
    await findTool(tools, 'create_user_request').handler(body);
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verification-requests', body);
  });

  it('create_user_request takes channels and strings at the API’s own limits', () => {
    const input = z.object(findTool(tools, 'create_user_request').schema as z.ZodRawShape);
    const longest = `https://proof.holdings/${'p'.repeat(1977)}`;
    expect(longest).toHaveLength(2000);
    expect(input.safeParse({
      assets: [{ type: 'phone', identifier: 'i'.repeat(500), channel: 'whatsapp', allowed_channels: Array(10).fill('sms') }],
      reference_id: 'r'.repeat(255),
      public_profile_id: '507f1f77bcf86cd799439011',
      action_context: { title: 't'.repeat(100), description: 'd'.repeat(500), currency: 'c'.repeat(10), entity: 'e'.repeat(200) },
      redirect_url: longest,
      callback_url: longest,
    }).success).toBe(true);
  });

  it('cancel_user_request calls DELETE /api/v1/me/verification-requests/:id', async () => {
    http.del.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'cancel_user_request');
    await tool.handler({ id: 'req_123' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/me/verification-requests/req_123');
  });

  it('extend_request calls POST /api/v1/me/verification-requests/:id/extend', async () => {
    http.post.mockResolvedValueOnce({ id: 'req_123', extended: true });
    const tool = findTool(tools, 'extend_request');
    await tool.handler({ id: 'req_123' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verification-requests/req_123/extend');
  });

  it('share_request_email calls POST /api/v1/me/verification-requests/:id/share-email', async () => {
    http.post.mockResolvedValueOnce({ success: true });
    const tool = findTool(tools, 'share_request_email');
    await tool.handler({ id: 'req_123' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verification-requests/req_123/share-email');
  });

  it('returns error result on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'list_my_requests');
    const result = await tool.handler({}) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// USER DOMAIN VERIFY
// ============================================================
describe('user domain verify tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/user-domain-verify.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 3 user domain verify tools', () => {
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name)).toEqual([
      'start_user_domain_verification', 'get_user_domain_verification_status', 'check_user_domain_verification',
    ]);

  });

  it('start_user_domain_verification calls POST /api/v1/me/verify/domain', async () => {
    http.post.mockResolvedValueOnce({ session_id: 'ses_1', status: 'pending' });
    const tool = findTool(tools, 'start_user_domain_verification');
    await tool.handler({ domain: 'example.com', channel: 'dns' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verify/domain', { domain: 'example.com', channel: 'dns' });
  });

  it('get_user_domain_verification_status calls GET /api/v1/me/verify/domain/:sessionId', async () => {
    http.get.mockResolvedValueOnce({ session_id: 'ses_1', status: 'pending' });
    const tool = findTool(tools, 'get_user_domain_verification_status');
    await tool.handler({ session_id: 'ses_1' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/me/verify/domain/ses_1');
  });

  it('check_user_domain_verification calls POST /api/v1/me/verify/domain/:sessionId/check', async () => {
    http.post.mockResolvedValueOnce({ session_id: 'ses_1', status: 'verified' });
    const tool = findTool(tools, 'check_user_domain_verification');
    await tool.handler({ session_id: 'ses_1' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/verify/domain/ses_1/check');
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Bad request', 'bad_request', 400));
    const tool = findTool(tools, 'start_user_domain_verification');
    const result = await tool.handler({ domain: 'bad' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// PUBLIC PROFILES
// ============================================================
describe('public profiles tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/public-profiles.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 2 public profile tools', () => {
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual([
      'claim_username', 'update_public_proofs',
    ]);

  });

  it('claim_username calls POST /api/v1/profiles/me/username', async () => {
    http.post.mockResolvedValueOnce({ username: 'testuser', claimed: true });
    const tool = findTool(tools, 'claim_username');
    await tool.handler({ username: 'testuser' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/profiles/me/username', { username: 'testuser' });
  });

  it('update_public_proofs calls PUT /api/v1/profiles/me/proofs', async () => {
    http.put.mockResolvedValueOnce({ updated: true });
    const tool = findTool(tools, 'update_public_proofs');
    await tool.handler({
      proofs: [{
        asset_id: 'asset_1',
        is_visible: true,
        mask_level: 'partial',
        display_order: 2,
        label: 'My Phone',
      }],
    });
    expect(http.put).toHaveBeenCalledWith('/api/v1/profiles/me/proofs', {
      proofs: [{ asset_id: 'asset_1', is_visible: true, mask_level: 'partial', display_order: 2, label: 'My Phone' }],
    });
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Conflict', 'conflict', 409));
    const tool = findTool(tools, 'claim_username');
    const result = await tool.handler({ username: 'taken' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// AUTHORIZATIONS
// ============================================================
describe('authorizations tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/authorizations.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers 5 authorization tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map(t => t.name).sort()).toEqual([
      'create_authorization',
      'export_authorizations',
      'get_authorization',
      'list_authorizations',
      'revoke_authorization',
    ]);
  });

  const consentArgs = {
    hitl_id: '64b7f0c2a1b2c3d4e5f60718',
    recipient: '123456789',
    phone: '+15551234567',
    channel: 'telegram',
  };

  it('create_authorization calls http.post', async () => {
    http.post.mockResolvedValueOnce({ id: 'auth_123', status: 'pending' });
    const tool = findTool(tools, 'create_authorization');
    await tool.handler(consentArgs);
    expect(http.post).toHaveBeenCalledWith('/api/v1/authorizations', consentArgs);
  });

  it('create_authorization accepts a call without business_name and marks it deprecated (#416)', () => {
    const tool = findTool(tools, 'create_authorization');
    const schema = z.object(tool.schema as z.ZodRawShape);
    expect(schema.safeParse(consentArgs).success).toBe(true);
    expect(schema.safeParse({ ...consentArgs, business_name: 'Acme Corp' }).success).toBe(true);
    // Positive control: the schema still refuses a call missing a field the server requires.
    const { hitl_id: _omitted, ...withoutSetup } = consentArgs;
    expect(schema.safeParse(withoutSetup).success).toBe(false);
    expect((tool.schema.business_name as z.ZodTypeAny).description).toMatch(/^Deprecated and ignored/);
  });

  it('get_authorization calls http.get with encoded ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'auth_123' });
    const tool = findTool(tools, 'get_authorization');
    await tool.handler({ id: 'auth/special' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/authorizations/auth%2Fspecial');
  });

  it('list_authorizations passes filters to http.get', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_authorizations');
    await tool.handler({ status: 'active', channel: 'whatsapp', limit: 10 });
    expect(http.get).toHaveBeenCalledWith('/api/v1/authorizations', {
      status: 'active',
      channel: 'whatsapp',
      limit: 10,
    });
  });

  it('revoke_authorization calls http.del with body', async () => {
    http.del.mockResolvedValueOnce({ id: 'auth_123', status: 'revoked' });
    const tool = findTool(tools, 'revoke_authorization');
    await tool.handler({ id: 'auth_123', reason: 'No longer needed' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/authorizations/auth_123', { reason: 'No longer needed' });
  });

  it('revoke_authorization omits reason when not provided', async () => {
    http.del.mockResolvedValueOnce({ id: 'auth_123', status: 'revoked' });
    const tool = findTool(tools, 'revoke_authorization');
    await tool.handler({ id: 'auth_123' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/authorizations/auth_123', undefined);
  });

  it('export_authorizations passes query params', async () => {
    http.get.mockResolvedValueOnce({ data: [], total: 0 });
    const tool = findTool(tools, 'export_authorizations');
    await tool.handler({ format: 'json', status: 'active' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/authorizations/export', {
      format: 'json',
      status: 'active',
    });
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Authorization exists', 'authorization_exists', 409));
    const tool = findTool(tools, 'create_authorization');
    const result = await tool.handler(consentArgs) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// HITL
// ============================================================
describe('hitl tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/hitl.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers 9 hitl tools', () => {
    expect(tools).toHaveLength(9);
    expect(tools.map(t => t.name).sort()).toEqual([
      'create_chat_id_discovery',
      'create_hitl',
      'delete_hitl',
      'get_hitl',
      'list_hitls',
      'poll_chat_id_discovery',
      'request_hitl_authorization',
      'update_hitl',
      'wait_for_chat_id_discovery',
    ]);
  });

  it('create_hitl calls http.post', async () => {
    http.post.mockResolvedValueOnce({ id: 'hitl_123', status: 'active' });
    const tool = findTool(tools, 'create_hitl');
    await tool.handler({
      name: 'My HITL',
      channels: [{ type: 'telegram', config: { chat_id: '123456' } }],
      timeout_seconds: 1800,
    });
    expect(http.post).toHaveBeenCalledWith('/api/v1/hitl', {
      name: 'My HITL',
      channels: [{ type: 'telegram', config: { chat_id: '123456' } }],
      timeout_seconds: 1800,
    });
  });

  it('get_hitl calls http.get with encoded ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'hitl_123' });
    const tool = findTool(tools, 'get_hitl');
    await tool.handler({ id: 'hitl/special' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/hitl/hitl%2Fspecial');
  });

  it('list_hitls passes filters to http.get', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_hitls');
    await tool.handler({ status: 'active', page: 1, limit: 10 });
    expect(http.get).toHaveBeenCalledWith('/api/v1/hitl', {
      status: 'active',
      page: 1,
      limit: 10,
    });
  });

  it('list_hitls omits undefined filters', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_hitls');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/hitl', {});
  });

  it('update_hitl calls http.patch with body excluding id', async () => {
    http.patch.mockResolvedValueOnce({ id: 'hitl_123', name: 'Updated' });
    const tool = findTool(tools, 'update_hitl');
    await tool.handler({
      id: 'hitl_123',
      name: 'Updated',
      channels: [{ type: 'whatsapp', config: { phone_number: '+1234567890' } }],
    });
    expect(http.patch).toHaveBeenCalledWith('/api/v1/hitl/hitl_123', {
      name: 'Updated',
      channels: [{ type: 'whatsapp', config: { phone_number: '+1234567890' } }],
    });
  });

  it('delete_hitl calls http.del', async () => {
    http.del.mockResolvedValueOnce({ id: 'hitl_123', status: 'archived' });
    const tool = findTool(tools, 'delete_hitl');
    await tool.handler({ id: 'hitl_123' });
    expect(http.del).toHaveBeenCalledWith('/api/v1/hitl/hitl_123');
  });

  it('wait_for_chat_id_discovery polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'completed', chat_id: '123456' });
    const tool = findTool(tools, 'wait_for_chat_id_discovery');
    const result = await tool.handler({ token: 'disc_token_1', timeout_seconds: 30 }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('completed');
    expect(parsed.chat_id).toBe('123456');
    expect(http.get).toHaveBeenCalledWith('/api/v1/hitl/chat-id-discovery/disc_token_1');
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Validation failed', 'validation_error', 422));
    const tool = findTool(tools, 'create_hitl');
    const result = await tool.handler({
      name: 'Bad HITL',
      channels: [{ type: 'telegram', config: { chat_id: '123' } }],
    }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// CONFIRMATIONS
// ============================================================
describe('confirmations tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/confirmations.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers 5 confirmation tools', () => {
    expect(tools).toHaveLength(5);
    expect(tools.map(t => t.name).sort()).toEqual([
      'create_confirmation',
      'get_confirmation',
      'get_confirmation_approval_link',
      'list_confirmations',
      'wait_for_confirmation',
    ]);
  });

  it('create_confirmation calls http.post', async () => {
    http.post.mockResolvedValueOnce({ id: 'conf_123', status: 'pending' });
    const tool = findTool(tools, 'create_confirmation');
    await tool.handler({
      hitl_id: '507f1f77bcf86cd799439011',
      message: 'Approve this deployment?',
    });
    expect(http.post).toHaveBeenCalledWith('/api/v1/confirmations', {
      hitl_id: '507f1f77bcf86cd799439011',
      message: 'Approve this deployment?',
    });
  });

  it('get_confirmation calls http.get with encoded ID', async () => {
    http.get.mockResolvedValueOnce({ id: 'conf_123', status: 'pending' });
    const tool = findTool(tools, 'get_confirmation');
    await tool.handler({ id: 'conf/special' });
    expect(http.get).toHaveBeenCalledWith('/api/v1/confirmations/conf%2Fspecial');
  });

  it('list_confirmations passes filters to http.get', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_confirmations');
    await tool.handler({
      status: 'pending',
      hitl_id: '507f1f77bcf86cd799439011',
      page: 1,
      limit: 25,
    });
    expect(http.get).toHaveBeenCalledWith('/api/v1/confirmations', {
      status: 'pending',
      hitl_id: '507f1f77bcf86cd799439011',
      page: 1,
      limit: 25,
    });
  });

  it('list_confirmations omits undefined filters', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_confirmations');
    await tool.handler({});
    expect(http.get).toHaveBeenCalledWith('/api/v1/confirmations', {});
  });

  it('get_confirmation_approval_link calls http.post with encoded ID', async () => {
    http.post.mockResolvedValueOnce({ approval_url: 'https://proof.holdings/approve/token123' });
    const tool = findTool(tools, 'get_confirmation_approval_link');
    await tool.handler({ id: '507f1f77bcf86cd799439011' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/confirmations/507f1f77bcf86cd799439011/approval-link');
  });

  it('wait_for_confirmation polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'approved', proof_token: 'tok_123' });
    const tool = findTool(tools, 'wait_for_confirmation');
    const result = await tool.handler({ id: 'conf_123', timeout_seconds: 30 }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('approved');
    expect(parsed.proof_token).toBe('tok_123');
    expect(http.get).toHaveBeenCalledWith('/api/v1/confirmations/conf_123');
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('HITL not found', 'not_found', 404));
    const tool = findTool(tools, 'create_confirmation');
    const result = await tool.handler({
      hitl_id: '507f1f77bcf86cd799439011',
      message: 'Test',
    }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// RENDER AUTH LINK
// ============================================================
describe('render-auth-link tools', () => {
  let tools: RegisteredTool[];

  beforeEach(async () => {
    const mod = await import('../src/tools/render-auth-link.js');
    tools = captureTools(mod.registerTools);
  });

  it('registers render_auth_link tool', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('render_auth_link');
  });

  it('renders URL and QR code for a valid URL', async () => {
    const tool = findTool(tools, 'render_auth_link');
    const result = await tool.handler({ url: 'https://example.com/verify/abc123' }) as { content: { text: string }[] };

    const text = result.content[0].text;
    expect(text).toContain('https://example.com/verify/abc123');
    expect(text).toContain('```');
  });

  it('includes label when provided', async () => {
    const tool = findTool(tools, 'render_auth_link');
    const result = await tool.handler({
      url: 'https://example.com/verify/abc123',
      label: 'Verify your phone number',
    }) as { content: { text: string }[] };

    const text = result.content[0].text;
    expect(text).toContain('Verify your phone number');
    expect(text).toContain('https://example.com/verify/abc123');
    expect(text).toContain('```');
  });

  it('omits label line when not provided', async () => {
    const tool = findTool(tools, 'render_auth_link');
    const result = await tool.handler({ url: 'https://example.com/test' }) as { content: { text: string }[] };

    const text = result.content[0].text;
    // Should start with the URL, not a label
    expect(text.startsWith('https://example.com/test')).toBe(true);
  });

  it('wraps QR code in markdown code block', async () => {
    const tool = findTool(tools, 'render_auth_link');
    const result = await tool.handler({ url: 'https://example.com' }) as { content: { text: string }[] };

    const text = result.content[0].text;
    const codeBlockStart = text.indexOf('```');
    const codeBlockEnd = text.lastIndexOf('```');
    // Two distinct ``` markers (open and close)
    expect(codeBlockStart).not.toBe(codeBlockEnd);
  });

  it('does not set isError on result', async () => {
    const tool = findTool(tools, 'render_auth_link');
    const result = await tool.handler({ url: 'https://example.com' }) as { isError?: boolean };
    expect(result.isError).toBeUndefined();
  });

  it('description documents agent usage and render_auth_link purpose', () => {
    const tool = findTool(tools, 'render_auth_link');
    expect(tool.description).toContain('local computation');
    expect(tool.description).toContain('no HTTP');
    expect(tool.description).toContain('qr_text');
  });
});

describe('multi-channel billing claim (m-usage-overage-and-upgrade, SC-3)', () => {
  /**
   * This tool's description told agents "Quota is charged per channel" — false since the meter
   * moved to proof ISSUANCE: one group can only ever produce ONE proof, and it is billed at
   * whichever channel completes. The description is what an agent reads BEFORE calling, so a
   * false billing claim here reaches a caller that never sees our docs.
   *
   * It is asserted HERE rather than in the issuer repo's own guard because this is where the
   * registered tool RESOLVES: `findTool` returns the object the server hands out, so the claim is
   * bound to the description in force. Scanning the source file instead would keep passing if the
   * descriptions were ever centralised out of it — the tool name would stay behind and the
   * sentence would leave.
   */
  it('tells agents one proof is billed, not one per channel', async () => {
    const mod = await import('../src/tools/verifications.js');
    const tools = captureTools(mod.registerTools, createMockHttp());
    const tool = findTool(tools, 'create_multi_channel_verification');

    expect(tool.description).toContain('Exactly one proof is billed');
    expect(tool.description).toContain('not one per channel');
    expect(tool.description.toLowerCase()).not.toContain('quota is charged');
  });
});

// ============================================================
// AUTH FLOWS
// ============================================================
describe('auth-flows tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/auth-flows.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers 2 auth flow tools', () => {
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['start_login', 'wait_for_login']);
  });

  it('start_login calls POST /api/v1/auth/sessions', async () => {
    http.post.mockResolvedValueOnce({ id: 'auth_123', status: 'pending', deep_link: 'https://t.me/bot?start=auth_123' });
    const tool = findTool(tools, 'start_login');
    await tool.handler({ channel: 'telegram' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/auth/sessions', { channel: 'telegram' });
  });

  it('start_login passes optional phone_number and email', async () => {
    http.post.mockResolvedValueOnce({ id: 'auth_456', status: 'pending' });
    const tool = findTool(tools, 'start_login');
    await tool.handler({ channel: 'sms', phone_number: '+1234567890' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/auth/sessions', { channel: 'sms', phone_number: '+1234567890' });
  });

  it('start_login description references render_auth_link', () => {
    const tool = findTool(tools, 'start_login');
    expect(tool.description).toContain('render_auth_link');
  });

  it('wait_for_login polls until terminal state', async () => {
    http.get
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'verified', user_id: 'user_123' });
    const tool = findTool(tools, 'wait_for_login');
    const result = await tool.handler({ id: 'auth_123', timeout_seconds: 30 }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('verified');
    expect(parsed.user_id).toBe('user_123');
    expect(http.get).toHaveBeenCalledWith('/api/v1/auth/sessions/auth_123');
  });

  it('wait_for_login returns error on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'wait_for_login');
    const result = await tool.handler({ id: 'bad_id' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('start_login returns error on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Rate limited', 'rate_limited', 429));
    const tool = findTool(tools, 'start_login');
    const result = await tool.handler({ channel: 'telegram' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('accounts tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/accounts.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers 4 account tools', () => {
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name).sort()).toEqual(
      ['create_account', 'send_account_email', 'start_2fa_for_action', 'wait_for_account_creation'].sort(),
    );
  });

  it('send_account_email calls POST /api/v1/accounts/:id/send', async () => {
    http.post.mockResolvedValueOnce({ id: 'auth_x', channel: 'email', email_sent: true });
    const tool = findTool(tools, 'send_account_email');

    await tool.handler({ id: 'auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    expect(http.post).toHaveBeenCalledWith('/api/v1/accounts/auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/send');
  });

  it('create_account tells the agent the email is NOT sent yet', async () => {
    // The description is what an agent reads instead of the schema. If it still implied the mail
    // went out, the two-step send would be defeated by an agent that simply never takes step two —
    // and the user would sit waiting for a message nobody asked us to deliver.
    const description = findTool(tools, 'create_account').description;

    expect(description).toMatch(/SENDS NOTHING HERE/i);
    expect(description).toContain('send_account_email');
  });

  it('create_account calls POST /api/v1/accounts with args', async () => {
    http.post.mockResolvedValueOnce({
      id: 'auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      type: 'account_creation',
      channel: 'telegram',
      status: 'pending',
    });
    const tool = findTool(tools, 'create_account');
    await tool.handler({ channel: 'telegram' });
    expect(http.post).toHaveBeenCalledWith('/api/v1/accounts', { channel: 'telegram' });
  });

  it('create_account description documents enumeration-safe uniform response and post-auth distinguishment path', () => {
    const tool = findTool(tools, 'create_account');
    // Response is intentionally uniform to avoid user-enumeration — the
    // description must tell the agent the endpoint is safe for both new and
    // returning identities, and point to `get_current_user` for distinguishing.
    expect(tool.description).toMatch(/uniform|safe to call regardless/i);
    expect(tool.description).toContain('get_current_user');
  });

  it('wait_for_account_creation polls until verified', async () => {
    http.get
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'verified', user_id: 'user_abc' });
    const tool = findTool(tools, 'wait_for_account_creation');
    const result = await tool.handler({ id: 'auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timeout_seconds: 30 }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('verified');
    expect(parsed.user_id).toBe('user_abc');
    expect(http.get).toHaveBeenCalledWith('/api/v1/accounts/auth_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('wait_for_account_creation returns error on ApiError', async () => {
    http.get.mockRejectedValueOnce(new ApiError('Not found', 'not_found', 404));
    const tool = findTool(tools, 'wait_for_account_creation');
    const result = await tool.handler({ id: 'bad_id' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('create_account returns error on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Rate limited', 'rate_limited', 429));
    const tool = findTool(tools, 'create_account');
    const result = await tool.handler({ channel: 'email', email: 'alex@example.com' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('start_2fa_for_action calls POST /api/v1/me/2fa/start with all params', async () => {
    http.post.mockResolvedValueOnce({ session_id: '2fa_abc', channel: 'whatsapp' });
    const tool = findTool(tools, 'start_2fa_for_action');
    await tool.handler({
      action_type: 'settings_write',
      channel: 'whatsapp',
      ttl_seconds: 3600,
      single_use: false,
    });
    expect(http.post).toHaveBeenCalledWith('/api/v1/me/2fa/start', {
      action_type: 'settings_write',
      channel: 'whatsapp',
      ttl_seconds: 3600,
      single_use: false,
    });
  });

  it('start_2fa_for_action accepts configuration scope action types', async () => {
    http.post.mockResolvedValueOnce({ session_id: '2fa_def', channel: 'email' });
    const tool = findTool(tools, 'start_2fa_for_action');
    const result = await tool.handler({
      action_type: 'profile_update',
      channel: 'email',
    });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('start_2fa_for_action offers the 1.5.0 action types and binds the grant to its targets', async () => {
    const tool = findTool(tools, 'start_2fa_for_action');
    const schema = z.object(tool.schema as z.ZodRawShape);
    for (const action_type of ['revocation_bulk', 'domain_remove', 'profile_delete', 'phone_primary', 'email_primary']) {
      expect(schema.safeParse({ action_type, channel: 'telegram' }).success).toBe(true);
    }
    http.post.mockResolvedValueOnce({ session_id: '2fa_t' });
    await tool.handler({ action_type: 'revocation_bulk', channel: 'telegram', targets: ['asset_1'] });
    expect(http.post).toHaveBeenLastCalledWith('/api/v1/me/2fa/start', { action_type: 'revocation_bulk', channel: 'telegram', targets: ['asset_1'] });
  });

  it('start_2fa_for_action returns error on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('2FA required', '2fa_required', 403));
    const tool = findTool(tools, 'start_2fa_for_action');
    const result = await tool.handler({ action_type: 'api_key_create', channel: 'whatsapp' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

// ============================================================
// PROOF-ME
// ============================================================
describe('proof-me tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  const CIRCLE_ID = '0123456789abcdef01234567';
  const MEMBER_ID = 'fedcba9876543210fedcba98';
  const CHALLENGE_ID = 'aaaabbbbccccddddeeeeffff';

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/proof-me.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers both proof-me tools', () => {
    expect(tools).toHaveLength(2);
    const names = tools.map(t => t.name);
    expect(names).toContain('create_identity_challenge');
    expect(names).toContain('get_identity_challenge');
  });

  it('create_identity_challenge calls POST /api/v1/identity-challenges with circle_id/member_id', async () => {
    http.post.mockResolvedValueOnce({ id: CHALLENGE_ID, status: 'pending' });
    const tool = findTool(tools, 'create_identity_challenge');
    await tool.handler({ circle_id: CIRCLE_ID, member_id: MEMBER_ID });

    expect(http.post).toHaveBeenCalledWith('/api/v1/identity-challenges', {
      circle_id: CIRCLE_ID,
      member_id: MEMBER_ID,
    });
  });

  it('get_identity_challenge calls GET /api/v1/identity-challenges/:id', async () => {
    http.get.mockResolvedValueOnce({ id: CHALLENGE_ID, status: 'active' });
    const tool = findTool(tools, 'get_identity_challenge');
    await tool.handler({ id: CHALLENGE_ID });

    expect(http.get).toHaveBeenCalledWith(`/api/v1/identity-challenges/${CHALLENGE_ID}`);
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Forbidden', 'forbidden', 403));
    const tool = findTool(tools, 'create_identity_challenge');
    const result = await tool.handler({ circle_id: CIRCLE_ID, member_id: MEMBER_ID }) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// HITL KEYS
// ============================================================
describe('hitl-keys tools', () => {
  it('get_hitl_keys says what a key without hitl:read receives', async () => {
    // GET /hitl/:id/keys answers a key holding confirmations:create but not hitl:read with
    // { public_key, kid } only (src/controllers/hitl.ts) — the description must not promise it more.
    const mod = await import('../src/tools/hitl-keys.js');
    const tools = captureTools(mod.registerTools, createMockHttp());
    const description = findTool(tools, 'get_hitl_keys').description;
    expect(description).toMatch(/confirmations:create/);
    expect(description).toMatch(/hitl:read/);
    expect(description).toMatch(/only `public_key` and `kid`/);
  });
});

// ============================================================
// CIRCLES
// ============================================================
describe('circles tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  const CIRCLE_ID = '0123456789abcdef01234567';
  const MEMBER_ID = 'fedcba9876543210fedcba98';
  const CHANNEL_ID = 'aaaabbbbccccddddeeeeffff';

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/circles.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 13 circle tools', () => {
    expect(tools).toHaveLength(13);
    const names = tools.map(t => t.name);
    expect(names).toContain('create_circle');
    expect(names).toContain('list_circles');
    expect(names).toContain('get_circle');
    expect(names).toContain('update_circle');
    expect(names).toContain('delete_circle');
    expect(names).toContain('add_circle_member');
    expect(names).toContain('list_circle_members');
    expect(names).toContain('invite_circle_member');
    expect(names).toContain('create_circle_member_drill');
    expect(names).toContain('remove_circle_member');
    expect(names).toContain('add_circle_member_channel');
    expect(names).toContain('list_circle_member_channels');
    expect(names).toContain('remove_circle_member_channel');
  });

  it('create_circle calls POST /api/v1/circles with the body', async () => {
    http.post.mockResolvedValueOnce({ id: CIRCLE_ID, status: 'active' });
    const tool = findTool(tools, 'create_circle');
    await tool.handler({ name: 'Family', proof_me_enabled: true });

    expect(http.post).toHaveBeenCalledWith('/api/v1/circles', { name: 'Family', proof_me_enabled: true });
  });

  it.each(['create_circle', 'update_circle'])('%s accepts the owner_name the REST endpoint accepts', (name) => {
    // REST (createCircleSchema / updateCircleSchema) takes a nullable owner_name of at most 100
    // characters; the handlers forward their args whole, so the schema is the only gate.
    const tool = findTool(tools, name);
    expect(Object.keys(tool.schema)).toContain('owner_name');
    const ownerName = tool.schema.owner_name as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(ownerName.safeParse('Dad').success).toBe(true);
    expect(ownerName.safeParse(null).success).toBe(true);
    expect(ownerName.safeParse(undefined).success).toBe(true);
    expect(ownerName.safeParse('x'.repeat(100)).success).toBe(true);
    expect(ownerName.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('update_circle forwards owner_name, including null to clear it', async () => {
    http.patch.mockResolvedValue({ id: CIRCLE_ID });
    const tool = findTool(tools, 'update_circle');
    await tool.handler({ id: CIRCLE_ID, owner_name: 'Dad' });
    await tool.handler({ id: CIRCLE_ID, owner_name: null });

    expect(http.patch).toHaveBeenNthCalledWith(1, `/api/v1/circles/${CIRCLE_ID}`, { owner_name: 'Dad' });
    expect(http.patch).toHaveBeenNthCalledWith(2, `/api/v1/circles/${CIRCLE_ID}`, { owner_name: null });
  });

  it('update_circle no longer claims the name is the only mutable field', () => {
    expect(findTool(tools, 'update_circle').description).not.toMatch(/Only the display name is mutable/);
  });

  it('list_circles calls GET /api/v1/circles with a filtered query', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_circles');
    await tool.handler({ status: 'active', limit: 20 });

    expect(http.get).toHaveBeenCalledWith('/api/v1/circles', { status: 'active', limit: 20 });
  });

  it('get_circle calls GET /api/v1/circles/:id', async () => {
    http.get.mockResolvedValueOnce({ id: CIRCLE_ID });
    const tool = findTool(tools, 'get_circle');
    await tool.handler({ id: CIRCLE_ID });

    expect(http.get).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}`);
  });

  it('update_circle calls PATCH /api/v1/circles/:id without id in body', async () => {
    http.patch.mockResolvedValueOnce({ id: CIRCLE_ID, name: 'Renamed' });
    const tool = findTool(tools, 'update_circle');
    await tool.handler({ id: CIRCLE_ID, name: 'Renamed' });

    expect(http.patch).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}`, { name: 'Renamed' });
  });

  it('delete_circle calls DELETE /api/v1/circles/:id', async () => {
    http.del.mockResolvedValueOnce({});
    const tool = findTool(tools, 'delete_circle');
    await tool.handler({ id: CIRCLE_ID });

    expect(http.del).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}`);
  });

  it('add_circle_member calls POST .../members without id in body', async () => {
    http.post.mockResolvedValueOnce({ id: MEMBER_ID, status: 'pending' });
    const tool = findTool(tools, 'add_circle_member');
    await tool.handler({ id: CIRCLE_ID, name: 'Alex', whatsapp_phone: '+15551234567' });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members`, {
      name: 'Alex',
      whatsapp_phone: '+15551234567',
    });
  });

  it('list_circle_members calls GET .../members', async () => {
    http.get.mockResolvedValueOnce({ members: [] });
    const tool = findTool(tools, 'list_circle_members');
    await tool.handler({ id: CIRCLE_ID });

    expect(http.get).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members`);
  });

  it('invite_circle_member calls POST .../members/invite with member_id', async () => {
    http.post.mockResolvedValueOnce({ token: 'pm_abc' });
    const tool = findTool(tools, 'invite_circle_member');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members/invite`, {
      member_id: MEMBER_ID,
    });
  });

  it('create_circle_member_drill calls POST .../members/:memberId/drill', async () => {
    http.post.mockResolvedValueOnce({ id: 'chal', status: 'pending' });
    const tool = findTool(tools, 'create_circle_member_drill');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members/${MEMBER_ID}/drill`);
  });

  it('remove_circle_member calls DELETE .../members/:memberId', async () => {
    http.del.mockResolvedValueOnce({});
    const tool = findTool(tools, 'remove_circle_member');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID });

    expect(http.del).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members/${MEMBER_ID}`);
  });

  it('add_circle_member_channel calls POST .../channels without id/member_id in body', async () => {
    http.post.mockResolvedValueOnce({ id: CHANNEL_ID, channel: 'telegram' });
    const tool = findTool(tools, 'add_circle_member_channel');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID, channel: 'telegram', identifier: '123456789' });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members/${MEMBER_ID}/channels`, {
      channel: 'telegram',
      identifier: '123456789',
    });
  });

  it('list_circle_member_channels calls GET .../channels', async () => {
    http.get.mockResolvedValueOnce({ channels: [] });
    const tool = findTool(tools, 'list_circle_member_channels');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID });

    expect(http.get).toHaveBeenCalledWith(`/api/v1/circles/${CIRCLE_ID}/members/${MEMBER_ID}/channels`);
  });

  it('remove_circle_member_channel calls DELETE .../channels/:channelId', async () => {
    http.del.mockResolvedValueOnce({});
    const tool = findTool(tools, 'remove_circle_member_channel');
    await tool.handler({ id: CIRCLE_ID, member_id: MEMBER_ID, channel_id: CHANNEL_ID });

    expect(http.del).toHaveBeenCalledWith(
      `/api/v1/circles/${CIRCLE_ID}/members/${MEMBER_ID}/channels/${CHANNEL_ID}`,
    );
  });

  it('returns error result on ApiError', async () => {
    http.post.mockRejectedValueOnce(new ApiError('Forbidden', 'forbidden', 403));
    const tool = findTool(tools, 'create_circle');
    const result = await tool.handler({ name: 'X' }) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// DELEGATIONS
// ============================================================
describe('delegations tools', () => {
  let http: ReturnType<typeof createMockHttp>;
  let tools: RegisteredTool[];

  const PH_DLG = 'ph_dlg_' + 'a'.repeat(32);
  const PH_CTL = 'ph_ctl_' + 'b'.repeat(32);
  const OBJECT_ID = '507f1f77bcf86cd799439011';

  beforeEach(async () => {
    http = createMockHttp();
    const mod = await import('../src/tools/delegations.js');
    tools = captureTools(mod.registerTools, http);
  });

  it('registers all 4 delegation tools', () => {
    expect(tools).toHaveLength(4);
    const names = tools.map(t => t.name);
    expect(names).toContain('create_delegation');
    expect(names).toContain('list_delegations');
    expect(names).toContain('get_delegation');
    expect(names).toContain('revoke_delegation');
  });

  it('create_delegation calls POST /api/v1/delegations with the typed body', async () => {
    http.post.mockResolvedValueOnce({ id: OBJECT_ID, delegation_id: PH_DLG, token: 'eyJ.token.sig' });
    const tool = findTool(tools, 'create_delegation');
    const args = {
      control_proof: PH_CTL,
      delegate: { type: 'purl', value: 'pkg:npm/@postmark/mcp' },
      scope: ['email:send'],
    };
    await tool.handler(args);

    expect(http.post).toHaveBeenCalledWith('/api/v1/delegations', args);
  });

  it('create_delegation schema pins the control proof and delegate shapes', () => {
    const tool = findTool(tools, 'create_delegation');
    expect(Object.keys(tool.schema)).toEqual(['control_proof', 'delegate', 'scope', 'expires_in']);
  });

  it('list_delegations calls GET /api/v1/delegations with a filtered query', async () => {
    http.get.mockResolvedValueOnce({ data: [], pagination: {} });
    const tool = findTool(tools, 'list_delegations');
    await tool.handler({ status: 'active', limit: 20 });

    expect(http.get).toHaveBeenCalledWith('/api/v1/delegations', { status: 'active', limit: 20 });
  });

  it('get_delegation calls GET /api/v1/delegations/:id with the handle', async () => {
    http.get.mockResolvedValueOnce({ id: OBJECT_ID, token: 'eyJ.token.sig', is_valid: true });
    const tool = findTool(tools, 'get_delegation');
    await tool.handler({ id: PH_DLG });

    expect(http.get).toHaveBeenCalledWith(`/api/v1/delegations/${PH_DLG}`);
  });

  it('revoke_delegation calls POST /api/v1/delegations/:id/revoke with the reason', async () => {
    http.post.mockResolvedValueOnce({ id: OBJECT_ID, status: 'revoked' });
    const tool = findTool(tools, 'revoke_delegation');
    await tool.handler({ id: OBJECT_ID, reason: 'key_compromise' });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/delegations/${OBJECT_ID}/revoke`, { reason: 'key_compromise' });
  });

  it('revoke_delegation omits the body when no reason is given', async () => {
    http.post.mockResolvedValueOnce({ status: 'revoked' });
    const tool = findTool(tools, 'revoke_delegation');
    await tool.handler({ id: PH_DLG });

    expect(http.post).toHaveBeenCalledWith(`/api/v1/delegations/${PH_DLG}/revoke`, undefined);
  });

  it('handlers return errorResult on ApiError instead of throwing', async () => {
    http.post.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Delegation not found'));
    const tool = findTool(tools, 'revoke_delegation');
    const result = await tool.handler({ id: PH_DLG }) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

// ============================================================
// PUBLIC MODE — keyed tools degrade to a hint, not a crash
// ============================================================
describe('public mode tool behaviour (real keyless HttpClient)', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A real client, not the mock above — the hint is produced by HttpClient, not by any tool. */
  function keylessHttp() {
    return new HttpClient({ baseUrl: 'https://api.proof.holdings', timeout: 1000, maxRetries: 0 });
  }

  it('a keyed tool answers api_key_required through the existing catch block', async () => {
    const mod = await import('../src/tools/verifications.js');
    const tools = captureTools(mod.registerTools, keylessHttp());

    const result = await findTool(tools, 'list_verifications').handler({}) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('api_key_required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the bootstrap tools reach the network with no key at all', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'auth_x', status: 'pending' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const mod = await import('../src/tools/accounts.js');
    const tools = captureTools(mod.registerTools, keylessHttp());

    const result = await findTool(tools, 'create_account').handler({ channel: 'telegram' }) as {
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    expect('Authorization' in options.headers).toBe(false);
  });
});

// ============================================================
// WAIT TOOLS — the client's request timeout bounds the call (h-fix-mcp-refusal-roads)
// ============================================================

describe('wait tools — defaults live under the MCP client request timeout', () => {
  const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');

  /**
   * Every tool that polls through `pollUntilTerminal`, with the module that registers it. A live
   * run (giorgi, 2026-09-03) had `wait_for_login` killed by the CLIENT at 60 s — the SDK's default
   * request timeout — while the server was still inside its 120 s default poll. The user had
   * scanned the QR; nothing was wrong except the two defaults facing the wrong way.
   */
  const WAIT_TOOLS: ReadonlyArray<[file: string, name: string]> = [
    ['auth-flows.ts', 'wait_for_login'],
    ['accounts.ts', 'wait_for_account_creation'],
    ['twofa.ts', 'wait_for_2fa'],
    ['hitl.ts', 'wait_for_chat_id_discovery'],
    ['verification-requests.ts', 'wait_for_request'],
    ['verifications.ts', 'wait_for_verification'],
    ['confirmations.ts', 'wait_for_confirmation'],
    ['sessions.ts', 'wait_for_session'],
  ];

  it('the list above names every tool file that polls — the corpus, not a hand-count', () => {
    // The first version of this list held six entries, enumerated from a grep whose output had
    // been cut short; the spec reviewer found the seventh and eighth still on `?? 120` / `?? 60`.
    // So the list is pinned to the directory: every file that calls pollUntilTerminal must be
    // listed, and nothing listed may have stopped polling.
    const polling = fs
      .readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.ts') && fs.readFileSync(path.join(TOOLS_DIR, f), 'utf-8').includes('pollUntilTerminal('))
      .sort();
    expect(polling).toEqual(WAIT_TOOLS.map(([file]) => file).sort());

    // …and ONE per file, which is what makes a file-granular list sufficient. A SECOND wait tool
    // added to an already-listed file would otherwise arrive with a numeric default and no case of
    // its own, since the schema pin below is driven by this list and not by the registrations.
    for (const [file] of WAIT_TOOLS) {
      const calls = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8').match(/pollUntilTerminal\(/g) ?? [];
      expect({ file, calls: calls.length }).toEqual({ file, calls: 1 });
    }
  });

  it('WAIT_DEFAULT_SECONDS sits under the SDK request timeout the client will apply', () => {
    // Against the SDK's own constant, not a copied 60: if the SDK moves, this moves with it.
    expect(WAIT_DEFAULT_SECONDS * 1000).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MSEC);
  });

  it('pollUntilTerminal answers "pending — call again" instead of an error when time runs out', async () => {
    const result = await pollUntilTerminal(
      async () => ({ status: 'pending' }),
      ['verified'],
      1,
      'login session sess_1',
    );
    // "Not yet" is not a failure. An `isError` timeout made the agent stop and report the login as
    // failed while the human was still scanning; a pending result is what makes it poll again.
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as {
      status: string;
      message: string;
      waited_seconds: number;
      timeout_seconds: number;
    };
    expect(parsed.status).toBe('pending');
    // The BUDGET is what the caller asked for; `waited_seconds` is what actually elapsed, and the
    // two are different by design — the loop stops as soon as the next interval would overrun.
    expect(parsed.timeout_seconds).toBe(1);
    expect(parsed.waited_seconds).toBeLessThanOrEqual(1);
    expect(parsed.message).toContain('call this tool again');
    expect(parsed.message).toContain('sess_1');
  });

  it('answers inside its own budget even when a poll never comes back', async () => {
    // The budget used to govern only WHEN a new iteration may begin. A request started inside the
    // last permitted iteration was bounded by HttpClient's own 30 s timeout instead, so against a
    // degraded API a 50 s wait could answer at ~71 s — past the 60 s at which the client kills the
    // call with `MCP error -32001`, the exact failure this task exists to remove, reappearing under
    // load. Without the budget race this case does not fail fast, it HANGS until vitest kills it.
    const started = Date.now();
    const result = await pollUntilTerminal(
      () => new Promise<Record<string, unknown>>(() => {}),
      ['verified'],
      1,
      'login session sess_3',
    );
    expect(Date.now() - started).toBeLessThan(3000);
    const parsed = JSON.parse(result.content[0].text) as { status: string; last_status: string | null };
    expect(parsed.status).toBe('pending');
    // Nothing was ever read, so there is no resource status to report.
    expect(parsed.last_status).toBeNull();
  }, 15000);

  it('reports the resource\'s OWN last status beside the wait\'s, instead of overwriting it', async () => {
    // `status: "pending"` describes the WAIT. For most of these tools it happens to coincide with
    // the resource's own non-terminal status; for `wait_for_request` it does not — a verification
    // request has TWO non-terminal statuses, `pending` and `partial` (some assets already
    // verified). Answering a flat "pending" there tells an agent something false about the
    // resource and invites it to re-drive the flow from asset one.
    const result = await pollUntilTerminal(
      async () => ({ status: 'partial', verified_count: 2 }),
      ['completed', 'expired', 'cancelled'],
      1,
      'verification request vr_1',
    );
    const parsed = JSON.parse(result.content[0].text) as { status: string; last_status: string | null; message: string };
    expect(parsed.status).toBe('pending');
    expect(parsed.last_status).toBe('partial');
    expect(parsed.message).toContain('partial');

    // Nothing observed at all — every poll threw a retryable error — must not invent a status.
    const neverRead = await pollUntilTerminal(
      async () => {
        throw Object.assign(new Error('upstream'), { statusCode: 503 });
      },
      ['verified'],
      1,
      'login session sess_2',
    );
    const neverParsed = JSON.parse(neverRead.content[0].text) as { last_status: string | null };
    expect(neverParsed.last_status).toBeNull();
  });

  it.each(WAIT_TOOLS)('%s: %s defaults to WAIT_DEFAULT_SECONDS and says so', async (file, name) => {
    // Source pin for the DEFAULT — the `?? N` literal is what the runtime falls back to, and a
    // schema description cannot see it. No numeric fallback may remain in a wait tool.
    const src = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8');
    expect(src).toContain('timeout_seconds ?? WAIT_DEFAULT_SECONDS');
    expect(src).not.toMatch(/timeout_seconds \?\? \d+/);

    // Schema pin for the DESCRIPTION — what the agent reads when deciding what to pass.
    const mod = (await import(`../src/tools/${file.replace(/\.ts$/, '.js')}`)) as {
      registerTools: (tool: unknown, http?: HttpClient) => void;
    };
    const tool = findTool(captureTools(mod.registerTools, createMockHttp()), name);
    const timeout = tool.schema.timeout_seconds as { description?: string };
    expect(timeout.description).toContain(`default: ${WAIT_DEFAULT_SECONDS}`);
    expect(timeout.description).toContain('request timeout');

    // …and the shared default must sit inside THIS tool's own bounds. The ceilings differ (600 on
    // most, 300 on the session and request waits), so one constant serving all eight is only
    // correct while every ceiling clears it — a future wait tool capped at 30 would otherwise ship
    // a default above its own documented maximum with every check above still green. Read off the
    // zod schema, not off the sentence beside it.
    // Every terminal state the LOOP stops on must be named in the description the agent reads.
    // `wait_for_verification` gained `revoked` and `cancelled` in the code while its sentence still
    // listed three, which re-opens the very loop the corpus rule closed: the tool returns
    // `{"status":"cancelled"}` promptly and correctly, and an agent that was told terminal means
    // verified/failed/expired classifies it as non-terminal and keeps going. The states are read
    // from the array passed to `pollUntilTerminal`, so the description is checked against the
    // behaviour rather than against a second hand-written list.
    //
    // STATED BOUND, measured rather than assumed: this requires each state to be NAMED somewhere in
    // the description, not that any particular enumeration in it be complete. Reverting
    // `wait_for_verification`'s parenthetical to three states leaves this green, because the
    // sentence below it names the other two — the description stays truthful, only its own summary
    // stops agreeing with it. The realistic defect, a state added to the list with no mention
    // anywhere, does turn it red.
    const terminalBlock = src.match(/pollUntilTerminal\([\s\S]*?\[([^\]]*)\]/);
    expect({ file, anchored: terminalBlock !== null }).toEqual({ file, anchored: true });
    const terminalStates = [...(terminalBlock as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect({ file, states: terminalStates.length > 0 }).toEqual({ file, states: true });
    for (const state of terminalStates) {
      expect({ file, state, named: tool.description.includes(state) }).toEqual({ file, state, named: true });
    }

    const bounds = (tool.schema.timeout_seconds as { unwrap(): { minValue: number | null; maxValue: number | null } }).unwrap();
    expect(typeof bounds.minValue).toBe('number');
    expect(typeof bounds.maxValue).toBe('number');
    expect(WAIT_DEFAULT_SECONDS).toBeGreaterThanOrEqual(bounds.minValue as number);
    expect(WAIT_DEFAULT_SECONDS).toBeLessThanOrEqual(bounds.maxValue as number);
  });

  it('wait_for_login describes the session this server keeps, not a browser cookie', async () => {
    // The MCP server is not a browser: it captures the Set-Cookie into its own session and signs
    // the caller's own-account calls with it. "JWT is set as httpOnly cookie" described a client
    // that does not exist here and told the agent nothing about what it can now do.
    const mod = await import('../src/tools/auth-flows.js');
    const tool = findTool(captureTools(mod.registerTools, createMockHttp()), 'wait_for_login');
    expect(tool.description).not.toContain('httpOnly');
    expect(tool.description).toContain('keeps the session');
    expect(tool.description).toContain('own account records');

    // The SAME sentence is written THREE times, in build graphs that share no test: here, in the
    // refusal's `keyless_alternative` for a tool a session cannot reach, and in `HttpClient`'s own
    // `api_key_required` — the SECOND refusal a signed-in remote caller hits, and the one this
    // task exists to reconcile with the first. All three are prose a caller ACTS on, and two of
    // them had already drifted apart by one item ("your public profile") before this pin existed:
    // membership is held both ways by SESSION_TOOLS, but the sentence explaining the membership
    // was held by nothing. The third copy is read as TEXT because the message is built inside
    // `HttpClient.request` and never exported. Each copy stops at a different character — `.`,
    // `)`, `;` — so the pattern names all three rather than the one written today.
    const refusal = authorizationRequiredBody('https://api.proof.holdings', 'get_platform_summary');
    const httpSource = fs.readFileSync(path.join(TOOLS_DIR, '../http.ts'), 'utf-8');
    // A FOURTH copy arrived with `h-fix-mcp-agent-facing-text`: the server `instructions`, which
    // explain the same split to an anonymous caller before any refusal happens. It was written with
    // one extra word ("and your public profile") and this pin could not see it, which is precisely
    // the drift the note above records happening twice already.
    const instructions = serverInstructions({ remote: true, hasCredential: false });
    const surfaceIn = (text: string) => text.match(/emails, phones,[^.);]*/)?.[0];
    const fromRefusal = surfaceIn(refusal.keyless_alternative);
    expect(fromRefusal).toBeTruthy();
    expect(surfaceIn(tool.description)).toBe(fromRefusal);
    // The http.ts copy is written across concatenated string literals, so compare it with the
    // quote/plus joinery removed rather than requiring one physical line.
    // …and the escape too: inside a single-quoted TS literal the apostrophe is written `\'`, which
    // is a property of the SOURCE, not of the string a caller reads.
    // EVERY copy in http.ts, not the first: `user_session_required` (m-mcp-release-drift-and-tool-hygiene)
    // put a second one there, above `api_key_required`, and a first-match read would have silently
    // stopped reading the older copy.
    const httpCopies = [
      ...httpSource.replace(/' \+\s*\n\s*'/g, '').replace(/\\'/g, "'").matchAll(/emails, phones,[^.);]*/g),
    ].map((m) => m[0]);
    expect(httpCopies).toHaveLength(2);
    expect(httpCopies).toEqual([fromRefusal, fromRefusal]);
    expect(surfaceIn(instructions)).toBe(fromRefusal);
  });
});
