/**
 * Our own delegation gate (m-delegation-publish-registries B.7): `src/delegationGate.ts` and its
 * wiring in `createProofServer`. Through the REAL SDK over an in-memory client; `fetch` is stubbed
 * (the gate's validate poll and nothing else may leave), and the gate's cache goes to a temp
 * directory per case so no case writes to the home directory and each gets its own engine.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELEGATION_META_KEY, readOwnDelegationToken } from '../src/delegationGate.js';
import { createProofServer } from '../src/factory.js';

import manifest from '../package.json' with { type: 'json' };

const OWN_TOKEN = (manifest as { _meta: Record<string, { token: string }> })._meta[DELEGATION_META_KEY].token;
const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;

let dir: string;
const validateCalls: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-gate-'));
  vi.stubEnv('PROOF_CACHE_DIR', dir);
  validateCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** The issuer answers every validate with `answer`; anything else is a test failure. */
function issuer(answer: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href === 'https://api.proof.holdings/api/v1/proofs/validate') {
        validateCalls.push(href);
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request in the gate test: ${href}`);
    }),
  );
}

async function connected(delegationToken?: string) {
  const instance = createProofServer({ baseUrl: 'https://staging-api.proof.holdings', delegationToken });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide);
  const client = new Client({ name: 'gate-test', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, instance };
}

describe('readOwnDelegationToken', () => {
  it("reads the mcp-server token this package's own manifest carries", () => {
    expect(readOwnDelegationToken()).toBe(OWN_TOKEN);
    expect(claims(OWN_TOKEN)).toMatchObject({ delegate: 'pkg:npm/@proof-holdings/mcp-server', principal: 'proof.holdings' });
  });

  it('answers undefined for a manifest without the entry, an empty token, or no readable file', () => {
    const plain = join(dir, 'plain.json');
    writeFileSync(plain, JSON.stringify({ name: 'x' }));
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ _meta: { [DELEGATION_META_KEY]: { token: '' } } }));
    expect(readOwnDelegationToken(pathToFileURL(plain))).toBeUndefined();
    expect(readOwnDelegationToken(pathToFileURL(empty))).toBeUndefined();
    expect(readOwnDelegationToken(pathToFileURL(join(dir, 'missing.json')))).toBeUndefined();
  });
});

describe('createProofServer with a delegation token', () => {
  it('adds the status tool outside the API tool set, and refuses a tool call once the issuer answers revoked', async () => {
    issuer({ valid: false, reason: 'revoked' });
    const { client, instance } = await connected(OWN_TOKEN);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('proof_holdings_status');
    expect(instance.toolNames.has('proof_holdings_status')).toBe(false);

    const result = await client.callTool({ name: 'validate_proof', arguments: { proof_token: 'x.y.z' } });
    expect(result.isError).toBe(true);
    const envelope = JSON.parse((result.content as Array<{ text: string }>)[0].text) as { error: string; message: string };
    expect(envelope.error).toBe('revoked');
    expect(envelope.message).not.toContain(OWN_TOKEN);
    // Asked the ISSUER, never the server's own PROOF_BASE_URL (staging here).
    expect(validateCalls).toEqual(['https://api.proof.holdings/api/v1/proofs/validate']);
  });

  it('lets the call through to the tool while the delegation is valid', async () => {
    issuer({ valid: true });
    const { client } = await connected(OWN_TOKEN);
    // The local tool (no HTTP of its own): its QR in the result proves the gate let the call through.
    const result = await client.callTool({ name: 'render_auth_link', arguments: { url: 'https://proof.holdings/x' } });
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0].text.length).toBeGreaterThan(0);
    expect(validateCalls.length).toBe(1);
  });
});

describe('createProofServer without a token', () => {
  it('installs nothing: no status tool, and no request to the issuer', async () => {
    issuer({ valid: false, reason: 'revoked' });
    const { client } = await connected(undefined);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('proof_holdings_status');
    expect(validateCalls).toEqual([]);
  });
});
