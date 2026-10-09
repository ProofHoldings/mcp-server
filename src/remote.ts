#!/usr/bin/env node
/**
 * Remote entrypoint: the Proof MCP server over Streamable HTTP (`h-mcp-remote`, SC-3 + SC-4).
 *
 * Deployed as its own service, NOT as a route inside the existing backend. The reason is
 * structural rather than stylistic: `src/cluster.ts` forks one worker per CPU and round-robins
 * between them, while a Streamable HTTP session lives in the memory of ONE process. Mounting this
 * on the clustered backend would lose sessions by default, not in an edge case. The deployment
 * therefore pins requests to a replica by the REPLICA PREFIX this server puts in every session id
 * it mints (`<replica>.<uuid>`); see `replicaId` below for why hashing the id itself cannot work,
 * and `k8s/mcp-remote/nginx-mcp.conf` for the routing that consumes the prefix. That routing is
 * deliberately NOT in the base nginx configmap — see that directory's README for the ingress it
 * would otherwise take down, and `src/__tests__/drift/mcp-remote-deployment.test.ts`, which asserts
 * the base stays free of it.
 *
 * ANONYMOUS FIRST, KEYED ON REQUEST (`h-mcp-oauth-remote-wiring`). Every connection starts with the
 * keyless surface and the ability to log in through the normal flows; a client that has been
 * through the OAuth ceremony (`h-mcp-oauth-server`) presents the API key it was granted, and this
 * server reads it from the `Authorization` header ONLY. A `?api_key=` query parameter is never
 * read: a token in a URL is copied into proxy logs and `Referer`, and the standard clients all send
 * a header. The token is resolved ONCE, at open, by self-inspection (`GET /api/v1/me/api-key`) —
 * purely so the refusal is legible; nothing is cached from it, and the key travels to the backend
 * on every call, which is what makes a revocation take effect immediately rather than at session
 * TTL. Where the 401 lands is a measurement, not a preference: on the TOOL CALL that needs an
 * account, because a 401 on `initialize` reached the human as a connection timeout and cost the
 * anonymous connection entirely (`docs/mcp-oauth-client-probe.md`).
 *
 * Each connection needs its OWN `HttpClient` for two reasons now: `captureSetCookie` writes a login
 * session onto the instance, and the API key of one connection must never be reachable from
 * another. The boundary between keyless and keyed tools lives in `./authBoundary.js`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  authorizationChallenge,
  authorizationRequiredBody,
  keyedToolsIn,
  malformedToolCallBody,
  sessionCredentialMismatchBody,
  type KeyedToolCall,
} from './authBoundary.js';
import { createProofServer } from './factory.js';
import { ApiError, HttpClient } from './http.js';

export interface RemoteServerOptions {
  baseUrl: string;
  /** Maximum concurrent MCP sessions. Each one registers the full tool set, so this is a memory bound. */
  maxSessions?: number;
  /** Idle time after which a session is closed and dropped. */
  sessionTtlMs?: number;
  sweepIntervalMs?: number;
  /**
   * Which replica this process is. It is PREFIXED to every session id it mints, and the proxy
   * routes on that prefix.
   *
   * This is not decoration, it is the only thing that makes sticky routing possible. Hashing the
   * session id — the obvious reading of "sticky by mcp-session-id" — cannot work: the replica is
   * chosen when the connection OPENS, and at that moment no session id exists yet, so the hash of
   * the id minted afterwards lands wherever it lands. Measured on a two-replica nginx stand, that
   * arrangement sent 45 of 60 follow-up requests to a replica that had never heard of the session.
   * Carrying the replica in the id turns the routing decision into a lookup instead of a guess.
   */
  replicaId?: string;
}

export interface RemoteServer {
  httpServer: Server;
  sessionCount(): number;
  /** Test seam: the live per-session HTTP clients, to assert they are distinct instances. */
  debugClients(): HttpClient[];
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  http: HttpClient;
  /** The names this session's server registers — what lets the gate tell a typo from a keyed tool. */
  toolNames: ReadonlySet<string>;
  close: () => Promise<void>;
  lastSeen: number;
  /**
   * Requests currently being served on this session. The sweeper skips any session with one.
   *
   * A `lastSeen` stamp cannot cover this WHICHEVER moment it records, which is why the counter
   * exists beside it. Stamped on arrival (the original form), a call that outlives the TTL ages out
   * mid-flight; stamped on completion (what the code does now), the clock still reads from before
   * the call began, so the same call ages out just the same — and the transport would be closed
   * underneath it. The `wait_for_*` tools poll for minutes by design, so that is the ordinary case,
   * not an edge one. Only a "busy right now" counter answers it.
   *
   * This rests on an SDK property rather than on our code: `handleRequest` stays unresolved while a
   * tool executes (Hono's request listener does not resolve until the SSE body is written).
   * Verified on 1.27.1 by holding a `tools/call` open past the TTL. An SDK that resolved at
   * headers-sent would reintroduce mid-call sweeps with this suite green.
   *
   * Stated bound, harmless today and not tomorrow: if the client DISCONNECTS mid-call, the request
   * settles and the session starts aging even though the tool may still be running. That is the
   * right answer while a dropped response is unrecoverable — nobody will ever read it. Configure an
   * `eventStore` on the transport (resumption by `Last-Event-ID`) and it stops being right: the
   * client could come back for that very result, and the session it needs may have been swept.
   */
  inFlight: number;
  /**
   * SHA-256 of the credential this session was opened with; absent for an anonymous session.
   *
   * It answers exactly ONE question — "is this the same caller as the one who opened the session" —
   * and never the question "is that key still alive". The second one is answered only by the
   * backend, on every call, which is why `DELETE /me/api-keys/:id` takes effect on the next tool
   * call instead of at the end of a 30-minute TTL. Reading liveness off anything remembered here
   * would make a revocation wait for the sweeper.
   *
   * Its other job is tenancy: without it a leaked `mcp-session-id` would be enough to spend
   * somebody else's key, since the key rides in the session's `HttpClient` and not in the request.
   *
   * STATED BOUND, because the sentence above covers ONE of the two roads to an account: it binds a
   * session to the KEY that opened it. A session that opened anonymously and then signed in from
   * inside (`start_login` / `wait_for_login`) has no credential of its own to bind to — the JWT
   * arrived on its client, not in its requests — so this stays undefined and a request that simply
   * sends no `Authorization` matches it. On that road the `mcp-session-id` IS the credential. That
       * is inherent rather than an oversight (there is nothing else to bind), and it is bounded by the
   * id being a `randomUUID` and by the session's own TTL; it is written down so the guarantee is
   * not read as covering both roads.
   *
   * The comparison is symmetric, which has a second consequence worth naming: an ANONYMOUS session
   * that later attaches a bearer is refused too, rather than upgraded. That is the right answer —
   * all three measured clients reconnect after signing in instead of reusing the old session, and
   * the refusal tells the caller exactly that — but it means "a request that drops the token" is
   * only half of what this check does.
   */
  keyFingerprint?: string;
}

/**
 * Measured, not guessed (the task called this out as an empirical question). Opening sessions
 * against a built `remote.js` and reading `process.memoryUsage()` after forced GC:
 *
 *   0 sessions   heap  17.3MB   rss  89.9MB
 *   10 sessions  heap  38.4MB   rss 148.1MB   ~2.11MB/session
 *   50 sessions  heap 110.9MB   rss 301.6MB   ~1.87MB/session
 *   100 sessions heap 201.4MB   rss 406.5MB   ~1.84MB/session
 *   200 sessions heap 382.1MB   rss 578.4MB   ~1.82MB/session
 *
 * Linear at ~1.84MB of heap per session — the full tool set is registered per connection, and that
 * is what it costs. 100 sessions therefore sits near 400MB RSS, which is what the container's
 * memory limit is sized against; `src/__tests__/drift/mcp-remote-deployment.test.ts` keeps the two
 * numbers in agreement, because raising this cap without raising the limit buys an OOMKill.
 */
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Largest request body accepted. JSON-RPC envelopes are small; this exists so that one anonymous
 * request cannot buffer the container out of memory (measured before the bound: a single 256MB body
 * took the process to 859MB RSS against a 768Mi limit).
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/**
 * The credential this request presents, read from the `Authorization` header and NOWHERE else.
 *
 * The absence of a query-parameter branch is the point, and it is guarded BEHAVIOURALLY:
 * `__tests__/remote.test.ts`'s SC-8 block measures that `?api_key=` opens an ANONYMOUS session — the
 * keyed tool is still refused — and that the value in the query never appears in an outbound
 * request. Teaching this function to read it turns that block red (verified by mutation).
 *
 * A source scan for the string `api_key` was considered and DELIBERATELY NOT written: the only
 * occurrences left in this file are the sentences explaining the rule, so such a scan would force a
 * choice between a rule that may not be explained and a guard loosened until it catches nothing.
 * The drift suite therefore pins reachability only (that this file still reads the header and still
 * gets its refusals from `./authBoundary.js`), never an absence.
 */
const bearerOf = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return undefined;
  const value = header.slice(7).trim();
  return value || undefined;
};

/**
 * Identity of a credential WITHOUT keeping a second copy of it in the open.
 *
 * The key itself already lives inside the session's `HttpClient`; what the session map needs is
 * only the ability to answer "is this the same caller". A plain comparison of two SHA-256 digests
 * is enough for that — the digest is not a secret whose leak buys anything, since the key cannot be
 * recovered from it.
 */
const fingerprintOf = (credential: string | undefined): string | undefined =>
  credential ? createHash('sha256').update(credential).digest('hex') : undefined;

/**
 * 429 for a caller that must simply wait. `Retry-After` travels only when the number is OURS —
 * i.e. when our own budget refused — because a header we cannot compute is worse absent than wrong.
 */
const rateLimited = (res: ServerResponse, description: string, retryAfterSeconds?: number): void => {
  res
    .writeHead(429, {
      'content-type': 'application/json',
      ...(retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {}),
    })
    .end(JSON.stringify({ error: 'rate_limited', error_description: description }));
};

/**
 * The body for a refused tool call. A call that named no tool is refused for a DIFFERENT reason
 * than a call that needs an account, and saying so is the difference between an instruction the
 * caller can act on and one that sends them to sign in over a typo.
 */
const refusalFor = (baseUrl: string, call: KeyedToolCall): unknown =>
  call.malformed ? malformedToolCallBody() : authorizationRequiredBody(baseUrl, call.name);

/** 401 + the challenge that sends a client to the authorization server (RFC 9728). */
const challenge = (res: ServerResponse, baseUrl: string, body: unknown): void => {
  res
    .writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': authorizationChallenge(baseUrl),
    })
    .end(JSON.stringify(body));
};

/** Thrown when a request body exceeds `MAX_BODY_BYTES`; answered as 413 rather than buffered. */
class BodyTooLargeError extends Error {}

/**
 * Reads and parses a request body, bounded in size and settled on every outcome.
 *
 * All three properties are load-bearing on a public endpoint:
 *  - BOUNDED: an unbounded read let one anonymous request take the process to 859MB RSS against a
 *    768Mi container limit (measured). MCP payloads are JSON-RPC envelopes; 4MB is generous.
 *  - `error`/`aborted` HANDLED: a client that disconnects mid-body never emits `end`, so a promise
 *    awaiting only `end` never settles — which silently leaks anything the caller accounts for
 *    after the await (the session reservation below is exactly that).
 *  - `resolve(undefined)` on unparseable JSON is deliberate: the transport answers such a request
 *    itself, and distinguishing "no body" from "bad body" is not this function's job.
 */
const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const fail = (error: Error) => {
      req.removeAllListeners('data');
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating, but do NOT destroy the socket here: the caller still has to send 413,
        // and tearing the connection down first makes the client see a write error instead of the
        // answer (EPIPE, observed).
        fail(new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted')));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });

/**
 * Answers a body-read failure and only THEN tears the connection down — the client still owes us
 * the rest of an oversized upload, and closing first would replace the answer with a write error.
 */
const rejectBody = (req: IncomingMessage, res: ServerResponse, error: unknown): void => {
  const tooLarge = error instanceof BodyTooLargeError;

  // Drain FIRST. The client is still uploading, and any arrangement that closes the connection
  // while it writes reaches it as a write error instead of the answer — measured twice: destroying
  // the socket outright gave EPIPE every time, and answering with `connection: close` gave it
  // intermittently (1 run in 4), which is a flaky test standing on a real race. Draining costs no
  // memory (bytes are counted and dropped, never buffered) and lets the response arrive intact.
  req.resume();

  if (!res.headersSent) {
    res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: tooLarge ? 'body_too_large' : 'bad_request' }));
  } else if (!res.writableEnded) {
    // Headers already went out. Nothing can be said about the status any more, but the response
    // must still be TERMINATED — an unfinished one hangs the socket until the client gives up, and
    // through the proxy that is a 3600s hold on a connection and a worker slot.
    //
    // Unreachable with SDK 1.27.1, stated rather than implied: both callers reach `rejectBody` only
    // out of `readBody`, which throws before any header is written, and a throw inside
    // `transport.handleRequest` is caught by Hono's request listener, which terminates the response
    // itself. The arm is kept because it costs nothing and is correct if that changes — not
    // because a test covers it.
    res.end();
  }
};

/**
 * How long the self-inspection may take, and how many times it may be tried.
 *
 * NOT the client's ordinary settings, and the difference is a capacity bound rather than a
 * preference. This call runs INSIDE the reservation taken below, so its duration is time a session
 * slot is held by a request that has not proved anything yet. The ordinary client retries twice and
 * honours `Retry-After`, and the backend answers `Retry-After: 60` from ONE per-pod IP bucket
 * shared by every tenant — so with those settings a single credential-less request holds a slot for
 * two minutes, and a hundred of them close the anonymous surface this service exists to keep open
 * (measured: 120s hold, 3 backend calls, a legitimate anonymous open answered 503).
 */
const RESOLVE_TIMEOUT_MS = 5_000;

/**
 * How fast this process may send self-inspections, sustained.
 *
 * A LOCAL bound on OUR outbound calls, and it exists because the refusal path is cheap: a bearer
 * that resolves to nothing releases its reservation immediately, so nothing else in this process
 * limits how fast such opens arrive. The proxy allows 30 r/s per client IP on `/mcp`
 * (`k8s/mcp-remote/nginx-mcp.conf`), while the backend's `/me` surface is one 300/60s bucket keyed
 * on the POD's egress IP (`src/routes/me.ts`) — about 5 r/s for the whole fleet, and that same
 * bucket also carries every ordinary `/me/*` tool call from every live session. Without this bound
 * one source staying comfortably inside the proxy's limit drains it in seconds, and every
 * LEGITIMATE keyed connection is answered 429 while the anonymous surface keeps working and the
 * service looks healthy.
 *
 * THE ARITHMETIC, so the next reader can check it rather than trust it: 1/s per process × the
 * replica count in `k8s/mcp-remote/statefulset.yaml` — the drift case named below multiplies the
 * two and compares the product with the backend's own literal, so neither figure is restated here
 * — leaving the remainder of that bucket for
 * the ordinary `/me` traffic that shares the bucket. A self-inspection happens once per CONNECTION,
 * not once per call, so 1/s is ~86k sign-ins a day per replica. It caches nothing about any token —
 * a refusal here is "ask again in a moment", never a verdict — so the rule that liveness is decided
 * only by the backend is untouched.
 *
 * STATED BOUND, and it is the residual of this cure rather than its elimination: the bucket is
 * keyed on NOTHING — one counter for the process. A single source sending garbage bearers at just
 * over the refill rate keeps it empty, and new keyed connections are then refused 429 while the
 * anonymous surface and every already-open session keep working. That is strictly better than the
 * shape it replaced (the same traffic used to spend the SHARED backend bucket, taking every
 * tenant's ordinary `/me` calls down with it), but it is not nothing. Keying per client IP is the
 * fix, and it needs a decision about trusting `X-Forwarded-For` that this task did not take.
 *
 * The other tail of the same residual is LOCAL rather than remote: the burst equals the whole
 * session cap, and each self-inspection sits inside a reservation for up to `RESOLVE_TIMEOUT_MS`.
 * The measured refusals (401, 429) release it immediately, so this only bites if the API HANGS —
 * then one source can hold a replica's reservations for that window before the budget throttles it
 * to the sustained rate. Bounded by the 5s timeout rather than by anything cleverer.
 */
const RESOLVE_RATE_PER_SECOND = 1;

/**
 * Ceiling on the burst, expressed FLEET-WIDE because the bucket it spends is fleet-wide.
 *
 * The burst below is sized off `maxSessions`, which is per replica — and the bucket it lands in is
 * `ipRateLimit(300, 60, 'me')` keyed on the pod's egress IP, i.e. shared by every replica. So the
 * figure that matters is `replicas × burst`, and stating the burst per replica beside a rate stated
 * fleet-wide is how those two drift apart: at `replicas: 3` and the default cap, an unbounded burst
 * is 300 — the entire minute's bucket, spent at exactly the moment those sessions also begin their
 * ordinary `/me/*` calls through it. `src/__tests__/drift/mcp-remote-deployment.test.ts` derives
 * `replicas × min(MCP_MAX_SESSIONS, RESOLVE_BURST_CEILING)` — the EFFECTIVE burst, not this
 * constant alone — against the backend's own literal, so SCALING THE FLEET reddens it instead of
 * surfacing as 429s in production. Raising THIS constant is caught elsewhere and deliberately so:
 * while the manifest cap sits at or below the ceiling, the effective burst does not move, and the
 * unit case in `mcp/__tests__/remote.test.ts` that runs a cap ABOVE the ceiling is what holds it.
 */
export const RESOLVE_BURST_CEILING = 100;

/**
 * How many may burst — sized off the capacity it can never exceed rather than picked, then clamped.
 *
 * A self-inspection happens once per connection, and a replica holds at most `maxSessions` of them,
 * so a reconnect herd after a restart or a rolling deploy is bounded by that number. A burst
 * smaller than the cap turns every such herd into refusals for everyone past the burst: the SDK
 * client does not retry a 429, so each one reaches the human as a failed connection. The ceiling is
 * what keeps that generosity inside the shared bucket above.
 */
function resolveBurstFor(maxSessions: number): number {
  return Math.min(maxSessions, RESOLVE_BURST_CEILING);
}

/** What a rate-limited caller is told to wait: long enough for one token, not for a whole burst. */
const RESOLVE_RETRY_AFTER_SECONDS = Math.ceil(1 / RESOLVE_RATE_PER_SECOND);

/**
 * A token bucket over the self-inspection above. Process-local on purpose: what it protects is this
 * process's own outbound channel, and a shared counter would need a store this service does not
 * have and must not grow for a defensive bound.
 *
 * Exported for its own test. The arithmetic below has a failure mode no HTTP-level case can reach
 * cheaply — a clock that steps BACKWARDS — and the previous version's clock seam was a default
 * parameter on an unexported function, i.e. unreachable from a test even in principle. That is the
 * same shape `positiveIntEnv` above was fixed for once already.
 */
export function createResolveBudget(maxSessions: number, now: () => number = () => performance.now()) {
  const burst = resolveBurstFor(maxSessions);
  let tokens = burst;
  let last = now();

  return {
    /** True when a self-inspection may be sent; consumes one token. */
    take(): boolean {
      const at = now();
      // Elapsed is clamped at BOTH ends. `performance.now()` is monotonic, so the floor is belt and
      // braces there — but the seam accepts any clock, and a wall clock stepped backwards by an
      // hour would otherwise drive the bucket to -7190 tokens and refuse every keyed connection for
      // about an hour, while `/healthz` and the anonymous surface looked perfect (measured).
      const elapsed = Math.max(0, at - last);
      tokens = Math.min(burst, tokens + (elapsed / 1000) * RESOLVE_RATE_PER_SECOND);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/**
 * Confirms the presented token names a live key, and answers the request itself if it does not.
 *
 * Returns true when the session may be opened. Every refusal arm exists because the alternative is
 * a session that LOOKS open and cannot work:
 *  - 401: the token is dead. Answered with the challenge rather than by opening an anonymous
 *    session, because the challenge is what makes a client refresh — measured on Inspector, which
 *    rotated its token and replayed the call inside a second (`docs/mcp-oauth-client-probe.md`).
 *  - 403: the key exists but cannot inspect itself, i.e. it lacks `settings:read`. Named out loud,
 *    since the alternative is an opaque `invalid_token` on some later call that has nothing to do
 *    with scopes. The ceremony always grants that scope (`MCP_OAUTH_MANDATORY_SCOPE`), so this arm
 *    is reachable mainly by a hand-made key.
 *  - 429: rate-limited, which is neither a verdict on the token nor an outage — either by our own
 *    budget below or by the API upstream. Answered 429 so a client waits instead of concluding its
 *    credential died or the service is down. `Retry-After` is sent ONLY for our own budget, where
 *    the number is ours to know; the upstream's own header does not survive `ApiError` (which
 *    carries `body.error.details`, and the backend puts its `retryAfter` beside that, not in it),
 *    so claiming to pass it through would be a sentence with nothing behind it.
 *  - 400: the credential is not an API key at all (the endpoint answers `api_key_required` to a
 *    JWT). A live credential of the wrong KIND, reached successfully — so it is named as such
 *    rather than reported as an outage.
 *  - anything else (timeout, network, 5xx): 503. Opening the session would hand the caller a
 *    connection whose identity nothing has established.
 *
 * It builds its OWN client rather than taking the session's: the session's is configured for real
 * work (retries, 30s timeout), and those settings are exactly what turn a rate-limited upstream
 * into a parked capacity slot.
 */
async function resolvePresentedToken(
  presented: string,
  baseUrl: string,
  res: ServerResponse,
  budget: { take(): boolean },
): Promise<boolean> {
  if (!budget.take()) {
    rateLimited(res, 'This server is checking too many credentials right now. Try again in a moment.', RESOLVE_RETRY_AFTER_SECONDS);
    return false;
  }

  try {
    // Inside the `try` so the docstring's list of outcomes stays exhaustive: a throw from the
    // constructor would otherwise leave through the opener's catch and be answered `bad_request`,
    // which is neither true nor one of the arms below. Unreachable today (the constructor only
    // normalises a string), and cheaper to keep correct than to explain.
    const probe = new HttpClient({ apiKey: presented, baseUrl, maxRetries: 0, timeout: RESOLVE_TIMEOUT_MS });
    await probe.get('/api/v1/me/api-key');
    return true;
  } catch (error) {
    const status = error instanceof ApiError ? error.statusCode : 0;
    const code = error instanceof ApiError ? error.code : '';
    // The CODE as well as the status, because a 400 produced in FRONT of the API (a proxy refusing
    // an oversized header, say) carries `http_400` and has nothing to say about the credential —
    // answering it "that is not an API key" would be a confident wrong diagnosis. Everything but
    // the endpoint's own `api_key_required` keeps falling into the 503 arm it had before.
    if (status === 400 && code === 'api_key_required') {
      // `GET /me/api-key` answers 400 `api_key_required` to a credential that is not an API key —
      // a JWT, say. That is a live credential of the WRONG KIND reached successfully, so reporting
      // it as "could not reach the API" would send the one person likely to hit it (somebody
      // pasting a token by hand) looking for an outage.
      json(res, 400, {
        error: 'unsupported_credential',
        error_description:
          'That credential is not a Proof API key. This server accepts the API key an OAuth ' +
          'connection grants; sign in through your client to get one.',
      });
    } else if (status === 401) {
      challenge(res, baseUrl, {
        error: 'invalid_token',
        error_description: 'The presented token is not a live Proof API key. Sign in again to get a new one.',
      });
    } else if (status === 403) {
      json(res, 403, {
        error: 'insufficient_scope',
        error_description:
          'This key cannot inspect itself, so this server cannot tell whose connection it is: the ' +
          'settings:read scope is required. Reconnect and approve it, or use a key that carries it.',
        required_scope: 'settings:read',
      });
    } else if (status === 429) {
      // No `Retry-After` here, deliberately: the upstream's own header is not reachable from
      // `ApiError` (see the docstring), and inventing a number would be worse than sending none.
      rateLimited(res, 'The Proof API is rate-limiting this server right now. Try again shortly.');
    } else {
      json(res, 503, {
        error: 'upstream_unavailable',
        error_description: 'Could not reach the Proof API to check the presented token. Try again shortly.',
      });
    }
    return false;
  }
}

/** True for the one JSON-RPC method allowed to open a session. */
const isInitialize = (body: unknown): boolean => {
  if (Array.isArray(body)) return body.some((entry) => (entry as { method?: string })?.method === 'initialize');
  return (body as { method?: string } | undefined)?.method === 'initialize';
};

/**
 * The replica's own index: `MCP_REPLICA_ID` if set, otherwise the ordinal a StatefulSet puts at the
 * end of the pod hostname (`mcp-remote-1` → `1`). Falls back to `0` for a single process, which is
 * what the stdio-style local run and the tests get.
 */
/**
 * Reads a positive-integer setting, falling back to the built-in default on anything else.
 *
 * A typo must not disable the bound it configures. `Number('abc')` is NaN, and both
 * `size >= NaN` and `lastSeen < NaN` are false — so an unparseable value would fail OPEN on exactly
 * the two limits this server relies on, with the pod still passing every probe. INTEGER rather than
 * merely finite-and-positive, because `MCP_SESSION_TTL_MS=0.5` would sweep every session on the
 * first tick and `MCP_MAX_SESSIONS=0.5` would silently mean one.
 *
 * Exported and at module scope so it can be tested — the previous version was a closure inside the
 * entrypoint guard, unreachable from a test even in principle, which left the fix one edit wide.
 */
export function positiveIntEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (!raw) return undefined;
  // Digits only, which says the contract exactly once instead of spreading it across a numeric
  // check and a textual exclusion: the earlier form tested `raw` for exponents but `parsed` for
  // integrality, so `0xD` was accepted as 13 while `0xE` was refused, and `1.8e6` — a plausible
  // shorthand for 30 minutes in ms — silently became the default.
  const parsed = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  // The upper bound is what a long decimal literal needs: 20 nines parses to 1e20, which is
  // effectively unbounded, and no exponent appears in the string to catch it.
  if (parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER) return parsed;
  console.error(`Ignoring ${name}=${raw}: not a positive integer. Falling back to the built-in default.`);
  return undefined;
}

export function resolveReplicaId(explicit?: string, hostname: string = os.hostname()): string {
  if (explicit) return explicit;
  const ordinal = hostname.match(/-(\d+)$/);
  return ordinal ? ordinal[1] : '0';
}

export function createRemoteServer(options: RemoteServerOptions): RemoteServer {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sweepMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const replicaId = resolveReplicaId(options.replicaId);

  const sessions = new Map<string, Session>();
  /** Opens that passed the cap check but have not reached `onsessioninitialized` yet. */
  let pendingOpens = 0;
  /** Bounds how fast this process may ask the API to resolve presented tokens. */
  const resolveBudget = createResolveBudget(maxSessions);

  const dropSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await session.close().catch(() => undefined);
  };

  const sweep = setInterval(() => {
    const deadline = Date.now() - ttlMs;
    for (const [sessionId, session] of sessions) {
      if (session.inFlight > 0) continue;
      if (session.lastSeen < deadline) void dropSession(sessionId);
    }
  }, sweepMs);
  // Never hold the process open for the sake of the sweeper alone.
  sweep.unref();

  const httpServer = createServer(async (req, res) => {
    const requestPath = (req.url ?? '').split('?')[0];

    if (requestPath === '/healthz') {
      json(res, 200, { status: 'ok', sessions: sessions.size });
      return;
    }

    if (requestPath !== '/mcp') {
      // Everything else is a plain 404 — including the OAuth metadata paths. This server has no
      // authorization server, and answering there would advertise one that does not exist.
      json(res, 404, { error: 'not_found' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (existing) {
      // BEFORE the counter, because a refusal here takes no slot: the credential presented now must
      // be the one that opened this session. Both directions are refused — a foreign token on
      // somebody else's session id, and a request that drops the token the session was opened with
      // — so neither a leaked id nor a stripped header reaches another tenant's key.
      //
      // STATED BOUND: this runs before any method check, so it applies to the standalone `GET /mcp`
      // event stream and to the session-terminating `DELETE` as well as to tool calls. A keyed
      // client that omits the header on those gets a challenge rather than its stream or its
      // teardown (the session then lingers to TTL). Standards-compliant clients attach the token to
      // every request to the resource — the live run shows Claude Code doing exactly that — so this
      // is a bound rather than a defect, and refusing is the safe direction: the alternative is a
      // credential-less request acting on a keyed session.
      if (fingerprintOf(bearerOf(req)) !== existing.keyFingerprint) {
        challenge(res, options.baseUrl, sessionCredentialMismatchBody());
        return;
      }

      // Counted from BEFORE the body is read: a slow upload is time the session is in use, and the
      // sweeper must not reclaim it midway.
      //
      // POST ONLY, and that is the whole point of the distinction. `handleRequest` for a standalone
      // `GET /mcp` SSE stream does not resolve until the stream ends, so counting it would keep
      // `inFlight` at 1 for the stream's entire life — and the MCP SDK client opens that stream
      // right after `initialize`. Counting it made the documented 30-minute idle TTL unreachable
      // for every real client (measured: a session with an open GET survived 6× its TTL), leaving
      // nginx's 3600s read timeout as the only bound. A stream is a connection, not work.
      //
      // The cost of that choice, measured rather than assumed: the official client does NOT
      // re-initialize after its session is swept — the stream's reconnect gives up after two
      // attempts and the next call fails `unknown_session` until the host reconnects. So the TTL
      // is a memory bound paid for in reconnects. Counting the stream instead would trade that for
      // sessions that are never reclaimed at all, which is the worse of the two.
      const counted = req.method === 'POST';
      // THE RULE, in the words the code can actually perform: the idle clock moves for a POST the
      // transport ACCEPTED — one it answered below 400. `inFlight` is what protects a request that
      // is still running; `lastSeen` is set in the `finally` below, the only place that can see the
      // answer.
      //
      // The word "work" is retired here on purpose. It was false five times running, each time on a
      // path the previous fix had not looked at:
      //   - an ARRIVAL stamp refreshed the clock for requests that never reached the transport
      //     (measured: five oversized bodies, each answered 413, held a session across twice its TTL);
      //   - a stamp on every COMPLETED request refreshed it for the four shapes the TRANSPORT itself
      //     refuses — unparseable body, empty body, unsupported `mcp-protocol-version`, a second
      //     `initialize` — each answered 400 from inside the SDK before `onmessage` runs, so 16 bytes
      //     of garbage postponed the TTL while 5MB of it did not;
      //   - and "accepted, therefore worked" is false too. `POST []` runs the SDK's message loop zero
      //     times and is still answered 202, so nothing is dispatched and the clock moves anyway
      //     (the original measurement: six of them over 360ms held a session whose TTL was 150ms —
      //     the case guarding it now uses a shorter TTL and more requests, which is margin, not a
      //     new fact).
      //     ACCEPTED is what
      //     this code can observe, so ACCEPTED is what it claims — and the empty batch has a test of
      //     its own, so the day someone refuses it, the sentence gets rewritten rather than quietly
      //     becoming a different claim.
      // Worth naming rather than leaving to be rediscovered: this makes the TTL no kind of abuse
      // bound — a single `notifications/initialized` sent just inside the TTL holds a slot just as
      // cheaply, and it IS dispatched. Capacity is bounded by `MCP_MAX_SESSIONS` and the proxy's rate limit instead.
      //
      // The rule ships in two artifacts — here and `README.md`'s Transport section — and the two are
      // tied together by `src/__tests__/drift/mcp-remote-deployment.test.ts`, which requires each to
      // state it exactly once. (The cases in `__tests__/remote.test.ts` restate it too, in prose that
      // explains what they measure; those are not shipped, and the guard does not read them.)
      if (counted) existing.inFlight += 1;
      let body: unknown;
      try {
        body = req.method === 'POST' ? await readBody(req) : undefined;
      } catch (error) {
        // Same bound on the established-session path: a live session is not a licence to buffer.
        // The release is symmetric with the increment above — unconditional here while the
        // increment was conditional would drive the counter negative on a path that never took a
        // slot, and a negative count disables the sweeper's skip for that session entirely.
        if (counted) existing.inFlight -= 1;
        rejectBody(req, res, error);
        return;
      }
      // THE GATE, and the whole reason it sits here rather than in a tool handler: a 401 with
      // `WWW-Authenticate` is an HTTP answer, and once the message reaches the transport the reply
      // is a JSON-RPC result no client's OAuth stack will read. A session with NO account behind it
      // may run the keyless surface; a registered tool outside it is refused with the challenge that
      // starts the ceremony, and a name the session's server does not register goes on to the SDK,
      // which answers it as an unknown tool (`keyedToolsIn` with `existing.toolNames`). For a session
      // with no account behind it `initialize` and `tools/list` are never refused — the control measurement for that arrangement was a connection timeout, not a login
      // prompt. THREE things do answer 401 at the handshake, and the third is on the anonymous
      // road, so "never refused" needs all of them: a PRESENTED token that fails to resolve
      // (`resolvePresentedToken`), a credential that does not match this session (above), and a
      // batch that smuggles a keyed `tools/call` alongside `initialize` — refused by this same rule
      // applied on the opening path, because the tool call is what asks for an account.
      //
      // TWO ways to have an account, not one, and reading only the first was a real defect: besides
      // the API key an OAuth client presents, a caller can SIGN IN from inside the session through
      // `start_login` / `wait_for_login`, after which `captureSetCookie` holds a live JWT on this
      // connection's client and the `SESSION_AUTH_PREFIXES` tools travel with it. That is the road
      // the refusal text itself advertises to clients that cannot speak OAuth, and gating on the
      // key alone closed it — the user signed in and was told to sign in. A tool outside that
      // surface still answers `api_key_required` from the client, exactly as it did before this
      // task; what the gate must not do is refuse the ones login actually unlocks.
      //
      // STATED BOUND, and harmless because the backend stays authoritative on every call: the
      // client clears its session only on `token_expired` (see the refresh path in `./http.js`), so
      // a JWT REVOKED server-side leaves this condition true. Such a caller keeps being forwarded
      // and keeps being refused one call at a time by the backend, rather than getting the
      // challenge that would restart the ceremony. It grants nothing — it is a worse error message,
      // not a hole.
      if (!existing.keyFingerprint && !existing.http.hasSessionToken()) {
        const keyed = keyedToolsIn(body, existing.toolNames);
        if (keyed.length > 0) {
          // Symmetric with `rejectBody` above: the counter was taken before the body was read, and
          // an unbalanced exit would leave this session permanently "busy" for the sweeper.
          if (counted) existing.inFlight -= 1;
          // `lastSeen` deliberately untouched — the file's rule is that the idle clock moves for an
          // answer BELOW 400, and this is a refusal.
          challenge(res, options.baseUrl, refusalFor(options.baseUrl, keyed[0]));
          return;
        }
      }

      try {
        // No `catch` here, unlike the new-session path below, and the asymmetry is deliberate:
        // there the `catch` exists to release the RESERVATION, which this path never takes. A
        // throw out of `handleRequest` is caught inside the SDK's own listener; if that ever
        // changed, the process-level handler keeps the server serving and this socket would be
        // held until the proxy's read timeout.
        await existing.transport.handleRequest(req, res, body);
      } finally {
        if (counted) {
          existing.inFlight -= 1;
          // Accepted: the idle clock restarts when the answer went out, not when the request began.
          //
          // `headersSent` is DEFENSIVE and currently unreachable — stated rather than implied, the
          // same posture as `rejectBody`'s `res.end()` arm. `res.statusCode` reads 200 until
          // something writes it, so without the conjunct a request that died before answering would
          // stamp as a successful one; but every route out of `handleRequest` writes a response
          // before resolving, and the one that does not (a client abort, which is swallowed as
          // `ERR_STREAM_PREMATURE_CLOSE`) has already dispatched its message, so the stamp would have
          // been right anyway. No test covers it, and none is claimed to.
          //
          // Name the right dependency, though: the guarantee belongs to `@hono/node-server` (1.19.9
          // here), which the SDK uses to bridge to `node:http`. Stated as the invariant rather than
          // as a mechanism — headers are SENT by the time it resolves — because not every branch
          // sends them itself: two hand off to something that already did. It is a TRANSITIVE
          // dependency, so a hono bump can move it while the SDK version pinned elsewhere in this
          // file stays put.
          if (res.headersSent && res.statusCode < 400) existing.lastSeen = Date.now();
        }
      }
      return;
    }

    if (typeof sessionId === 'string') {
      // A session id this process does not know. Refused rather than treated as a fresh session:
      // silently starting a new one would make a misrouted request LOOK like a success, and the
      // absence of sticky routing would surface much later as inexplicably lost state.
      json(res, 404, { error: 'unknown_session' });
      return;
    }

    if (req.method !== 'POST') {
      json(res, 400, { error: 'session_required' });
      return;
    }

    // RESERVE the slot before the first await, and count reservations alongside live sessions.
    // Checking `sessions.size` alone is not a bound: the map is written in `onsessioninitialized`,
    // which is several awaits away, so every concurrent opener reads the pre-request count.
    // Measured on the unreserved version: `maxSessions: 2` admitted 25 concurrent opens.
    //
    // The deliberate trade: a slow uploader holds its reservation while it dribbles, so parked
    // openers can occupy the cap without creating a session. Node's `requestTimeout` (300s) bounds
    // it, and the documented deployment puts nginx in front with request buffering on, so the
    // shape is not reachable there — a capacity pause is accepted in exchange for the memory bound.
    if (sessions.size + pendingOpens >= maxSessions) {
      json(res, 503, { error: 'session_capacity_reached' });
      return;
    }
    pendingOpens += 1;

    try {
      const body = await readBody(req);

      // Build nothing until the body says it is an opening handshake. Previously any malformed POST
      // constructed a full server + transport (measured 1.35ms in the factory, plus the whole tool set) only for the SDK to
      // answer 400 — an uncounted allocation amplifier on the cheapest possible request.
      if (!isInitialize(body)) {
        json(res, 400, { error: 'initialize_expected' });
        return;
      }

      const presented = bearerOf(req);

      // The gate again, on the OPENING request. `isInitialize` accepts a batch that merely
      // CONTAINS an initialize, so in principle `[initialize, tools/call …]` reaches the transport
      // without ever passing the check above. SDK 1.27.1 refuses such a batch itself (400, "Only
      // one initialization request is allowed") and an anonymous session has no credential to
      // spend — but both of those are somebody else's properties, and the boundary should not rest
      // on a dependency's version. Two lines make it self-standing.
      const smuggled = keyedToolsIn(body);
      if (!presented && smuggled.length > 0) {
        challenge(res, options.baseUrl, refusalFor(options.baseUrl, smuggled[0]));
        return;
      }

      // RESOLVE the presented token BEFORE anything is built for it, by the SAME self-inspection an
      // agent uses (`GET /api/v1/me/api-key`, `settings:read`). No new authorization branch is
      // invented here and nothing is remembered: every scope decision stays with
      // `requireScopeIfApiKey` on the backend, on every call. What this buys is a legible refusal —
      // without it a dead token opens a session that answers `authorization_required` to
      // everything, and a token missing `settings:read` fails later as an opaque `invalid_token`.
      //
      // Ordered before `createProofServer` deliberately, and it is the same rule the `isInitialize`
      // check above states: build nothing for a request that is about to be refused. A full server
      // is the whole tool set, ~1.84MB of heap by the table above, and a garbage bearer is the
      // cheapest request an attacker can send.
      if (presented && !(await resolvePresentedToken(presented, options.baseUrl, res, resolveBudget))) return;

      const { server, http, toolNames } = createProofServer({ baseUrl: options.baseUrl, apiKey: presented, remote: true });

      const transport = new StreamableHTTPServerTransport({
        // `<replica>.<uuid>` — the prefix is what the proxy routes on. See `replicaId` above.
        sessionIdGenerator: () => `${replicaId}.${randomUUID()}`,
        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            http,
            toolNames,
            close: async () => {
              await transport.close().catch(() => undefined);
              await server.close().catch(() => undefined);
            },
            // The one arrival-shaped stamp left, and deliberately so: the opening POST creates the
            // entry, so there is nothing to stamp on its completion. It is safe for a reason
            // outside our code, and measured rather than assumed: SDK 1.27.1 answers any batch
            // carrying `initialize` alongside anything else with 400 "Only one initialization
            // request is allowed", so this request cannot also be carrying work whose completion
            // would be the honest moment to stamp.
            lastSeen: Date.now(),
            inFlight: 0,
            keyFingerprint: fingerprintOf(presented),
          });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      // `readBody` rejects on an oversized body and on a client that disappears mid-upload; the
      // reservation must come back in both cases, which is what the `finally` below is for.
      rejectBody(req, res, error);
    } finally {
      pendingOpens -= 1;
    }
  });

  return {
    httpServer,
    sessionCount: () => sessions.size,
    debugClients: () => [...sessions.values()].map((session) => session.http),
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map((sessionId) => dropSession(sessionId)));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

const isEntrypoint = (): boolean => {
  const invoked = process.argv[1];
  return !!invoked && path.resolve(invoked) === fileURLToPath(import.meta.url);
};

if (isEntrypoint()) {
  // Bare `Number()` on purpose, unlike the two settings below: `listen(NaN)` throws
  // ERR_SOCKET_BAD_PORT synchronously, so a typo here is fail-LOUD and cannot silently disable
  // anything. The pod carries no `PORT` env at all (pinned by the deployment drift suite).
  const port = Number(process.env.PORT ?? 3100);
  const remote = createRemoteServer({
    baseUrl: process.env.PROOF_BASE_URL ?? 'https://api.proof.holdings',
    replicaId: process.env.MCP_REPLICA_ID,
    maxSessions: positiveIntEnv('MCP_MAX_SESSIONS'),
    sessionTtlMs: positiveIntEnv('MCP_SESSION_TTL_MS'),
  });

  remote.httpServer.listen(port, () => {
    console.error(
      `Proof MCP remote server listening on ${port} ` +
        '(anonymous connections allowed; an API key is read from the Authorization header only)',
    );
  });

  // The stdio entrypoint has carried these since it shipped; this one serves MANY users, so an
  // uncaught error here kills every live session rather than one. Log and keep serving: on Node 22
  // an unhandled rejection would otherwise terminate the process by default.
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error instanceof Error ? error.message : error);
  });
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error instanceof Error ? error.message : error);
  });

  const shutdown = () => {
    // Bounded: `httpServer.close()` waits on keep-alive connections, and a Streamable HTTP client
    // holds them open by design, so an unbounded wait would sit here until SIGKILL.
    const forced = setTimeout(() => process.exit(0), 15_000);
    forced.unref();
    void remote.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
