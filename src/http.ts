// The version this client sends in its own `User-Agent` (`proof-mcp/<version>`), i.e. what the
// issuer's logs attribute a request to. A LITERAL for the same reason `factory.ts`'s `serverInfo`
// one is, and safe for the same reason: the pin, not the choice. Held equal to `mcp/package.json`
// by `src/__tests__/drift/delegation-publication.test.ts` (h-npm-registry-release).
//
// Of the carriers a version bump has to move, this is the one it misses: a bare constant at the
// top of a module about HTTP, where nothing about editing the manifest leads a reader.
const VERSION = '1.1.0';

export interface HttpClientConfig {
  /**
   * API key (Bearer). OPTIONAL — the server also runs in public mode, where the bootstrap
   * and verification surfaces work with no credential at all and every other tool answers
   * `api_key_required` instead of the process exiting at startup.
   */
  apiKey?: string;
  baseUrl: string;
  timeout?: number;
  maxRetries?: number;
  /**
   * True when this client serves the REMOTE transport (`src/remote.ts`) rather than a local stdio
   * process. It changes exactly one thing — what the "you need a key" refusal tells the user to do
   * — because the stdio instruction (set `PROOF_API_KEY`, restart the server) is impossible on a
   * server somebody else runs.
   */
  remote?: boolean;
}

type QueryValue = string | number | boolean | undefined;

// Path prefixes protected by `jwtAuth` ONLY (pure JWT surface — these 401 with an API key).
// Deliberately excludes the dual-auth (`jwtOrApiKeyAuth`) endpoints that already work with the
// API key and enforce its scopes — `/me/{profiles,settings,usage,export,assets}`,
// `/profiles/me`, `/profiles/me/assets`, `/profiles/profiles/:id/proofs`, and `/auth/sessions`
// (list/revoke). Sending the JWT there would silently switch the principal from the API-key
// tenant to the logged-in user and bypass scope checks. The two `/profiles/me/*` entries
// below are the jwt-only exceptions inside that otherwise dual-auth family.
const SESSION_AUTH_PREFIXES = [
  '/api/v1/me/emails',
  '/api/v1/me/phones',
  '/api/v1/me/api-keys',
  '/api/v1/me/2fa',
  '/api/v1/me/domains',
  '/api/v1/me/dns-credentials',
  '/api/v1/me/dns-providers',
  '/api/v1/me/verification-requests',
  '/api/v1/me/verify/',
  '/api/v1/me/account',
  '/api/v1/profiles/me/username',
  '/api/v1/profiles/me/proofs',
];

/**
 * Endpoints the client may call with NO credential — the public mode surface.
 *
 * Stored as (method, prefix) PAIRS, not bare prefixes, and the reason is load-bearing:
 * `/api/v1/auth/sessions` is the prefix of two public routes (create a login session, poll one)
 * AND of two `jwt+api_key` ones (`GET /auth/sessions` lists sessions, `DELETE /auth/sessions/:id`
 * revokes one). A prefix-only list would mark those two public, so a keyless call would travel to
 * the network and come back `invalid_token` instead of getting the structured hint here.
 *
 * The drift rule `validateMcpPublicPathCoverage` (scripts/validate-api-map.ts) requires every
 * `auth: public` + `mcp: available` endpoint in docs/api-map.yaml to appear below. That rule is a
 * LOWER BOUND, not the definition: the two poll routes are carried here but not required by it,
 * because the map holds them `planned` (they are reached through `wait_for_login` /
 * `wait_for_account_creation` rather than by a tool of their own). Removing them would leave both
 * wait tools broken in public mode while every check stayed green.
 */
export const PUBLIC_PATHS: ReadonlyArray<{ method: string; prefix: string }> = [
  { method: 'POST', prefix: '/api/v1/proofs/validate' },
  { method: 'GET', prefix: '/api/v1/proofs/revoked' },
  { method: 'POST', prefix: '/api/v1/auth/sessions' },
  { method: 'GET', prefix: '/api/v1/auth/sessions/' },
  { method: 'POST', prefix: '/api/v1/accounts' },
  { method: 'GET', prefix: '/api/v1/accounts/' },
];

/** True when (method, path) is on the public surface above. Method is compared case-insensitively. */
function isPublicPath(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return PUBLIC_PATHS.some((p) => p.method === verb && path.startsWith(p.prefix));
}

export class HttpClient {
  public readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly remote: boolean;
  private sessionToken?: string;
  private refreshToken?: string;
  private refreshing?: Promise<boolean>;

  constructor(config: HttpClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.remote = config.remote ?? false;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, QueryValue>;
      headers?: Record<string, string>;
      /** Internal: set on the post-refresh retry to prevent an infinite refresh loop. */
      _refreshed?: boolean;
    },
  ): Promise<T> {
    const useSession = this.usesSessionAuth(path) && !!this.sessionToken;
    const bearer = useSession ? this.sessionToken! : this.apiKey;

    // Public mode: answer before the network rather than after it. A credential-less call to a
    // keyed route would otherwise spend a round trip to return `invalid_token`, which reads to an
    // agent as "the key is wrong" rather than "there is no key yet".
    if (!bearer && !isPublicPath(method, path)) {
      // The wording matters as much as the code, and it has to be true for the transport the caller
      // is actually on. It once said "run create_account to get a key from inside this session",
      // which an agent can follow forever without succeeding on stdio: the key is read from the
      // environment and has no runtime setter. But the fix was written for stdio alone, and on the
      // REMOTE server the resulting instruction is not merely unhelpful — it is impossible, since
      // nobody can set an env var on somebody else's pod or restart it. A signed-in remote user
      // calling a tool outside the session surface is exactly who reads this.
      throw new ApiError(
        this.remote
          ? 'This operation needs a Proof account with an API key. Connect this server to your account ' +
            '(your client\'s sign-in / "Authenticate" step), then call the tool again. Signing in with ' +
            'start_login alone covers your own contact and account records — emails, phones, domains, ' +
            'API keys, 2FA, DNS credentials, verification requests, your public profile\'s username ' +
            'and proof list; account-wide reads such as the platform summary, settings and usage ' +
            'need the key that connecting grants.'
          : 'This operation needs a Proof API key, which must be present in PROOF_API_KEY when the server starts. ' +
            'Without one you can still create an account or sign in (create_account, start_login) and check ' +
            'proofs and delegations. If you are signed in, create_api_key works over that session — but the new ' +
            'key takes effect only after it is put in PROOF_API_KEY and this MCP server is restarted.',
        'api_key_required',
        401,
      );
    }

    const url = this.buildUrl(path, options?.query);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            ...options?.headers,
            'Content-Type': 'application/json',
            ...(bearer ? { 'Authorization': `Bearer ${bearer}` } : {}),
            'User-Agent': `proof-mcp/${VERSION}`,
          },
          body: options?.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Capture the JWT session cookie set by the login / account-creation flows
        this.captureSetCookie(response);

        if (response.status === 429 && attempt < this.maxRetries) {
          const retryAfter = response.headers.get('Retry-After');
          const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
          const delay = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed * 1000, 60_000) : this.backoff(attempt);
          await this.sleep(delay);
          continue;
        }

        if (response.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }

        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

        if (!response.ok) {
          const apiError = body.error as { code?: string; message?: string; details?: unknown } | undefined;
          const code = apiError?.code ?? `http_${response.status}`;
          const message = apiError?.message ?? `Request failed with status ${response.status}`;

          // Expired session JWT: refresh once and retry the original request.
          if (
            response.status === 401 &&
            code === 'token_expired' &&
            useSession &&
            !options?._refreshed &&
            this.refreshToken &&
            (await this.refreshSession())
          ) {
            return this.request<T>(method, path, { ...options, _refreshed: true });
          }

          throw new ApiError(message, code, response.status, apiError?.details);
        }

        return body as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof ApiError) throw error;

        lastError = error as Error;

        if (lastError.name === 'AbortError') {
          if (attempt < this.maxRetries) {
            await this.sleep(this.backoff(attempt));
            continue;
          }
          throw new ApiError(
            `Request to ${method} ${path} timed out after ${this.timeout}ms`,
            'timeout',
            0,
          );
        }

        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
      }
    }

    throw new ApiError(lastError?.message ?? 'Network request failed', 'network_error', 0);
  }

  /**
   * True once a login flow has put a session on this client (`captureSetCookie`).
   *
   * Boolean only, never the token: the remote server needs to know whether this CONNECTION has
   * been signed in — the bootstrap road `start_login` opens — and nothing else. Without it a caller
   * with no API key looks identical before and after signing in, and the tools behind
   * `SESSION_AUTH_PREFIXES` are refused to a user who just logged in.
   */
  hasSessionToken(): boolean {
    return !!this.sessionToken;
  }

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  del<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body ? { body } : undefined);
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /** True for endpoints behind `jwtAuth` — the user JWT session surface. */
  private usesSessionAuth(path: string): boolean {
    return SESSION_AUTH_PREFIXES.some((prefix) => path.startsWith(prefix)) || path === '/api/v1/auth/me';
  }

  /** Capture the `token` / `refresh_token` cookies the login + refresh flows set via Set-Cookie. */
  private captureSetCookie(response: Response): void {
    // getSetCookie() requires Node >= 18.14 / undici; guard so older runtimes don't throw.
    if (typeof response.headers.getSetCookie !== 'function') return;
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      const pair = cookie.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name === 'token') this.sessionToken = value;
      else if (name === 'refresh_token') this.refreshToken = value;
    }
  }

  /**
   * Exchange the refresh token for a rotated access token. Returns true on success.
   * Concurrent callers share one in-flight refresh so a single-use refresh token is
   * only spent once (otherwise the loser would post a consumed token and wipe the
   * freshly-rotated session).
   */
  private refreshSession(): Promise<boolean> {
    if (!this.refreshToken) return Promise.resolve(false);
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(this.buildUrl('/api/v1/auth/refresh'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `refresh_token=${this.refreshToken}`,
          'User-Agent': `proof-mcp/${VERSION}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.sessionToken = undefined;
        this.refreshToken = undefined;
        return false;
      }
      this.captureSetCookie(response);
      return true;
    } catch {
      this.sessionToken = undefined;
      this.refreshToken = undefined;
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 10000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
