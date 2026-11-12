import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';
import { RENDERABLE_LINK_SCHEMES } from '../src/tools/render-auth-link.js';

// m-fix-mcp-tool-contract-drift SC-6: render_auth_link took any `z.string().url()`, so it rendered
// `javascript:` into a link and a QR code. It now takes exactly the schemes the API hands an agent
// to render: https (Telegram t.me, WhatsApp wa.me) and sms (POST /sessions on the SMS channel, i.e.
// create_session). That those ARE the producers' schemes is held, from the backend's own builders,
// by src/__tests__/drift/render-auth-link-producers.test.ts.
describe('render_auth_link schemes', () => {
  async function render(url: string) {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'render-test', version: '1.0.0' });
    await client.connect(clientSide);
    return (await client.callTool({ name: 'render_auth_link', arguments: { url } })) as { isError?: boolean; content: { text: string }[] };
  }

  it('allows exactly https: and sms:', () => {
    expect([...RENDERABLE_LINK_SCHEMES].sort()).toEqual(['https:', 'sms:']);
  });

  it.each([
    'https://t.me/proof_holdings_bot?start=sess_abc',
    'https://wa.me/15551112222?text=Verify%20ABC123',
    'sms:+15551112222?body=Verify%20ABC123',
    'SMS:+15551112222?body=Verify%20ABC123',
  ])('renders %s', async (url) => {
    const result = await render(url);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(url);
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://t.me/proof_holdings_bot?start=x',
    'file:///etc/passwd',
    'tg://resolve?domain=proof_holdings_bot',
  ])('refuses %s as invalid_arguments, rendering nothing', async (url) => {
    const result = await render(url);
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string; message: string };
    expect(env.error).toBe('invalid_arguments');
    expect(env.message).toMatch(/https: or sms:/);
  });
});
