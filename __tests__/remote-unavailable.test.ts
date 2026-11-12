import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';
import { REMOTE_UNAVAILABLE_TOOLS } from '../src/authBoundary.js';

// m-fix-mcp-tool-contract-drift M4 / SC-4: the hosted server never grants auth:read / auth:write
// (MCP_OAUTH_FORBIDDEN_SCOPES), so these tools cannot work there. They must say so — in the
// description an agent reads before calling, and in the answer if it calls anyway — instead of
// sending a request that comes back `insufficient_scope`. Which tools belong in the set is held to
// the backend's scopes by src/__tests__/drift/mcp-remote-forbidden-scopes.test.ts.
describe('tools the hosted server cannot serve', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function connect(remote: boolean) {
    const { server } = createProofServer({ apiKey: 'pk_test_abc', baseUrl: 'https://api.proof.holdings', remote });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'remote-unavailable-test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }

  it('names exactly the two auth-session tools', () => {
    expect([...REMOTE_UNAVAILABLE_TOOLS].sort()).toEqual(['list_auth_sessions', 'revoke_auth_session']);
  });

  it.each([...REMOTE_UNAVAILABLE_TOOLS])('%s: remote description says it is unavailable and where to go instead', async (name) => {
    const { tools } = await (await connect(true)).listTools();
    const description = tools.find((t) => t.name === name)!.description!;
    expect(description).toMatch(/not available on the hosted/i);
    expect(description).toContain('Settings → Signed-in devices');
    expect(description).toContain('https://proof.holdings/dev)');
  });

  it.each([...REMOTE_UNAVAILABLE_TOOLS])('%s: a remote call is refused without a request', async (name) => {
    const result = (await (await connect(true)).callTool({ name, arguments: name === 'revoke_auth_session' ? { session_id: 's1' } : {} })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string; retryable: boolean };
    expect(env).toMatchObject({ error: 'tool_unavailable_remote', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stdio is unchanged: no notice, and the call is sent (control)', async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'list_auth_sessions')!.description).not.toMatch(/not available on the hosted/i);
    const result = (await client.callTool({ name: 'list_auth_sessions', arguments: {} })) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
