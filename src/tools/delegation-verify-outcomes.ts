import { classifyFailureReason, type FailureReason } from '@proof-holdings/delegation-verifier';

/**
 * The batch checker's outcome vocabulary (h-proof-checker-mcp).
 *
 * `confirmed_valid` is not a key of this map — it comes from `VerificationSuccess.valid: true`,
 * never from a `FailureReason`. The three keys below are the only buckets a FAILED verification
 * may land in, and the distinction is the whole point of the task: a checker that renders
 * "could not reach the issuer" the same as "revoked" silently breaks tools belonging to people
 * who have never heard of us.
 *
 * This is a LOCAL map, scoped to this MCP tool. `h-delegation-verifier-status-fallthrough-gate`
 * added the official upstream field this map anticipated (`VerificationFailure.outcome` via
 * `classifyFailureReason`), but that field is BINARY (`invalid` | `unconfirmed`) while this
 * tool's vocabulary is three buckets — `no_claim_found` has no upstream equivalent (the package
 * has no concept of "nothing to check", only "checked and bad" vs "could not check"), and two
 * more reasons (`multiple_publications`, and the two unreachable-in-practice call-shape errors)
 * read differently at this tool's altitude than the package's binary split would give them by
 * default. So the map is not deleted, only DERIVED: every reason not named in `LOCAL_OVERRIDE`
 * below takes its bucket straight from `classifyFailureReason`.
 */
export type FailureOutcome = 'confirmed_invalid' | 'no_claim_found' | 'unconfirmed';

/** Every `FailureReason` the shared package declares today. Kept as an explicit value list
 * (not derived from the type, which is erased at runtime) — the exhaustiveness test in
 * `delegation-verify-outcomes.test.ts` fails loudly if this list drifts from the package. */
const ALL_FAILURE_REASONS: FailureReason[] = [
  'invalid_options',
  'no_trust_policy',
  'malformed_token',
  'untrusted_issuer',
  'unsupported_algorithm',
  'unknown_key',
  'bad_signature',
  'jwks_unavailable',
  'not_a_delegation',
  'unsupported_schema',
  'expired',
  'not_yet_valid',
  'malformed_claims',
  'principal_mismatch',
  'delegate_mismatch',
  'scope_not_granted',
  'status_uri_untrusted',
  'status_unavailable',
  'revoked',
  'suspended',
  'unknown_delegation',
  'no_publication',
  'multiple_publications',
];

/**
 * The reasons whose LOCAL 3-bucket meaning differs from the package's binary
 * `classifyFailureReason` — everything else in `ALL_FAILURE_REASONS` derives straight from it.
 */
const LOCAL_OVERRIDE: Partial<Record<FailureReason, FailureOutcome>> = {
  // The card carries no delegation publication at all — an absence, never an accusation. The
  // package's binary field has no third bucket for this; it isn't a "check" at all.
  no_publication: 'no_claim_found',
  // Ambiguous input (the card names two different publications), not a confirmed-bad artifact —
  // the package's binary split would otherwise bucket it `invalid`, which overstates it.
  multiple_publications: 'unconfirmed',
  // Errors in the CALL itself, not a statement about the artifact. This tool always supplies a
  // well-formed VerifyOptions (non-empty trustedIssuers, delegate required by the Zod schema),
  // so these are unreachable in practice — mapped for exhaustiveness, not because they occur.
  invalid_options: 'unconfirmed',
  no_trust_policy: 'unconfirmed',
};

export const FAILURE_REASON_OUTCOME: Record<FailureReason, FailureOutcome> = Object.fromEntries(
  ALL_FAILURE_REASONS.map((reason) => [
    reason,
    LOCAL_OVERRIDE[reason] ?? (classifyFailureReason(reason) === 'unconfirmed' ? 'unconfirmed' : 'confirmed_invalid'),
  ])
) as Record<FailureReason, FailureOutcome>;
