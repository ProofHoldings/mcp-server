import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createProofServer, listToolFor } from '../src/factory.js';

/**
 * AX bar (coordinator ruling, 11 Nov): a not-found refusal names where the caller can see what exists —
 * the resource's list tool, derived from the registry by name (`<verb>_<noun>` → `list_<noun>s`), never a
 * hand table — and adds nothing where the registry has no such tool.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function callWith404(name: string, args: Record<string, unknown>, code: string, message = 'Not here') {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ error: { code, message } }), { status: 404, headers: { 'content-type': 'application/json' } }),
  ) as typeof fetch;
  const { server } = createProofServer({ apiKey: 'pk_test_abc', baseUrl: 'https://api.proof.holdings' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'not-found-test', version: '1.0.0' });
  await client.connect(clientSide);
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as { error: string; message: string };
}

describe('a not-found refusal names the list tool of its resource', () => {
  it('derives the list tool from the registry', () => {
    const { toolNames } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    expect(listToolFor('get_approval_channel', toolNames)).toBe('list_approval_channels');
    expect(listToolFor('get_my_proof', toolNames)).toBe('list_my_proofs');
    expect(listToolFor('delete_webhook_endpoint', toolNames)).toBe('list_webhook_endpoints');
    expect(listToolFor('revoke_api_key', toolNames)).toBe('list_api_keys');
    // A deprecated alias is answered as its tool.
    expect(listToolFor('get_hitl', toolNames)).toBe('list_approval_channels');
    // Nothing where the registry has no list tool, and never the tool itself.
    expect(listToolFor('get_settings', toolNames)).toBeUndefined();
    expect(listToolFor('list_approval_channels', toolNames)).toBeUndefined();
  });

  it('appends it to a *_not_found and a plain not_found answer', async () => {
    const id = '0123456789abcdef01234567';
    for (const code of ['hitl_not_found', 'not_found']) {
      const envelope = await callWith404('get_approval_channel', { id }, code);
      expect(envelope.error).toBe(code);
      expect(envelope.message).toBe('Not here List what exists with list_approval_channels.');
    }
  });

  // Codex review: the list must be the MISSING resource's, named by the code, not the called tool's —
  // create_confirmation refused hitl_not_found needs list_approval_channels, not list_confirmations.
  it('names the list of the resource the code names, read through the aliases', async () => {
    const id = '0123456789abcdef01234567';
    const confirmation = await callWith404('create_confirmation', { hitl_id: id, message: '{}', action_type: 'approval' }, 'hitl_not_found');
    expect(confirmation.message).toBe('Not here List what exists with list_approval_channels.');
    const current = await callWith404('get_current_sub_account', {}, 'profile_not_found');
    expect(current.message).toBe('Not here List what exists with list_sub_accounts.');
    // A code naming a resource with no list tool adds nothing, rather than falling back to the tool's.
    const unknown = await callWith404('get_approval_channel', { id }, 'widget_not_found');
    expect(unknown.message).toBe('Not here');
  });

  // Codex review: the hint must not carry the message past ERROR_MESSAGE_MAX_CHARS.
  it('keeps the message within ERROR_MESSAGE_MAX_CHARS, the hint whole', async () => {
    const { ERROR_MESSAGE_MAX_CHARS } = await import('../src/types.js');
    const envelope = await callWith404('get_approval_channel', { id: '0123456789abcdef01234567' }, 'not_found', 'x'.repeat(5000));
    expect([...envelope.message].length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS);
    expect(envelope.message.endsWith(' List what exists with list_approval_channels.')).toBe(true);
  });

  it('adds nothing to another refusal, or where no list tool exists (controls)', async () => {
    const envelope = await callWith404('get_approval_channel', { id: '0123456789abcdef01234567' }, 'invalid_status');
    expect(envelope.message).toBe('Not here');
    const settings = await callWith404('get_settings', {}, 'not_found');
    expect(settings.message).toBe('Not here');
  });
});
