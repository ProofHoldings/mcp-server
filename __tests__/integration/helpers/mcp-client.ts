import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const SERVER_PATH = resolve(import.meta.dirname, '../../../dist/server.js');

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

export async function connectClient(): Promise<Client> {
  if (client) return client;

  const apiKey = process.env.PROOF_API_KEY || process.env.TEST_API_KEY;
  if (!apiKey) {
    throw new Error('PROOF_API_KEY or TEST_API_KEY environment variable is required for integration tests');
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PROOF_API_KEY: apiKey,
  };
  if (process.env.PROOF_BASE_URL) {
    env.PROOF_BASE_URL = process.env.PROOF_BASE_URL;
  }

  transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    env,
    stderr: 'pipe',
  });

  client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function disconnectClient(): Promise<void> {
  if (transport) {
    await transport.close();
    transport = null;
  }
  client = null;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const c = await connectClient();
  const result = await c.callTool({ name, arguments: args });
  return result as unknown as ToolResult;
}

export function parseJsonResult(result: ToolResult): unknown {
  expect(result.isError).toBeFalsy();
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text);
}

export interface ErrorEnvelope {
  error: string;
  message: string;
  retryable: boolean;
}

export function parseErrorResult(result: ToolResult): ErrorEnvelope {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  const text = result.content[0].text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const envelope = parsed as Partial<ErrorEnvelope> | null | undefined;
  if (
    !envelope ||
    typeof envelope.error !== 'string' ||
    typeof envelope.message !== 'string' ||
    typeof envelope.retryable !== 'boolean'
  ) {
    throw new Error(`Expected an error envelope, got: ${text}`);
  }
  return envelope as ErrorEnvelope;
}
