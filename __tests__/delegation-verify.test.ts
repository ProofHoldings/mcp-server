/**
 * The `verify_delegation` tool — the reference verifier's first consumer
 * (m-delegation-verifier-ref).
 *
 * These tests drive the tool end to end against a real RS256 issuer (WebCrypto keys, real
 * signatures) with a routed mock `fetch`, so what is exercised is the actual chain the library
 * walks, not a stubbed verdict.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { registerTools } from '../src/tools/delegation-verify.js';
import { resetJwksCache } from '@proof-holdings/delegation-verifier';

const BASE_URL = 'https://api.proof.holdings';
const JWKS_URI = `${BASE_URL}/.well-known/jwks.json`;
const STATUS_ENDPOINT = `${BASE_URL}/api/v1/proofs/validate`;

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function captureTools(): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const mockTool = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: RegisteredTool['handler']
  ) => {
    tools.push({ name, description, schema, handler });
  };
  registerTools(mockTool as never, { baseUrl: BASE_URL });
  return tools;
}

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface TestKey {
  kid: string;
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
}

async function generateKey(kid = 'mcp-test-key'): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' }, privateKey: pair.privateKey };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signDelegation(key: TestKey, overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'proof.holdings',
    sub: 'ph_dlg_00000000000000000000000000000001',
    iat: now - 60,
    exp: now + 3600,
    token_type: 'delegation',
    delegation_schema_version: '1.0',
    user_id: 'user-1',
    principal: 'postmarkapp.com',
    delegate: 'pkg:npm/postmark-mcp',
    scope: ['send-email'],
    control_proof: 'ph_ctl_00000000000000000000000000000002',
    proof_id: 'ph_dlg_00000000000000000000000000000001',
    jti: 'ph_jti_00000000000000000000000000000003',
    ...overrides,
  };
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid };
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signingInput) as unknown as BufferSource
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function routedFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(routes[url]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

let tools: RegisteredTool[];
let key: TestKey;

beforeEach(async () => {
  resetJwksCache();
  tools = captureTools();
  key = await generateKey();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function verifyTool(): RegisteredTool {
  const tool = tools.find((entry) => entry.name === 'verify_delegation');
  if (!tool) throw new Error(`verify_delegation not registered. Got: ${tools.map((t) => t.name).join(', ')}`);
  return tool;
}

describe('the tool is WIRED, not merely written', () => {
  it('is registered in the server factory with the base URL and no HTTP client', async () => {
    // Requirement (b) of the design — the verifier ships with a running consumer — is broken
    // by deleting one line in the registration list, which typechecks cleanly and no other test
    // reads. Source-scanned in the style of web/__tests__/mcp-tools-drift.test.ts.
    //
    // Reads `factory.ts`, not `server.ts`: `h-mcp-remote` moved the single registration list there
    // so the stdio path and the remote server build the same set. This guard was RE-AIMED rather
    // than dropped — the property it protects (no API key on a third party's delegation) is
    // unchanged, only its address moved.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/factory.ts', import.meta.url), 'utf-8');

    expect(source).toContain("from './tools/delegation-verify.js'");
    // `{ baseUrl }` rather than `http`: verifying a third party's delegation carries no API key.
    expect(source).toMatch(/registerDelegationVerify\(tool,\s*\{\s*baseUrl/);
  });
});

describe('verify_delegation registration', () => {
  it('registers verify_delegation and verify_delegations', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['verify_delegation', 'verify_delegations']);
  });

  it('describes the boundary of what a valid result means', () => {
    // §11 claim boundary: the tool must not let an agent read "verified" as "safe".
    expect(verifyTool().description).toMatch(/NOT that the artifact is safe/i);
  });

  it('requires the independently resolved delegate in its schema', () => {
    expect(verifyTool().schema).toHaveProperty('delegate');
  });

  it('requires expected_principal — an issuer binds the artifact to nothing', () => {
    // Any domain owner can mint a genuine delegation naming someone else's package, so a
    // verdict without this pin would mean "some domain claims this".
    const schema = verifyTool().schema as Record<string, { isOptional?: () => boolean }>;
    expect(schema.expected_principal.isOptional?.()).toBe(false);
    expect(schema.required_scopes.isOptional?.()).toBe(true);
  });
});

describe('verify_delegation behaviour', () => {
  it('verifies a delegation published in a server card', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: true },
    });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      card: { name: 'io.example/postmark', _meta: { 'holdings.proof/delegation': { token } } },
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });

    const body = parse(result);
    expect(body.verified).toBe(true);
    expect(body.status_checked).toBe(true);
    expect(body.principal_checked).toBe(true);
    expect(body.attests).toBe('postmarkapp.com authorized pkg:npm/postmark-mcp for: send-email');
    expect(body.disclaimer).toMatch(/not a statement that the artifact is safe/i);
  });

  it('verifies a raw token without a card', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
      check_status: false,
    });

    const body = parse(result);
    expect(body.verified).toBe(true);
    expect(body.status_checked).toBe(false);
    expect(net.calls).not.toContain(STATUS_ENDPOINT);
  });

  it("refuses a genuine token republished under someone else's package", async () => {
    const token = await signDelegation(key);
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      card: { name: 'pkg:npm/postmark-mcp', _meta: { 'holdings.proof/delegation': { token } } },
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp-community' },
      expected_principal: 'postmarkapp.com',
    });

    const body = parse(result);
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('delegate_mismatch');
  });

  it('reports a revoked delegation from the issuer status endpoint', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: false, reason: 'revoked' },
    });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });

    const body = parse(result);
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('revoked');
    expect(body.outcome).toBe('invalid');
  });

  it('reports status_unavailable with outcome unconfirmed — structurally different from a revoked result (h-delegation-verifier-status-fallthrough-gate SC-4)', async () => {
    const token = await signDelegation(key);
    // STATUS_ENDPOINT deliberately absent from the route table — routedFetch throws
    // "unexpected fetch" for it, which checkStatusEndpoint's own try/catch turns into
    // status_unavailable, the same way the network-failure fixtures elsewhere in this file do.
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });

    const body = parse(result);
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('status_unavailable');
    expect(body.outcome).toBe('unconfirmed');
    expect(body.outcome).not.toBe('invalid');
  });

  it('refuses a delegation minted by a domain the caller did not expect', async () => {
    // The sibling attack the required `delegate` does NOT stop: evil.example mints a genuine,
    // signature-valid delegation naming someone else's package.
    const token = await signDelegation(key, { principal: 'evil.example' });
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });

    const body = parse(result);
    expect(body.verified).toBe(false);
    expect(body.reason).toBe('principal_mismatch');
  });

  it('reports a card that publishes no delegation', async () => {
    const result = await verifyTool().handler({
      card: { name: 'io.example/plain' },
      delegate: { type: 'purl', value: 'pkg:npm/plain' },
      expected_principal: 'example.com',
    });

    expect(parse(result).reason).toBe('no_publication');
  });

  it('refuses a token from an issuer this server does not trust', async () => {
    const token = await signDelegation(key, { iss: 'evil.example' });
    const net = routedFetch({});
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyTool().handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });

    expect(parse(result).reason).toBe('untrusted_issuer');
    expect(net.calls).toEqual([]);
  });

  it('rejects a call that supplies neither card nor token', async () => {
    const result = await verifyTool().handler({
      delegate: { type: 'purl', value: 'pkg:npm/x' },
      expected_principal: 'example.com',
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a call that supplies both card and token', async () => {
    const token = await signDelegation(key);
    const result = await verifyTool().handler({
      card: { _meta: { 'holdings.proof/delegation': { token } } },
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
    });
    expect(result.isError).toBe(true);
  });

  it('points the trust policy at PROOF_BASE_URL, not a hard-coded host', async () => {
    const stagingBase = 'https://staging-api.proof.holdings';
    const stagingTools: RegisteredTool[] = [];
    registerTools(
      ((name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) => {
        stagingTools.push({ name, description, schema, handler });
      }) as never,
      { baseUrl: stagingBase }
    );
    const token = await signDelegation(key);
    const net = routedFetch({ [`${stagingBase}/.well-known/jwks.json`]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    await stagingTools[0].handler({
      token,
      delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
      expected_principal: 'postmarkapp.com',
      check_status: false,
    });

    expect(net.calls).toEqual([`${stagingBase}/.well-known/jwks.json`]);
  });
});

/**
 * The batch checker — the inventory half of h-proof-checker-mcp: re-check everything already
 * trusted in one call instead of one verify_delegation call per artifact. It does NOT discover
 * what is installed and does NOT fetch cards on the caller's behalf (m-artifact-lookup-surface
 * owns closing resolve.ts's SSRF gaps) — it batch-verifies material the caller already holds.
 */
function verifyDelegationsTool(): RegisteredTool {
  const tool = tools.find((entry) => entry.name === 'verify_delegations');
  if (!tool) throw new Error(`verify_delegations not registered. Got: ${tools.map((t) => t.name).join(', ')}`);
  return tool;
}

interface BatchResult {
  results: Array<Record<string, unknown>>;
}

describe('verify_delegations registration', () => {
  it('accepts 1-50 items', () => {
    const schema = verifyDelegationsTool().schema as {
      items: { _def: { minLength: { value: number }; maxLength: { value: number } } };
    };
    expect(schema.items._def.minLength.value).toBe(1);
    expect(schema.items._def.maxLength.value).toBe(50);
  });

  it('rejects an item supplying neither card nor token, at the schema level', () => {
    const schema = verifyDelegationsTool().schema as { items: { element: { safeParse: (v: unknown) => { success: boolean } } } };
    const parsed = schema.items.element.safeParse({
      delegate: { type: 'purl', value: 'pkg:npm/x' },
      expected_principal: 'example.com',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an item supplying both card and token, at the schema level', () => {
    const schema = verifyDelegationsTool().schema as { items: { element: { safeParse: (v: unknown) => { success: boolean } } } };
    const parsed = schema.items.element.safeParse({
      card: {},
      token: 'x',
      delegate: { type: 'purl', value: 'pkg:npm/x' },
      expected_principal: 'example.com',
    });
    expect(parsed.success).toBe(false);
  });

  it('describes the four outcome buckets and the no-discovery / point-in-time limits', () => {
    const description = verifyDelegationsTool().description;
    expect(description).toMatch(/confirmed_valid/);
    expect(description).toMatch(/confirmed_invalid/);
    expect(description).toMatch(/no_claim_found/);
    expect(description).toMatch(/unconfirmed/);
    expect(description).toMatch(/does NOT discover/i);
    expect(description).toMatch(/NEVER treat this as a bad verdict/i);
  });
});

describe('verify_delegations behaviour — the SC-7 outcome buckets, including the sixth', () => {
  it('confirmed_valid: a genuinely valid delegation', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: true },
    });
    vi.stubGlobal('fetch', net.impl);

    const before = new Date().toISOString();
    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });
    const after = new Date().toISOString();

    const body = parse(result) as unknown as BatchResult;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ outcome: 'confirmed_valid', verified: true, status_checked: true });
    const checkedAt = body.results[0].checked_at as string;
    expect(new Date(checkedAt).toISOString()).toBe(checkedAt);
    expect(checkedAt >= before && checkedAt <= after).toBe(true);
  });

  it('confirmed_invalid: revoked-but-untouched card', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: false, reason: 'revoked' },
    });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [
        {
          card: { name: 'io.example/postmark', _meta: { 'holdings.proof/delegation': { token } } },
          delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' },
          expected_principal: 'postmarkapp.com',
        },
      ],
    });

    expect((parse(result) as unknown as BatchResult).results[0]).toMatchObject({
      outcome: 'confirmed_invalid',
      reason: 'revoked',
      verified: false,
    });
  });

  it('confirmed_invalid: expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signDelegation(key, { exp: now - 60 });
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });

    expect((parse(result) as unknown as BatchResult).results[0]).toMatchObject({
      outcome: 'confirmed_invalid',
      reason: 'expired',
    });
  });

  it('confirmed_invalid: delegate mismatch', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [
        { token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp-community' }, expected_principal: 'postmarkapp.com' },
      ],
    });

    expect((parse(result) as unknown as BatchResult).results[0]).toMatchObject({
      outcome: 'confirmed_invalid',
      reason: 'delegate_mismatch',
    });
  });

  it('confirmed_invalid: principal mismatch', async () => {
    const token = await signDelegation(key, { principal: 'evil.example' });
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });

    expect((parse(result) as unknown as BatchResult).results[0]).toMatchObject({
      outcome: 'confirmed_invalid',
      reason: 'principal_mismatch',
    });
  });

  it('no_claim_found: a card with no delegation publication at all — no accusation', async () => {
    const result = await verifyDelegationsTool().handler({
      items: [{ card: { name: 'io.example/plain' }, delegate: { type: 'purl', value: 'pkg:npm/plain' }, expected_principal: 'example.com' }],
    });

    expect((parse(result) as unknown as BatchResult).results[0]).toMatchObject({
      outcome: 'no_claim_found',
      reason: 'no_publication',
    });
  });

  it('THE SIXTH OUTCOME: an unreachable issuer lands in unconfirmed, never confirmed_invalid', async () => {
    const token = await signDelegation(key);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('simulated network failure — issuer unreachable');
      })
    );

    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });

    const item = (parse(result) as unknown as BatchResult).results[0];
    expect(item.outcome).toBe('unconfirmed');
    expect(item.outcome).not.toBe('confirmed_invalid');
    expect(item.verified).toBe(false);
  });
});

describe('verify_delegations behaviour — batch mechanics', () => {
  it('verifies items independently: one bad item does not affect a good one, order preserved', async () => {
    const goodToken = await signDelegation(key);
    const badToken = await signDelegation(key, { principal: 'evil.example' });
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: true },
    });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [
        { token: badToken, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' },
        { token: goodToken, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' },
      ],
    });

    const body = parse(result) as unknown as BatchResult;
    expect(body.results).toHaveLength(2);
    expect(body.results[0].outcome).toBe('confirmed_invalid');
    expect(body.results[1].outcome).toBe('confirmed_valid');
  });

  it('always checks revocation status — no check_status:false escape hatch on the batch tool', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({
      [JWKS_URI]: { keys: [key.publicJwk] },
      [STATUS_ENDPOINT]: { valid: true },
    });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });

    expect((parse(result) as unknown as BatchResult).results[0].status_checked).toBe(true);
    expect(net.calls).toContain(STATUS_ENDPOINT);
  });

  it('requires no API key — registered with { baseUrl } only, same as verify_delegation', async () => {
    const token = await signDelegation(key);
    const net = routedFetch({ [JWKS_URI]: { keys: [key.publicJwk] }, [STATUS_ENDPOINT]: { valid: true } });
    vi.stubGlobal('fetch', net.impl);

    const result = await verifyDelegationsTool().handler({
      items: [{ token, delegate: { type: 'purl', value: 'pkg:npm/postmark-mcp' }, expected_principal: 'postmarkapp.com' }],
    });
    expect(result.isError).toBeUndefined();
  });
});
