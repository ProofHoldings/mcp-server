import { describe, it, expect } from 'vitest';

import { createProofServer } from '../src/factory.js';
import {
  KEYLESS_TOOLS,
  SESSION_TOOLS,
  PROTECTED_RESOURCE_METADATA_PATH,
  authorizationChallenge,
  authorizationRequiredBody,
  keyedToolsIn,
  resourceMetadataUrl,
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
    const leaked = [...registered].filter((name) => !KEYLESS_TOOLS.has(name) && keyedToolsIn(call(name)).length === 0);
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
    // Still built from the base URL rather than hardcoded to production.
    expect(body.connect_instructions_url).toBe('https://api.proof.holdings/api/v1/mcp/connect');
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
