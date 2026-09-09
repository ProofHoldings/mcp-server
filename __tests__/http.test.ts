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
      await client.get('/api/v1/auth/me');
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

  it('falls back to the API key on /me/ when no session has been captured', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/me/emails');

    expect(authHeaderOfCall(0)).toBe('Bearer pk_test_abc123');
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
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'refresh_token_expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const client = createClient();
    await client.get('/api/v1/auth/sessions/auth_x');

    await expect(client.get('/api/v1/me/emails')).rejects.toMatchObject({ code: 'token_expired' });

    // session cleared → next /me/ call uses the API key
    await client.get('/api/v1/me/emails');
    expect(authHeaderOfCall(3)).toBe('Bearer pk_test_abc123');
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
