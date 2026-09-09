#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createProofServer } from './factory.js';

const API_KEY = process.env.PROOF_API_KEY;
const BASE_URL = process.env.PROOF_BASE_URL ?? 'https://api.proof.holdings';

// PUBLIC MODE: no key is required to START. The bootstrap surface (create_account, start_login and
// their polls) and the public verification surface (validate_proof, list_revoked_proofs,
// verify_delegation*) work with no credential; every other tool answers `api_key_required` from
// HttpClient. Exiting here instead would make trying Proof impossible without an account already
// in hand, which is the precondition both the publisher showcase and the remote server need.
if (!API_KEY) {
  console.error('Notice: PROOF_API_KEY is not set — starting in public mode.');
  console.error('Account-bootstrap, login and public verification tools work; the rest ask for a key.');
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
