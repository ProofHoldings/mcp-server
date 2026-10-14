// The version this client sends in its own `User-Agent` (`proof-mcp/<version>`), i.e. what the
// issuer's logs attribute a request to. A LITERAL for the same reason `factory.ts`'s `serverInfo`
// one is, and safe for the same reason: the pin, not the choice. Held equal to `mcp/package.json`
// by `src/__tests__/drift/delegation-publication.test.ts` (h-npm-registry-release).
//
// Of the carriers a version bump has to move, this is the one it misses: a bare constant at the
// top of a module about HTTP, where nothing about editing the manifest leads a reader.
const VERSION = '1.6.0';

// Every request names this client: the issuer tells a request an agent made, signed in as a person,
// from one the person made in the dashboard by this prefix, and labels it with the name the agent's
// own MCP client gave in the handshake, sent beside it. Both are the client's own claim. The issuer
// reads the same two literals in `src/constants/agentClient.ts`; the pair is held together by
// `src/__tests__/drift/mcp-user-request-contract.test.ts`.
const USER_AGENT_PREFIX = 'proof-mcp/';
const AGENT_NAME_HEADER = 'X-Proof-Agent-Name';

/**
 * The most code points of the name this client sends, which bounds the header's size. It equals the
 * issuer's own cut (`CLIENT_LABEL_MAX` in `src/constants/mcpOauth.ts`, held equal by the same drift
 * test), but this cut is applied to the raw name and the issuer's after it flattens whitespace and
 * invisible characters, so a name that flattening shortens can be stored shorter than the issuer
 * alone would keep. It is a label, so that costs only characters.
 */
const AGENT_NAME_MAX = 60;

/**
 * The agent's name as a header value, or nothing. Percent-encoded because fetch refuses any value
 * outside Latin-1 or carrying a newline (an emoji, a bidi override), and a refused header would fail
 * EVERY call this client makes, not just lose the label. A lone surrogate is replaced first, since
 * `encodeURIComponent` throws on one.
 */
function agentNameHeader(name: string | undefined): Record<string, string> {
  const cut = [...(name ?? '').trim()].slice(0, AGENT_NAME_MAX).join('');
  const wellFormed = cut.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  return wellFormed ? { [AGENT_NAME_HEADER]: encodeURIComponent(wellFormed) } : {};
}

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
   * process. It changes only the wording of refusals — what the "you need a key" and "you need a
   * session" refusals tell the user — because the stdio instruction (set `PROOF_API_KEY`, restart
   * the server) is impossible on a server somebody else runs, and a remote user usually never saw a key.
   */
  remote?: boolean;
  /**
   * The name the connected MCP client gave in its handshake (`clientInfo.name`), read at call time
   * because the handshake happens after this client is built. Absent, or answering nothing, sends
   * no name.
   */
  agentName?: () => string | undefined;
}

type QueryValue = string | number | boolean | undefined;

/**
 * 5xx error codes that must NOT be retried, because they are refusals rather than outages.
 *
 * The distinction is not academic on this client: it retries EVERY method, so a POST refusal is
 * re-sent as a fresh act. `challenge_delivery_failed` (`POST /api/v1/auth/sessions`, email
 * channel) is the case that forced the list — the server deletes the session whose mail it could
 * not send, so a retry mails again and drops again.
 *
 * Deliberately narrow. That route answers FOUR other 5xx and none of them belongs here.
 * `identity_check_unavailable`, `email_service_unavailable` (both 503) and
 * `session_creation_failed` (500) each refuse BEFORE anything is stored, so a second attempt is a
 * second chance rather than a second act. The fourth is the uncomfortable one: a generic 500
 * `internal_error` from the controller's own `catch` can be raised AFTER `storeAuthSession`, so
 * retrying it CAN repeat an act — and it stays retryable regardless, because `internal_error` is
 * what the error handler answers for every unhandled throw in the whole API, so listing it would
 * stop retrying genuine outages everywhere. Narrowing that one needs a code of its own, which is a
 * backend change rather than a client one.
 *
 * SCOPE. This list is keyed on the CODE, not the path, so the second emitter of
 * `challenge_delivery_failed` — `POST /api/v1/verifications`, via
 * `abortUndeliverableEmailChallenge` — is covered here too. What is NOT covered is the four SDKs:
 * their HTTP clients each retry any 5xx on any method, so the same defect stands on that surface.
 *
 * Held to the issuer's own spelling by `src/__tests__/drift/login-delivery-refusal.test.ts`, which
 * extracts the code from the controller that emits it.
 */
const TERMINAL_5XX_CODES = new Set(['challenge_delivery_failed']);

// Path prefixes protected by `jwtAuth` ONLY (pure JWT surface — these 401 with an API key).
// Deliberately excludes the dual-auth (`jwtOrApiKeyAuth`) endpoints that already work with the
// API key and enforce its scopes — `/me/{profiles,settings,usage,assets}`,
// `/profiles/me`, `/profiles/me/assets`, `/profiles/profiles/:id/proofs`, and `/auth/sessions`
// (list/revoke). Sending the JWT there would silently switch the principal from the API-key
// tenant to the logged-in user and bypass scope checks. The two `/profiles/me/*` entries
// below are the jwt-only exceptions inside that otherwise dual-auth family. `/me/export` joined
// in 1.5.0: the export became the signed-in owner's alone (h-implement-proper-deletion ACC-2).
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
  '/api/v1/me/export',
  '/api/v1/profiles/me/username',
  '/api/v1/profiles/me/proofs',
];

/**
 * ONE verb on a path whose other verbs stay on the key (mcp-server 1.5.0, h-implement-proper-deletion
 * MCP-1). Revoking an asset's proofs and deleting a project belong to the signed-in owner, while
 * listing and reading assets and projects stay keyed with their scopes — so a prefix would move
 * the reads onto the session and switch their principal. `src/__tests__/drift/api-parity.test.ts`
 * reads this list (element lines only) to decide which map endpoints the client signs with the
 * session.
 */
export const SESSION_AUTH_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'DELETE', pattern: /^\/api\/v1\/me\/assets\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/v1\/me\/assets\/revoke$/ },
  { method: 'DELETE', pattern: /^\/api\/v1\/me\/profiles\/[^/]+$/ },
];

/**
 * Routes that sit UNDER a `SESSION_AUTH_PREFIXES` prefix but are not session-only on the backend,
 * so a keyed client without a login session may still send them with the key. Everything else on
 * the session surface is refused before the network when no session is held
 * (`user_session_required`): the backend's answer there would be `invalid_token`, which an agent
 * reads as "the key is bad" rather than "sign in first".
 *
 * `src/__tests__/drift/api-parity.test.ts` holds this list against `docs/api-map.yaml` in both
 * directions: every endpoint under the session prefixes whose `auth` is not `jwt` must match an
 * entry, and every entry must match such an endpoint.
 */
export const SESSION_EXEMPT_PATHS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/api\/v1\/me\/api-keys\/[^/]+\/usage$/ },
  { method: 'GET', pattern: /^\/api\/v1\/me\/verification-requests$/ },
  { method: 'GET', pattern: /^\/api\/v1\/me\/emails\/verify\/[^/]+$/ },
  // The emailed account-deletion cancel link's two halves (h-implement-proper-deletion, ACC-3):
  // public, the token is the whole secret. A keyed client never calls them, but a public route
  // under the session prefix must be exempt or the map's completeness rule reads it as locked.
  { method: 'GET', pattern: /^\/api\/v1\/me\/account\/deletion\/cancel\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/v1\/me\/account\/deletion\/cancel\/[^/]+$/ },
  // Deleting a project signs with the session when there is one; with a key alone it still goes
  // out keyed, and the backend allows a key to delete only an EMPTY project (PRJ-3).
  { method: 'DELETE', pattern: /^\/api\/v1\/me\/profiles\/[^/]+$/ },
];

function isSessionExempt(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  return SESSION_EXEMPT_PATHS.some((p) => p.method === verb && p.pattern.test(path));
}

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
  private readonly agentName?: () => string | undefined;
  private sessionToken?: string;
  private refreshToken?: string;
  private refreshing?: Promise<boolean>;

  constructor(config: HttpClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.maxRetries = config.maxRetries ?? 2;
    this.remote = config.remote ?? false;
    this.agentName = config.agentName;
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
    const sessionPath = this.usesSessionAuth(method, path);
    const useSession = sessionPath && !!this.sessionToken;
    const bearer = useSession ? this.sessionToken! : this.apiKey;

    // A key is held but this route answers only to a signed-in user. Sending the key would come
    // back `invalid_token` — "your key is bad" — when the key is fine and a login is what's missing.
    // The reason is spelled out for the agent to pass on (W6, walkthrough 2026-10-02): on the remote
    // transport the person has usually just finished a browser sign-in and does not know it produced a key,
    // so "a key cannot open it" read as a sign-in that had failed.
    if (sessionPath && !this.sessionToken && this.apiKey && !isSessionExempt(method, path)) {
      const keyOrigin = this.remote
        ? 'The API key this connection carries — usually granted by the browser sign-in that connected it —'
        : 'The API key this server started with (PROOF_API_KEY, or the key saved by its login command)';
      throw new ApiError(
        `This tool works only in a signed-in Proof session. ${keyOrigin} does not open this tool. A sign-in ` +
          'session opens your own account records (emails, phones, domains, API keys, 2FA, DNS credentials, ' +
          'verification requests, your public profile\'s username and proof list); getting one is a separate ' +
          'confirmation, not a failed sign-in — tell the user that first. Then call start_login, show ' +
          'them its challenge in your reply, call wait_for_login until it reports success, and call this tool ' +
          'again.',
        'user_session_required',
        401,
      );
    }

    // Public mode: answer before the network rather than after it. A credential-less call to a
    // keyed route would otherwise spend a round trip to return `invalid_token`, which reads to an
    // agent as "the key is wrong" rather than "there is no key yet".
    if (!bearer && !isPublicPath(method, path)) {
      // The wording matters as much as the code, and it has to be true for the transport the caller
      // is actually on. It once said "run create_account to get a key from inside this session",
      // which an agent can follow forever without succeeding on stdio: the key is read at startup
      // (PROOF_API_KEY, or the file `npx @proof-holdings/mcp-server login` saves) and has no
      // runtime setter. But the fix was written for stdio alone, and on the
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
          : 'This operation needs a Proof API key, which this server reads when it starts: from PROOF_API_KEY, or ' +
            'the key saved by running `npx @proof-holdings/mcp-server login` in a terminal. Without one you can ' +
            'still create an account or sign in (create_account, start_login) and check proofs and delegations. ' +
            'If you are signed in, create_api_key works over that session — but the new key takes effect only ' +
            'after it is put in PROOF_API_KEY (or the user runs that login command instead) and this MCP server ' +
            'is restarted.',
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
            'User-Agent': `${USER_AGENT_PREFIX}${VERSION}`,
            ...agentNameHeader(this.agentName?.()),
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
          // A 5xx is retried as transient — EXCEPT where the body names itself a terminal REFUSAL.
          // This client retries every method, POST included, so a retried refusal is not a second
          // chance at the same act: `POST /api/v1/auth/sessions` deletes the session it could not
          // mail before answering, so each attempt composes a NEW one, and a provider that fails
          // after accepting can leave a person holding several codes, none of which belongs to a
          // live session. `response.clone()` keeps the body readable for the error path below.
          const peeked = (await response.clone().json().catch(() => ({}))) as Record<string, unknown>;
          const peekedCode = (peeked.error as { code?: string } | undefined)?.code;
          if (!peekedCode || !TERMINAL_5XX_CODES.has(peekedCode)) {
            await this.sleep(this.backoff(attempt));
            continue;
          }
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

          // The API answers a revoked or expired key exactly as an unknown one, so that a key thief
          // learns nothing. Passed through as "Invalid API key", an agent invents the cause — on the
          // 2026-10-02 walkthrough it told the owner their just-deleted key was still valid. The
          // client knows what this answer means for a key it sent, and what can be done about it on
          // its own transport.
          if (response.status === 401 && code === 'invalid_api_key' && this.apiKey && bearer === this.apiKey) {
            throw new ApiError(
              this.remote
                ? 'The API key this connection was authorized with is no longer accepted: the account owner ' +
                  'revoked it (for example by deleting it in the dashboard), or it expired. It cannot be repaired ' +
                  'from here, and signing in with start_login will not restore this connection. Reconnect this ' +
                  'server to the account (your client\'s sign-in / "Authenticate" step, e.g. /mcp in Claude Code) ' +
                  'to authorize a new key.'
                : 'The API key this server started with (PROOF_API_KEY, or the key saved by its login command) is no ' +
                  'longer accepted: it was revoked, has expired, or is mistyped. Get a new one by running ' +
                  '`npx @proof-holdings/mcp-server login` in a terminal, or put a new key from the Proof dashboard ' +
                  '(Settings → API keys) in PROOF_API_KEY, then restart this MCP server.',
              code,
              response.status,
              apiError?.details,
            );
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
  private usesSessionAuth(method: string, path: string): boolean {
    const verb = method.toUpperCase();
    return (
      SESSION_AUTH_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      path === '/api/v1/auth/me' ||
      SESSION_AUTH_ROUTES.some((route) => route.method === verb && route.pattern.test(path))
    );
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
          'User-Agent': `${USER_AGENT_PREFIX}${VERSION}`,
          ...agentNameHeader(this.agentName?.()),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        // Only a refusal ends the sign-in. A 5xx (including `session_binding_unavailable`, after
        // which the server keeps the old refresh token valid) is an outage, and dropping the
        // session on it would sign the agent out over a blip.
        if (response.status < 500) {
          this.sessionToken = undefined;
          this.refreshToken = undefined;
        }
        return false;
      }
      this.captureSetCookie(response);
      return true;
    } catch {
      // Network failure or timeout: same reasoning — nothing refused the session.
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
