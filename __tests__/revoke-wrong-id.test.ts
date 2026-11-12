import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';

// m-fix-mcp-tool-contract-drift T8c: revoke_my_proof and revoke_proof take ids an agent confuses — neither
// refused the other's. A ph_ctl_/ph_dlg_ handle is a proof address, so revoke_my_proof can refuse it by
// SHAPE and name revoke_proof. The other direction cannot be decided by shape (asset and verification
// ids are both ObjectIds), so revoke_proof adds the hint to the backend's 404 instead — which the
// backend pins in src/__tests__/routes/proofs-domain-control.test.ts ("an ASSET id sent to …").
const ASSET_ID = '0123456789abcdef01234567';
const HANDLE = 'ph_ctl_0123456789abcdef0123456789abcdef';

describe('revoke_my_proof / revoke_proof — a wrong id fails loudly and names the other tool', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function call(name: string, args: Record<string, unknown>) {
    const { server } = createProofServer({ apiKey: 'pk_test_abc', baseUrl: 'https://api.proof.holdings' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'revoke-test', version: '1.0.0' });
    await client.connect(clientSide);
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError, envelope: JSON.parse(result.content[0].text) as { error: string; message: string } };
  }

  it.each([HANDLE, 'ph_dlg_0123456789abcdef0123456789abcdef'])('revoke_my_proof refuses the proof handle %s and names revoke_proof, before any request', async (id) => {
    const { isError, envelope } = await call('revoke_my_proof', { id });
    expect(isError).toBe(true);
    expect(envelope.error).toBe('invalid_arguments');
    expect(envelope.message).toContain('revoke_proof');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revoke_my_proof refuses anything that is not a 24-hex asset id', async () => {
    const { envelope } = await call('revoke_my_proof', { id: 'not-an-id' });
    expect(envelope.error).toBe('invalid_arguments');
    expect(envelope.message).toContain('list_my_proofs');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revoke_my_proof lets a 24-hex id through to its own refusal path (no schema error)', async () => {
    const { envelope } = await call('revoke_my_proof', { id: ASSET_ID });
    // A key-only connection is refused by the client (session tool), which is not a schema error.
    expect(envelope.error).toBe('user_session_required');
  });

  it('revoke_proof adds the revoke_my_proof hint to a 404 on a 24-hex id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Proof not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const { envelope } = await call('revoke_proof', { id: ASSET_ID });
    expect(envelope.error).toBe('not_found');
    expect(envelope.message).toContain('If this id came from list_my_proofs, it is an asset id: use revoke_my_proof');
  });

  it('revoke_proof does not add it for a handle, which can never be an asset id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Proof not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const { envelope } = await call('revoke_proof', { id: HANDLE });
    expect(envelope.error).toBe('not_found');
    expect(envelope.message).not.toContain('revoke_my_proof');
  });
});
