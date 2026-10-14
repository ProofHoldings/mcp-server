#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { LOGIN_COMMAND, defaultCredentialsPath, resolveApiKey } from './credentials.js';
import { createProofServer } from './factory.js';

const BASE_URL = process.env.PROOF_BASE_URL ?? 'https://api.proof.holdings';

// `proof-mcp login | logout | status` run their command and exit (src/cli.ts). Only these three
// words dispatch: anything else — no argument, or one an MCP client happens to pass — starts the
// server exactly as before, and the command module is never loaded on that path.
const COMMANDS = new Set(['login', 'logout', 'status']);
const command = process.argv[2];
if (command !== undefined && COMMANDS.has(command)) {
  const { runCommand } = await import('./cli.js');
  const exitCode = await runCommand(command, process.argv.slice(3), { baseUrl: BASE_URL, envKey: process.env.PROOF_API_KEY });
  // process.exit drops writes still queued on a PIPE; let both streams drain first.
  await Promise.all([process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write('', () => resolve()))));
  process.exit(exitCode);
}

// PROOF_API_KEY wins; otherwise the key `proof-mcp login` saved for THIS base URL (never one saved
// for another API). A broken credentials file is a notice, never a failed start.
const resolved = resolveApiKey({ envKey: process.env.PROOF_API_KEY, baseUrl: BASE_URL, file: defaultCredentialsPath() });
if (resolved.notice) console.error(resolved.notice);
if (resolved.source === 'file') {
  console.error(`Using the API key saved by ${LOGIN_COMMAND} for ${BASE_URL} (key ${resolved.entry?.key_id}).`);
}
const API_KEY = resolved.apiKey;

// PUBLIC MODE: no key is required to START. The bootstrap surface (create_account, start_login and
// their polls) and the public verification surface (validate_proof, list_revoked_proofs,
// verify_delegation*) work with no credential; every other tool answers `api_key_required` from
// HttpClient. Exiting here instead would make trying Proof impossible without an account already
// in hand, which is the precondition both the publisher showcase and the remote server need.
if (!API_KEY) {
  console.error('Notice: no API key (PROOF_API_KEY is not set and no login is saved for this API) — starting in public mode.');
  console.error('Account-bootstrap, login and public verification tools work; the rest ask for a key.');
  console.error(`To sign in, run \`${LOGIN_COMMAND}\` in a terminal, then restart this server.`);
}

// One server + one HTTP client, built by the SAME factory the remote server calls per connection.
// stdio serves a single user, so one instance for the whole process is correct here.
const { server } = createProofServer({ apiKey: API_KEY, baseUrl: BASE_URL });

// Catch unhandled errors to avoid silent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
