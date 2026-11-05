import { describe, it, expect, vi, afterEach } from 'vitest';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { installToolCallWrapper, normalizeToolResult, UNEXPECTED_FAILURE } from '../src/toolCallWrapper.js';
import { createProofServer } from '../src/factory.js';
import { ApiError } from '../src/http.js';
import { errorResult, jsonResult } from '../src/types.js';

type Handler = (request: unknown, extra: unknown) => Promise<unknown>;

function stubServer(handlers: unknown): McpServer {
  return { server: { _requestHandlers: handlers } } as unknown as McpServer;
}

function envelope(result: unknown): { error: string; message: string; retryable: boolean } {
  const r = result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  expect(r.isError).toBe(true);
  expect(r.content).toHaveLength(1);
  return JSON.parse(r.content[0].text);
}

const UNEXPECTED = JSON.parse(errorResult(UNEXPECTED_FAILURE).content[0].text);

describe('normalizeToolResult', () => {
  it('rewrites an SDK validation error to invalid_arguments', () => {
    const result = { content: [{ type: 'text', text: 'MCP error -32602: Input validation error: bad id' }], isError: true };

    expect(envelope(normalizeToolResult(result))).toEqual({
      error: 'invalid_arguments',
      message: 'Input validation error: bad id',
      retryable: false,
    });
  });

  it('leaves an envelope error untouched', () => {
    const result = errorResult('not_found: gone');

    expect(normalizeToolResult(result)).toBe(result);
  });

  it('leaves a success untouched, even one whose text is not JSON', () => {
    const json = jsonResult({ ok: true });
    const raw = { content: [{ type: 'text', text: 'https://proof.holdings/x\n```\nQR\n```' }] };

    expect(normalizeToolResult(json)).toBe(json);
    expect(normalizeToolResult(raw)).toBe(raw);
  });

  it.each([
    ['raw thrown text', { content: [{ type: 'text', text: 'Cannot read properties of undefined (reading MARKER)' }], isError: true }],
    ['JSON that is not an envelope', { content: [{ type: 'text', text: '{"error":"x","detail":"MARKER"}' }], isError: true }],
    ['an error with two blocks', { content: [{ type: 'text', text: '{"error":"x","message":"MARKER","retryable":false}' }, { type: 'text', text: 'MARKER' }], isError: true }],
    ['an error with no content', { isError: true }],
  ])('turns %s into internal_error without the original text', (_label, result) => {
    const normalized = normalizeToolResult(result);

    expect(envelope(normalized)).toEqual(UNEXPECTED);
    expect(JSON.stringify(normalized)).not.toContain('MARKER');
  });

  it.each([
    ['a result that fails the output schema', 'Output validation error: Invalid structured content for tool t: MARKER'],
    ['a result missing the structured content its schema needs', 'Output validation error: Tool MARKER has an output schema but no structured content was provided'],
  ])('turns %s into internal_error: the answer is ours, not the caller\'s input', (_label, detail) => {
    const normalized = normalizeToolResult({ content: [{ type: 'text', text: `MCP error -32602: ${detail}` }], isError: true });

    expect(envelope(normalized)).toEqual(UNEXPECTED);
    expect(JSON.stringify(normalized)).not.toContain('MARKER');
  });

  it('names the failure as ours, not the caller\'s', () => {
    expect(UNEXPECTED.error).toBe('internal_error');
    expect(UNEXPECTED.retryable).toBe(false);
  });
});

describe('installToolCallWrapper', () => {
  it('wraps the tools/call entry and normalizes what it returns', async () => {
    const original = vi.fn<Handler>().mockResolvedValue({ content: [{ type: 'text', text: 'MCP error -32602: x' }], isError: true });
    const handlers = new Map<string, Handler>([['tools/call', original]]);

    expect(installToolCallWrapper(stubServer(handlers))).toBe(true);
    const result = await handlers.get('tools/call')!({ method: 'tools/call' }, { signal: 'extra' });

    expect(original).toHaveBeenCalledWith({ method: 'tools/call' }, { signal: 'extra' });
    expect(envelope(result).error).toBe('invalid_arguments');
  });

  it('leaves every other handler alone', () => {
    const list = vi.fn<Handler>();
    const handlers = new Map<string, Handler>([['tools/call', vi.fn<Handler>()], ['tools/list', list]]);

    installToolCallWrapper(stubServer(handlers));

    expect(handlers.get('tools/list')).toBe(list);
  });

  it.each([
    ['no server.server', {} as McpServer],
    ['no _requestHandlers', stubServer(undefined)],
    ['a _requestHandlers that is not a Map', stubServer({ 'tools/call': vi.fn() })],
    ['no tools/call entry', stubServer(new Map([['tools/list', vi.fn()]]))],
    ['a tools/call entry that is not a function', stubServer(new Map([['tools/call', 'nope']]))],
  ])('installs nothing and does not throw with %s', (_label, server) => {
    expect(() => installToolCallWrapper(server)).not.toThrow();
    expect(installToolCallWrapper(server)).toBe(false);
  });

  it('does not wrap twice', async () => {
    const original = vi.fn<Handler>().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const handlers = new Map<string, Handler>([['tools/call', original]]);
    const server = stubServer(handlers);

    expect(installToolCallWrapper(server)).toBe(true);
    const once = handlers.get('tools/call');
    expect(installToolCallWrapper(server)).toBe(false);

    expect(handlers.get('tools/call')).toBe(once);
  });

  it('returns the original result when the transform throws', async () => {
    const hostile = {
      content: [{ type: 'text', text: 'MCP error -32602: x' }],
      get isError(): boolean {
        throw new Error('boom');
      },
    };
    const handlers = new Map<string, Handler>([['tools/call', vi.fn<Handler>().mockResolvedValue(hostile)]]);
    installToolCallWrapper(stubServer(handlers));

    await expect(handlers.get('tools/call')!({}, {})).resolves.toBe(hostile);
  });

  it('lets an error thrown by the SDK handler itself propagate', async () => {
    const thrown = new Error('url elicitation required');
    const handlers = new Map<string, Handler>([['tools/call', vi.fn<Handler>().mockRejectedValue(thrown)]]);
    installToolCallWrapper(stubServer(handlers));

    await expect(handlers.get('tools/call')!({}, {})).rejects.toBe(thrown);
  });
});

describe('against the real SDK', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connected(instance: { server: McpServer }) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.server.connect(serverSide);
    const client = new Client({ name: 'wrapper-test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    return client.callTool({ name, arguments: args });
  }

  it('answers a schema-invalid call with invalid_arguments naming the field', async () => {
    const client = await connected(createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' }));

    const body = envelope(await call(client, 'get_proof_status', {}));

    expect(body.error).toBe('invalid_arguments');
    expect(body.retryable).toBe(false);
    expect(body.message).toMatch(/\bat id\b/);
    expect(body.message).not.toContain('MCP error');
  });

  it('answers an unknown tool with invalid_arguments', async () => {
    const client = await connected(createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' }));

    const body = envelope(await call(client, 'no_such_tool', {}));

    expect(body.error).toBe('invalid_arguments');
    expect(body.message).toContain('no_such_tool');
  });

  it('answers a handler that throws a plain Error with internal_error and without its text', async () => {
    const instance = createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' });
    vi.spyOn(instance.http, 'get').mockRejectedValue(new Error('MARKER_secret_path /etc/passwd'));
    const client = await connected(instance);

    const result = await call(client, 'get_proof_status', { id: 'ph_ctl_x' });

    expect(envelope(result)).toEqual(UNEXPECTED);
    expect(JSON.stringify(result)).not.toContain('MARKER');
  });

  it('keeps an API error\'s own code', async () => {
    const instance = createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' });
    vi.spyOn(instance.http, 'get').mockRejectedValue(new ApiError('Proof not found', 'not_found', 404));
    const client = await connected(instance);

    expect(envelope(await call(client, 'get_proof_status', { id: 'ph_ctl_x' }))).toEqual({
      error: 'not_found',
      message: 'Proof not found',
      retryable: false,
    });
  });

  it('returns a success as compact JSON', async () => {
    const instance = createProofServer({ apiKey: 'pk_test', baseUrl: 'https://api.proof.holdings' });
    vi.spyOn(instance.http, 'get').mockResolvedValue({ status: 'active', id: 'ph_ctl_x' });
    const client = await connected(instance);

    const result = (await call(client, 'get_proof_status', { id: 'ph_ctl_x' })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('{"status":"active","id":"ph_ctl_x"}');
  });

  it('answers a result that fails its own output schema with internal_error, not invalid_arguments', async () => {
    const server = new McpServer({ name: 'drifted', version: '0.0.0' });
    server.registerTool(
      'drifted',
      { description: 'answers what its schema forbids', outputSchema: z.object({ scope: z.array(z.string()) }) },
      async () => jsonResult({ other: 1 }),
    );
    installToolCallWrapper(server);
    const client = await connected({ server });

    expect(envelope(await call(client, 'drifted', {}))).toEqual(UNEXPECTED);
  });

  it('answers a disabled tool with invalid_arguments', async () => {
    const server = new McpServer({ name: 'disabled', version: '0.0.0' });
    const registered = server.tool('switched_off', 'off', {}, async () => jsonResult({}));
    registered.disable();
    installToolCallWrapper(server);
    const client = await connected({ server });

    const body = envelope(await call(client, 'switched_off', {}));

    expect(body.error).toBe('invalid_arguments');
    expect(body.message).toContain('switched_off');
  });

  it('is what turns the SDK text into the envelope: a bare McpServer still leaks it', async () => {
    const bare = new McpServer({ name: 'bare', version: '0.0.0' });
    bare.tool('needs_id', 'needs an id', { id: z.string() }, async () => jsonResult({}));
    const client = await connected({ server: bare });

    const result = (await call(client, 'needs_id', {})) as { content: Array<{ text: string }> };

    expect(result.content[0].text).toMatch(/^MCP error -32602: /);
  });
});
