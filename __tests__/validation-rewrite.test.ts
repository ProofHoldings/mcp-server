import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { rewriteValidationError, VALIDATION_MESSAGE_MAX_CHARS } from '../src/validationRewrite.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../sdks/shared/fixtures/mcp_delegation_gate');
const MODULE = path.join(HERE, '../src/validationRewrite.ts');
const IN_MONOREPO = fs.existsSync(path.join(HERE, '../../packages/delegation-verifier/package.json'));

interface Fixture {
  cases: Array<{ id: string; kind: string; text: string; expect: unknown }>;
  codes: Record<string, boolean>;
  message_max_chars: number;
}

function fixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

function errorText(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

function envelopeOf(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

describe('rewriteValidationError', () => {
  it.skipIf(!IN_MONOREPO)('rewrites the SDK validation error exactly as the contract fixture expects', () => {
    const cases = fixture('envelope_cases.json').cases as Array<{ id: string; text: string; expect: unknown }>;
    const sdkCase = cases.find((c) => c.id === 'text_sdk_validation_error_rewritten');
    expect(sdkCase).toBeDefined();

    const result = rewriteValidationError(errorText(sdkCase!.text));

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(envelopeOf(result)).toEqual(sdkCase!.expect);
  });

  it.skipIf(!IN_MONOREPO)('bounds the detail at the contract message_max_chars, by code point', () => {
    expect(VALIDATION_MESSAGE_MAX_CHARS).toBe(fixture('constants.json').message_max_chars);

    const detail = '😀'.repeat(VALIDATION_MESSAGE_MAX_CHARS + 5);
    const message = (envelopeOf(rewriteValidationError(errorText(`MCP error -32602: ${detail}`))) as { message: string }).message;

    expect([...message]).toHaveLength(VALIDATION_MESSAGE_MAX_CHARS);
    expect(message.endsWith('…')).toBe(true);
  });

  it('keeps a detail of exactly the bound uncut', () => {
    const detail = 'x'.repeat(VALIDATION_MESSAGE_MAX_CHARS);
    const message = (envelopeOf(rewriteValidationError(errorText(`MCP error -32602: ${detail}`))) as { message: string }).message;

    expect(message).toBe(detail);
  });

  it.each([
    ['a non-validation error', errorText('not_found: The request could not be completed.')],
    ['an error that mentions the code later in the text', errorText('internal_error: upstream said MCP error -32602: bad')],
    ['a success result', { content: [{ type: 'text', text: 'MCP error -32602: looks like one' }] }],
    ['a two-block error', { content: [{ type: 'text', text: 'MCP error -32602: x' }, { type: 'text', text: 'y' }], isError: true }],
    ['a non-text block carrying a text field', { content: [{ type: 'resource', text: 'MCP error -32602: x' }], isError: true }],
  ])('returns %s unchanged, as the same object', (_label, result) => {
    expect(rewriteValidationError(result)).toBe(result);
  });

  it.each([[null], [undefined], ['MCP error -32602: x'], [42]])('returns the non-object %s unchanged', (value) => {
    expect(rewriteValidationError(value)).toBe(value);
  });

  it('keeps every other field of the result', () => {
    const result = { ...errorText('MCP error -32602: Input validation error: bad'), _meta: { trace: 't1' } };

    expect(rewriteValidationError(result)._meta).toEqual({ trace: 't1' });
  });

  it('imports nothing, so the gate package can carry it as a lockstep copy', () => {
    const source = fs.readFileSync(MODULE, 'utf-8');

    expect(source).toContain('export function rewriteValidationError');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
