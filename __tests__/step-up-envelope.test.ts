import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { apiErrorResult, errorResult, ENVELOPE_RETRYABLE, ERROR_MESSAGE_MAX_CHARS } from '../src/types.js';
import { HttpClient, ApiError } from '../src/http.js';

/**
 * A `2fa_required` refusal's step-up fields reach the agent as KEYS of the error envelope (1.11.0 batch,
 * SC-3; Alex, 12 Nov: "Envelope keys"). The server says `targets` in its own sentence only while the list is
 * short (300 characters); a longer list exists only in the field, and inside `message` the 1000 cut would
 * break it partway through. So the three fields ride beside `error`, `message`, `retryable`, never cut, and
 * the message text stays what 1.10.0 produced for the same body. Every other code keeps exactly three keys.
 */

const THREE = ['error', 'message', 'retryable'];
const envelopeOf = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text) as Record<string, unknown>;

const LONG_TARGETS = Array.from({ length: 25 }, (_, i) => `sha256:${i.toString(16).padStart(64, '0')}`);

function refusalBody(fields: Record<string, unknown>) {
  return { error: { code: '2fa_required', message: '2FA verification required to delete this webhook endpoint.', required_scope: 'webhook_write', ...fields } };
}

describe('HttpClient: a 2fa_required body carries its step-up fields onto ApiError', () => {
  const fetchMock = vi.fn();
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); });

  async function refuse(body: unknown, status = 403): Promise<ApiError> {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    const client = new HttpClient({ apiKey: 'pk_test_x', baseUrl: 'https://api.test', maxRetries: 0 });
    return (await client.del('/api/v1/webhook-endpoints/abc').catch((e: unknown) => e)) as ApiError;
  }

  it('reads action_type, reason and targets', async () => {
    const e = await refuse(refusalBody({ action_type: 'webhook_write', reason: 'target_mismatch', targets: ['act:delete', 'abc'] }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.stepUp).toEqual({ actionType: 'webhook_write', reason: 'target_mismatch', targets: ['act:delete', 'abc'] });
  });

  it.each([
    ['action_type', { reason: 'target_mismatch', targets: ['abc'] }, { reason: 'target_mismatch', targets: ['abc'] }],
    ['reason', { action_type: 'webhook_write', targets: ['abc'] }, { actionType: 'webhook_write', targets: ['abc'] }],
    ['targets', { action_type: 'webhook_write' }, { actionType: 'webhook_write' }],
  ])('leaves out %s when the API did not send it', async (_name, fields, expected) => {
    expect((await refuse(refusalBody(fields))).stepUp).toEqual(expected);
  });

  it('drops a mistyped value rather than passing it on', async () => {
    const e = await refuse(refusalBody({ action_type: 7, reason: { x: 1 }, targets: ['abc', 5] }));
    expect(e.stepUp).toBeUndefined();
    const f = await refuse(refusalBody({ action_type: 'webhook_write', targets: 'abc' }));
    expect(f.stepUp).toEqual({ actionType: 'webhook_write' });
  });

  it('reads nothing for another code, even a body that carries the same names', async () => {
    const e = await refuse({ error: { code: 'owner_session_required', message: 'Sign in.', action_type: 'webhook_write', targets: ['abc'] } });
    expect(e.code).toBe('owner_session_required');
    expect(e.stepUp).toBeUndefined();
  });

  it('end to end: the refusal becomes an envelope with the three keys after the three', async () => {
    const e = await refuse(refusalBody({ action_type: 'webhook_write', reason: 'target_mismatch', targets: ['act:delete', 'abc'] }));
    const env = envelopeOf(apiErrorResult(e));
    expect(Object.keys(env)).toEqual([...THREE, 'action_type', 'reason', 'targets']);
    expect(env).toMatchObject({ error: '2fa_required', retryable: false, action_type: 'webhook_write', reason: 'target_mismatch', targets: ['act:delete', 'abc'] });
  });
});

describe('apiErrorResult: the step-up keys of a 2fa_required envelope', () => {
  const base = { code: '2fa_required', message: '2FA verification required to delete this webhook endpoint.', requestId: 'req_1' };

  it('keeps the message text exactly as it is without the fields', () => {
    const without = envelopeOf(apiErrorResult(base));
    const withFields = envelopeOf(apiErrorResult({ ...base, stepUp: { actionType: 'webhook_write', reason: 'target_mismatch', targets: ['abc'] } }));
    expect(withFields.message).toBe(without.message);
    expect(Object.keys(without)).toEqual(THREE);
  });

  it('puts only the fields the API sent, in the order action_type, reason, targets', () => {
    expect(Object.keys(envelopeOf(apiErrorResult({ ...base, stepUp: { targets: ['abc'], actionType: 'webhook_write' } })))).toEqual([...THREE, 'action_type', 'targets']);
    expect(Object.keys(envelopeOf(apiErrorResult({ ...base, stepUp: { reason: 'target_mismatch' } })))).toEqual([...THREE, 'reason']);
  });

  it('a targets list longer than the message cut arrives whole while the message is cut', () => {
    const longMessage = `2FA verification required to update this webhook endpoint. ${'x'.repeat(1200)}`;
    expect(JSON.stringify(LONG_TARGETS).length).toBeGreaterThan(ERROR_MESSAGE_MAX_CHARS);
    const env = envelopeOf(apiErrorResult({ code: '2fa_required', message: longMessage, stepUp: { actionType: 'webhook_write', targets: LONG_TARGETS } }));
    expect(env.targets).toEqual(LONG_TARGETS);
    expect([...(env.message as string)].length).toBe(ERROR_MESSAGE_MAX_CHARS);
  });
});

/**
 * The codes this client can name, enumerated rather than asserted universally: the retryable table, the
 * codes `http.ts` constructs an `ApiError` with, and every `errorResult('<code>: …')` literal a handler writes.
 * A code found later EXTENDS this list.
 */
function clientCodes(): string[] {
  const codes = new Set<string>(Object.keys(ENVELOPE_RETRYABLE));
  const src = join(__dirname, '..', 'src');
  const files = [src, join(src, 'tools')].flatMap((dir) =>
    readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(dir, f), 'utf8')));
  for (const text of files) {
    for (const m of text.matchAll(/errorResult\(\s*[`'"]([a-z0-9][a-z0-9_]*): /g)) codes.add(m[1]);
    // `new ApiError(message, code, status, …)`: the code is the literal right before the status number.
    for (const m of text.matchAll(/'([a-z0-9][a-z0-9_]*)',\s*\d{1,3}\s*[,)]/g)) codes.add(m[1]);
  }
  for (const s of [400, 401, 403, 404, 409, 429, 500, 502, 503, 504]) codes.add(`http_${s}`);
  codes.add('2fa_required');
  return [...codes].sort();
}

describe('the envelope shape over every code the client names', () => {
  const codes = clientCodes();
  const stepUp = { actionType: 'webhook_write', reason: 'target_mismatch', targets: ['abc'] };

  it('finds the codes it sweeps (anti-vacuity)', () => {
    expect(codes).toEqual(expect.arrayContaining(['2fa_required', 'api_key_required', 'user_session_required', 'timeout', 'network_error', 'invalid_arguments', 'internal_error']));
    expect(codes.length).toBeGreaterThan(30);
  });

  it.each(codes.filter((c) => c !== '2fa_required'))('%s keeps exactly error, message, retryable, even handed step-up fields', (code) => {
    expect(Object.keys(envelopeOf(apiErrorResult({ code, message: 'm', stepUp })))).toEqual(THREE);
    expect(Object.keys(envelopeOf(errorResult(`${code}: m`)))).toEqual(THREE);
  });

  it('2fa_required adds action_type, reason, targets after the three, in that order', () => {
    expect(Object.keys(envelopeOf(apiErrorResult({ code: '2fa_required', message: 'm', stepUp })))).toEqual([...THREE, 'action_type', 'reason', 'targets']);
  });
});
