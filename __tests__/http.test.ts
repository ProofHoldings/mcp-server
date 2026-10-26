import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, ApiError } from '../src/http.js';

describe('HttpClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createClient(overrides?: Partial<{ baseUrl: string; timeout: number; maxRetries: number }>) {
    return new HttpClient({
      apiKey: 'pk_test_abc123',
      baseUrl: overrides?.baseUrl ?? 'https://api.proof.holdings',
      timeout: overrides?.timeout ?? 5000,
      maxRetries: overrides?.maxRetries ?? 0,
    });
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // h-implement-proper-deletion MCP-1: an account scheduled for deletion answers every keyed call
  // with one refusal whose message carries the date and the way back; the agent must see it as
  // sent, not as a generic failure or a retried 5xx.
  it('passes the deletion-lock refusal through verbatim, without retrying', async () => {
    const message = 'This account is scheduled for deletion on 2026-10-16T12:00:00.000Z. Sign in to the dashboard to cancel it or download your data.';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'account_scheduled_for_deletion', message, scheduled_for: '2026-10-16T12:00:00.000Z' } }, 403));

    const error = await createClient().get('/api/v1/verifications').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'account_scheduled_for_deletion', statusCode: 403, message });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes GET requests with correct headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '123' }));

    const client = createClient();
    const result = await client.get('/api/v1/test');

    expect(result).toEqual({ id: '123' });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.proof.holdings/api/v1/test');
    expect(options.method).toBe('GET');
    expect(options.headers['Authorization']).toBe('Bearer pk_test_abc123');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(options.headers['User-Agent']).toMatch(/^proof-mcp\//);
  });

  it('makes POST requests with body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = createClient();
    await client.post('/api/v1/verifications', { channel: 'sms', phone_number: '+1234' });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ channel: 'sms', phone_number: '+1234' }));
  });

  it('appends query parameters for GET', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/verifications', { status: 'pending', limit: 10 });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('status=pending');
    expect(url).toContain('limit=10');
  });

  it('filters undefined query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/test', { a: 'yes', b: undefined });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('a=yes');
    expect(url).not.toContain('b=');
  });

  it('throws ApiError on 400', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { error: { code: 'validation_error', message: 'Invalid channel' } },
      400,
    ));

    const client = createClient();
    await expect(client.post('/api/v1/verifications', {})).rejects.toThrow(ApiError);

    try {
      await client.post('/api/v1/verifications', {});
    } catch {
      // Already thrown above, re-mock for this assertion
    }
  });

  it('throws ApiError with correct code on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { error: { code: 'unauthorized', message: 'Invalid API key' } },
      401,
    ));

    const client = createClient();
    try {
      await client.get('/api/v1/verifications');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('unauthorized');
      expect((e as ApiError).statusCode).toBe(401);
    }
  });

  it('throws ApiError on 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { error: { code: 'not_found', message: 'Not found' } },
      404,
    ));

    const client = createClient();
    try {
      await client.get('/api/v1/verifications/unknown');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(404);
    }
  });

  it('retries on 429 with backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'rate_limit' } }), { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = createClient({ maxRetries: 1 });
    const result = await client.get('/api/v1/test');

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 with backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'server_error' } }), { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = createClient({ maxRetries: 1 });
    const result = await client.get('/api/v1/test');

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 5xx that names itself a terminal refusal', async () => {
    // `challenge_delivery_failed` is a REFUSAL, not a transient failure: the server already
    // deleted the session it could not mail. Retrying it is not a second chance — each attempt
    // sends a fresh mail and drops its own session, so a provider failing after accepting can
    // leave a person holding several codes, none of which belongs to a live session.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'challenge_delivery_failed', message: 'no' } }), { status: 503 }),
    );

    const client = createClient({ maxRetries: 2 });
    await expect(client.post('/api/v1/auth/sessions', { channel: 'email' })).rejects.toMatchObject({
      code: 'challenge_delivery_failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Positive control for the case above, run over EVERY other 5xx the same route answers — the
  // docblock says each of them must keep retrying, and covering only one of the four left three of
  // that sentence unasserted. The FIRST THREE refuse before anything is stored, so a retry there is
  // a second chance rather than a second act; `internal_error` is the exception on that reasoning
  // and stays retryable for the separate reason `TERMINAL_5XX_CODES`' own docblock gives.
  it.each([
    ['identity_check_unavailable', 503],
    ['email_service_unavailable', 503],
    ['session_creation_failed', 500],
    ['internal_error', 500],
  ])('still retries a 5xx carrying %s', async (code, status) => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code } }), { status }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = createClient({ maxRetries: 1 });
    const result = await client.post('/api/v1/auth/sessions', { channel: 'email' });

    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes DELETE requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));

    const client = createClient();
    await client.del('/api/v1/test/123');

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('DELETE');
  });

  it('makes PATCH requests with body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ updated: true }));

    const client = createClient();
    await client.patch('/api/v1/test', { name: 'new' });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.method).toBe('PATCH');
    expect(options.body).toBe(JSON.stringify({ name: 'new' }));
  });

  it('strips trailing slash from baseUrl', () => {
    const client = createClient({ baseUrl: 'https://api.proof.holdings/' });
    expect(client.baseUrl).toBe('https://api.proof.holdings');
  });
});

describe('HttpClient JWT session auth', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createClient() {
    return new HttpClient({
      apiKey: 'pk_test_abc123',
      baseUrl: 'https://api.proof.holdings',
      timeout: 5000,
      maxRetries: 0,
    });
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** Build a Response carrying one or more Set-Cookie headers (array form preserves duplicates). */
  function cookieResponse(body: unknown, cookies: string[], status = 200) {
    const headers: [string, string][] = [['Content-Type', 'application/json']];
    for (const c of cookies) headers.push(['Set-Cookie', c]);
    return new Response(JSON.stringify(body), { status, headers });
  }

  function authHeaderOfCall(index: number): string {
    const [, options] = fetchMock.mock.calls[index];
    return options.headers['Authorization'];
  }

  it('captures the token cookie and sends it as Bearer on the /me/ surface', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/; HttpOnly']))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x'); // login poll establishes the session
    await client.get('/api/v1/me/emails');

    expect(authHeaderOfCall(1)).toBe('Bearer JWT123');
  });

  it('uses the API key on non-session paths even when a session exists', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.get('/api/v1/verifications');

    expect(authHeaderOfCall(1)).toBe('Bearer pk_test_abc123');
  });

  it('uses the API key on dual-auth /me paths (settings/profiles) even with a session', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.get('/api/v1/me/settings'); // dual-auth: must stay on the API key
    await client.get('/api/v1/me/profiles'); // dual-auth: must stay on the API key

    expect(authHeaderOfCall(1)).toBe('Bearer pk_test_abc123');
    expect(authHeaderOfCall(2)).toBe('Bearer pk_test_abc123');
  });

  it('uses the session token on the jwt-only /profiles/me subpaths (username, proofs)', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.post('/api/v1/profiles/me/username', { username: 'demo' }); // jwt-only route
    await client.put('/api/v1/profiles/me/proofs', { proofs: [] }); // jwt-only route
    await client.get('/api/v1/profiles/me'); // dual-auth: must stay on the API key

    expect(authHeaderOfCall(1)).toBe('Bearer JWT123');
    expect(authHeaderOfCall(2)).toBe('Bearer JWT123');
    expect(authHeaderOfCall(3)).toBe('Bearer pk_test_abc123');
  });

  /**
   * mcp-server 1.5.0 (h-implement-proper-deletion MCP-1): ONE verb on a path can belong to the
   * signed-in owner while its reads stay keyed. Revoking an asset and deleting a project sign with
   * the session; listing and reading assets and projects keep the key and its scopes.
   */
  it('signs the owner-only verbs on assets and projects with the session and keeps their reads on the key', async () => {
    fetchMock.mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']));
    for (let i = 0; i < 7; i += 1) fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.del('/api/v1/me/assets/a1'); // owner-only: session
    await client.post('/api/v1/me/assets/revoke', { asset_ids: ['a1'] }); // owner-only: session
    await client.del('/api/v1/me/profiles/p1'); // owner-only with a session
    await client.post('/api/v1/me/export'); // the owner's own export
    await client.get('/api/v1/me/assets/a1'); // a read: key
    await client.get('/api/v1/me/assets'); // a read: key
    await client.get('/api/v1/me/profiles'); // a read: key

    expect([1, 2, 3, 4].map(authHeaderOfCall)).toEqual(['Bearer JWT123', 'Bearer JWT123', 'Bearer JWT123', 'Bearer JWT123']);
    expect([5, 6, 7].map(authHeaderOfCall)).toEqual(['Bearer pk_test_abc123', 'Bearer pk_test_abc123', 'Bearer pk_test_abc123']);
  });

  // The terminal login ends the sign-in session it used (l-fix-mcp-1-7-1-followups): logout is
  // `jwtAuth` only, so it must carry the session — and with no session it never leaves keyed.
  it('signs POST /api/v1/auth/logout with the session, and refuses it before the network without one', async () => {
    const keyed = createClient();
    const refused = await keyed.post('/api/v1/auth/logout').catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'user_session_required', statusCode: 401 });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']));
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.post('/api/v1/auth/logout');
    expect(authHeaderOfCall(1)).toBe('Bearer JWT123');
  });

  it('with a key and no session: revoking an asset is refused before the network, deleting a project goes out keyed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createClient();

    const refused = await client.del('/api/v1/me/assets/a1').catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'user_session_required', statusCode: 401 });
    expect(fetchMock).not.toHaveBeenCalled();

    // A key may still delete an EMPTY project (PRJ-3), so this route is session-exempt.
    await client.del('/api/v1/me/profiles/p1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authHeaderOfCall(0)).toBe('Bearer pk_test_abc123');
  });

  /**
   * M4 (live review 2026-09-26). The session surface is `jwtAuth`-only on the backend: a key sent
   * there comes back `invalid_token`, which an agent reads as "the key is bad" when the real answer
   * is "sign in". So a keyed client with no session is refused before the network, naming the road.
   */
  it.each([
    ['GET', '/api/v1/me/emails'],
    ['GET', '/api/v1/auth/me'],
    ['POST', '/api/v1/me/api-keys'],
    ['PUT', '/api/v1/profiles/me/proofs'],
  ])('refuses %s %s with user_session_required when a key is held but no session', async (method, path) => {
    const client = createClient();

    const error = await client.request(method, path).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'user_session_required', statusCode: 401 });
    expect((error as ApiError).message).toContain('start_login');
    expect((error as ApiError).message).toContain('wait_for_login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // W6 (walkthrough 2026-10-02): "an API key cannot open it" left the person asking why a second
  // sign-in, right after one succeeded. The refusal has to give the agent a reason to pass on.
  it('on stdio, says the key in PROOF_API_KEY does not open this tool and to tell the user why', async () => {
    const error = await createClient().get('/api/v1/me/api-keys').catch((e: unknown) => e);

    const message = (error as ApiError).message;
    expect(message).toContain('PROOF_API_KEY');
    expect(message).toMatch(/does not open this tool/i);
    expect(message).toMatch(/tell the user/i);
  });

  it('says the same road on the remote transport, without an env-var instruction', async () => {
    const client = new HttpClient({
      apiKey: 'mcp_at_oauth',
      baseUrl: 'https://api.proof.holdings',
      maxRetries: 0,
      remote: true,
    });

    const error = await client.get('/api/v1/me/phones').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'user_session_required', statusCode: 401 });
    expect((error as ApiError).message).toContain('start_login');
    expect((error as ApiError).message).not.toContain('PROOF_API_KEY');
    expect((error as ApiError).message).toContain('wait_for_login');
    expect((error as ApiError).message).toMatch(/browser sign-in/i);
    expect((error as ApiError).message).toContain('API key');
    expect((error as ApiError).message).toMatch(/does not open this tool/i);
    expect((error as ApiError).message).toMatch(/tell the user/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/api/v1/me/api-keys/6ab8149e5c34eed762617db4/usage',
    '/api/v1/me/verification-requests',
    '/api/v1/me/emails/verify/some-magic-token',
  ])('lets GET %s travel with the API key — it is not session-only on the backend', async (path) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await createClient().get(path, { api_key_id: 'k1' });

    expect(authHeaderOfCall(0)).toBe('Bearer pk_test_abc123');
  });

  it('refuses the session-only siblings of the exempt paths', async () => {
    const client = createClient();

    await expect(client.post('/api/v1/me/verification-requests', {})).rejects.toMatchObject({
      code: 'user_session_required',
    });
    await expect(client.get('/api/v1/me/verification-requests/incoming')).rejects.toMatchObject({
      code: 'user_session_required',
    });
    await expect(client.post('/api/v1/me/api-keys/k1/regenerate')).rejects.toMatchObject({
      code: 'user_session_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-refreshes on token_expired and retries the original request', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT1; Path=/', 'refresh_token=R1; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'token_expired', message: 'Token has expired' } }, 401))
      .mockResolvedValueOnce(cookieResponse({ success: true }, ['token=JWT2; Path=/', 'refresh_token=R2; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ data: ['ok'] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');
    const result = await client.get('/api/v1/me/emails');

    expect(result).toEqual({ data: ['ok'] });
    // call 2 = refresh POST
    const [refreshUrl, refreshOpts] = fetchMock.mock.calls[2];
    expect(refreshUrl).toBe('https://api.proof.holdings/api/v1/auth/refresh');
    expect(refreshOpts.method).toBe('POST');
    expect(refreshOpts.headers['Cookie']).toBe('refresh_token=R1');
    // call 3 = retry with the rotated JWT
    expect(authHeaderOfCall(3)).toBe('Bearer JWT2');
  });

  it('clears the session and propagates the 401 when refresh fails', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT1; Path=/', 'refresh_token=R1; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'token_expired', message: 'Token has expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'refresh_token_expired' } }, 401));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');

    await expect(client.get('/api/v1/me/emails')).rejects.toMatchObject({ code: 'token_expired' });

    // session cleared → the next session-only call asks for a new login instead of spending the key
    await expect(client.get('/api/v1/me/emails')).rejects.toMatchObject({ code: 'user_session_required' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps the session when refresh fails with a 5xx — an outage refuses nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT1; Path=/', 'refresh_token=R1; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'token_expired', message: 'Token has expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'session_binding_unavailable' } }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'token_expired', message: 'Token has expired' } }, 401))
      .mockResolvedValueOnce(cookieResponse({ success: true }, ['token=JWT2; Path=/', 'refresh_token=R2; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');

    await expect(client.get('/api/v1/me/emails')).rejects.toMatchObject({ code: 'token_expired' });

    // the next call still has a session and a refresh token to try again with
    await expect(client.get('/api/v1/me/emails')).resolves.toEqual({ data: [] });
    expect(fetchMock.mock.calls[4][1].headers['Cookie']).toBe('refresh_token=R1');
  });
});

describe('HttpClient public mode (no API key)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function keylessClient() {
    return new HttpClient({ baseUrl: 'https://api.proof.holdings', timeout: 5000, maxRetries: 0 });
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function cookieResponse(body: unknown, cookies: string[], status = 200) {
    const headers: [string, string][] = [['Content-Type', 'application/json']];
    for (const c of cookies) headers.push(['Set-Cookie', c]);
    return new Response(JSON.stringify(body), { status, headers });
  }

  it('omits the Authorization header entirely when there is no key', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'auth_x' }));

    await keylessClient().post('/api/v1/accounts', { channel: 'telegram' });

    const [, options] = fetchMock.mock.calls[0];
    // The KEY must be absent, not present with an undefined/empty value: `Bearer undefined`
    // is a well-formed credential the backend would try to resolve.
    expect('Authorization' in options.headers).toBe(false);
  });

  it.each([
    ['POST', '/api/v1/proofs/validate'],
    ['GET', '/api/v1/proofs/revoked'],
    ['POST', '/api/v1/auth/sessions'],
    ['GET', '/api/v1/auth/sessions/auth_abc'],
    ['POST', '/api/v1/accounts'],
    ['GET', '/api/v1/accounts/auth_abc'],
  ])('reaches the network without a key on the public pair %s %s', async (method, path) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await keylessClient().request(method, path);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws api_key_required BEFORE fetch on a keyed path', async () => {
    const client = keylessClient();

    await expect(client.get('/api/v1/verifications')).rejects.toMatchObject({
      code: 'api_key_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells a STDIO caller what a stdio caller can actually do', async () => {
    // The transport-aware split has two arms and only the remote one was guarded, so deleting this
    // branch left the whole suite green while every stdio user was told to use a "sign-in step"
    // that a local process does not have. The two arms are opposite instructions — one names an env
    // var and a restart, the other names the client's Connect button — so each needs its own case.
    await expect(keylessClient().get('/api/v1/verifications')).rejects.toMatchObject({
      message: expect.stringContaining('PROOF_API_KEY'),
    });
  });

  it('tells a REMOTE caller to connect through their client instead', async () => {
    const remote = new HttpClient({ baseUrl: 'https://api.proof.holdings', remote: true });

    await expect(remote.get('/api/v1/verifications')).rejects.toMatchObject({
      message: expect.not.stringContaining('PROOF_API_KEY'),
    });
    await expect(remote.get('/api/v1/verifications')).rejects.toMatchObject({
      message: expect.stringContaining('Connect this server to your account'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/v1/auth/sessions'],
    ['DELETE', '/api/v1/auth/sessions/sess_abc'],
  ])('does NOT treat %s %s as public despite the shared path prefix', async (method, path) => {
    // Negative control for the pair-matching rule: both of these start with the public
    // `/api/v1/auth/sessions` prefix but are `jwt+api_key` routes. A prefix-only list would
    // send them into the network to fail with invalid_token instead of answering here.
    const client = keylessClient();

    await expect(client.request(method, path)).rejects.toMatchObject({
      code: 'api_key_required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the session surface off the captured JWT with no API key present', async () => {
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = keylessClient();
    await client.get('/api/v1/auth/sessions/auth_x'); // public poll establishes the session
    await client.get('/api/v1/me/emails');

    const [, options] = fetchMock.mock.calls[1];
    expect(options.headers['Authorization']).toBe('Bearer JWT123');
  });

  it('still throws api_key_required for API-key-only paths while a session exists', async () => {
    fetchMock.mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT123; Path=/']));

    const client = keylessClient();
    await client.get('/api/v1/auth/sessions/auth_x');

    // `/verifications` is neither public nor part of the session surface — a JWT does not
    // authenticate it, so the tool must get the structured hint rather than a network 401.
    await expect(client.get('/api/v1/verifications')).rejects.toMatchObject({
      code: 'api_key_required',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('HttpClient — a key the API no longer accepts (W9)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const invalidKey = () =>
    new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

  // The backend answers a revoked key exactly as an unknown one, on purpose. Left as "Invalid API
  // key", an agent on the walkthrough invented a cause and told the owner the revoked key was still
  // valid until December — so the client says what the answer means on the transport it is on.
  it('REMOTE: says the connection\'s key is no longer accepted and to reconnect, keeping the code', async () => {
    fetchMock.mockResolvedValueOnce(invalidKey());
    const client = new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: 'https://api.proof.holdings', maxRetries: 0, remote: true });

    const error = await client.get('/api/v1/verifications').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'invalid_api_key', statusCode: 401 });
    expect((error as ApiError).message).toMatch(/no longer accepted/);
    expect((error as ApiError).message).toMatch(/revoked/);
    expect((error as ApiError).message).toMatch(/reconnect|Authenticate/i);
    expect((error as ApiError).message).not.toContain('PROOF_API_KEY');
  });

  it('STDIO: names PROOF_API_KEY and the restart, keeping the code', async () => {
    fetchMock.mockResolvedValueOnce(invalidKey());
    const client = new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: 'https://api.proof.holdings', maxRetries: 0 });

    const error = await client.get('/api/v1/verifications').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'invalid_api_key', statusCode: 401 });
    expect((error as ApiError).message).toMatch(/no longer accepted/);
    expect((error as ApiError).message).toContain('PROOF_API_KEY');
  });

  it('applies to the sign-in routes too: a revoked connection cannot start a login (W8)', async () => {
    fetchMock.mockResolvedValueOnce(invalidKey());
    const client = new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: 'https://api.proof.holdings', maxRetries: 0, remote: true });

    await expect(client.post('/api/v1/auth/sessions', { channel: 'telegram' })).rejects.toMatchObject({
      code: 'invalid_api_key',
      message: expect.stringMatching(/no longer accepted/),
    });
  });

  it('leaves a 401 the client did NOT send its key for untouched', async () => {
    fetchMock.mockResolvedValueOnce(invalidKey());
    const keyless = new HttpClient({ baseUrl: 'https://api.proof.holdings', maxRetries: 0, remote: true });

    await expect(keyless.post('/api/v1/auth/sessions', { channel: 'telegram' })).rejects.toMatchObject({
      code: 'invalid_api_key',
      message: 'Invalid API key',
    });
  });
});

describe('HttpClient agent name header', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  // Real fetch refuses a header value outside Latin-1 or carrying a newline. Building `Headers` from
  // what the client hands over applies the same check, so a value fetch would refuse fails here too.
  beforeEach(() => {
    fetchMock = vi.fn((_url: string, options: { headers: Record<string, string> }) => {
      new Headers(options.headers);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function clientNamed(agentName?: () => string | undefined) {
    return new HttpClient({ apiKey: 'pk_test_abc123', baseUrl: 'https://api.proof.holdings', timeout: 5000, maxRetries: 0, agentName });
  }

  function headersOfCall(index: number): Record<string, string> {
    return fetchMock.mock.calls[index][1].headers;
  }

  it('sends the client name beside an unchanged User-Agent', async () => {
    await clientNamed(() => 'claude-code').get('/api/v1/test');

    expect(headersOfCall(0)['X-Proof-Agent-Name']).toBe('claude-code');
    expect(headersOfCall(0)['User-Agent']).toMatch(/^proof-mcp\/\d+\.\d+\.\d+$/);
  });

  it('checks header values the way fetch does (control: a raw emoji name is refused)', () => {
    expect(() => new Headers({ 'X-Proof-Agent-Name': 'bot 🤖' })).toThrow();
  });

  it('percent-encodes a name fetch could not carry, so the call still goes out', async () => {
    const name = 'bot 🤖 ‮evil\nx';
    await expect(clientNamed(() => name).get('/api/v1/test')).resolves.toEqual({ ok: true });

    expect(headersOfCall(0)['X-Proof-Agent-Name']).toBe(encodeURIComponent(name));
  });

  it('replaces a lone surrogate, which encodeURIComponent would throw on', async () => {
    await expect(clientNamed(() => 'a\uD800b').get('/api/v1/test')).resolves.toEqual({ ok: true });

    expect(headersOfCall(0)['X-Proof-Agent-Name']).toBe(encodeURIComponent('a�b'));
  });

  it('cuts the name at 60 code points before encoding it', async () => {
    await clientNamed(() => `${'x'.repeat(59)}😀tail`).get('/api/v1/test');

    expect(headersOfCall(0)['X-Proof-Agent-Name']).toBe(encodeURIComponent(`${'x'.repeat(59)}😀`));
  });

  it.each([
    ['no name getter', undefined],
    ['a getter with no name yet', () => undefined],
    ['a blank name', () => '   '],
  ])('sends no name header for %s', async (_label, getter) => {
    await clientNamed(getter).get('/api/v1/test');

    expect(headersOfCall(0)).not.toHaveProperty('X-Proof-Agent-Name');
    expect(headersOfCall(0)['User-Agent']).toMatch(/^proof-mcp\//);
  });

  it('sends the name on the session refresh and on the retried call', async () => {
    const cookieResponse = (body: unknown, cookies: string[], status = 200) =>
      new Response(JSON.stringify(body), { status, headers: [['Content-Type', 'application/json'], ...cookies.map((c): [string, string] => ['Set-Cookie', c])] });
    fetchMock
      .mockResolvedValueOnce(cookieResponse({ status: 'verified' }, ['token=JWT1; Path=/', 'refresh_token=R1; Path=/']))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'token_expired', message: 'Token has expired' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(cookieResponse({ success: true }, ['token=JWT2; Path=/', 'refresh_token=R2; Path=/']))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: ['ok'] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const client = clientNamed(() => 'claude-code');
    await client.get('/api/v1/auth/sessions/auth_x');
    await client.get('/api/v1/me/emails');

    expect(fetchMock.mock.calls[2][0]).toBe('https://api.proof.holdings/api/v1/auth/refresh');
    expect(headersOfCall(2)['X-Proof-Agent-Name']).toBe('claude-code');
    expect(headersOfCall(3)['X-Proof-Agent-Name']).toBe('claude-code');
  });
});
