import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ENVELOPE_RETRYABLE, ERROR_MESSAGE_MAX_CHARS, errorResult, jsonResult } from '../src/types.js';
import { ApiError, HttpClient } from '../src/http.js';
import { parseErrorResult } from './integration/helpers/mcp-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../sdks/shared/fixtures/mcp_delegation_gate');
const IN_MONOREPO = fs.existsSync(path.join(HERE, '../../packages/delegation-verifier/package.json'));
const BASE = 'https://api.proof.holdings';

const GATE_ONLY_CASES = new Set([
  'text_message_bounded',
  'text_token_redacted',
  'text_sdk_output_validation_error',
  'text_sdk_output_validation_error_bounded',
]);

interface Fixture {
  cases: Array<{ id: string; kind: string; text: string; expect: unknown }>;
  codes: Record<string, boolean>;
  message_max_chars: number;
}

function fixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8'));
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return result.content[0].text;
}

function envelopeOf(message: string): { error: string; message: string; retryable: boolean } {
  const result = errorResult(message);
  expect(result.isError).toBe(true);
  return JSON.parse(textOf(result));
}

describe('jsonResult', () => {
  it('emits compact JSON', () => {
    const data = { id: 'v_1', nested: { list: [1, 2], flag: true }, note: 'a b' };

    expect(textOf(jsonResult(data))).toBe(JSON.stringify(data));
    expect(textOf(jsonResult(data))).not.toContain('\n');
  });

  it('is not an error result', () => {
    expect('isError' in jsonResult({})).toBe(false);
  });
});

describe('errorResult', () => {
  const textCases = IN_MONOREPO
    ? (fixture('envelope_cases.json').cases as Array<{ id: string; kind: string; text: string; expect: unknown }>)
        .filter((c) => c.kind === 'text')
    : [];

  it.skipIf(!IN_MONOREPO)('the fixture still holds the cases this suite skips, so skipping them is a decision and not a typo', () => {
    const ids = new Set(textCases.map((c) => c.id));
    for (const id of GATE_ONLY_CASES) expect(ids.has(id)).toBe(true);
  });

  it.each(textCases.filter((c) => !GATE_ONLY_CASES.has(c.id)).map((c) => [c.id, c] as const))(
    'matches the contract case %s',
    (_id, c) => {
      expect(envelopeOf(c.text)).toEqual(c.expect);
    },
  );

  it.skipIf(!IN_MONOREPO)('takes retryable from a whitelist equal to the contract fixture', () => {
    expect(ENVELOPE_RETRYABLE).toEqual(fixture('envelope_whitelist.json').codes);
  });

  it('passes a code outside the whitelist through as not retryable', () => {
    expect(envelopeOf('domain_revoking: This domain is being revoked.')).toEqual({
      error: 'domain_revoking',
      message: 'This domain is being revoked.',
      retryable: false,
    });
  });

  it('does not treat an inherited property name as a whitelisted code', () => {
    expect(envelopeOf('constructor: x').retryable).toBe(false);
  });

  it('emits exactly the three envelope fields, compact', () => {
    const text = textOf(errorResult('rate_limited: slow down'));

    expect(text).toBe('{"error":"rate_limited","message":"slow down","retryable":false}');
  });

  describe('the message bound', () => {
    it.skipIf(!IN_MONOREPO)('is wider than the gate bound, because this server writes longer instructions', () => {
      expect(ERROR_MESSAGE_MAX_CHARS).toBe(1000);
      expect(ERROR_MESSAGE_MAX_CHARS).toBeGreaterThan(fixture('constants.json').message_max_chars);
    });

    it('keeps a message of exactly the bound uncut', () => {
      const body = '😀'.repeat(ERROR_MESSAGE_MAX_CHARS);

      expect(envelopeOf(`rate_limited: ${body}`).message).toBe(body);
    });

    it('cuts one code point past the bound to the bound, the last being an ellipsis', () => {
      const body = '😀'.repeat(ERROR_MESSAGE_MAX_CHARS + 1);
      const message = envelopeOf(`rate_limited: ${body}`).message;

      expect([...message]).toHaveLength(ERROR_MESSAGE_MAX_CHARS);
      expect(message.endsWith('…')).toBe(true);
      expect(message.startsWith('😀'.repeat(ERROR_MESSAGE_MAX_CHARS - 1))).toBe(true);
    });

    it('bounds an internal_error text the same way', () => {
      const message = envelopeOf('X'.repeat(ERROR_MESSAGE_MAX_CHARS + 50)).message;

      expect([...message]).toHaveLength(ERROR_MESSAGE_MAX_CHARS);
    });
  });
});

describe('the instructions http.ts writes itself survive the envelope verbatim', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Invalid API key' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function apiErrorOf(promise: Promise<unknown>): Promise<ApiError> {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }

  it.skipIf(!IN_MONOREPO).each([
    ['user_session_required', 'stdio', () => new HttpClient({ apiKey: 'pk_live_ok', baseUrl: BASE, maxRetries: 0 }).get('/api/v1/me/api-keys')],
    ['user_session_required', 'remote', () => new HttpClient({ apiKey: 'pk_live_ok', baseUrl: BASE, maxRetries: 0, remote: true }).get('/api/v1/me/api-keys')],
    ['api_key_required', 'stdio', () => new HttpClient({ baseUrl: BASE, maxRetries: 0 }).get('/api/v1/verifications')],
    ['api_key_required', 'remote', () => new HttpClient({ baseUrl: BASE, maxRetries: 0, remote: true }).get('/api/v1/verifications')],
    ['invalid_api_key', 'stdio', () => new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: BASE, maxRetries: 0 }).get('/api/v1/verifications')],
    ['invalid_api_key', 'remote', () => new HttpClient({ apiKey: 'pk_live_revoked', baseUrl: BASE, maxRetries: 0, remote: true }).get('/api/v1/verifications')],
  ])('%s, %s', async (code, _transport, call) => {
    const error = await apiErrorOf(call());

    expect(error.code).toBe(code);
    expect([...error.message].length).toBeGreaterThan(fixture('constants.json').message_max_chars);
    expect(envelopeOf(`${error.code}: ${error.message}`)).toEqual({
      error: error.code,
      message: error.message,
      retryable: false,
    });
  });
});

describe('parseErrorResult (integration helper)', () => {
  it('returns the parsed envelope', () => {
    expect(parseErrorResult(errorResult('not_found: gone') as never)).toEqual({
      error: 'not_found',
      message: 'gone',
      retryable: false,
    });
  });

  it.each([
    ['plain text', 'not_found: gone'],
    ['JSON that is not an envelope', '{"error":"not_found"}'],
  ])('throws on %s', (_label, text) => {
    expect(() => parseErrorResult({ content: [{ type: 'text', text }], isError: true } as never)).toThrow(
      /Expected an error envelope/,
    );
  });
});
