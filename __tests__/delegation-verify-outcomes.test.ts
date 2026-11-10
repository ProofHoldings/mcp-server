/**
 * Exhaustiveness guard for FAILURE_REASON_OUTCOME (h-proof-checker-mcp, SC-4).
 *
 * `Record<FailureReason, FailureOutcome>` already makes an unmapped reason a COMPILE error, but
 * `FailureReason` is a type — erased at runtime — so nothing here can iterate it directly. This
 * reads `packages/delegation-verifier/src/types.ts` as TEXT (the same technique
 * `drift/delegation-pointer-format.test.ts` already uses for a cross-package fact `mcp/` cannot
 * import) and requires every literal in the union to
 * be a mapped key, so a reason added to the shared package later and left unmapped here fails
 * this test — not silently, and not only at compile time for whoever next touches this file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { FailureReason } from '@proof-holdings/delegation-verifier';
import { FAILURE_REASON_OUTCOME, failureOutcome, type FailureOutcome } from '../src/tools/delegation-verify-outcomes.js';

const TYPES_PATH = new URL('../../packages/delegation-verifier/src/types.ts', import.meta.url);

// The verifier's source sits beside this package only in the monorepo; the public mirror
// (ProofHoldings/mcp-server) has none, so the two checks that read it skip there. Keyed on the
// package rather than on `types.ts`, so that inside the monorepo a moved file still fails loudly.
const IN_MONOREPO = existsSync(new URL('../../packages/delegation-verifier/package.json', import.meta.url));

function readFailureReasonUnion(): string[] {
  const source = readFileSync(TYPES_PATH, 'utf-8');
  const match = source.match(/export type FailureReason =\s*([\s\S]*?);/);
  if (!match) {
    throw new Error('FailureReason union not found in delegation-verifier/src/types.ts — has it moved or been renamed?');
  }
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
}

describe('FAILURE_REASON_OUTCOME exhaustiveness', () => {
  it.skipIf(!IN_MONOREPO)('positive control: the source scan actually finds reasons', () => {
    // A regex that stopped matching would make every case below pass vacuously.
    const reasons = readFailureReasonUnion();
    expect(reasons.length).toBeGreaterThan(15);
  });

  it.skipIf(!IN_MONOREPO)('maps every FailureReason declared in the verifier package, and nothing extra', () => {
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

  it('a delegation the issuer reports issued in test mode is confirmed_invalid, not unconfirmed', () => {
    expect(FAILURE_REASON_OUTCOME.test_environment).toBe('confirmed_invalid');
  });
});

describe('failureOutcome — a reason this server does not map yet', () => {
  // A published server resolves the newest verifier its range allows, so a reason added to the
  // package later reaches a map that does not name it; the bucket then comes from the verdict's own
  // `outcome`, never `undefined` (which `verify_delegations`' outputSchema refuses for the whole batch).
  const unmapped = 'a_reason_added_later' as FailureReason;

  it('takes unconfirmed from the verifier when the verifier could not check', () => {
    expect(failureOutcome({ reason: unmapped, outcome: 'unconfirmed' })).toBe('unconfirmed');
  });

  it('takes confirmed_invalid from the verifier when the check completed with a negative verdict', () => {
    expect(failureOutcome({ reason: unmapped, outcome: 'invalid' })).toBe('confirmed_invalid');
  });

  it('reads only the map\'s own entries — a reason named like an Object.prototype member is unmapped', () => {
    expect(failureOutcome({ reason: 'constructor' as FailureReason, outcome: 'invalid' })).toBe('confirmed_invalid');
    expect(failureOutcome({ reason: 'toString' as FailureReason, outcome: 'unconfirmed' })).toBe('unconfirmed');
  });

  it('keeps the local bucket for a mapped reason even where the verifier says otherwise', () => {
    expect(failureOutcome({ reason: 'no_publication', outcome: 'invalid' })).toBe('no_claim_found');
    expect(failureOutcome({ reason: 'multiple_publications', outcome: 'invalid' })).toBe('unconfirmed');
  });
});
