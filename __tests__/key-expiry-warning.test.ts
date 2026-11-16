/**
 * SC-11 (m-api-key-expiry-parity T8b): the server warns when the key it calls with has 7 days or fewer left — only
 * for a key a person must replace by hand, never for one a sign-in connection renews, once per server process per UTC
 * day per key, and never on every tool result. The key's kind comes from `managed_by_sign_in` on `GET /me/api-key`:
 * stdio asks it (absent → hand-made, an older API), the hosted server notes it at session open (absent → unknown → no
 * warning).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  HttpClient,
  KEY_EXPIRES_AT_HEADER,
  KEY_EXPIRY_WARNING_DAYS,
  keyKindFromField,
  resetKeyExpiryWarningsForTests,
} from '../src/http.js';
import { createProofServer } from '../src/factory.js';
import samples from '../src/generated/output-samples.json' with { type: 'json' };

/** The real body `GET /billing/balance` answers, so `get_balance` passes its own output schema. */
const BALANCE = (samples as Record<string, unknown[]>)['GET /api/v1/billing/balance 200'][0];

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const KEY = 'pk_live_handmade_key_for_the_warning_tests';

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, expiresAt?: number) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(expiresAt ? { [KEY_EXPIRES_AT_HEADER]: new Date(expiresAt).toISOString() } : {}) },
  });
}

/** Every keyed call answers the header; the self-inspection answers `self` (or fails when `self` is an Error). */
function routeFetch(expiresAt: number | undefined, self: Record<string, unknown> | Error, body: unknown = { ok: true }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/v1/me/api-key')) {
      if (self instanceof Error) throw self;
      return answer({ id: 'k1', name: 'Backend', ...self }, expiresAt);
    }
    return answer(body, expiresAt);
  });
}

const selfCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/v1/me/api-key')).length;

function client(remote = false, apiKey = KEY) {
  return new HttpClient({ apiKey, baseUrl: 'https://api.example.test', remote, maxRetries: 0 });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetKeyExpiryWarningsForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe('the rule, in one place', () => {
  it('reads the field the same way on both transports except when it is absent', () => {
    expect(keyKindFromField(true, false)).toBe('sign-in');
    expect(keyKindFromField(true, true)).toBe('sign-in');
    expect(keyKindFromField(false, false)).toBe('hand-made');
    expect(keyKindFromField(false, true)).toBe('hand-made');
    expect(keyKindFromField(undefined, false)).toBe('hand-made');
    expect(keyKindFromField(undefined, true)).toBe('unknown');
    expect(KEY_EXPIRY_WARNING_DAYS).toBe(7);
  });
});

describe('stdio (the key this server started with)', () => {
  it('present-false: warns once that UTC day, then again the next day', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    const first = await http.takeKeyExpiryWarning(NOW);
    expect(first).toBe(
      'Heads up: the Proof Holdings API key this AI client uses stops working on 2026-11-18 12:00 UTC (in 3 days). Create a new key and update the client before then.',
    );
    expect(await http.takeKeyExpiryWarning(NOW + 60_000)).toBeUndefined();
    const nextDay = Date.UTC(2026, 10, 16, 0, 1, 0);
    expect(await http.takeKeyExpiryWarning(nextDay)).toMatch(/stops working/);
    expect(selfCalls()).toBe(1); // the kind is asked once per process, not per warning
  });

  it('present-true: a key a sign-in connection renews never warns', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: true });
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
  });

  it('absent (an API older than the field): read as hand-made, so it warns', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, {});
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
  });

  it('more than 7 days left, no header, or a key already past its end: nothing, and the kind is not asked', async () => {
    const http = client();
    routeFetch(NOW + 8 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
    const bare = client();
    routeFetch(undefined, { managed_by_sign_in: false });
    await bare.get('/api/v1/me/settings');
    expect(await bare.takeKeyExpiryWarning(NOW)).toBeUndefined();
    expect(await http.takeKeyExpiryWarning(NOW + 9 * DAY)).toBeUndefined();
    expect(selfCalls()).toBe(0);
  });

  it('a self-inspection that fails warns nothing now and asks again on a later call', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, new Error('network down'));
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
  });
});

describe('round-1 review fixes', () => {
  it('a key without settings:read (the self-inspection answers 403 insufficient_scope) is hand-made: warns, asks once', async () => {
    const http = client();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/v1/me/api-key')) {
        return new Response(JSON.stringify({ error: { code: 'insufficient_scope', message: 'needs settings:read' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', [KEY_EXPIRES_AT_HEADER]: new Date(NOW + 3 * DAY).toISOString() },
        });
      }
      return answer({ ok: true }, NOW + 3 * DAY);
    });
    await http.get('/api/v1/verifications');
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
    expect(await http.takeKeyExpiryWarning(Date.UTC(2026, 10, 16, 0, 1, 0))).toMatch(/stops working/);
    expect(selfCalls()).toBe(1);
  });

  it('an expiry cleared to never stops the warning: a keyed 2xx with no header forgets the old date', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
    routeFetch(undefined, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(Date.UTC(2026, 10, 16, 0, 1, 0))).toBeUndefined();
  });

  it('a public-path answer (no key read) or a refusal without the header does not forget the date', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/v1/me/api-key') ? answer({ managed_by_sign_in: false }) : answer({ revoked: [] }),
    );
    await http.get('/api/v1/proofs/revoked');
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
  });

  it('a route that never reads the key (the emailed verify link) does not forget the date', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/v1/me/api-key') ? answer({ managed_by_sign_in: false }) : answer({ ok: true }),
    );
    await http.get('/api/v1/me/emails/verify/tok_123');
    expect(await http.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
  });

  it('the self-inspection is asked once with no retries, so a 503 there never holds a tool result back', async () => {
    const http = new HttpClient({ apiKey: KEY, baseUrl: 'https://api.example.test', remote: false, maxRetries: 2 });
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/api/v1/me/api-key')
        ? new Response(JSON.stringify({ error: { code: 'unavailable', message: 'down' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        : answer({ ok: true }, NOW + 3 * DAY),
    );
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
    expect(selfCalls()).toBe(1);
  });

  it('two tool calls finishing at once warn once, not twice', async () => {
    const http = client();
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    const both = await Promise.all([http.takeKeyExpiryWarning(NOW), http.takeKeyExpiryWarning(NOW)]);
    expect(both.filter(Boolean)).toHaveLength(1);
  });

  it('says "1 day", not "1 days", on the last day', async () => {
    const http = client();
    routeFetch(NOW + 2 * 60 * 60 * 1000, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBe(
      'Heads up: the Proof Holdings API key this AI client uses stops working on 2026-11-15 14:00 UTC (in 1 day). Create a new key and update the client before then.',
    );
  });
});

describe('hosted (the key a connection presented)', () => {
  it('present-false noted at open: warns, naming no command to run', async () => {
    const http = client(true);
    http.noteKeyManagedBySignIn(false);
    routeFetch(NOW + 2 * DAY, { managed_by_sign_in: false });
    await http.get('/api/v1/me/settings');
    const note = await http.takeKeyExpiryWarning(NOW);
    // The same approved note as on stdio: it names no variable, command or tool.
    expect(note).toBe(
      'Heads up: the Proof Holdings API key this AI client uses stops working on 2026-11-17 12:00 UTC (in 2 days). Create a new key and update the client before then.',
    );
    expect(selfCalls()).toBe(0); // the open already asked
  });

  it('present-true noted at open: never warns', async () => {
    const http = client(true);
    http.noteKeyManagedBySignIn(true);
    routeFetch(NOW + 2 * DAY, {});
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
  });

  it('absent at open (an older API): unknown, so no warning and no extra request', async () => {
    const http = client(true);
    http.noteKeyManagedBySignIn(undefined);
    routeFetch(NOW + 2 * DAY, {});
    await http.get('/api/v1/me/settings');
    expect(await http.takeKeyExpiryWarning(NOW)).toBeUndefined();
    expect(selfCalls()).toBe(0);
  });

  it('once per process per day per key, across connections; another key warns on its own', async () => {
    routeFetch(NOW + 2 * DAY, {});
    const a = client(true);
    const b = client(true);
    const other = client(true, 'pk_live_another_handmade_key_entirely');
    for (const c of [a, b, other]) {
      c.noteKeyManagedBySignIn(false);
      await c.get('/api/v1/me/settings');
    }
    expect(await a.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
    expect(await b.takeKeyExpiryWarning(NOW)).toBeUndefined();
    expect(await other.takeKeyExpiryWarning(NOW)).toMatch(/stops working/);
  });
});

describe('where the line goes', () => {
  async function connect() {
    const { server, http } = createProofServer({ apiKey: KEY, baseUrl: 'https://api.example.test' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
    return { mcp, http };
  }

  it('is one extra text block on a successful result, once, with the structured answer untouched', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    routeFetch(NOW + 3 * DAY, { managed_by_sign_in: false }, BALANCE);
    const { mcp } = await connect();
    const first = (await mcp.callTool({ name: 'get_balance', arguments: {} })) as { content: Array<{ text: string }>; structuredContent?: unknown };
    expect(first.content).toHaveLength(2);
    expect(first.content[1].text).toMatch(/stops working on 2026-11-18 12:00 UTC/);
    expect(first.structuredContent).toEqual(BALANCE);
    const second = (await mcp.callTool({ name: 'get_balance', arguments: {} })) as { content: unknown[] };
    expect(second.content).toHaveLength(1);
  });

  it('never rides on an error result, so the error envelope stays one block', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', [KEY_EXPIRES_AT_HEADER]: new Date(NOW + 3 * DAY).toISOString() },
      }),
    );
    const { mcp } = await connect();
    const res = (await mcp.callTool({ name: 'get_balance', arguments: {} })) as { isError?: boolean; content: unknown[] };
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
  });
});
