import { describe, it, expect, vi } from 'vitest';

/**
 * The other release shape (m-fix-mcp-tool-contract-drift, coordinator 11 Nov): a row of `TOOL_RENAMES`
 * flipped to `alias: true` must be the WHOLE change. Two rows are flipped here — a session-only tool and
 * a keyed one — and the server is checked to register each old name as the new tool: same input and
 * annotations, one-line deprecated description, no output schema, and the same access rules.
 */
vi.mock('../src/tool-renames.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tool-renames.js')>();
  const flipped = new Set(['revoke_asset', 'list_assets']);
  const rows = actual.TOOL_RENAMES.map((row) => ({ ...row, alias: flipped.has(row.from) }));
  const aliasTo = new Map(rows.filter((row) => row.alias).map((row) => [row.from, row.to]));
  return {
    ...actual,
    TOOL_RENAMES: rows,
    aliasesOf: (name: string) => rows.filter((row) => row.alias && row.to === name).map((row) => row.from),
    canonicalToolName: (name: string) => aliasTo.get(name) ?? name,
  };
});

const { createProofServer } = await import('../src/factory.js');
const { isSessionOnlyTool, keyedToolsIn } = await import('../src/authBoundary.js');
const { aliasDescription, canonicalToolName } = await import('../src/tool-renames.js');

type Registered = Record<string, { description?: string; inputSchema?: unknown; outputSchema?: unknown; annotations?: unknown }>;
const registeredOf = (server: unknown) => (server as { _registeredTools: Registered })._registeredTools;

describe('tool aliases — when a row says alias', () => {
  it('registers the old name as the new tool, with a one-line deprecated description and no output schema', () => {
    const { server, toolNames } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const tools = registeredOf(server);

    for (const [from, to] of [['revoke_asset', 'revoke_my_proof'], ['list_assets', 'list_my_proofs']]) {
      expect(tools[from], from).toBeDefined();
      expect(toolNames.has(from)).toBe(true);
      expect(tools[from].description).toBe(aliasDescription(to));
      expect(tools[from].description).not.toContain('\n');
      expect(tools[from].outputSchema).toBeUndefined();
      expect(tools[from].annotations).toEqual(tools[to].annotations);
      expect(tools[from].inputSchema).toEqual(tools[to].inputSchema);
    }
    // An unflipped row registers no alias.
    expect(tools.create_hitl).toBeUndefined();
  });

  it('answers an alias by the access rules of the tool it stands for', () => {
    expect(isSessionOnlyTool('revoke_my_proof')).toBe(true);
    expect(isSessionOnlyTool(canonicalToolName('revoke_asset'))).toBe(true);
    // A session-only alias passes the anonymous gate like its tool; a keyed alias is challenged.
    const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
    expect(keyedToolsIn(call('revoke_asset'), undefined, canonicalToolName)).toEqual([]);
    // …and is refused as the tool it stands for, so the 401 names the new name.
    expect(keyedToolsIn(call('list_assets'), undefined, canonicalToolName)).toEqual([{ name: 'list_my_proofs', malformed: false }]);
  });
});
