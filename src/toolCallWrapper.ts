import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { rewriteValidationError } from './validationRewrite.js';
import { errorResult } from './types.js';

const WRAPPED = Symbol.for('proof-holdings.mcp-server.tools-call-wrapped');

export const UNEXPECTED_FAILURE =
  'internal_error: The tool failed unexpectedly. This is a defect in the Proof MCP server, not a problem with your input.';

const OUTPUT_VALIDATION_PREFIX = /^MCP error -32602: ?Output validation error/;

type Handler = ((request: unknown, extra: unknown) => Promise<unknown>) & { [WRAPPED]?: true };

function isOutputValidationFailure(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true || !Array.isArray(r.content) || r.content.length !== 1) return false;
  const block = r.content[0] as { type?: unknown; text?: unknown } | null;
  return !!block && block.type === 'text' && typeof block.text === 'string' && OUTPUT_VALIDATION_PREFIX.test(block.text);
}

function isEnvelopeResult(result: { content?: unknown }): boolean {
  if (!Array.isArray(result.content) || result.content.length !== 1) return false;
  const block = result.content[0] as { type?: unknown; text?: unknown } | null;
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return false;
  try {
    const parsed = JSON.parse(block.text) as Record<string, unknown> | null;
    return (
      !!parsed &&
      typeof parsed.error === 'string' &&
      typeof parsed.message === 'string' &&
      typeof parsed.retryable === 'boolean'
    );
  } catch {
    return false;
  }
}

export function normalizeToolResult(result: unknown): unknown {
  if (isOutputValidationFailure(result)) return errorResult(UNEXPECTED_FAILURE);
  const rewritten = rewriteValidationError(result);
  if (rewritten !== result) return rewritten;
  if (result === null || typeof result !== 'object') return result;
  const r = result as { isError?: unknown; content?: unknown };
  if (r.isError !== true || isEnvelopeResult(r)) return result;
  return errorResult(UNEXPECTED_FAILURE);
}

export function installToolCallWrapper(server: McpServer): boolean {
  const inner = (server as unknown as { server?: { _requestHandlers?: unknown } }).server;
  const handlers = inner?._requestHandlers;
  if (!(handlers instanceof Map)) return false;
  const original = handlers.get('tools/call') as Handler | undefined;
  if (typeof original !== 'function' || original[WRAPPED]) return false;
  const wrapped: Handler = async (request, extra) => {
    const result = await original(request, extra);
    try {
      return normalizeToolResult(result);
    } catch {
      return result;
    }
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  handlers.set('tools/call', wrapped);
  return true;
}
