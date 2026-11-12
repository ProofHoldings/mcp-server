import { describe, it, expect, vi, afterEach } from 'vitest';

import { apiErrorResult, UNLISTED_TARGETS_RULE } from '../src/types.js';
import { HttpClient, type ApiError } from '../src/http.js';

/**
 * AX bar (coordinator, 11 Nov): an error an agent can hit names the next step or tool. Two API refusals
 * carried no such step — the step-up (`2fa_required`) and the missing scope (`insufficient_scope`) — so
 * the agent had a code and a sentence about what failed but not what to do.
 */
const textOf = (result: { content: Array<{ text: string }> }) => (JSON.parse(result.content[0].text) as { message: string }).message;

describe('apiErrorResult names the next step where the API sentence does not', () => {
  it('2fa_required names the step-up tools and the retry', () => {
    const text = textOf(apiErrorResult({ code: '2fa_required', message: '2FA verification required to revoke this proof' }));
    expect(text).toContain('2FA verification required to revoke this proof');
    expect(text).toMatch(/Next: call start_2fa_for_action .*then wait_for_2fa, then call this tool again\./);
    // Codex review: targets only for an action that binds them — passed for an untargeted one
    // (api_key_revoke), the grant is refused at the retry and the caller loops.
    expect(text).not.toMatch(/and as targets the ids this call names/);
    // #772 binds more action types to targets than start_2fa_for_action names (delegation_lifecycle,
    // webhook_write, api_key_revoke/regenerate, phone/email_primary): for those the refusal is the only
    // source of the exact strings, so the step says to copy them instead of "leave out" (coordinator).
    expect(text).toContain(UNLISTED_TARGETS_RULE);
    expect(text).not.toMatch(/only when that action type takes them/);
  });

  it('insufficient_scope says how to get a credential with the scope, on either transport', () => {
    const text = textOf(apiErrorResult({ code: 'insufficient_scope', message: 'This endpoint requires one of the following scopes: proofs:write' }));
    expect(text).toContain('This endpoint requires one of the following scopes: proofs:write');
    expect(text).toContain('Next:');
    expect(text).toContain('Authenticate');
    expect(text).toContain('PROOF_API_KEY');
  });

  it('username_requires_brand_domain names the domain tools and keeps unlocks_with', () => {
    const text = textOf(apiErrorResult({
      code: 'username_requires_brand_domain',
      message: "This username reads as Storybook's own.",
      details: { brand: 'Storybook', match_kind: 'brand_token', unlocks_with: 'a checked domain of Storybook' },
    }));
    expect(text).toMatch(/Next: .*start_user_domain_verification.*check_user_domain_verification.*claim_username again\./);
    expect(text).toContain('a checked domain of Storybook');
  });

  it('adds nothing to a code whose own sentence is the answer (control)', () => {
    const text = textOf(apiErrorResult({ code: 'balance_empty', message: 'Top up to continue.' }));
    expect(text).toBe('Top up to continue.');
  });
});

describe('a refusal with no JSON body says in words whether it is temporary', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function errorFor(status: number): Promise<ApiError> {
    globalThis.fetch = vi.fn(async () => new Response('<html>Bad gateway</html>', { status, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    const client = new HttpClient({ apiKey: 'pk_test_abc123', baseUrl: 'https://api.proof.holdings', timeout: 5000, maxRetries: 0 });
    try {
      await client.get('/api/v1/proofs/x/status');
    } catch (e) {
      return e as ApiError;
    }
    throw new Error('expected a refusal');
  }

  it('a 5xx is called temporary, with the retry', async () => {
    const e = await errorFor(502);
    expect(e.code).toBe('http_502');
    expect(e.message).toMatch(/temporary/i);
    expect(e.message).toMatch(/retry/i);
  });

  it('a 4xx is not called temporary (control)', async () => {
    const e = await errorFor(404);
    expect(e.message).not.toMatch(/temporary/i);
  });
});
