#!/usr/bin/env node
/**
 * `h-mcp-oauth-probe` (SC-1..SC-6): what do real MCP clients demand of an authorization server?
 *
 * Two unknowns drive this file, and neither can be settled by reading code:
 *
 *   1. Can "connect by link, no login" survive next to a keyed surface? The remote server admits
 *      anonymous clients today (`h-mcp-remote`, measured). A client only enters OAuth once it gets
 *      HTTP 401 with `WWW-Authenticate`. So the candidate shape is: anonymous `initialize` passes,
 *      and the 401 arrives on the TOOL CALL that needs an account. Whether live clients turn into
 *      OAuth at that moment — and whether they REPLAY the original call afterwards — is measured.
 *   2. Is dynamic client registration (RFC 7591) mandatory in practice? A stock client cannot hold
 *      a pre-issued `client_id` for our server, so "registration disabled" may simply be unbuildable.
 *
 * The authorization server below is a TOY and entirely ours: zero imports from
 * `@modelcontextprotocol/sdk/server/auth/*` and not one line of Proof business logic. With the SDK's
 * auth surface mounted, a failure would be indistinguishable between "the client cannot do this" and
 * "our server is broken" — telling those two apart is the only job this probe has.
 *
 * NOT A REFERENCE IMPLEMENTATION. It is an instrument: it answers whatever a client asks so the
 * asking can be recorded. `/token` accepts any `client_id` and never authenticates the client, the
 * refresh branch hands out a token unconditionally, and `redirect_uri` is compared only against the
 * value from the same authorization request. Every one of those is a hole a real server must close
 * (the rules live in `team-management/tasks/h-mcp-oauth-server.md`, derived FROM these measurements).
 * What is enforced here is only what could otherwise corrupt a measurement: PKCE S256 is verified,
 * an authorization code is single-use, and a `redirect_uri` at `/token` must match the one from its
 * own authorization request — none of which is the same as validating that URI against a policy.
 *
 * Every inbound request is logged BEFORE routing, including the ones answered 404 — otherwise
 * "the client never asked for that document" would be an absence of observation rather than an
 * observation. Bodies: `/register` and the `/authorize` query in full; `/token` with `code` and
 * `code_verifier` masked.
 *
 * Usage:
 *   node mcp/probe/oauth-probe.mjs --port 8932 --log /tmp/oauth.jsonl --label anon
 *   node mcp/probe/oauth-probe.mjs --host 0.0.0.0                  # default is loopback only
 *   node mcp/probe/oauth-probe.mjs --mode always-401        # 401 on `initialize` itself
 *   node mcp/probe/oauth-probe.mjs --no-dcr                 # no registration_endpoint, /register 404
 *   node mcp/probe/oauth-probe.mjs --omit-field scopes_supported --omit-field code_challenge_methods_supported
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const argAll = (name) =>
  process.argv.reduce((acc, value, i) => (value === `--${name}` ? [...acc, process.argv[i + 1]] : acc), []);
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = Number(arg('port', '8932'));
const LOG = arg('log', 'oauth-probe.jsonl');
const LABEL = arg('label', 'oauth-probe');
// Loopback by DEFAULT: this instrument mints bearer tokens to anyone who asks and redirects
// anywhere, so it must not be reachable from the network by accident. The tunnelled runs still
// work — `cloudflared` connects to it locally — and `--host 0.0.0.0` remains available for the
// case where something must reach it directly, as an explicit choice rather than a default.
const HOST = arg('host', '127.0.0.1');
const MODE = arg('mode', 'anon-then-401');
const NO_DCR = flag('no-dcr');
const OMITTED = new Set(argAll('omit-field').filter(Boolean));

if (!['anon-then-401', 'always-401'].includes(MODE)) {
  process.stderr.write(`unknown --mode ${MODE}; expected anon-then-401 or always-401\n`);
  process.exit(2);
}

const write = (entry) => appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), label: LABEL, ...entry })}\n`);

/**
 * Called as the FIRST statement of the request handler, before any routing decision. It returns a
 * mutable record the handler enriches (bodies, verdicts); the line itself is written on `finish`,
 * so the status in the log is the status that was actually sent.
 */
const logRequest = (req, res) => {
  const entry = {
    method: req.method,
    url: req.url,
    headers_sent: Object.keys(req.headers).sort(),
    'user-agent': req.headers['user-agent'],
    host: req.headers.host,
    origin: req.headers.origin,
    authorization: req.headers.authorization ? '<present>' : undefined,
    'mcp-session-id': req.headers['mcp-session-id'],
    'mcp-protocol-version': req.headers['mcp-protocol-version'],
  };
  res.on('finish', () =>
    write({
      ...entry,
      status: res.statusCode,
      // `getHeader` sees only what `setHeader` put there — a header passed inline to `writeHead`
      // is invisible here, which silently emptied both of these fields. Everything below therefore
      // goes through `setHeader`, and the two are asserted non-empty by the drift suite.
      'www-authenticate-sent': res.getHeader('www-authenticate') ?? undefined,
      location_sent: maskCodeInUrl(res.getHeader('location')),
    }),
  );
  return entry;
};

/** The redirect carries the authorization code in the clear; mask it the way `/token` bodies are. */
const maskCodeInUrl = (location) => {
  if (!location) return undefined;
  return String(location).replace(/([?&]code=)[^&]+/, (_m, prefix) => `${prefix}<masked>`);
};

/** Sets headers where `getHeader` — and therefore the log line — can see them. */
const sendHead = (res, status, headers) => {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.writeHead(status);
};

/** Absolute base URL as the CLIENT sees it, so the issuer in the metadata matches the URL it was fetched from. */
const baseUrl = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
};

const withoutOmitted = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !OMITTED.has(key)));

const protectedResourceMetadata = (req) => {
  const base = baseUrl(req);
  return withoutOmitted({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: ['probe:read', 'probe:whoami'],
    bearer_methods_supported: ['header'],
    resource_name: 'Proof OAuth probe resource',
    resource_documentation: `${base}/docs`,
  });
};

const authorizationServerMetadata = (req) => {
  const base = baseUrl(req);
  return withoutOmitted({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    ...(NO_DCR ? {} : { registration_endpoint: `${base}/register` }),
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['probe:read', 'probe:whoami'],
    service_documentation: `${base}/docs`,
  });
};

const json = (res, status, body, headers = {}) => {
  sendHead(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

/** One transport + one server per MCP session, keyed by the id the transport mints. */
const sessions = new Map();
/** Issued authorization codes, deleted on first use, so a replayed code cannot mint a second token. */
const codes = new Map();
/** Access tokens this probe minted. A token it did not mint is reported as `unknown`, never accepted. */
const tokens = new Map();
/**
 * Registrations, kept for the LOG only. `/token` deliberately does not consult this map: it accepts
 * any `client_id`, which is what lets the "pre-issued client_id against a server without dynamic
 * registration" case be measured without inventing an out-of-band way to hand one out.
 */
const clients = new Map();

const buildServer = () => {
  const server = new McpServer({ name: 'oauth-probe', version: '0.0.1' });
  server.tool(
    'probe_echo',
    'Echoes the text back. Never requires authorization — the keyless half of the surface.',
    { text: z.string() },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );
  server.tool(
    'probe_whoami',
    'Reports who the caller is. Requires authorization — this is the tool whose 401 the probe measures.',
    {},
    async (_args, extra) => ({
      content: [{ type: 'text', text: JSON.stringify({ subject: extra?.authInfo?.subject ?? 'authorized-caller' }) }],
    }),
  );
  return server;
};

const readRaw = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const parseJson = (raw) => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** `application/x-www-form-urlencoded` or JSON — real clients send both to `/token`. */
const parseForm = (raw, contentType) => {
  if (!raw) return {};
  if (String(contentType ?? '').includes('json')) return parseJson(raw) ?? {};
  return Object.fromEntries(new URLSearchParams(raw));
};

const maskSecrets = (params) =>
  Object.fromEntries(
    Object.entries(params).map(([key, value]) =>
      ['code', 'code_verifier', 'refresh_token', 'client_secret', 'token'].includes(key)
        ? [key, `<masked:${String(value).length}>`]
        : [key, value],
    ),
  );

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unauthorized = (req, res, entry, reason) => {
  const challenge = `Bearer realm="proof-oauth-probe", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`;
  entry.probe_verdict = reason;
  json(res, 401, { error: 'unauthorized', error_description: reason }, { 'www-authenticate': challenge });
};

const bearerOf = (req) => {
  const header = req.headers.authorization ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
};

const httpServer = createServer(async (req, res) => {
  const entry = logRequest(req, res); // BEFORE routing: a 404 is an observation, not a silence.
  try {
    await route(req, res, entry);
  } catch (error) {
    // A crash here would be INDISTINGUISHABLE from the finding this probe exists to record: every
    // central verdict is of the form "the client never asked for X" / "then ten minutes of silence",
    // and a dead process produces byte-identical evidence. So the failure is answered, written down
    // under its own key, and the instrument stays up.
    entry.probe_error = String(error?.stack ?? error).slice(0, 500);
    if (!res.headersSent) {
      json(res, 500, { error: 'probe_error' });
    } else {
      // The log line for this request was already serialized on `finish`, so mutating `entry` above
      // reaches nobody — the failure gets its own line instead of vanishing.
      write({ event: 'post_response_error', url: req.url, error: entry.probe_error });
      res.end();
    }
  }
});

const route = async (req, res, entry) => {
  const url = new URL(req.url ?? '/', baseUrl(req));
  const path = url.pathname;

  // ---- Metadata documents -------------------------------------------------------------------
  // Both the path-suffixed and the root form are served, so the LOG shows which one the client
  // reaches for first rather than which one we decided to offer.
  if (req.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
    json(res, 200, protectedResourceMetadata(req));
    return;
  }
  if (req.method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp')) {
    json(res, 200, authorizationServerMetadata(req));
    return;
  }
  // OIDC discovery is deliberately absent: this probe is not an OpenID provider, and a client that
  // falls through to it after the two documents above is telling us something worth recording.

  // ---- Authorization server ------------------------------------------------------------------
  if (path === '/register') {
    if (NO_DCR || req.method !== 'POST') {
      json(res, 404, { error: 'not_found', path });
      return;
    }
    const raw = await readRaw(req);
    const body = parseJson(raw);
    entry.register_body = body ?? raw.slice(0, 4000);
    const clientId = `probe-client-${randomUUID()}`;
    clients.set(clientId, body ?? {});
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: body?.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: body?.response_types ?? ['code'],
      redirect_uris: body?.redirect_uris ?? [],
      client_name: body?.client_name,
      scope: body?.scope,
    });
    return;
  }

  if (path === '/authorize' && req.method === 'GET') {
    const params = Object.fromEntries(url.searchParams);
    entry.authorize_query = params;
    const redirectUri = params.redirect_uri;
    if (!redirectUri) {
      json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is required' });
      return;
    }
    // One button. The consent screen of the real thing is the next task's job; here it exists only
    // so the round trip is driven by a human the way it will be in production.
    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const hidden = Object.entries(params)
      .map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`)
      .join('\n');
    sendHead(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Proof OAuth probe</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:34rem">
<h1>Proof OAuth probe</h1>
<p>Client <code>${escape(params.client_id)}</code> asks for scope <code>${escape(params.scope) || '(none)'}</code>
and will be sent back to <code>${escape(redirectUri)}</code>.</p>
<form method="POST" action="/authorize">${hidden}<button type="submit">Approve</button></form>
</body>`,
    );
    return;
  }

  if (path === '/authorize' && req.method === 'POST') {
    const raw = await readRaw(req);
    const params = parseForm(raw, req.headers['content-type']);
    entry.authorize_approval = params;
    const code = `probe_code_${randomUUID()}`;
    codes.set(code, {
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      scope: params.scope,
      resource: params.resource,
      issued_at: Date.now(),
    });
    const location = new URL(params.redirect_uri);
    location.searchParams.set('code', code);
    if (params.state) location.searchParams.set('state', params.state);
    write({ event: 'code_issued', client_id: params.client_id, redirect_uri: params.redirect_uri, has_state: Boolean(params.state) });
    sendHead(res, 302, { location: location.toString(), 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (path === '/token' && req.method === 'POST') {
    const raw = await readRaw(req);
    const params = parseForm(raw, req.headers['content-type']);
    entry.token_body = maskSecrets(params);
    entry.token_client_auth = req.headers.authorization
      ? 'authorization_header'
      : params.client_secret
        ? 'client_secret_post'
        : params.client_id
          ? 'client_id_only'
          : 'none';

    // Checks NOTHING on purpose — not the refresh token, not the client. It exists only to observe
    // WHETHER a client tries to refresh, and a refusal here would hide that behaviour behind our own
    // validation. A real authorization server must do the opposite (see `h-mcp-oauth-server` SC-7).
    if (params.grant_type === 'refresh_token') {
      const accessToken = `probe_at_${randomUUID()}`;
      tokens.set(accessToken, { client_id: params.client_id, scope: params.scope, refreshed: true });
      json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: `probe_rt_${randomUUID()}` });
      return;
    }

    const record = params.code ? codes.get(params.code) : undefined;
    if (!record) {
      // Either an invented code or a REPLAY of one already spent — single-use is enforced by the
      // delete below, and the distinction is what the log line records.
      entry.probe_verdict = params.code ? 'code_unknown_or_reused' : 'code_missing';
      json(res, 400, { error: 'invalid_grant', error_description: 'authorization code is unknown or already used' });
      return;
    }
    codes.delete(params.code);

    if (record.code_challenge) {
      const expected = base64url(createHash('sha256').update(String(params.code_verifier ?? ''), 'ascii').digest());
      if (record.code_challenge_method !== 'S256' || expected !== record.code_challenge) {
        entry.probe_verdict = 'pkce_mismatch';
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      entry.probe_verdict = 'pkce_ok';
    } else {
      entry.probe_verdict = 'no_pkce_sent';
    }

    if (record.redirect_uri && params.redirect_uri && record.redirect_uri !== params.redirect_uri) {
      entry.probe_verdict = 'redirect_uri_mismatch';
      json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request' });
      return;
    }

    const accessToken = `probe_at_${randomUUID()}`;
    tokens.set(accessToken, { client_id: record.client_id, scope: record.scope, resource: record.resource });
    write({ event: 'token_issued', client_id: record.client_id, scope: record.scope, resource: record.resource });
    json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `probe_rt_${randomUUID()}`,
      scope: record.scope,
    });
    return;
  }

  if (path === '/revoke' && req.method === 'POST') {
    const raw = await readRaw(req);
    const params = parseForm(raw, req.headers['content-type']);
    entry.revoke_body = maskSecrets(params);
    if (params.token) tokens.delete(params.token);
    json(res, 200, {});
    return;
  }

  // ---- Resource ------------------------------------------------------------------------------
  if (path !== '/mcp') {
    json(res, 404, { error: 'not_found', path });
    return;
  }

  const bearer = bearerOf(req);
  const authorized = bearer ? tokens.has(bearer) : false;
  entry.bearer = bearer ? (authorized ? '<valid>' : '<unknown>') : undefined;

  if (MODE === 'always-401' && !authorized) {
    unauthorized(req, res, entry, 'authorization required for every request in --mode always-401');
    return;
  }

  const raw = req.method === 'POST' ? await readRaw(req) : '';
  const body = parseJson(raw);
  const messages = Array.isArray(body) ? body : body ? [body] : [];
  entry.rpc = messages.map((m) => m?.method).filter(Boolean).join(',') || undefined;
  entry.rpc_tool = messages.map((m) => m?.params?.name).filter(Boolean).join(',') || undefined;

  // The candidate shape under measurement: anonymous `initialize` and `tools/list` pass, and the
  // 401 lands on the tool that needs an account. A client that never replays this call cannot be
  // given a keyed surface behind an anonymous connection.
  const wantsKeyedTool = messages.some((m) => m?.method === 'tools/call' && m?.params?.name === 'probe_whoami');
  if (wantsKeyedTool && !authorized) {
    unauthorized(req, res, entry, 'probe_whoami requires an account');
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(req, res, body);
    return;
  }

  if (req.method !== 'POST') {
    json(res, 400, { error: 'no_session' });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
      write({ event: 'session_initialized', session: id });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, body);
};

// Same reasoning as the handler's own catch, one level up: an unhandled failure anywhere must leave
// a line in the log rather than a silence that reads like a client saying nothing.
process.on('uncaughtException', (error) => write({ event: 'uncaught_exception', error: String(error?.stack ?? error).slice(0, 500) }));
process.on('unhandledRejection', (reason) => write({ event: 'unhandled_rejection', error: String(reason).slice(0, 500) }));

httpServer.listen(PORT, HOST, () => {
  // The ACTUAL port, not the requested one: `--port 0` asks the OS for a free port, which is how
  // the drift suite starts this probe without racing whatever else is listening on the machine.
  const port = httpServer.address().port;
  process.stdout.write(`listening on ${port}\n`);
  write({ event: 'listening', port, host: HOST, mode: MODE, dcr: !NO_DCR, omitted_fields: [...OMITTED] });
});
