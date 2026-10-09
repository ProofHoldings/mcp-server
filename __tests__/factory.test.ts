import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createProofServer } from '../src/factory.js';
import { KEYLESS_TOOLS } from '../src/authBoundary.js';
import { READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, annotationsFor } from '../src/toolAnnotations.js';

/**
 * Guards for the per-connection server factory (`h-mcp-remote`, SC-4).
 *
 * The remote server builds one `McpServer` + one `HttpClient` PER CONNECTION, where the stdio
 * entrypoint builds exactly one of each for the whole process. Two things can go wrong silently,
 * and each has a block below:
 *
 *   1. The factory drifts from the tool modules — a module gets added to `src/tools` and nobody
 *      wires it into the factory. Every existing test stays green, because they exercise the
 *      modules directly; the only symptom is a tool missing from the remote server.
 *   2. Two connections share HTTP state. `HttpClient.captureSetCookie` writes `sessionToken` onto
 *      the INSTANCE, so a shared client means user B inherits user A's logged-in session. On a
 *      single-user stdio process that field is harmless; on a shared server it is the whole
 *      tenancy boundary.
 *
 * The third block pins that `server.ts` actually goes THROUGH the factory. Nothing else would
 * notice if the stdio path kept its own private copy of the registration list — both paths would
 * work, and they would drift apart one module at a time.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(HERE, '../src/tools');
const SERVER_ENTRY = path.join(HERE, '../src/server.ts');

/** Same regex the backend parity tooling applies to these files, so neither side can see a name the other misses. */
function toolNamesInSources(): Set<string> {
  const names = new Set<string>();
  for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
    const content = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8');
    const regex = /\btool\(\s*['"`]([a-zA-Z_][a-zA-Z0-9_]*)['"`]/g;
    let match;
    while ((match = regex.exec(content)) !== null) names.add(match[1]);
  }
  return names;
}

function registeredNames(server: unknown): Set<string> {
  return new Set(Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools));
}

describe('createProofServer — SC-4: registers every tool module, same as the stdio entrypoint', () => {
  it('the names it registers are exactly the names declared in src/tools', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings' });

    const registered = registeredNames(server);
    const declared = toolNamesInSources();

    // Guard against a vacuous pass: an empty set on either side would make the comparison trivial.
    expect(declared.size).toBeGreaterThan(100);
    expect(registered.size).toBeGreaterThan(100);

    const missing = [...declared].filter((name) => !registered.has(name));
    const extra = [...registered].filter((name) => !declared.has(name));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('builds a fresh server and a fresh client on every call', () => {
    const first = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const second = createProofServer({ baseUrl: 'https://api.proof.holdings' });

    expect(first.server).not.toBe(second.server);
    expect(first.http).not.toBe(second.http);
  });
});

describe('createProofServer — SC-4: one connection cannot inherit another connection\'s session', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('a session captured by one connection is not sent by another', async () => {
    const alice = createProofServer({ apiKey: 'pk_alice', baseUrl: 'https://api.proof.holdings' });
    const bob = createProofServer({ apiKey: 'pk_bob', baseUrl: 'https://api.proof.holdings' });

    // Alice logs in: the response carries the session cookie the client captures.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: [
          ['content-type', 'application/json'],
          ['set-cookie', 'token=ALICE_SESSION_JWT; Path=/; HttpOnly'],
        ],
      }),
    );
    await alice.http.post('/api/v1/auth/sessions/verify', {});

    // Alice now reaches a pure-JWT route with her session...
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await alice.http.get('/api/v1/me/emails');
    const aliceAuth = fetchMock.mock.calls[1][1].headers['Authorization'];
    expect(aliceAuth).toBe('Bearer ALICE_SESSION_JWT');

    // ...and Bob, hitting the same route, must NOT travel as Alice. Holding no session of his own,
    // he is told to sign in before anything leaves the process — had he inherited Alice's session
    // the call would have gone out carrying her token.
    await expect(bob.http.get('/api/v1/me/emails')).rejects.toMatchObject({ code: 'user_session_required' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The access notice (`h-fix-mcp-agent-facing-text`, SC-1..SC-4).
 *
 * WHY IT HAS TO LIVE IN THE DESCRIPTION. A tool that needs an account answers 401 with
 * `WWW-Authenticate`, and that challenge is the ONLY reason an OAuth-capable client offers to
 * authenticate at all — so it stays. But an MCP client raises that 401 as a TRANSPORT error: it
 * throws, the body never becomes a tool result, and the model never reads a word of the refusal we
 * spent a whole task writing. Measured on a live client, which then narrated "the token expired"
 * about a server that had never been given a token.
 *
 * `tools/list` and `initialize` are delivered to an anonymous caller and are delivered always. So
 * the same fact is stated in both, and only while it is TRUE: with a credential in hand the notice
 * would be noise on every one of the tools, paid for in the agent's context on every listing.
 */
function descriptionOf(server: unknown, name: string): string {
  const tools = (server as { _registeredTools: Record<string, { description: string }> })._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool '${name}' is not registered`);
  return tool.description;
}

/** One tool from each side of the boundary in `authBoundary.ts`. */
const KEYLESS_SAMPLE = 'start_login';
const SESSION_SAMPLE = 'list_emails';
const KEYED_SAMPLE = 'get_platform_summary';

describe('createProofServer — SC-1: the access notice appears only while the server has no credential', () => {
  it('an account-needing tool carries it when built without a credential', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });

    expect(descriptionOf(server, KEYED_SAMPLE)).toContain('Proof account');
    expect(descriptionOf(server, SESSION_SAMPLE)).toContain('Proof account');
  });

  it('the same tools carry nothing extra once a credential is present', () => {
    const anonymous = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const keyed = createProofServer({ apiKey: 'pk_live_x', baseUrl: 'https://api.proof.holdings', remote: true });

    for (const name of [KEYED_SAMPLE, SESSION_SAMPLE]) {
      const withKey = descriptionOf(keyed.server, name);
      const without = descriptionOf(anonymous.server, name);

      expect(without.startsWith(withKey)).toBe(true);
      expect(without.length).toBeGreaterThan(withKey.length);
    }
  });

  it('a keyless tool carries nothing either way — it needs no account to begin with', () => {
    const anonymous = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const keyed = createProofServer({ apiKey: 'pk_live_x', baseUrl: 'https://api.proof.holdings', remote: true });

    expect(descriptionOf(anonymous.server, KEYLESS_SAMPLE)).toBe(descriptionOf(keyed.server, KEYLESS_SAMPLE));
  });
});

describe('createProofServer — SC-1: every tool outside the keyless set carries the notice', () => {
  it('the notice reaches all of them, not just the three this file samples', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );

    // Guard against a vacuous pass on either side.
    expect(registered.length).toBeGreaterThan(100);
    expect(registered.filter((name) => KEYLESS_TOOLS.has(name)).length).toBe(KEYLESS_TOOLS.size);

    // Sampling three names could not see a registration shape the factory's wrapper passes through
    // untouched — today every module registers `tool(name, description, …)`, but a future
    // `tool(name, schema, cb)` would silently get no notice with every sampled case still green.
    const missing = registered.filter(
      (name) => !KEYLESS_TOOLS.has(name) && !descriptionOf(server, name).includes('ACCESS: needs a Proof account'),
    );
    expect(missing).toEqual([]);

    const wrongly = registered.filter(
      (name) => KEYLESS_TOOLS.has(name) && descriptionOf(server, name).includes('ACCESS:'),
    );
    expect(wrongly).toEqual([]);
  });
});

describe('createProofServer — SC-2: the notice says WHICH class of access opens the tool', () => {
  it('a session-reachable tool offers start_login; a keyed tool says it will not help', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });

    const session = descriptionOf(server, SESSION_SAMPLE);
    const keyed = descriptionOf(server, KEYED_SAMPLE);

    expect(session).toContain('start_login');
    expect(session).not.toMatch(/start_login does NOT/);

    // The defect `h-fix-mcp-refusal-roads` fixed in the 401 body, restated here: sending every
    // refused caller to start_login walked a human through a whole login for a second refusal.
    expect(keyed).toMatch(/start_login does NOT/);
  });
});

describe('createProofServer — SC-3: the recipe matches the transport', () => {
  it('the remote server names the in-client step; the stdio server names the variable it reads', () => {
    const remote = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const stdio = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const keyed = createProofServer({ apiKey: 'pk_live_x', baseUrl: 'https://api.proof.holdings' });

    // SLICED to the notice itself. Run over the whole description these negatives would be
    // satisfied by the base text happening to mention neither token, and would turn red the day
    // somebody edits that base text for an unrelated reason.
    const base = descriptionOf(keyed.server, KEYED_SAMPLE).length;
    const remoteNotice = descriptionOf(remote.server, KEYED_SAMPLE).slice(base);
    const stdioNotice = descriptionOf(stdio.server, KEYED_SAMPLE).slice(base);

    expect(remoteNotice.length).toBeGreaterThan(0);
    expect(stdioNotice.length).toBeGreaterThan(0);

    // Asserted on the ACTION each branch names, not on the client UI beside it: `/mcp` occurs only
    // inside the "(Claude Code: …)" parenthetical, so pinning that string would make this case red
    // the day the parenthetical is reworded for a reason SC-3 says nothing about.
    expect(remoteNotice).toContain('Authenticate this client');
    expect(remoteNotice).not.toContain('PROOF_API_KEY');

    // Telling somebody to set an environment variable on a server another company runs is the
    // instruction this branch exists to avoid, and vice versa.
    expect(stdioNotice).toContain('PROOF_API_KEY');
    expect(stdioNotice).not.toContain('Authenticate this client');
  });
});

describe('createProofServer — SC-4: the server carries instructions', () => {
  it('states what the server is, that it starts credential-less, and how to sign in', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '';

    expect(instructions).toContain('Proof');
    expect(instructions).toContain('start_login');
    expect(instructions).toContain('/mcp');
    // The lie a real client told a real user when it could not read our refusal...
    expect(instructions).toMatch(/no expired token is involved/i);
    // ...and the other real cause, which the paragraph used to deny outright: this server drops
    // idle sessions, so a long anonymous bootstrap can fail opaquely with nothing wrong credentially.
    expect(instructions).toMatch(/idle/i);
  });

  it('lists every keyless tool by name, derived from the set rather than retyped', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '';

    // The prose beside this list was removed for the same reason the list is derived: a sentence
    // saying what these tools "cover" is true of today's set and silently false of the next
    // addition. What CAN be pinned is that every member is actually named.
    const missing = [...KEYLESS_TOOLS].filter((name) => !instructions.includes(name));
    expect(missing).toEqual([]);
    expect(KEYLESS_TOOLS.size).toBeGreaterThan(5);
  });

  it('drops the sign-in half once a credential is present', () => {
    const { server } = createProofServer({ apiKey: 'pk_live_x', baseUrl: 'https://api.proof.holdings', remote: true });
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '';

    expect(instructions).toContain('Proof');
    expect(instructions).not.toContain('/mcp →');
  });
});

describe('createProofServer — SC-4: the stdio entrypoint goes through the factory', () => {
  it('server.ts calls the factory and keeps no private registration list', () => {
    const source = fs.readFileSync(SERVER_ENTRY, 'utf-8');

    expect(source).toContain('createProofServer');

    // A second copy of the registration list is the drift this block exists for: both paths would
    // work on the day it is written and diverge one module at a time afterwards.
    const registerCalls = source.match(/^\s*register[A-Z][A-Za-z]*\(/gm) ?? [];
    expect(registerCalls).toEqual([]);
  });
});

/**
 * Tool annotations (live review 2026-09-26, M5).
 *
 * The table in `toolAnnotations.ts` is names; the truth is what each handler SENDS. So the split is
 * derived here from the HTTP method each registration's handler calls, and the two must agree both
 * ways — a new DELETE tool left out of `DESTRUCTIVE_TOOLS` would otherwise advertise itself to every
 * client as additive, and a new write left in `READ_ONLY_TOOLS` would be auto-approved as a read.
 */
describe('createProofServer — every tool tells the client what it does to the account', () => {
  /** Names whose meaning the method alone gets wrong, each with the reason it is an exception. */
  const READ_ONLY_POSTS = new Set(['validate_proof', 'preview_template', 'preview_profile_template', 'render_template']);
  const SIDE_EFFECT_GETS = new Set(['export_data']); // spends the once-per-24h export allowance
  const DESTRUCTIVE_POSTS = new Set([
    'revoke_delegation', // terminal
    'revoke_proof', // terminal
    'regenerate_api_key', // invalidates the old key
    // Upsert the account-level DnsProviderCredential, replacing the token every other domain uses.
    'connect_cloudflare',
    'connect_godaddy',
    'connect_dns_provider',
    'add_verification_provider',
    'create_dns_credential',
    // Demote the current primary profile (`PublicProfile.ensureSinglePrimary`).
    'set_primary_profile',
    'create_profile',
  ]);
  const LOCAL_TOOLS = new Set(['render_auth_link', 'verify_delegation', 'verify_delegations']);

  /** tool name → the `http.<verb>(` calls inside its registration, read from the module source. */
  function methodsByTool(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const file of fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(TOOLS_DIR, file), 'utf-8');
      const starts = [...source.matchAll(/\btool\(\s*['"`]([a-zA-Z_][a-zA-Z0-9_]*)['"`]/g)];
      starts.forEach((m, i) => {
        const block = source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : source.length);
        out.set(m[1], new Set([...block.matchAll(/\bhttp\.(get|post|put|patch|del)\s*[<(]/g)].map((c) => c[1])));
      });
    }
    return out;
  }

  it('stamps annotationsFor() onto every registration', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const tools = (server as unknown as { _registeredTools: Record<string, { annotations?: unknown }> })._registeredTools;
    const wrong = Object.entries(tools)
      .filter(([name, t]) => JSON.stringify(t.annotations) !== JSON.stringify(annotationsFor(name)))
      .map(([name, t]) => `${name}: ${JSON.stringify(t.annotations)}`);
    expect(Object.keys(tools).length).toBeGreaterThan(100);
    expect(wrong).toEqual([]);
  });

  it('names only registered tools, and no tool is both a read and destructive', () => {
    const registered = registeredNames(createProofServer({ baseUrl: 'https://api.proof.holdings' }).server);
    const unknown = [...READ_ONLY_TOOLS, ...DESTRUCTIVE_TOOLS].filter((n) => !registered.has(n));
    const both = [...READ_ONLY_TOOLS].filter((n) => DESTRUCTIVE_TOOLS.has(n));
    expect({ unknown, both }).toEqual({ unknown: [], both: [] });
  });

  it('agrees with the HTTP method each handler calls, both ways', () => {
    const methods = methodsByTool();
    const registered = registeredNames(createProofServer({ baseUrl: 'https://api.proof.holdings' }).server);

    // Anti-vacuity: the parse must see every registration, and "calls no HTTP" must mean the three
    // local tools and nothing else — a handler the regex failed to read would otherwise pass as a read.
    expect([...methods.keys()].sort()).toEqual([...registered].sort());
    const silent = [...methods].filter(([, m]) => m.size === 0).map(([n]) => n).sort();
    expect(silent).toEqual([...LOCAL_TOOLS].sort());

    const expectedReadOnly = new Set<string>();
    const expectedDestructive = new Set<string>();
    for (const [name, m] of methods) {
      const onlyGets = [...m].every((verb) => verb === 'get');
      const readOnly = (onlyGets && !SIDE_EFFECT_GETS.has(name)) || READ_ONLY_POSTS.has(name);
      if (readOnly) expectedReadOnly.add(name);
      else if (m.has('put') || m.has('patch') || m.has('del') || DESTRUCTIVE_POSTS.has(name)) expectedDestructive.add(name);
    }

    expect({
      readOnly: [...READ_ONLY_TOOLS].sort(),
      destructive: [...DESTRUCTIVE_TOOLS].sort(),
    }).toEqual({
      readOnly: [...expectedReadOnly].sort(),
      destructive: [...expectedDestructive].sort(),
    });
  });
});

describe('createProofServer — the API learns which agent is calling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A real MCP handshake over an in-memory pair, by a client that calls itself `name`. */
  async function connect(instance: ReturnType<typeof createProofServer>, name: string) {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.server.connect(serverSide);
    await new Client({ name, version: '2.0.0' }).connect(clientSide);
  }

  const agentNameOfCall = (index: number) => fetchMock.mock.calls[index][1].headers['X-Proof-Agent-Name'];

  it('sends no name before the client has introduced itself', async () => {
    const instance = createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' });
    await instance.http.get('/api/v1/test');
    expect(agentNameOfCall(0)).toBeUndefined();
  });

  it('sends the name the client gave in its handshake', async () => {
    const instance = createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' });
    await connect(instance, 'claude-code');
    await instance.http.get('/api/v1/test');
    expect(agentNameOfCall(0)).toBe('claude-code');
  });

  it('keeps each connection to its own client name', async () => {
    const first = createProofServer({ apiKey: 'pk_a', baseUrl: 'https://api.proof.holdings', remote: true });
    const second = createProofServer({ apiKey: 'pk_b', baseUrl: 'https://api.proof.holdings', remote: true });
    await connect(first, 'claude-code');
    await connect(second, 'cursor-vscode');

    await first.http.get('/api/v1/test');
    await second.http.get('/api/v1/test');
    expect([agentNameOfCall(0), agentNameOfCall(1)]).toEqual(['claude-code', 'cursor-vscode']);
  });
});
