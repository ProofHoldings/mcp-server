/**
 * Exhaustiveness guard for FAILURE_REASON_OUTCOME (h-proof-checker-mcp, SC-4).
 *
 * `Record<FailureReason, FailureOutcome>` already makes an unmapped reason a COMPILE error, but
 * `FailureReason` is a type — erased at runtime — so nothing here can iterate it directly. This
 * reads `packages/delegation-verifier/src/types.ts` as TEXT (the same technique
 * `drift/delegation-scope-grammar.test.ts` and `drift/delegation-pointer-format.test.ts` already
 * use for a cross-package fact `mcp/` cannot import) and requires every literal in the union to
 * be a mapped key, so a reason added to the shared package later and left unmapped here fails
 * this test — not silently, and not only at compile time for whoever next touches this file.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { FAILURE_REASON_OUTCOME, type FailureOutcome } from '../src/tools/delegation-verify-outcomes.js';

const TYPES_PATH = new URL('../../packages/delegation-verifier/src/types.ts', import.meta.url);

function readFailureReasonUnion(): string[] {
  const source = readFileSync(TYPES_PATH, 'utf-8');
  const match = source.match(/export type FailureReason =\s*([\s\S]*?);/);
  if (!match) {
    throw new Error('FailureReason union not found in delegation-verifier/src/types.ts — has it moved or been renamed?');
  }
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
}

describe('FAILURE_REASON_OUTCOME exhaustiveness', () => {
  it('positive control: the source scan actually finds reasons', () => {
    // A regex that stopped matching would make every case below pass vacuously.
    const reasons = readFailureReasonUnion();
    expect(reasons.length).toBeGreaterThan(15);
  });

  it('maps every FailureReason declared in the verifier package, and nothing extra', () => {
    const reasons = readFailureReasonUnion();
    expect(Object.keys(FAILURE_REASON_OUTCOME).sort()).toEqual([...reasons].sort());
  });

  it('every mapped value is one of the three failure buckets (confirmed_valid is not a FailureReason)', () => {
    const buckets: FailureOutcome[] = ['confirmed_invalid', 'no_claim_found', 'unconfirmed'];
    for (const outcome of Object.values(FAILURE_REASON_OUTCOME)) {
      expect(buckets).toContain(outcome);
    }
  });

  it('the sixth outcome: an unreachable issuer (status_unavailable / jwks_unavailable) is unconfirmed, never confirmed_invalid', () => {
    expect(FAILURE_REASON_OUTCOME.status_unavailable).toBe('unconfirmed');
    expect(FAILURE_REASON_OUTCOME.jwks_unavailable).toBe('unconfirmed');
  });

  it('no_publication is no_claim_found — an absence, never an accusation', () => {
    expect(FAILURE_REASON_OUTCOME.no_publication).toBe('no_claim_found');
  });

  it('a genuine negative verdict (revoked) is confirmed_invalid', () => {
    expect(FAILURE_REASON_OUTCOME.revoked).toBe('confirmed_invalid');
  });

  it('key rotation: a revoked signing key is confirmed_invalid, a stale key set is unconfirmed — two distinct outcomes (h-verifier-jwks-multikey SC-10)', () => {
    expect(FAILURE_REASON_OUTCOME.key_revoked).toBe('confirmed_invalid');
    expect(FAILURE_REASON_OUTCOME.jwks_stale).toBe('unconfirmed');
    expect(FAILURE_REASON_OUTCOME.key_revoked).not.toBe(FAILURE_REASON_OUTCOME.jwks_stale);
  });

  it('key rotation: a key-policy violation is a genuine negative verdict', () => {
    for (const reason of ['wrong_key_purpose', 'outside_key_window', 'token_lifetime_exceeded'] as const) {
      expect(FAILURE_REASON_OUTCOME[reason]).toBe('confirmed_invalid');
    }
  });
});
