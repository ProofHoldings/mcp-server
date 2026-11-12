import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';
import { EXPORT_TEXT_MAX_CHARS } from '../src/tools/authorizations.js';

// m-fix-mcp-tool-contract-drift M1: `export_authorizations` with `format: "csv"` answered `{}`, because the
// client parsed every body as JSON. Called through a real in-memory client because the tool declares an
// output schema: a result without structured content would come back as an error, not as the CSV.
describe('export_authorizations csv', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function exportCsv(csv: string) {
    fetchMock.mockResolvedValueOnce(new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }));
    const { server } = createProofServer({ apiKey: 'pk_test_abc', baseUrl: 'https://api.proof.holdings' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'export-test', version: '1.0.0' });
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'export_authorizations', arguments: { format: 'csv' } });
    return result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  }

  it('returns the CSV body as text', async () => {
    const csv = 'id,status\n1,approved\n2,denied\n';
    const result = await exportCsv(csv);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ content_type: 'text/csv; charset=utf-8', body: csv, truncated: false });
  });

  it('cuts a CSV over the bound at a full line and says how to narrow it', async () => {
    const line = 'x'.repeat(99) + '\n';
    const csv = 'id\n' + line.repeat(Math.ceil((EXPORT_TEXT_MAX_CHARS * 1.5) / line.length));
    const result = await exportCsv(csv);

    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { body: string; truncated: boolean; total_chars: number; note: string };
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeLessThanOrEqual(EXPORT_TEXT_MAX_CHARS);
    expect(out.body.endsWith('\n')).toBe(true);
    expect(out.total_chars).toBe(csv.length);
    expect(out.note).toMatch(/from.*to|status/);
  });
});
