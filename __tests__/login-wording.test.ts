/**
 * What the agent-facing texts say about getting a key, now that `login` exists (SC-9).
 *
 * Every stdio road to a key names the scoped command, never a bare `proof-mcp login`: most installs
 * run through `npx`, where `proof-mcp` is not on PATH, and `npx proof-mcp` resolves an UNSCOPED npm
 * package somebody else publishes — following that instruction would run a stranger's code at the
 * moment the person is handling sign-in codes. The remote texts name neither (nobody runs a command
 * on a server another company hosts), and `user_session_required` keeps pointing at `start_login`:
 * there the key is fine and what is missing is a session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, HttpClient } from '../src/http.js';
import { serverInstructions } from '../src/authBoundary.js';
import { LOGIN_COMMAND } from '../src/credentials.js';

const BASE = 'https://api.proof.holdings';

function invalidKey(): Response {
  return new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid API key' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).message;
}

describe('the login command in the key texts', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is the scoped npx form', () => {
    expect(LOGIN_COMMAND).toBe('npx @proof-holdings/mcp-server login');
  });

  it('stdio api_key_required names it beside PROOF_API_KEY', async () => {
    const message = await messageOf(new HttpClient({ baseUrl: BASE, maxRetries: 0 }).get('/api/v1/verifications'));
    expect(message).toContain(LOGIN_COMMAND);
    expect(message).toContain('PROOF_API_KEY');
    expect(message).not.toContain('proof-mcp login');
  });

  it('stdio invalid_api_key names it beside PROOF_API_KEY', async () => {
    fetchMock.mockResolvedValueOnce(invalidKey());
    const message = await messageOf(new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: BASE, maxRetries: 0 }).get('/api/v1/verifications'));
    expect(message).toContain(LOGIN_COMMAND);
    expect(message).toContain('PROOF_API_KEY');
    expect(message).not.toContain('proof-mcp login');
  });

  it('stdio user_session_required says where the key came from but sends the caller to start_login', async () => {
    const message = await messageOf(new HttpClient({ apiKey: 'pk_live_ok', baseUrl: BASE, maxRetries: 0 }).get('/api/v1/me/api-keys'));
    expect(message).toContain('PROOF_API_KEY');
    expect(message).toContain('start_login');
    expect(message).not.toContain('mcp-server login');
    expect(message).not.toContain('proof-mcp login');
  });

  it('the anonymous stdio instructions name it; the keyed ones need no recipe', () => {
    const anonymous = serverInstructions({ hasCredential: false });
    expect(anonymous).toContain(LOGIN_COMMAND);
    expect(anonymous).toContain('PROOF_API_KEY');
    expect(anonymous).not.toContain('proof-mcp login');
  });

  it('no remote text names a command to run', async () => {
    const remoteKeyless = new HttpClient({ baseUrl: BASE, maxRetries: 0, remote: true });
    const remoteKeyed = new HttpClient({ apiKey: 'mcp_at_oauth', baseUrl: BASE, maxRetries: 0, remote: true });
    fetchMock.mockResolvedValueOnce(invalidKey());
    const texts = [
      await messageOf(remoteKeyless.get('/api/v1/verifications')),
      await messageOf(remoteKeyed.get('/api/v1/verifications')),
      await messageOf(remoteKeyed.get('/api/v1/me/api-keys')),
      serverInstructions({ remote: true, hasCredential: false }),
    ];
    for (const text of texts) {
      expect(text).not.toContain('mcp-server login');
      expect(text).not.toContain('proof-mcp login');
    }
  });
});
