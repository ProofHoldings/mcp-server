import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createProofServer } from '../src/factory.js';
import { TOOL_RENAMES, KEPT_TOOL_NAMES, ALIASES_REMOVED_IN, aliasDescription } from '../src/tool-renames.js';

/**
 * SC-10 (m-fix-mcp-tool-contract-drift): the confirmed table is what the server registers. Written to
 * hold under either release shape — each new name is registered, and each old name is registered
 * exactly when its row of `TOOL_RENAMES` says `alias` (no row does in the 2.0.0 shape).
 */
type Registered = Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown; handler?: unknown }>;
const registeredOf = (server: unknown) => (server as { _registeredTools: Registered })._registeredTools;
function registeredNames(server: unknown): Set<string> {
  return new Set(Object.keys(registeredOf(server)));
}

describe('tool renames — the confirmed table, registered', () => {
  it('is the confirmed shape: 23 renames and 7 kept names, no name used twice', () => {
    expect(TOOL_RENAMES).toHaveLength(23);
    expect(KEPT_TOOL_NAMES).toHaveLength(7);
    const all = [...TOOL_RENAMES.flatMap((row) => [row.from, row.to]), ...KEPT_TOOL_NAMES.map((kept) => kept.name)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('registers every new name and every kept name', () => {
    const registered = registeredNames(createProofServer({ baseUrl: 'https://api.proof.holdings' }).server);
    const missing = [...TOOL_RENAMES.map((row) => row.to), ...KEPT_TOOL_NAMES.map((kept) => kept.name)].filter(
      (name) => !registered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it('registers an old name only where its row says alias', () => {
    const registered = registeredNames(createProofServer({ baseUrl: 'https://api.proof.holdings' }).server);
    const mismatched = TOOL_RENAMES.filter((row) => registered.has(row.from) !== row.alias).map((row) => row.from);
    expect(mismatched).toEqual([]);
  });
});

describe('tool renames — 1.10.0 keeps every old name as a deprecated alias', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('ships every row as an alias, removed in 2.0.0', () => {
    expect(TOOL_RENAMES.filter((row) => !row.alias).map((row) => row.from)).toEqual([]);
    expect(ALIASES_REMOVED_IN).toBe('2.0.0');
  });

  it('registers each alias as its tool: same handler, input and annotations, one deprecated line, no output schema', () => {
    const tools = registeredOf(createProofServer({ baseUrl: 'https://api.proof.holdings' }).server);
    for (const { from, to } of TOOL_RENAMES) {
      expect(tools[from].handler, from).toBe(tools[to].handler);
      expect(tools[from].inputSchema, from).toEqual(tools[to].inputSchema);
      expect(tools[from].annotations, from).toEqual(tools[to].annotations);
      expect(tools[from].outputSchema, from).toBeUndefined();
      expect(tools[from].description, from).toBe(aliasDescription(to));
      expect(tools[from].description).toBe(`Deprecated: use ${to}`);
    }
  });

  it('an alias call returns exactly what a call of the new name returns, from the same request', async () => {
    // Real bodies (the pinned controller samples the output schemas are proven against), so the new
    // name's output schema passes and the comparison is between two successful calls.
    const samples = JSON.parse(readFileSync(join(__dirname, '../src/generated/output-samples.json'), 'utf8')) as Record<string, unknown[]>;
    let body: unknown;
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const { server } = createProofServer({ apiKey: 'pk_test_abc', baseUrl: 'https://api.proof.holdings' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'alias-test', version: '1.0.0' });
    await client.connect(clientSide);

    const cases: [string, Record<string, unknown>, string][] = [
      ['list_my_proofs', {}, 'GET /api/v1/me/assets 200'],
      ['list_sub_accounts', {}, 'GET /api/v1/me/profiles 200'],
      ['get_approval_channel', { id: '0123456789abcdef01234567' }, 'GET /api/v1/hitl/{id} 200'],
    ];
    for (const [to, args, sample] of cases) {
      const from = TOOL_RENAMES.find((row) => row.to === to)!.from;
      body = samples[sample][0];
      expect(body, sample).toBeDefined();
      requests.length = 0;
      const viaNew = (await client.callTool({ name: to, arguments: args })) as { content: unknown; isError?: boolean };
      const viaAlias = (await client.callTool({ name: from, arguments: args })) as { content: unknown; isError?: boolean };
      expect(requests, to).toHaveLength(2);
      expect(requests[1], to).toBe(requests[0]);
      expect(viaNew.isError, to).toBeFalsy();
      expect(viaAlias.isError, to).toBe(viaNew.isError);
      expect(viaAlias.content, to).toEqual(viaNew.content);
    }
  });
});
