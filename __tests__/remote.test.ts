import { createServer as createHttpServer, type Server } from 'node:http';
import net from 'node:net';

import { describe, it, expect, afterEach } from 'vitest';

import { keyedToolsIn, malformedToolCallBody, MALFORMED_TOOL_NAME } from '../src/authBoundary.js';

import {
  createRemoteServer,
  createResolveBudget,
  positiveIntEnv,
  resolveReplicaId,
  RESOLVE_BURST_CEILING,
  type RemoteServer,
} from '../src/remote.js';

/**
 * Guards for the remote (Streamable HTTP) entrypoint — `h-mcp-remote`, SC-3 + SC-4.
 *
 * This file is the one that turns "one process, one user" into "one process, many users", so the
 * properties below are the tenancy boundary itself rather than conveniences:
 *
 *   - Every MCP session gets its OWN server and its OWN `HttpClient`. A shared client would hand
 *     the next connection the previous connection's captured login (see `factory.test.ts`).
 *   - A session id is required for anything but the opening request, and an unknown one is
 *     refused rather than silently promoted to a new session — that refusal is exactly what makes
 *     sticky routing OBSERVABLE: without it, a request landing on the wrong replica would quietly
 *     start a second session and the misrouting would look like success.
 *   - Sessions are bounded in both count and lifetime. Each one registers the full tool set, so an
 *     unbounded map is a memory leak reachable by anyone who can open a connection.
 */

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let running: RemoteServer | undefined;
const stubs: Server[] = [];

async function start(options?: Partial<Parameters<typeof createRemoteServer>[0]>) {
  running = createRemoteServer({ baseUrl: 'https://api.proof.holdings', ...options });
  const port = await new Promise<number>((resolve) => {
    running!.httpServer.listen(0, () => resolve((running!.httpServer.address() as ReturnType<Server['address']> & { port: number }).port));
  });
  return { url: `http://127.0.0.1:${port}`, remote: running };
}

/** Same as `start`, but hands back the port for the raw-socket cases below. */
async function startRaw(options?: Partial<Parameters<typeof createRemoteServer>[0]>) {
  const { url, remote } = await start(options);
  return { port: Number(new URL(url).port), remote };
}

/**
 * A socket with the request head already written and the BODY WITHHELD.
 *
 * This is the shape `fetch` cannot produce, and two defects live exactly there: the window between
 * the session cap check and the map write, and a request whose lifetime spans more than one TTL.
 */
async function openSocket(port: number, head: string) {
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(head);

  return {
    write: (chunk: string) => socket.write(chunk),
    /** Writes the final chunk and reads until the server stops sending. */
    sendAndRead: (chunk: string) =>
      new Promise<string>((resolve) => {
        let received = '';
        const done = () => resolve(received);
        socket.on('data', (data) => {
          received += String(data);
          // Enough of a reply to classify it; SSE bodies never "end" on their own.
          if (received.includes('\r\n\r\n')) setTimeout(done, 60);
        });
        socket.once('close', done);
        socket.write(chunk);
        setTimeout(done, 3000);
      }),
    end: () => socket.destroy(),
  };
}

/** Opens a session over a raw socket and returns its id. */
async function openSessionRaw(port: number): Promise<string> {
  const payload = JSON.stringify(INIT_BODY);
  const socket = await openSocket(port, [
    'POST /mcp HTTP/1.1',
    'Host: 127.0.0.1',
    'content-type: application/json',
    'accept: application/json, text/event-stream',
    `content-length: ${Buffer.byteLength(payload)}`,
    '',
    '',
  ].join('\r\n'));
  const reply = await socket.sendAndRead(payload);
  socket.end();

  const match = reply.match(/mcp-session-id: (\S+)/i);
  if (!match) throw new Error(`no session id in raw reply:\n${reply}`);
  return match[1];
}

async function openSession(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(INIT_BODY),
  });
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`no session id in response (status ${response.status})`);
  // The SDK refuses `tools/call` on a session that never acknowledged the handshake.
  await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });
  return sessionId;
}

/** One `tools/call`, returned unread so a case can look at the status and the headers first. */
function callTool(
  url: string,
  sessionId: string,
  name: string,
  headers: Record<string, string> = {},
  args: Record<string, unknown> = {},
) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
  });
}

interface StubRequest {
  path: string;
  authorization?: string;
}

/**
 * A stand-in for the Proof API, so the cases below can watch what the remote server sends UPSTREAM.
 *
 * The whole point of several of them is a negative — "this value never left the process" — and a
 * negative about outbound traffic cannot be read off a response body. `requests` is that evidence.
 */
interface StubAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  setCookie?: string[];
}

async function startStubBackend(reply: (path: string, request: StubRequest) => StubAnswer) {
  const requests: StubRequest[] = [];
  const server = createHttpServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const entry: StubRequest = { path, authorization: req.headers.authorization };
    requests.push(entry);
    const answer = reply(path, entry);
    res
      .writeHead(answer.status, {
        'content-type': 'application/json',
        ...answer.headers,
        ...(answer.setCookie ? { 'set-cookie': answer.setCookie } : {}),
      })
      .end(JSON.stringify(answer.body));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => resolve((server.address() as { port: number }).port));
  });
  stubs.push(server);
  return { url: `http://127.0.0.1:${port}`, requests };
}

/** The answer a live, `settings:read`-carrying key gets from `GET /api/v1/me/api-key`. */
const SELF_KEY_OK = { status: 200, body: { id: 'key_1', name: 'MCP: example.com', scopes: ['settings:read'] } };

afterEach(async () => {
  await running?.close();
  running = undefined;
  await Promise.all(stubs.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('remote server — SC-4: every connection gets its own server and client', () => {
  it('two connections produce two session ids and two distinct HttpClients', async () => {
    const { url, remote } = await start();

    const first = await openSession(url);
    const second = await openSession(url);

    expect(first).not.toBe(second);
    expect(remote.sessionCount()).toBe(2);

    const clients = remote.debugClients();
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
  });
});

describe('remote server — SC-1: the 401 lands on the tool, never on the connection', () => {
  it('lets an anonymous client connect, list tools and run a keyless one', async () => {
    // The control measurement for the opposite arrangement is in
    // `docs/mcp-oauth-client-probe.md` SC-5: a 401 on `initialize` reached the human as
    // `Failed to connect — connection timed out after 30000ms`, i.e. no connection at all. Every
    // assertion here is that measurement written down.
    const { url } = await start();

    const opened = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
    const sessionId = opened.headers.get('mcp-session-id')!;
    await opened.text();
    expect(opened.status).toBe(200);
    expect(opened.headers.get('www-authenticate')).toBeNull();

    await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });

    const listed = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    await listed.text();
    expect(listed.status).toBe(200);

    // `render_auth_link` is the one keyless tool that touches no network at all, so this case
    // measures the gate rather than the reachability of api.proof.holdings.
    const keyless = await callTool(url, sessionId, 'render_auth_link');
    await keyless.text();
    expect(keyless.status).not.toBe(401);
  });

  it('refuses a keyed tool with a challenge naming the resource-metadata document', async () => {
    const { url } = await start();
    const sessionId = await openSession(url);

    const called = await callTool(url, sessionId, 'list_verifications');
    await called.text();

    expect(called.status).toBe(401);
    const challenge = called.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer');
    // The address is ours to choose — the probe measured every client fetching whatever
    // `resource_metadata` names — so it must be the one the backend actually serves.
    expect(challenge).toContain('resource_metadata="https://api.proof.holdings/.well-known/oauth-protected-resource"');
  });
});

/**
 * The two anonymous channels, asserted ON THE WIRE (`h-fix-mcp-agent-facing-text`, SC-1..SC-4).
 *
 * `factory.test.ts` reads the same strings off a constructed server, which proves the text is built
 * correctly and proves nothing about it being DELIVERED. That gap is the whole reason this task
 * exists: the refusal body is also built correctly, and a client throws it away before the model can
 * read it. So the notice and the instructions are checked where a client would meet them — in the
 * `initialize` result and in a `tools/list` reply that travelled over HTTP.
 */
function eventStreamPayloads(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>);
}

describe('remote server — SC-4: an anonymous handshake is told how to sign in', () => {
  it('the initialize result carries instructions naming both roads', async () => {
    const { url } = await start();

    const opened = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
    const body = await opened.text();

    expect(opened.status).toBe(200);

    const initResult = eventStreamPayloads(body)
      .map((message) => (message as { result?: { instructions?: string } }).result)
      .find((result) => result !== undefined);

    expect(initResult?.instructions).toContain('start_login');
    expect(initResult?.instructions).toContain('/mcp → this server → Authenticate');
    expect(initResult?.instructions).toMatch(/no expired token is involved/i);
  });

  it('tools/list carries the per-tool access notice, which is what the model reads when a call throws', async () => {
    const { url } = await start();
    const sessionId = await openSession(url);

    const listed = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const body = await listed.text();
    expect(listed.status).toBe(200);

    const tools = eventStreamPayloads(body)
      .flatMap((message) => (message as { result?: { tools?: Array<{ name: string; description: string }> } }).result?.tools ?? []);
    const byName = new Map(tools.map((t) => [t.name, t.description]));

    // Guard against a vacuous pass: an empty listing would satisfy every assertion below.
    expect(tools.length).toBeGreaterThan(100);

    expect(byName.get('get_platform_summary')).toMatch(/start_login does NOT open this tool/);
    expect(byName.get('list_emails')).toContain('sign in with start_login');
    expect(byName.get('render_auth_link')).not.toContain('ACCESS:');
  });
});

describe('remote server — SC-1: a refused tool call is a refusal, not work', () => {
  it('neither holds the in-flight slot nor postpones the idle TTL', async () => {
    // Two failure modes in one shape, both invisible from the refusal itself. The counter is taken
    // BEFORE the body is read, so a gate that returns without releasing it leaves the session
    // permanently "busy" and the sweeper skips it forever; and stamping `lastSeen` on a 401 would
    // let a stream of refusals hold a session open for free — the same defect the 413 case below
    // pins for oversized bodies.
    const { url, remote } = await start({ sessionTtlMs: 400, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    // Refusals spread across the window, all comfortably inside the TTL — so the sweep below is
    // about whether they MOVED the clock, not about whether the session had time to age.
    for (let i = 0; i < 4; i++) {
      const refused = await callTool(url, sessionId, 'list_verifications');
      await refused.text();
      expect(refused.status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(remote.sessionCount()).toBe(1);

    // Past the TTL measured from the LAST accepted request. A refusal that stamped `lastSeen`
    // would push this out; one that kept the in-flight slot would make the sweeper skip it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(remote.sessionCount()).toBe(0);
  });
});

describe('remote server — SC-2: the refusal names the action and carries a working link', () => {
  it('tells a Claude Code user to sign in AND repeat the call, with a link either way', async () => {
    // Written for the worst measured client: Inspector replays the call itself and Desktop does it
    // after one button press, but Claude Code stops before the browser step, needs a separate
    // command, and never replays — so this body is that person's entire instruction.
    const { url } = await start();
    const sessionId = await openSession(url);

    const called = await callTool(url, sessionId, 'get_platform_summary');
    const body = JSON.parse(await called.text());

    expect(body.error).toBe('authorization_required');
    expect(body.error_description).toContain('get_platform_summary');
    expect(body.error_description).toContain('CALL THE TOOL AGAIN');
    expect(body.error_description).toContain('claude mcp login');
    // Built from this server's base URL rather than hardcoded, and pointing at an endpoint that
    // exists: `GET /api/v1/mcp/connect` is public and keyless (`h-mcp-showcase`). Named for what it
    // IS — a JSON document for the client — after a human opened the old `login_url` in a browser
    // expecting a sign-in page and got the raw document (h-fix-mcp-refusal-roads).
    expect('login_url' in body).toBe(false);
    expect(body.connect_instructions_url).toBe('https://api.proof.holdings/api/v1/mcp/connect');
    expect(body.error_description).toContain('inside the client');
    // get_platform_summary is NOT on the session surface, so the keyless road must say it will
    // not open this tool rather than send the caller down it.
    expect(body.keyless_alternative).toContain('start_login');
    expect(body.keyless_alternative).toContain('will NOT unlock');
  });
});

describe('remote server — SC-3: a presented token is resolved by self-inspection', () => {
  it('opens a keyed session after ONE self-inspection carrying that very token', async () => {
    const stub = await startStubBackend(() => SELF_KEY_OK);
    const { url } = await start({ baseUrl: stub.url });

    const sessionId = await openSession(url, { authorization: 'Bearer pk_live_good' });
    expect(sessionId).toBeTruthy();

    const inspections = stub.requests.filter((entry) => entry.path === '/api/v1/me/api-key');
    expect(inspections).toHaveLength(1);
    expect(inspections[0].authorization).toBe('Bearer pk_live_good');

    // And the session is keyed: the tool that was refused anonymously now reaches the backend.
    const called = await callTool(url, sessionId, 'list_verifications', { authorization: 'Bearer pk_live_good' });
    await called.text();
    expect(called.status).not.toBe(401);
    expect(stub.requests.some((entry) => entry.path === '/api/v1/verifications')).toBe(true);
  });

  it('refuses a dead token with a challenge instead of opening an anonymous session', async () => {
    // Opening anonymously here would be the quiet failure: the client believes it is signed in,
    // every keyed call answers `authorization_required`, and nothing ever tells it the token died.
    // The challenge is what makes Inspector refresh silently (measured, probe § refresh_token).
    const stub = await startStubBackend(() => ({ status: 401, body: { error: { code: 'invalid_token' } } }));
    const { url } = await start({ baseUrl: stub.url });

    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer pk_live_dead' },
      body: JSON.stringify(INIT_BODY),
    });
    await opened.text();

    expect(opened.status).toBe(401);
    expect(opened.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(opened.headers.get('mcp-session-id')).toBeNull();
  });

  it('names the missing scope rather than answering a silent invalid_token', async () => {
    const stub = await startStubBackend(() => ({
      status: 403,
      body: { error: { code: 'insufficient_scope', message: 'missing scope' } },
    }));
    const { url } = await start({ baseUrl: stub.url });

    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer pk_live_narrow' },
      body: JSON.stringify(INIT_BODY),
    });
    const body = JSON.parse(await opened.text());

    expect(opened.status).toBe(403);
    expect(body.error).toBe('insufficient_scope');
    expect(body.required_scope).toBe('settings:read');
  });
});

describe('remote server — SC-4: two identities on one process do not see each other', () => {
  it('gives each session its own client and sends each token only to its own session', async () => {
    const stub = await startStubBackend(() => SELF_KEY_OK);
    const { url, remote } = await start({ baseUrl: stub.url });

    const first = await openSession(url, { authorization: 'Bearer pk_live_alice' });
    const second = await openSession(url, { authorization: 'Bearer pk_live_bob' });
    const anonymous = await openSession(url);

    expect(new Set([first, second, anonymous]).size).toBe(3);
    const clients = remote.debugClients();
    expect(clients).toHaveLength(3);
    expect(new Set(clients).size).toBe(3);

    await (await callTool(url, first, 'list_verifications', { authorization: 'Bearer pk_live_alice' })).text();

    const outbound = stub.requests.filter((entry) => entry.path === '/api/v1/verifications');
    expect(outbound).toHaveLength(1);
    // Alice's call left with Alice's token. A shared client would have carried whichever token was
    // captured last — which is the whole reason the factory builds one per connection.
    expect(outbound[0].authorization).toBe('Bearer pk_live_alice');

    // The anonymous session is unaffected by the two keyed ones living beside it.
    const refused = await callTool(url, anonymous, 'list_verifications');
    await refused.text();
    expect(refused.status).toBe(401);
  });
});

describe('remote server — SC-5: a revoked key closes the session on the NEXT call', () => {
  it('answers the tool call with a refusal rather than working until the session TTL', async () => {
    // The self-inspection at open is about making the refusal legible, and NOTHING is cached from
    // it. If it were, this is where that would show: the key dies mid-session and the gate would
    // keep waving calls through for the rest of a 30-minute TTL.
    let revoked = false;
    const stub = await startStubBackend((path) => {
      if (path === '/api/v1/me/api-key' && !revoked) return SELF_KEY_OK;
      return { status: 401, body: { error: { code: 'invalid_token', message: 'API key revoked' } } };
    });
    const { url } = await start({ baseUrl: stub.url });

    const sessionId = await openSession(url, { authorization: 'Bearer pk_live_soon_revoked' });
    revoked = true;

    const called = await callTool(url, sessionId, 'list_verifications', { authorization: 'Bearer pk_live_soon_revoked' });
    const body = await called.text();

    expect(body).toContain('invalid_token');
    // The decision was taken by the backend on THIS call, not by anything remembered here.
    expect(stub.requests.some((entry) => entry.path === '/api/v1/verifications')).toBe(true);
  });
});

describe('remote server — SC-1: the gate does not rest on the SDK refusing a batch', () => {
  it('refuses a keyed tool smuggled into the opening batch', async () => {
    // `isInitialize` accepts any batch CONTAINING an initialize, so this shape would otherwise
    // reach the transport without passing the gate. Today the SDK refuses it on its own and an
    // anonymous session has no credential to spend — but both are properties of somebody else's
    // code, and this case is what makes the boundary independent of them.
    const { url } = await start();

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify([
        INIT_BODY,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_verifications', arguments: {} } },
      ]),
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(body).toContain('authorization_required');
    // Nothing was opened for it either.
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });
});

describe('remote server — SC-2: the road the refusal advertises actually works', () => {
  it('a session that signs in through start_login reaches the tools that login unlocks', async () => {
    // The refusal tells a client with no OAuth to call `start_login`, and `mcp/README.md` promises
    // the login flows work with no credential. That is only true if signing in actually changes
    // what the session may do: `captureSetCookie` puts the JWT on this connection's HttpClient, and
    // the tools behind `SESSION_AUTH_PREFIXES` travel with it. A gate that looks only for a
    // presented API key refuses them anyway — the user signs in and is told to sign in.
    const stub = await startStubBackend((path) => {
      if (path === '/api/v1/auth/sessions') {
        return { status: 201, body: { id: 'auth_1', status: 'pending' }, setCookie: ['token=jwt-for-this-session; Path=/; HttpOnly'] };
      }
      return { status: 200, body: { data: [] } };
    });
    const { url } = await start({ baseUrl: stub.url });
    const sessionId = await openSession(url);

    // Before signing in, the keyed surface is refused — the positive control for the case below.
    const before = await callTool(url, sessionId, 'list_api_keys');
    await before.text();
    expect(before.status).toBe(401);

    const login = await callTool(url, sessionId, 'start_login', {}, { channel: 'email', email: 'someone@example.test' });
    const loginBody = await login.text();
    expect(login.status).toBe(200);
    // The call really reached the backend — otherwise no cookie could have been captured and the
    // assertion below would be measuring a schema rejection rather than the gate.
    expect(loginBody).not.toContain('isError');
    expect(stub.requests.some((entry) => entry.path === '/api/v1/auth/sessions')).toBe(true);

    const after = await callTool(url, sessionId, 'list_api_keys');
    const body = await after.text();

    expect(after.status).not.toBe(401);
    expect(body).not.toContain('authorization_required');
    // …and it travelled as the logged-in user, not as nobody.
    const keysCall = stub.requests.find((entry) => entry.path === '/api/v1/me/api-keys');
    expect(keysCall?.authorization).toBe('Bearer jwt-for-this-session');
  });
});

describe('remote server — SC-2: the advertised road, walked the way the backend answers', () => {
  it('start_login then wait_for_login leaves the session able to use the tools login unlocks', async () => {
    // The case above proves the GATE reads a session token; this one walks the road the refusal
    // actually advertises, with the cookie where the real backend puts it — on the POLL, once the
    // person has confirmed (`src/controllers/auth.ts` sets it only for a verified session), not on
    // the call that starts the login.
    const stub = await startStubBackend((path) => {
      if (path.startsWith('/api/v1/auth/sessions/')) {
        return {
          status: 200,
          body: { id: 'auth_1', status: 'verified' },
          setCookie: ['token=jwt-from-the-poll; Path=/; HttpOnly'],
        };
      }
      if (path === '/api/v1/auth/sessions') return { status: 201, body: { id: 'auth_1', status: 'pending' } };
      return { status: 200, body: { data: [] } };
    });
    const { url } = await start({ baseUrl: stub.url });
    const sessionId = await openSession(url);

    await (await callTool(url, sessionId, 'start_login', {}, { channel: 'email', email: 'someone@example.test' })).text();
    const waited = await callTool(url, sessionId, 'wait_for_login', {}, { id: 'auth_1' });
    await waited.text();

    const after = await callTool(url, sessionId, 'list_api_keys');
    await after.text();

    expect(after.status).not.toBe(401);
    expect(stub.requests.find((entry) => entry.path === '/api/v1/me/api-keys')?.authorization).toBe(
      'Bearer jwt-from-the-poll',
    );
  }, 30_000);
});

describe('remote server — resolving a token cannot park capacity', () => {
  it('answers fast and leaves the anonymous surface reachable when the API rate-limits us', async () => {
    // The self-inspection runs INSIDE the capacity reservation, so however long it takes is time a
    // slot is held. The ordinary client retries twice and honours `Retry-After`, and the backend's
    // /me surface answers `Retry-After: 60` from ONE per-pod IP bucket shared by every tenant — so
    // a single credential-less request could hold a slot for two minutes, and enough of them close
    // the anonymous surface this service exists to keep open.
    const stub = await startStubBackend(() => ({
      status: 429,
      body: { error: { code: 'rate_limited' } },
      headers: { 'retry-after': '60' },
    }));
    const { url } = await start({ baseUrl: stub.url, maxSessions: 1 });

    const started = Date.now();
    const answer = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer pk_live_whatever' },
      body: JSON.stringify(INIT_BODY),
    });
    await answer.text();
    const elapsed = Date.now() - started;

    // TWO properties, and neither is measured by racing the two requests — an earlier version slept
    // 300ms and hoped the refusal had landed, which is a coin flip on a loaded machine (measured: it
    // came back at 302ms once and reddened a correct server).
    //
    // (1) It answered FAST. With the session client's settings this call would retry twice, sleeping
    //     `Retry-After: 60` each time, and the reservation is held for all of it.
    expect({ what: 'refusal answered within', elapsed, fast: elapsed < 15_000 }).toEqual({
      what: 'refusal answered within',
      elapsed,
      fast: true,
    });

    // (2) It PARKED NOTHING. `maxSessions: 1`, so if that refusal had kept its reservation the next
    //     open — an ordinary anonymous one — would be answered 503 `session_capacity_reached`.
    const anonymous = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
    await anonymous.text();
    expect(anonymous.status).toBe(200);
    // Our own budget did not fire here — one request is well inside it — so the 429 below is the
    // upstream's, and it carries no `Retry-After` we cannot compute.
    expect(answer.headers.get('retry-after')).toBeNull();
    // A rate-limited upstream is its own answer, not a token verdict: 503 would tell the client the
    // service is down and 401 would tell it to sign in again, and both are wrong.
    expect(answer.status).toBe(429);
    // One attempt, not three: the retrying client is what turns a 429 into a two-minute hold.
    expect(stub.requests.filter((entry) => entry.path === '/api/v1/me/api-key')).toHaveLength(1);
  }, 30_000);
});

describe('remote server — the self-inspection cannot drain the API budget', () => {
  it('rate-limits itself before the shared backend bucket, and never the anonymous surface', async () => {
    // The refusal path releases its reservation at once, so nothing in this process bounds how FAST
    // opens carrying a garbage bearer arrive. The proxy allows 30 r/s per client IP while the
    // backend's /me surface is one ~5 r/s bucket keyed on the POD's egress IP and shared by every
    // tenant — so without a local budget one source drains it and every LEGITIMATE keyed connection
    // is answered 429, with the anonymous surface still up and the service looking healthy.
    // Garbage bearers, which is the traffic that matters here: each one spends a token and a
    // backend call, and its refusal returns the session slot at once — so capacity never stops it
    // and only this budget does.
    const stub = await startStubBackend(() => ({ status: 401, body: { error: { code: 'invalid_token' } } }));
    const { url } = await start({ baseUrl: stub.url, maxSessions: 3 });

    const answers: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer pk_live_burst_${i}` },
        body: JSON.stringify(INIT_BODY),
      });
      await response.text();
      answers.push(response.status);
      if (response.status === 429 && !limited) limited = response;
    }

    // The burst — sized off the session cap, so a reconnect herd is never refused — is spent, and
    // the rest are refused HERE rather than upstream.
    expect(answers.filter((status) => status === 429).length).toBeGreaterThan(0);
    // …and the upstream was asked no more often than our own budget allows.
    expect(stub.requests.filter((entry) => entry.path === '/api/v1/me/api-key').length).toBeLessThan(8);
    // Our own refusal knows the number, so it says when to come back.
    expect(limited?.headers.get('retry-after')).toBeTruthy();

    // The anonymous surface is untouched — it makes no upstream call, and that is the whole point
    // of bounding this one.
    const anonymous = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
    await anonymous.text();
    expect(anonymous.status).toBe(200);
  });
});

describe('resolve budget — the arithmetic, without an HTTP round trip', () => {
  it('spends a burst sized off the session cap, then refills at the sustained rate', () => {
    let clock = 0;
    const budget = createResolveBudget(4, () => clock);

    // The burst is the CAP, not a number of its own: a reconnect herd after a restart is bounded by
    // how many sessions a replica can hold, and a smaller burst turns that herd into refusals.
    expect([budget.take(), budget.take(), budget.take(), budget.take()]).toEqual([true, true, true, true]);
    expect(budget.take()).toBe(false);

    clock += 1000;
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it('lets a full reconnect herd through at a REALISTIC cap, not just a tiny one', () => {
    // The cases either side of this one use caps of 2 and 4, and every one of them is satisfied by
    // a burst clamped to any constant ≥ 5 — measured: `Math.min(5, maxSessions)` left all 46 remote
    // cases green. The property the burst exists for is about the SHIPPED cap: a replica holds up
    // to `maxSessions` sessions, so a restart can produce that many reconnects at once, and the SDK
    // client does not retry a 429. So the figure is executed at the number that actually ships.
    const budget = createResolveBudget(100, () => 0);

    for (let i = 0; i < 100; i++) {
      expect({ i, allowed: budget.take() }).toEqual({ i, allowed: true });
    }
    // …and it is a bound, not an absence of one.
    expect(budget.take()).toBe(false);
  });

  it('stops following the session cap once it passes the ceiling', () => {
    // Every other budget case runs at or below the ceiling, where `Math.min` is the identity — so
    // the clamp itself was executed nowhere, and a mutation widening it to `ceiling * 5` left both
    // suites green (measured). That matters because `MCP_MAX_SESSIONS` can legitimately be raised:
    // the fleet-wide arithmetic the drift case checks (`replicas × ceiling` against the backend's
    // /me bucket) is only true while a bigger cap really does NOT buy a bigger burst.
    const cap = RESOLVE_BURST_CEILING * 2 + 50;
    const budget = createResolveBudget(cap, () => 0);

    // Derived from the constant rather than restating it: a legitimate raise should arrive as this
    // case still passing, not as a puzzle about a loop bound somebody has to edit.
    for (let i = 0; i < RESOLVE_BURST_CEILING; i++) {
      expect({ i, allowed: budget.take() }).toEqual({ i, allowed: true });
    }
    expect({ what: 'the take past the ceiling', allowed: budget.take() }).toEqual({
      what: 'the take past the ceiling',
      allowed: false,
    });
    expect(cap).toBeGreaterThan(RESOLVE_BURST_CEILING);
  });

  it('survives a clock that steps BACKWARDS instead of refusing everything for an hour', () => {
    // With the elapsed unclamped, an hour-long backwards NTP step drives the bucket to about -7190
    // tokens, and every keyed connection to this replica is refused until it climbs back — while
    // /healthz and the anonymous surface look perfect. Measured on the unclamped version.
    let clock = 0;
    const budget = createResolveBudget(2, () => clock);

    expect(budget.take()).toBe(true);
    clock -= 3_600_000;
    expect(budget.take()).toBe(true);
    // The bucket did not go into deep debt: one second of real time still buys a token.
    expect(budget.take()).toBe(false);
    clock += 1000;
    expect(budget.take()).toBe(true);
  });
});

describe('remote server — a call that names no tool is not told to sign in', () => {
  it('refuses it as a malformed request rather than as a missing account', () => {
    // Fail-closed still applies — such a call is classified KEYED and refused — but the WORDS have
    // to say what is wrong. On the remote transport this gate runs before the SDK, so the SDK's
    // schema never gets to answer, and "the tool <unnamed> needs a Proof account. Sign in…" would
    // be the only thing the caller ever reads.
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toEqual([
      { name: MALFORMED_TOOL_NAME, malformed: true },
    ]);
    // A caller may SEND that placeholder as a name; it is then an ordinary unknown tool, and must
    // not be answered with the sentence about a nameless call.
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: MALFORMED_TOOL_NAME } })).toEqual([
      { name: MALFORMED_TOOL_NAME, malformed: false },
    ]);

    const body = malformedToolCallBody();
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('named no tool');
    // The words that belong to the OTHER situation must not appear here.
    expect(body.error_description).not.toContain('Sign in');
    expect(body.error_description).not.toContain('CALL THE TOOL AGAIN');
  });

  it('and the SERVER actually sends that body, not the sign-in one', async () => {
    // The case above is about the function; this one is about the wire. Without it, a server that
    // kept answering `authorization_required` for a nameless call would leave the suite green —
    // measured: mutating the refusal back turned nothing red.
    const { url } = await start();
    const sessionId = await openSession(url);

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { arguments: {} } }),
    });
    const body = JSON.parse(await response.text());

    // Still refused, still fail-closed, still challenged — only the words differ.
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('named no tool');
    expect(JSON.stringify(body)).not.toContain('<unnamed>');
  });

  it('and a caller who SENDS that placeholder as a name gets the ordinary refusal', async () => {
    // The placeholder shares a namespace with caller input, so deciding at the refusal by comparing
    // strings answers "this call named no tool" to somebody who named one. Measured: with the
    // decision made by string comparison instead of the flag, every other case stayed green.
    const { url } = await start();
    const sessionId = await openSession(url);

    const response = await callTool(url, sessionId, MALFORMED_TOOL_NAME);
    const body = JSON.parse(await response.text());

    expect(response.status).toBe(401);
    // An unknown tool needing an account — not a statement about a message they did not send.
    expect(body.error).toBe('authorization_required');
    expect(body.error_description).toContain('CALL THE TOOL AGAIN');
  });
});

describe('remote server — the refusal text fits the transport the caller is on', () => {
  it('never tells a remote user to set PROOF_API_KEY and restart the server', async () => {
    // The stdio instruction is impossible on a server somebody else runs, and after the gate learned
    // to accept a logged-in session this is exactly the text a signed-in remote user reaches when
    // calling a tool outside the session surface.
    const stub = await startStubBackend((path) => {
      if (path === '/api/v1/auth/sessions') {
        return { status: 201, body: { id: 'auth_1' }, setCookie: ['token=jwt-for-this-session; Path=/; HttpOnly'] };
      }
      return { status: 200, body: {} };
    });
    const { url } = await start({ baseUrl: stub.url });
    const sessionId = await openSession(url);

    await (await callTool(url, sessionId, 'start_login', {}, { channel: 'email', email: 'someone@example.test' })).text();

    // `list_verifications` is outside SESSION_AUTH_PREFIXES, so the JWT cannot carry it and the
    // client refuses before the network — with the message under test.
    const refused = await callTool(url, sessionId, 'list_verifications');
    const body = await refused.text();

    expect(body).toContain('api_key_required');
    expect(body).not.toContain('PROOF_API_KEY');
    expect(body).not.toContain('restarted');
    // It names the road that does exist from here.
    expect(body).toContain('Connect this server to your account');
  });

  it('still gives a hand-pasted non-key credential a straight answer, not an outage', async () => {
    // `GET /me/api-key` answers 400 to a credential that is not an API key (a JWT, say). Folding
    // that into the 5xx arm would tell the one person likely to hit it that the service is down.
    const stub = await startStubBackend(() => ({
      status: 400,
      body: { error: { code: 'api_key_required', message: 'API key context required' } },
    }));
    const { url } = await start({ baseUrl: stub.url });

    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.not-an-api-key' },
      body: JSON.stringify(INIT_BODY),
    });
    const body = JSON.parse(await opened.text());

    expect(opened.status).toBe(400);
    expect(body.error).toBe('unsupported_credential');
    expect(body.error_description).not.toContain('Could not reach');
  });

  it('does not diagnose the credential from a 400 that came from in FRONT of the API', async () => {
    // A proxy refusing an oversized header answers 400 with no `api_key_required` in it, and it
    // knows nothing about the token. Reading that as "your credential is the wrong kind" is a
    // confident wrong answer; the honest one is the same "could not check it" as any other
    // unexpected failure.
    const stub = await startStubBackend(() => ({ status: 400, body: { message: 'Request Header Or Cookie Too Large' } }));
    const { url } = await start({ baseUrl: stub.url });

    const opened = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer pk_live_whatever' },
      body: JSON.stringify(INIT_BODY),
    });
    const body = JSON.parse(await opened.text());

    expect(opened.status).toBe(503);
    expect(body.error).toBe('upstream_unavailable');
  });
});

describe('remote server — SC-8: a token is read from the header ONLY, and never leaves its session', () => {
  it('ignores ?api_key= entirely and refuses a session id presented with a foreign token', async () => {
    // This block replaces `SC-5: a credential in the request is ignored, not adopted`. That guard
    // pinned "no credential is read at all", which SC-3 has now deliberately made false — so the
    // claim had to be REPLACED rather than deleted, and the replacement has to stay dangerous:
    //
    //   1. the query string is still refused, and `?api_key=` is now the ONLY refused vector, so
    //      nothing else in the suite would notice if it were adopted (a token in a URL is copied
    //      into proxy logs and `Referer`, which is why it stays refused);
    //   2. the value in the query never leaves the process — a negative about OUTBOUND traffic,
    //      unreadable from a response body, hence the stub's request log;
    //   3. a token belongs to the session it opened. Without this, a leaked `mcp-session-id` would
    //      be enough to spend somebody else's key.
    const stub = await startStubBackend(() => SELF_KEY_OK);
    const { url } = await start({ baseUrl: stub.url });

    // (1) A query-string credential opens an ANONYMOUS session — the keyed tool is refused.
    const attackerUrl = `${url}/mcp?api_key=pk_live_attacker_supplied`;
    const opened = await fetch(attackerUrl, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });
    const anonymousId = opened.headers.get('mcp-session-id')!;
    await opened.text();
    await fetch(attackerUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': anonymousId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    const refused = await fetch(attackerUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': anonymousId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'list_verifications', arguments: {} } }),
    });
    await refused.text();
    expect(refused.status).toBe(401);

    // (2) It never travelled either.
    expect(stub.requests.some((entry) => entry.authorization?.includes('pk_live_attacker_supplied'))).toBe(false);

    // (3) A token from one session does not work on another session's id.
    const keyed = await openSession(url, { authorization: 'Bearer pk_live_alice' });
    const crossed = await callTool(url, anonymousId, 'list_verifications', { authorization: 'Bearer pk_live_alice' });
    await crossed.text();
    expect(crossed.status).toBe(401);
    // …and the reverse: the keyed session refuses a request that drops the token.
    const stripped = await callTool(url, keyed, 'list_verifications');
    await stripped.text();
    expect(stripped.status).toBe(401);
  });
});

describe('remote server — SC-3: the session id carries the replica that minted it', () => {
  it('prefixes every session id with the replica id', async () => {
    const { url } = await start({ replicaId: '7' });

    const sessionId = await openSession(url);

    // The proxy routes on this prefix. Hashing the id instead cannot work — the replica is picked
    // before any id exists — which a two-replica stand showed as 45 of 60 follow-ups landing on a
    // replica that had never heard of the session.
    expect(sessionId.startsWith('7.')).toBe(true);
  });

  it('derives the replica from the StatefulSet pod ordinal when none is given', () => {
    expect(resolveReplicaId(undefined, 'mcp-remote-0')).toBe('0');
    expect(resolveReplicaId(undefined, 'mcp-remote-11')).toBe('11');
    // A machine name with no ordinal — a laptop, a plain container — is a single replica.
    expect(resolveReplicaId(undefined, 'someones-macbook')).toBe('0');
    expect(resolveReplicaId('3', 'mcp-remote-0')).toBe('3');
  });
});

describe('remote server — the two counters release symmetrically', () => {
  it('an aborted upload does not retire a capacity slot for the life of the process', async () => {
    // `readBody`'s `error`/`aborted` handlers are what settle the promise when a client vanishes
    // mid-upload. Without them the promise never settles, the `finally` that returns the
    // reservation never runs, and the slot is gone permanently — 100 aborted uploads retire a
    // replica while `/healthz` still reports it healthy with a low session count.
    const { port, remote } = await startRaw({ maxSessions: 1 });

    const socket = await openSocket(port, [
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'content-type: application/json',
      'accept: application/json, text/event-stream',
      'content-length: 100000',
      '',
      '',
    ].join('\r\n'));
    socket.write('{"jsonrpc"');
    await new Promise((resolve) => setTimeout(resolve, 60));
    socket.end();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // The slot came back: a fresh open succeeds rather than hitting the cap.
    const opened = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    await opened.text();

    expect(opened.status).toBe(200);
    expect(remote.sessionCount()).toBe(1);
  });

  it('a GET stream that never counted cannot decrement the in-flight counter', async () => {
    // The increment is POST-only; a release that is not would drive the counter NEGATIVE on a GET,
    // and `inFlight > 0` does not skip on a negative — so the sweeper would close a transport out
    // from under a live POST. This case is the generalisation of the in-flight case below: it
    // drives the counter through a GET first, then runs a POST across more than one TTL.
    // TTL generous enough that the GET phase alone cannot age the session out — a GET no longer
    // refreshes the clock, so the setup has to fit inside the window for the POST phase to be the
    // thing under test.
    const { port, remote } = await startRaw({ sessionTtlMs: 400, sweepIntervalMs: 20 });
    const sessionId = await openSessionRaw(port);

    const controller = new AbortController();
    const stream = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      signal: controller.signal,
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await stream;

    // Now a POST that outlives the TTL. If the GET had decremented, the sweeper would reclaim the
    // session mid-request and this would answer on a closed transport.
    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const socket = await openSocket(port, [
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'content-type: application/json',
      'accept: application/json, text/event-stream',
      `mcp-session-id: ${sessionId}`,
      `content-length: ${Buffer.byteLength(payload)}`,
      '',
      '',
    ].join('\r\n'));
    socket.write(payload.slice(0, payload.length - 1));
    // Outlives the TTL: only the in-flight skip keeps the session, and a negative counter (the
    // defect this case exists for) disables that skip.
    await new Promise((resolve) => setTimeout(resolve, 520));
    const reply = await socket.sendAndRead(payload.slice(payload.length - 1));
    socket.end();

    expect(remote.sessionCount()).toBe(1);
    expect(reply).toMatch(/HTTP\/1\.1 20[02]/);
  });

});

describe('remote server — configuration is read fail-closed', () => {
  it('reads a positive integer setting and refuses anything else', () => {
    // Was a closure inside the entrypoint guard — unreachable from a test even in principle, so
    // the fix for "a typo disables the bound" was itself one edit wide.
    expect(positiveIntEnv('X', { X: '250' })).toBe(250);
    expect(positiveIntEnv('X', {})).toBeUndefined();
    expect(positiveIntEnv('X', { X: 'abc' })).toBeUndefined();
    expect(positiveIntEnv('X', { X: '0' })).toBeUndefined();
    expect(positiveIntEnv('X', { X: '-5' })).toBeUndefined();
    // Non-integers are refused too: 0.5 would sweep every session on the first tick, and as a
    // session cap it would silently mean one.
    expect(positiveIntEnv('X', { X: '0.5' })).toBeUndefined();
    // Exponent notation parses as an integer (`Number.isInteger(1e21)` is true) and would make the
    // cap unreachable. The function is exported, so the bound is enforced rather than assumed.
    expect(positiveIntEnv('X', { X: '1e21' })).toBeUndefined();
    expect(positiveIntEnv('X', { X: '1e3' })).toBeUndefined();
    // A long decimal literal carries no exponent to spot, so the upper bound is what refuses it —
    // 20 nines parse to 1e20, which is effectively no cap at all.
    expect(positiveIntEnv('X', { X: '99999999999999999999' })).toBeUndefined();
    // Digits only: hex and underscores were inconsistent under the previous two-part predicate.
    expect(positiveIntEnv('X', { X: '0xD' })).toBeUndefined();
    expect(positiveIntEnv('X', { X: '1_000' })).toBeUndefined();
    // Surrounding whitespace is tolerated — a trailing newline is what a k8s env file produces.
    expect(positiveIntEnv('X', { X: ' 100\n' })).toBe(100);
  });
});

describe('remote server — SC-3: a session id is required, and an unknown one is refused', () => {
  it('refuses a non-initialize request that carries no session id', async () => {
    const { url } = await start();

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(400);
  });

  it('refuses an unknown session id instead of quietly starting a new session', async () => {
    // This is the property that makes misrouting visible. If an unknown id were treated as a fresh
    // session, a request landing on the wrong replica would succeed, and the missing sticky rule
    // would show up only as mysteriously lost state much later.
    const { url, remote } = await start();
    await openSession(url);

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'a-session-this-process-never-minted' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(404);
    expect(remote.sessionCount()).toBe(1);
  });
});

describe('remote server — SC-3: sessions are bounded in count and in lifetime', () => {
  it('refuses a new session past the cap with 503 rather than growing without limit', async () => {
    const { url, remote } = await start({ maxSessions: 1 });
    await openSession(url);

    const response = await fetch(`${url}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: JSON.stringify(INIT_BODY) });

    expect(response.status).toBe(503);
    expect(remote.sessionCount()).toBe(1);
  });

  it('holds the cap under CONCURRENT opens, not just sequential ones', async () => {
    // Raw sockets, not `fetch`: the defect is a window between the cap check and the map write, and
    // `fetch` closes it by accident — each request completes before the next is dispatched, so a
    // Promise.all of fetches passes against the BROKEN code (verified: it did). The shape that
    // reaches the window is many sockets parked with headers sent and bodies withheld, then all
    // bodies released at once. On the unreserved version that admitted 25 sessions to a cap of 2.
    const { port, remote } = await startRaw({ maxSessions: 2 });

    const OPENERS = 25;
    const payload = JSON.stringify(INIT_BODY);
    const sockets = await Promise.all(
      Array.from({ length: OPENERS }, () =>
        openSocket(port, [
          'POST /mcp HTTP/1.1',
          'Host: 127.0.0.1',
          'content-type: application/json',
          'accept: application/json, text/event-stream',
          `content-length: ${Buffer.byteLength(payload)}`,
          '',
          '',
        ].join('\r\n')),
      ),
    );

    // Every opener is now inside the handler, parked on `readBody`, before any body arrives.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const replies = await Promise.all(sockets.map((socket) => socket.sendAndRead(payload)));
    sockets.forEach((socket) => socket.end());

    // EXACTLY the cap, not merely "no more than". `<=` passed against a server that refused every
    // open (`if (true)` on the capacity check), which is half of what this case's name promises.
    expect(remote.sessionCount()).toBe(2);
    expect(replies.filter((reply) => reply.includes('503')).length).toBeGreaterThan(0);
  });

  it('answers 413 for a body past the size bound', async () => {
    // One anonymous request took the process to 859MB RSS against a 768Mi container limit before
    // this bound existed.
    const { url } = await start();

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: 'x'.repeat(5 * 1024 * 1024),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'body_too_large' });
  });

  it('bounds the body on an ESTABLISHED session too, and gives the slot back', async () => {
    // The sibling of the new-session case, and it was covered by nothing: both the 4MB bound and
    // the `inFlight` release on this path could be deleted with the whole package suite green.
    // The second deletion is the worse one — an oversized or aborted upload would pin the session
    // as permanently "in flight", the sweeper would skip it forever, and the slot would never come
    // back. Hence the second half of this case: after the refusal, the session must still age out.
    const { url, remote } = await start({ sessionTtlMs: 120, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: 'x'.repeat(5 * 1024 * 1024),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'body_too_large' });

    // The slot returns: a session left counted as busy would be skipped by every sweep. Generous
    // margin on purpose — a tight one turns a real property into a flaky assertion.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(remote.sessionCount()).toBe(0);
  });

  it('a RECONNECTING GET stream does not postpone the idle TTL either', async () => {
    // The sibling of the case below, and the one the README's wording actually promised. Stamping
    // `lastSeen` on every request meant each stream open and close refreshed the clock, so a client
    // that only reconnects its stream held its session forever. Measured before the fix: six 200ms
    // streams against a 300ms TTL kept the session alive while a silent control aged out.
    const { url, remote } = await start({ sessionTtlMs: 150, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const stream = fetch(`${url}/mcp`, {
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
        signal: controller.signal,
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 60));
      controller.abort();
      await stream;
    }

    // ~240ms of stream traffic against a 150ms TTL, and no work at all.
    expect(remote.sessionCount()).toBe(0);
  });

  it('a stream of REFUSED uploads does not postpone the idle TTL', async () => {
    // The third shape of the same claim: a POST that is rejected before it reaches the transport
    // did no work, so it must not refresh the clock. An arrival stamp did refresh it, and five
    // oversized bodies held a session across twice its TTL with every case still green.
    const { url, remote } = await start({ sessionTtlMs: 150, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const refused = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
        body: 'x'.repeat(5 * 1024 * 1024),
      });
      statuses.push(refused.status);
      await refused.text();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // The FIRST refusal must be the size bound — otherwise this case is measuring something else.
    expect(statuses[0]).toBe(413);
    // Later ones may be 404: once the session ages out mid-sequence, an unknown id is the correct
    // answer, and that IS the behaviour under test. What must not happen is the session surviving.
    for (const status of statuses.slice(1)) expect([413, 404]).toContain(status);
    expect(remote.sessionCount()).toBe(0);
  });

  it('the four shapes the case below rests on are refused by the TRANSPORT, not by us', async () => {
    // The anchor for the next case, and for the sentence in `remote.ts` and the README. Each of
    // these four reaches `transport.handleRequest` — our own bounds pass them — and comes back 400
    // from inside the SDK, before `onmessage` is ever called. Measured on 1.27.1: parse error,
    // parse error, unsupported protocol version, "Server already initialized". If a future SDK
    // starts ACCEPTING one of them, that shape becomes real work and this case says so, instead of
    // the TTL rule quietly changing meaning.
    const { url, remote } = await start({ sessionTtlMs: 60_000 });
    const sessionId = await openSession(url);
    const withSession = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    // The JSON-RPC code is what makes this case say what its NAME says. A status of 400 alone does
    // not: our own `json()` refusals are 400 too, so a future bound of ours that rejected these
    // before `handleRequest` would keep a status-only assertion green while the docblock, `README.md`
    // and the case below all went on citing these four as the TRANSPORT's family. Demonstrated in
    // review — a pre-transport refusal of an unparseable body left the whole suite green. The SDK
    // answers with its own envelope; `{ error: 'bad_request' }` cannot satisfy that shape.
    //
    // The envelope and the CODE, deliberately not the `message` text: the strings ("Parse error:
    // Invalid JSON") are free prose a minor SDK release may reword, and pinning them would turn this
    // red for a change it is not about. Precisely: `-32700` and `-32600` are JSON-RPC 2.0 constants,
    // while `-32000` sits in the implementation-defined range and is the SDK's own choice — no less
    // free to change than the text. Kept anyway, because that direction fails LOUD (a red case
    // naming the code) rather than passing something through.
    const refusals = [
      { label: 'unparseable body', code: -32700, init: { method: 'POST', headers: withSession, body: 'not json at all' } },
      { label: 'empty body', code: -32700, init: { method: 'POST', headers: withSession, body: '' } },
      {
        label: 'unsupported protocol version',
        code: -32000,
        init: { method: 'POST', headers: { ...withSession, 'mcp-protocol-version': '1999-01-01' }, body: notification },
      },
      {
        label: 'repeated initialize',
        code: -32600,
        init: { method: 'POST', headers: withSession, body: JSON.stringify(INIT_BODY) },
      },
    ];

    for (const { label, code, init } of refusals) {
      const response = await fetch(`${url}/mcp`, init as RequestInit);
      const body = (await response.json()) as { jsonrpc?: string; error?: { code?: number } };
      expect({ label, status: response.status, jsonrpc: body.jsonrpc, code: body.error?.code }).toEqual({
        label,
        status: 400,
        jsonrpc: '2.0',
        code,
      });
    }

    // Positive control: a request that IS work answers below 400 through the same path, so the
    // status split above is a property of the request, not of this endpoint refusing everything.
    const accepted = await fetch(`${url}/mcp`, { method: 'POST', headers: withSession, body: notification });
    await accepted.text();
    expect(accepted.status).toBe(202);
    // None of the five closed the session — the case below measures the CLOCK, not survival.
    expect(remote.sessionCount()).toBe(1);
  });

  it('a POST the TRANSPORT refuses does not postpone the idle TTL', async () => {
    // The fourth shape of the same claim, and the one that outlived three fixes. Our own bounds
    // (size, envelope) refuse before the transport is reached and were covered above; these four
    // get all the way IN and are refused inside the SDK, doing no work — yet a `finally` that
    // stamped every completed POST refreshed the clock for them just the same. Measured before the
    // fix: four rounds of these against a 150ms TTL kept the session alive indefinitely, so a
    // 16-byte piece of garbage postponed the TTL while a 5MB one did not.
    const { url, remote } = await start({ sessionTtlMs: 150, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);
    const withSession = { ...MCP_HEADERS, 'mcp-session-id': sessionId };
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    const shapes: RequestInit[] = [
      { method: 'POST', headers: withSession, body: 'not json at all' },
      { method: 'POST', headers: withSession, body: '' },
      { method: 'POST', headers: { ...withSession, 'mcp-protocol-version': '1999-01-01' }, body: notification },
      { method: 'POST', headers: withSession, body: JSON.stringify(INIT_BODY) },
    ];

    const statuses: number[] = [];
    for (const init of shapes) {
      const response = await fetch(`${url}/mcp`, init);
      statuses.push(response.status);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // The FIRST must be the transport's refusal — otherwise this case is measuring something else.
    expect(statuses[0]).toBe(400);
    // Later ones may be 404: once the session ages out mid-sequence, an unknown id is the correct
    // answer, and that IS the behaviour under test.
    for (const status of statuses.slice(1)) expect([400, 404]).toContain(status);
    // ~240ms of refusals against a 150ms TTL.
    expect(remote.sessionCount()).toBe(0);
  });

  it('an ACCEPTED POST postpones the TTL even when it dispatched nothing — `POST []`', async () => {
    // The fifth path of the same sentence, and the one that decided its wording. `[]` runs the SDK's
    // message loop zero times and is still answered 202, so "the clock moves for a request that did
    // WORK" is false no matter how the stamp is placed — the code cannot see work, only the answer.
    // Rather than grow a second copy of JSON-RPC's rules here to refuse it (and still be wrong, since
    // a bare `notifications/initialized` IS dispatched and is no more use than `[]`), the claim was
    // retired down to what the code does: ACCEPTED, answered below 400.
    //
    // So this case pins the behaviour the sentence describes, not a behaviour anyone prefers. Refuse
    // `[]` some day and it goes red — which is the point: the sentence in `remote.ts` and in
    // `README.md` gets rewritten in the same change, instead of quietly becoming a different claim.
    // Unlike its neighbours this case asserts SURVIVAL, so its margin is the gap between requests,
    // not the total: one stall longer than the TTL kills the session and reddens it on a loaded
    // machine. Hence 8 × 40ms against a 200ms TTL — 320ms of sleeping alone, well past the TTL, with
    // up to 160ms of slack per gap rather than 90ms (up to: each request's own duration eats into
    // it). A stall that does beat it is self-diagnosing: the swept
    // session shows up as a 404 inside the pinned `statuses` array.
    const { url, remote } = await start({ sessionTtlMs: 200, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
        body: '[]',
      });
      statuses.push(response.status);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    // Accepted every time — a 400 here would mean something started refusing the shape, and the
    // survival assertion below would then be measuring a session nobody kept alive.
    expect(statuses).toEqual([202, 202, 202, 202, 202, 202, 202, 202]);
    // ~320ms of them against a 200ms TTL, and the session is still here.
    expect(remote.sessionCount()).toBe(1);
  });

  it('an open GET stream does not postpone the idle TTL', async () => {
    // `handleRequest` for a standalone SSE stream resolves only when the stream ends, so counting
    // it as in-flight kept the documented TTL from ever firing — and the SDK client opens that
    // stream right after `initialize`, so that was every real session.
    const { url, remote } = await start({ sessionTtlMs: 100, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    const controller = new AbortController();
    const stream = fetch(`${url}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      signal: controller.signal,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(remote.sessionCount()).toBe(0);

    controller.abort();
    await stream;
  });

  it('answers initialize_expected for a POST that is not an initialize, creating no session', async () => {
    // A malformed POST used to construct a full 176-tool server and a transport (2.09ms each) only
    // for the SDK to answer 400 — an uncounted amplifier on the cheapest possible request. The
    // assertion is the RESPONSE CODE this path now produces before anything is built; the previous
    // test asserted only "400", which the expensive path also satisfied.
    const { url, remote } = await start();

    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'initialize_expected' });
    expect(remote.sessionCount()).toBe(0);
  });

  it('does not sweep a session out from under a request that is still in flight', async () => {
    // `lastSeen` records a moment that is already past — arrival in the original form, completion
    // in the current one — so a request that takes longer than the TTL to complete ages out
    // mid-flight either way and the sweeper closes the transport underneath it. The `wait_for_*`
    // tools poll for minutes by design, so this is the normal case, not an edge one. What actually
    // protects it is `inFlight`. Reproduced by dribbling the body in over more than one TTL: a `fetch` cannot
    // express it (it sends the whole body at once), which is why an earlier version of this test
    // passed against the unfixed code.
    const { port, remote } = await startRaw({ sessionTtlMs: 120, sweepIntervalMs: 20 });
    const sessionId = await openSessionRaw(port);
    expect(remote.sessionCount()).toBe(1);

    const payload = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const socket = await openSocket(port, [
      'POST /mcp HTTP/1.1',
      'Host: 127.0.0.1',
      'content-type: application/json',
      'accept: application/json, text/event-stream',
      `mcp-session-id: ${sessionId}`,
      `content-length: ${Buffer.byteLength(payload)}`,
      '',
      '',
    ].join('\r\n'));

    // Dribble: three chunks, ~80ms apart, so the request spans ~240ms against a 120ms TTL.
    const head = payload.slice(0, payload.length - 2);
    const tail = payload.slice(payload.length - 2);
    socket.write(head.slice(0, head.length - 1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    socket.write(head.slice(head.length - 1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const reply = await socket.sendAndRead(tail);
    socket.end();

    // The session survived its own in-flight request, and the request was answered.
    expect(remote.sessionCount()).toBe(1);
    expect(reply).toMatch(/HTTP\/1\.1 20[02]/);
  });

  it('sweeps a session that has been idle past its TTL', async () => {
    const { url, remote } = await start({ sessionTtlMs: 40, sweepIntervalMs: 20 });
    await openSession(url);
    expect(remote.sessionCount()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(remote.sessionCount()).toBe(0);
  });

  it('keeps a session alive while it is being used', async () => {
    const { url, remote } = await start({ sessionTtlMs: 150, sweepIntervalMs: 20 });
    const sessionId = await openSession(url);

    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      });
    }

    // Total elapsed (~240ms) is well past the 150ms TTL; only the touches keep it alive.
    expect(remote.sessionCount()).toBe(1);
  });
});

describe('remote server — SC-3: a client that ends its session frees the slot immediately', () => {
  it('drops the session on DELETE, and refuses the id afterwards', async () => {
    // Two requests, because one cannot see the defect this guards. The map entry is removed by
    // `transport.onclose`, which we assign BEFORE `server.connect(transport)` — and `Protocol.connect`
    // assigns `onclose` too. Our handler survives only because the SDK CHAINS the two (verified on
    // 1.27.1); an SDK that replaced instead would leave a correctly-closed session in the map until
    // its TTL expired, with capacity held and every existing case still green. Until this test there
    // was no DELETE coverage in the package at all.
    const { url, remote } = await start({ sessionTtlMs: 60_000 });
    const sessionId = await openSession(url);
    expect(remote.sessionCount()).toBe(1);

    const ended = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId } });
    await ended.text();
    expect(ended.status).toBe(200);

    // The slot is back NOW, not one TTL from now — the TTL here is 60s, so a lingering entry cannot
    // be swept out from under the assertion.
    expect(remote.sessionCount()).toBe(0);

    // And the id is genuinely gone: a follow-up gets the unknown-session refusal rather than a
    // silently fresh session.
    const afterwards = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    expect(afterwards.status).toBe(404);
    expect(await afterwards.json()).toMatchObject({ error: 'unknown_session' });
  });
});

describe('remote server — operational surface', () => {
  it('answers /healthz with the live session count', async () => {
    const { url } = await start();
    await openSession(url);

    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', sessions: 1 });
  });

  it('404s any other path, including OAuth metadata it does not serve', async () => {
    // The remote server is PUBLIC-MODE only in this task; authorization is `h-mcp-oauth-server`
    // (the authorization server) plus `h-mcp-oauth-remote-wiring` (this side of it).
    // Serving a stub at this path would advertise an authorization server that does not exist.
    const { url } = await start();

    const response = await fetch(`${url}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(404);
  });
});
