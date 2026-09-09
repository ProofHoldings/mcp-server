#!/usr/bin/env node
/**
 * SC-1/SC-2 probe: does a real MCP client connect to a REMOTE server with no login at all?
 *
 * Deliberately carries ZERO auth middleware and ZERO OAuth router, though the SDK ships both
 * (`@modelcontextprotocol/sdk/server/auth/*` is not imported anywhere below). Mixing them in would
 * make a failure indistinguishable between "the client refuses to connect anonymously" and "our
 * OAuth is broken" — and telling those two apart is the entire point of this probe.
 *
 * Every inbound request is appended to a JSONL log, INCLUDING the ones this server answers 404 to.
 * A client that demands authorization metadata asks for `/.well-known/oauth-authorization-server`
 * or `/.well-known/oauth-protected-resource` first; those 404s are what distinguishes outcome 2
 * from outcome 1, and their presence in the log is also the evidence that no auth layer was mounted.
 *
 * Usage: node mcp/probe/anon-connect-probe.mjs --port 8931 --log /path/to/probe.jsonl
 */
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg('port', '8931'));
const LOG = arg('log', 'probe.jsonl');
const LABEL = arg('label', 'probe');

const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), label: LABEL, ...entry })}\n`);

/** One transport + one server per MCP session, keyed by the session id the transport mints. */
const sessions = new Map();

const buildServer = () => {
  const server = new McpServer({ name: 'anon-connect-probe', version: '0.0.1' });
  server.tool('probe_echo', 'Echoes the text back. Exists only to prove a tool call reaches the server.', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }));
  return server;
};

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
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

const httpServer = createServer(async (req, res) => {
  const h = req.headers;
  let rpc; // JSON-RPC method name of the request body, filled in once the body is read.

  // Capture the first 400 chars the server writes back, so a 4xx explains ITSELF in the log rather
  // than leaving a bare status to be guessed at later.
  let replied = '';
  // Chunks arrive as Uint8Array, whose String() is a comma-separated list of byte VALUES, not text.
  const asText = (chunk) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  const capture = (chunk) => {
    if (chunk && typeof chunk !== 'function' && replied.length < 400) {
      replied += asText(chunk).slice(0, 400 - replied.length);
    }
  };
  const { write: origWrite, end: origEnd } = res;
  res.write = (chunk, ...rest) => {
    capture(chunk);
    return origWrite.call(res, chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    capture(chunk);
    return origEnd.call(res, chunk, ...rest);
  };

  // One log line per request, written when the response is done so the status is real.
  res.on('finish', () =>
    log({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      rpc,
      accept: h.accept,
      'mcp-session-id': h['mcp-session-id'],
      authorization: h.authorization ? '<present>' : undefined,
      'mcp-protocol-version': h['mcp-protocol-version'],
      'user-agent': h['user-agent'],
      host: h.host,
      origin: h.origin,
      'www-authenticate-sent': res.getHeader('www-authenticate') ?? undefined,
      body_out: res.statusCode >= 400 ? replied : undefined,
    }),
  );

  const path = (req.url ?? '').split('?')[0];
  if (path !== '/mcp') {
    // Everything else — crucially including /.well-known/* — is a plain 404. No auth metadata exists.
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not_found', path }));
    return;
  }

  const body = req.method === 'POST' ? await readBody(req) : undefined;
  rpc = Array.isArray(body) ? body.map((m) => m?.method).join(',') : body?.method;

  const sessionId = h['mcp-session-id'];
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    await existing.handleRequest(req, res, body);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no_session' }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, transport);
      log({ event: 'session_initialized', session: id });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => {
  // The ACTUAL port, not the requested one: `--port 0` asks the OS for a free port, which is how
  // the drift suite starts this probe without racing whatever else is listening on the machine.
  const port = httpServer.address().port;
  process.stdout.write(`listening on ${port}\n`);
  log({ event: 'listening', port });
});
