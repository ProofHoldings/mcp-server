#!/usr/bin/env node
/**
 * r-mcp-instructions-channel: does the `instructions` field of an `initialize` response reach
 * the model's context? Sets an inert canary string via the McpServer CONSTRUCTOR option (never a
 * write to the private `_instructions` field), so a negative result cannot be confused between
 * "the channel is dead" and "our own write mechanism failed" -- this probe has no write mechanism.
 *
 * Scratch copy for the live-run phase of the research task. Not committed to the repo as-is; the
 * validated version (this file, unchanged apart from import paths) lands under mcp/probe/ together
 * with its drift test as a follow-up task, mirroring anon-connect-probe.mjs / oauth-probe.mjs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export const INSTRUCTIONS_MARKER = 'proof-instructions-channel-canary-4b9e1a7f';

const server = new McpServer({ name: 'instructions-channel-probe', version: '0.0.1' }, { instructions: INSTRUCTIONS_MARKER });

server.tool('probe_noop', 'Does nothing. Exists only so the server exposes at least one tool.', async () => ({
  content: [{ type: 'text', text: 'ok' }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
