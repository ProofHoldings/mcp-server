import { describe, it, expect } from 'vitest';

import { createProofServer } from '../src/factory.js';
import {
  KEYLESS_TOOLS,
  KEY_OR_SESSION_TOOLS,
  SESSION_TOOLS,
  accessNoticeFor,
  isSessionOnlyTool,
  PROTECTED_RESOURCE_METADATA_PATH,
  authorizationChallenge,
  authorizationRequiredBody,
  keyedToolsIn,
  resourceMetadataUrl,
  serverInstructions,
} from '../src/authBoundary.js';

/**
 * The boundary between "works with no account" and "needs one" (`h-mcp-oauth-remote-wiring`, SC-1).
 *
 * It is written here rather than derived at the call site because the remote server has to decide
 * BEFORE the message reaches the MCP transport — a 401 with `WWW-Authenticate` is an HTTP answer,
 * and by the time a tool handler runs, the response is already a JSON-RPC result the client's OAuth
 * stack will never look at.
 *
 * Two properties are load-bearing and each has its own case below:
 *
 *   1. The list agrees with the SERVER, not merely with itself. A keyless name that no longer
 *      exists would refuse nothing while reading like a boundary, and a tool added to `src/tools`
 *      would silently land on the keyed side — which is the safe direction, but the test says so
 *      out loud instead of leaving it to luck.
 *   2. An unknown name is KEYED. The alternative — treat unrecognized as keyless — turns a typo in
 *      this file into a hole rather than into a broken tool.
 */

function registeredNames(server: unknown): Set<string> {
  return new Set(Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools));
}

const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

describe('authBoundary — SC-1: what needs an account, named on both sides', () => {
  it('lets the connection itself through: initialize, tools/list, and a batch of both', () => {
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toEqual([]);
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).toEqual([]);
    expect(
      keyedToolsIn([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ]),
    ).toEqual([]);
    // Shapes the transport itself refuses, which must not throw on the way to it.
    expect(keyedToolsIn(undefined)).toEqual([]);
    expect(keyedToolsIn([])).toEqual([]);
    expect(keyedToolsIn('not an envelope')).toEqual([]);
  });

  it('lets every keyless tool through and stops every other one', () => {
    for (const name of KEYLESS_TOOLS) {
      expect(keyedToolsIn(call(name)), `${name} is keyless and must not be refused`).toEqual([]);
    }
    expect(keyedToolsIn(call('list_verifications'))).toEqual([{ name: 'list_verifications', malformed: false }]);
    expect(keyedToolsIn(call('get_platform_summary'))).toEqual([{ name: 'get_platform_summary', malformed: false }]);
  });

  it('reports only the keyed half of a mixed batch', () => {
    expect(keyedToolsIn([call('render_auth_link'), call('list_verifications')])).toEqual([
      { name: 'list_verifications', malformed: false },
    ]);
  });

  it('treats an unknown name as keyed — a typo must break a tool, never open a hole', () => {
    expect(keyedToolsIn(call('not_a_tool'))).toEqual([{ name: 'not_a_tool', malformed: false }]);
  });

  it('given the names the server registers, lets a name it does not register through to be answered "no such tool"', () => {
    // M9 (live review 2026-09-26): an anonymous caller who mistyped a tool was sent to sign in. With
    // the registered set in hand the call can reach the SDK, which refuses the name itself. Nothing
    // opens: a name the server does not register has no handler to run. The fail-closed rule for a
    // name the server DOES register is unchanged, and so is the no-set form above.
    const registered = new Set(['list_verifications', 'start_login']);
    expect(keyedToolsIn(call('not_a_tool'), registered)).toEqual([]);
    expect(keyedToolsIn(call('list_verifications'), registered)).toEqual([{ name: 'list_verifications', malformed: false }]);
    expect(keyedToolsIn(call('start_login'), registered)).toEqual([]);
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }, registered)).toEqual([
      { name: '<unnamed>', malformed: true },
    ]);
  });

  it('treats a malformed tool name as keyed too, rather than letting it walk past', () => {
    // The SDK's own schema refuses these, so the arm is unreachable today — but "fail-closed on
    // every axis" has to be true here rather than true by somebody else's validator, and skipping
    // such a message would make a MALFORMED call the one shape the gate waves through.
    const malformed = [{ name: '<unnamed>', malformed: true }];
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 123 } })).toEqual(malformed);
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toEqual(malformed);
    expect(keyedToolsIn({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '' } })).toEqual(malformed);
  });

  it('agrees with the tools the server actually registers, in BOTH directions', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const registered = registeredNames(server);

    // Guard against a vacuous pass on an empty registration set.
    expect(registered.size).toBeGreaterThan(100);

    // (a) every keyless name is a real tool — a stale one would refuse nothing while looking
    //     exactly like a boundary.
    const phantom = [...KEYLESS_TOOLS].filter((name) => !registered.has(name));
    expect(phantom, `keyless names that no tool answers to: ${phantom.join(', ')}`).toEqual([]);

    // (b) everything else is keyed. No tool is called here — a real call would leave the process
    //     for api.proof.holdings, which is exactly what this suite must never do.
    //     The one exception is the session-only tools (M5): they pass the gate so the CLIENT can
    //     refuse them readably before any request — the case below holds that exception exactly.
    const leaked = [...registered].filter(
      (name) => !KEYLESS_TOOLS.has(name) && !isSessionOnlyTool(name) && keyedToolsIn(call(name)).length === 0,
    );
    expect(leaked, `tools that would answer without an account: ${leaked.join(', ')}`).toEqual([]);
  });
});

describe('authBoundary — SC-2: the refusal names the action and carries a link', () => {
  it('challenges with the resource-metadata address the client is meant to fetch', () => {
    expect(resourceMetadataUrl('https://api.proof.holdings/')).toBe(
      `https://api.proof.holdings${PROTECTED_RESOURCE_METADATA_PATH}`,
    );
    const challenge = authorizationChallenge('https://api.proof.holdings');
    expect(challenge).toContain('Bearer ');
    expect(challenge).toContain(`resource_metadata="https://api.proof.holdings${PROTECTED_RESOURCE_METADATA_PATH}"`);
  });

  it('tells the human what to DO, not merely what is missing', () => {
    const body = authorizationRequiredBody('https://api.proof.holdings', 'get_platform_summary');

    expect(body.error).toBe('authorization_required');
    expect(body.error_description).toContain('get_platform_summary');
    // The measured worst case is Claude Code: it neither replays the call nor opens the browser
    // step on its own, so this text is the only instruction its user gets.
    expect(body.error_description).toContain('CALL THE TOOL AGAIN');
    expect(body.error_description).toContain('claude mcp login');
    // Connecting happens INSIDE the client — there is no page for it. A human opened the old
    // `login_url` in a browser and got the raw connect document (h-fix-mcp-refusal-roads), so the
    // document keeps its link under a name that says what it is, and the text names the real step,
    // including that `claude mcp login` needs a terminal of its own (inside Claude Code's `!` shell
    // it fails with "stdin isn't a terminal").
    expect(body.error_description).toContain('inside the client');
    expect(body.error_description).toContain('terminal');
    expect('login_url' in body).toBe(false);
    // The public MCP docs page, fixed: the base URL is the API host, which serves no `/md/` page.
    expect(body.connect_instructions_url).toBe('https://proof.holdings/md/docs/mcp.md');
  });

  it('offers start_login only to the tools a signed-in session actually reaches', () => {
    // The unconditional version sent a caller of get_platform_summary through start_login — a
    // Telegram sign-in later, the tool refused again, with a second text that finally said the
    // session covers only the caller's own records. The first text now says which side of that
    // line the refused tool is on, so nobody walks the road to learn it does not lead there.
    const session = authorizationRequiredBody('https://api.proof.holdings', 'list_emails');
    expect(SESSION_TOOLS.has('list_emails')).toBe(true);
    expect(session.keyless_alternative).toContain('start_login');
    expect(session.keyless_alternative).toContain('works over that signed-in session');
    expect(session.keyless_alternative).not.toContain('will NOT unlock');

    const keyed = authorizationRequiredBody('https://api.proof.holdings', 'get_platform_summary');
    expect(SESSION_TOOLS.has('get_platform_summary')).toBe(false);
    expect(keyed.keyless_alternative).toContain('start_login');
    expect(keyed.keyless_alternative).toContain('will NOT unlock');
    expect(keyed.keyless_alternative).toContain('own account records');
    expect(keyed.keyless_alternative).not.toContain('works over that signed-in session');
  });

  it('keeps the session surface real: registered tools only, none of them keyless', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings' });
    const registered = registeredNames(server);

    // Anti-vacuity: an empty set passes every line below while making each refusal say "needs the
    // key" — for the fifty-odd tools that do not.
    expect(SESSION_TOOLS.size).toBeGreaterThan(0);

    // A stale name here would promise a road for a tool that no longer exists.
    const phantom = [...SESSION_TOOLS].filter((name) => !registered.has(name));
    expect(phantom, `session names that no tool answers to: ${phantom.join(', ')}`).toEqual([]);

    // Keyless tools are never refused, so they can never be told anything about a session.
    const both = [...SESSION_TOOLS].filter((name) => KEYLESS_TOOLS.has(name));
    expect(both).toEqual([]);

    // The other direction — that every tool the client signs with the session IS listed — is the
    // map's business: src/__tests__/drift/api-parity.test.ts joins this set to docs/api-map.yaml.
  });
});

describe('serverInstructions — a connected client is told the account records need a sign-in (W6)', () => {
  // Walkthrough 2026-10-02: right after the browser "Authenticate", list_api_keys was refused and
  // nothing the client had been told explained why a second sign-in was needed.
  const surfaceIn = (text: string) => text.match(/emails, phones,[^.);]*/)?.[0];

  it.each([false, true])('keyed (remote=%s) names the refusal, the road, and the same records', (remote) => {
    const text = serverInstructions({ remote, hasCredential: true });
    expect(text).toContain('user_session_required');
    expect(text).toContain('start_login');
    expect(text).toContain('wait_for_login');
    const canonical = surfaceIn(serverInstructions({ remote, hasCredential: false }));
    expect(canonical).toBeTruthy();
    expect(surfaceIn(text)).toBe(canonical);
  });

  it.each([false, true])('anonymous (remote=%s) does not gain the keyed sentence', (remote) => {
    expect(serverInstructions({ remote, hasCredential: false })).not.toContain('user_session_required');
  });
});

describe('authBoundary — M5: the no-key hint for a session tool names the road that opens it', () => {
  // M5 (r-prod-full-test-keys-delegations, prod 09.11): the notice told an anonymous caller of a
  // session-only tool to authenticate the client first. Authenticating grants an API key, and a key
  // on those routes is refused `user_session_required`, so the first road named was a dead end. Only
  // the tools whose route is in SESSION_EXEMPT_PATHS open to a key as well; they keep both roads.
  const SESSION_ONLY = 'list_emails';

  it('keeps the key-also set inside the session surface, and non-empty', () => {
    expect(KEY_OR_SESSION_TOOLS.size).toBeGreaterThan(0);
    expect([...KEY_OR_SESSION_TOOLS].filter((name) => !SESSION_TOOLS.has(name))).toEqual([]);
    expect(KEY_OR_SESSION_TOOLS.has(SESSION_ONLY)).toBe(false);
  });

  it.each([false, true])('a session-only tool (remote=%s) is sent to start_login, not to a key', (remote) => {
    const notice = accessNoticeFor(SESSION_ONLY, { remote, hasCredential: false });
    expect(notice).toContain('ACCESS: needs a Proof account');
    expect(notice).toMatch(/start_login[^.]*wait_for_login[^.]*call this tool again/);
    expect(notice).toContain('does NOT open this tool');
    // The key recipe must not be offered as a road here: it is the one that leads to the refusal.
    expect(notice).not.toContain('Authenticate this client (Claude Code');
    expect(notice).not.toContain('Set PROOF_API_KEY and restart');
    expect(notice).not.toMatch(/start_login does NOT/);
  });

  it.each([false, true])('a tool a key also opens (remote=%s) keeps both roads', (remote) => {
    for (const tool of KEY_OR_SESSION_TOOLS) {
      const notice = accessNoticeFor(tool, { remote, hasCredential: false });
      expect(notice, tool).toContain(remote ? 'Authenticate this client' : 'Set PROOF_API_KEY');
      expect(notice, tool).toContain('start_login');
      expect(notice, tool).not.toContain('does NOT');
    }
  });

  it('the 401 body for a session-only tool leads with start_login and says connecting does not open it', () => {
    const body = authorizationRequiredBody('https://api.proof.holdings', SESSION_ONLY);
    expect(body.error_description).toContain(SESSION_ONLY);
    expect(body.error_description).toMatch(/start_login[^.]*wait_for_login/);
    expect(body.error_description).toContain('CALL THE TOOL AGAIN');
    expect(body.error_description).toContain('does NOT open this tool');
    expect(body.error_description.indexOf('start_login')).toBeLessThan(body.error_description.indexOf('Authenticate'));
  });

  it('the 401 body for a key-also tool still leads with connecting the client', () => {
    for (const tool of KEY_OR_SESSION_TOOLS) {
      const body = authorizationRequiredBody('https://api.proof.holdings', tool);
      expect(body.error_description, tool).toContain('claude mcp login');
      expect(body.error_description, tool).not.toContain('does NOT open this tool');
      expect(body.keyless_alternative, tool).toContain('works over that signed-in session');
    }
  });
});

describe('authBoundary — M5: the remote gate and the notices agree about session-only tools', () => {
  // Coordinator condition 1: the gate lets an anonymous call of a session-only tool through (the
  // client then refuses it with user_session_required naming start_login, before any request),
  // because the 401 it used to answer sends an OAuth client to Authenticate — a key, which does not
  // open the tool. "Session-only" is ONE predicate, read by the gate and by both texts.
  it('defines session-only as SESSION_TOOLS minus KEY_OR_SESSION_TOOLS', () => {
    for (const name of SESSION_TOOLS) expect(isSessionOnlyTool(name), name).toBe(!KEY_OR_SESSION_TOOLS.has(name));
    expect(isSessionOnlyTool('list_verifications')).toBe(false);
    expect(isSessionOnlyTool('start_login')).toBe(false);
  });

  it('passes an anonymous session-only call, and still stops a key-also or keyed one', () => {
    expect(keyedToolsIn(call('list_emails'))).toEqual([]);
    expect(keyedToolsIn(call('get_api_key_usage'))).toEqual([{ name: 'get_api_key_usage', malformed: false }]);
    expect(keyedToolsIn(call('list_verifications'))).toEqual([{ name: 'list_verifications', malformed: false }]);
  });

  it('a mixed batch still reports its keyed call, so the request is refused', () => {
    expect(keyedToolsIn([call('list_emails'), call('list_verifications')])).toEqual([
      { name: 'list_verifications', malformed: false },
    ]);
  });

  it('for every registered tool, the gate passes it exactly when its notice sends the caller to start_login alone', () => {
    const { server } = createProofServer({ baseUrl: 'https://api.proof.holdings', remote: true });
    const registered = [...registeredNames(server)];
    expect(registered.length).toBeGreaterThan(100);
    const disagree = registered
      .filter((name) => !KEYLESS_TOOLS.has(name))
      .filter((name) => {
        const passes = keyedToolsIn(call(name)).length === 0;
        const sessionAlone = accessNoticeFor(name, { remote: true, hasCredential: false }).includes('signed in: call start_login');
        return passes !== sessionAlone;
      });
    expect(disagree, `gate and notice disagree about: ${disagree.join(', ')}`).toEqual([]);
    // Anti-vacuity: the session-only class is not empty.
    expect(registered.filter((name) => isSessionOnlyTool(name)).length).toBeGreaterThan(40);
  });
});
