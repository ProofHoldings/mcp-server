import { describe, it, expect, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

/**
 * Zero-configuration proof: a client that was handed NO key at all connects, sees the whole tool
 * list, gets a live answer from the public surface, and gets a structured hint (not a crash, not a
 * network 401) from a keyed tool.
 *
 * It deliberately does NOT use `helpers/mcp-client.ts` — that helper REQUIRES a key and injects it,
 * which is the exact condition under test. The child env is stripped of both key variables, so a
 * developer machine that happens to export one cannot turn this green for the wrong reason.
 */
const SERVER_PATH = resolve(import.meta.dirname, '../../dist/server.js');

let transport: StdioClientTransport | null = null;
let client: Client | null = null;

/** Spawn a server, optionally with a key. `apiKey: null` strips BOTH key variables from the child. */
async function spawnServer(apiKey: string | null): Promise<{ client: Client; transport: StdioClientTransport }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'PROOF_API_KEY' || key === 'TEST_API_KEY') continue;
    if (value !== undefined) env[key] = value;
  }
  if (process.env.PROOF_BASE_URL) env.PROOF_BASE_URL = process.env.PROOF_BASE_URL;
  if (apiKey !== null) env.PROOF_API_KEY = apiKey;

  const t = new StdioClientTransport({ command: 'node', args: [SERVER_PATH], env, stderr: 'pipe' });
  const c = new Client({ name: 'public-mode-test', version: '1.0.0' });
  await c.connect(t);
  return { client: c, transport: t };
}

async function connectKeylessClient(): Promise<Client> {
  if (client) return client;
  const spawned = await spawnServer(null);
  client = spawned.client;
  transport = spawned.transport;
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map(c => c.text ?? '').join('\n');
}

describe('public mode — zero configuration', () => {
  afterAll(async () => {
    if (transport) await transport.close();
    transport = null;
    client = null;
  });

  it('connects with no API key and hides NOTHING a keyed server would offer', async () => {
    // Asserted as EQUALITY against a keyed server rather than as "more than N tools". A threshold
    // is satisfied by a public mode that quietly dropped fifty tools, and it drifts out of date the
    // moment a tool is added. The keyed server needs no working credential — registration happens
    // before any network call — so a dummy key is enough to produce the reference list.
    const keyless = await connectKeylessClient();
    const keyed = await spawnServer('pk_test_reference_list_only');

    try {
      const keylessNames = (await keyless.listTools()).tools.map(t => t.name).sort();
      const keyedNames = (await keyed.client.listTools()).tools.map(t => t.name).sort();

      expect(keyedNames.length).toBeGreaterThan(100); // anti-vacuity: the reference list is real
      expect(keylessNames).toEqual(keyedNames);
      for (const name of ['create_account', 'send_account_email', 'start_login', 'validate_proof', 'verify_delegation']) {
        expect(keylessNames).toContain(name);
      }
    } finally {
      await keyed.transport.close();
    }
  }, 30_000);

  it('gets a live judgement from the API on a public tool', async () => {
    const c = await connectKeylessClient();

    const result = await c.callTool({
      name: 'validate_proof',
      arguments: { proof_token: 'not.a.real.token' },
    });

    // Asserted on the SHAPE the API answers with, not on "something came back". An earlier version
    // of this case passed the argument as `token`, so the MCP schema rejected it locally and the
    // request never left the process — and every loose assertion ("no api_key_required", "text is
    // non-empty") was satisfied by that local refusal. A network error would satisfy them too.
    const body = JSON.parse(textOf(result)) as { valid?: boolean; reason?: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('invalid'); // the API judged the token; nothing local produces this
  }, 30_000);

  it('reads the public revocation list with no credential', async () => {
    const c = await connectKeylessClient();

    const result = await c.callTool({ name: 'list_revoked_proofs', arguments: {} });

    // A signed list is something only the server can produce, so this cannot pass on a local stub.
    const body = JSON.parse(textOf(result)) as { revoked?: unknown[]; signature?: string };
    expect(Array.isArray(body.revoked)).toBe(true);
    expect(typeof body.signature).toBe('string');
  }, 30_000);

  it('answers a keyed tool with a structured hint instead of failing', async () => {
    const c = await connectKeylessClient();

    const result = await c.callTool({ name: 'list_verifications', arguments: {} });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('api_key_required');
  }, 30_000);
});
