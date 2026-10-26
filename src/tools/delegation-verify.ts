import { z } from 'zod';
import { verifyDelegation, verifyPublishedDelegation } from '@proof-holdings/delegation-verifier';
import type {
  TrustedIssuer,
  VerificationFailure,
  VerifyOptions,
  VerificationResult,
} from '@proof-holdings/delegation-verifier';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
import { FAILURE_REASON_OUTCOME } from './delegation-verify-outcomes.js';

/**
 * The FIRST CONSUMER of the issuer-agnostic reference verifier (m-delegation-verifier-ref).
 *
 * Two things make this tool different from every other tool in this server:
 *
 *   1. It needs no API key. Verifying someone else's delegation is not a customer operation —
 *      it runs entirely against public surfaces (the issuer's JWKS, its status list and its
 *      public token-status endpoint). An agent evaluating a third-party MCP server can call
 *      this before it has an account with anyone.
 *   2. `delegate` AND `expected_principal` are both REQUIRED, and they close two different
 *      attacks. `delegate` is the artifact identity the CALLER resolved — the npm package it
 *      is about to install, the endpoint it is about to call — never a field copied out of the
 *      ARTIFACT being checked, because a published token is a bearer artifact anyone can paste
 *      into their own card, and a name in that artifact's own package.json or manifest is just
 *      as self-declared as one in its card. The comment used to say "the card" alone; a live
 *      agent read `package.json` instead, matched the artifact against itself, and accused a
 *      real publisher of acting without authority. The rule now lives in both tool descriptions
 *      where an agent can actually read it, not only here.
 *
 *      `expected_principal` is the domain the caller expects to stand behind it: an issuer binds
 *      `delegate` to nothing, so ANY domain owner can mint a genuine, signature-valid delegation
 *      naming someone else's package. Without both pins, a `verified: true` here would mean only
 *      "some domain said something about some artifact" — which is what an agent would then act on.
 *
 * The trust policy is stated HERE, explicitly, rather than defaulted inside the library — the
 * library ships with no trust list at all, which is what makes it a verifier rather than a
 * client. This server trusts proof.holdings because it is proof.holdings' own server.
 */

const delegateTypeEnum = z.enum(['url', 'purl']);

function proofHoldingsTrust(baseUrl: string): TrustedIssuer {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    issuer: 'proof.holdings',
    jwksUri: `${origin}/.well-known/jwks.json`,
    // The only PUBLIC surface that resolves the control-proof cascade: a delegation is worth
    // no more than the domain proof under it, and the status list carries each row's own bit.
    statusEndpoint: `${origin}/api/v1/proofs/validate`,
  };
}

export interface DelegationVerifyItem {
  card?: Record<string, unknown>;
  token?: string;
  delegate: { type: 'url' | 'purl'; value: string };
  expected_principal: string;
  required_scopes?: string[];
  check_status?: boolean;
}

/**
 * The single-artifact verification core, factored out so `verify_delegation` (one item) and
 * `verify_delegations` (a batch of up to 50, h-proof-checker-mcp) share exactly one call into
 * the reference verifier. Callers must already have checked `card` XOR `token` — this function
 * does not, so it stays usable per-item inside a batch loop without duplicating that guard.
 */
export function verifyOneDelegation(item: DelegationVerifyItem, baseUrl: string): Promise<VerificationResult> {
  const verifyOptions: VerifyOptions = {
    trustedIssuers: [proofHoldingsTrust(baseUrl)],
    delegate: item.delegate,
    expectedPrincipal: item.expected_principal,
    ...(item.required_scopes ? { requiredScopes: item.required_scopes } : {}),
    statusCheck: item.check_status === false ? 'skip' : 'required',
  };

  return item.card !== undefined
    ? verifyPublishedDelegation(item.card, verifyOptions)
    : verifyDelegation(item.token as string, verifyOptions);
}

/**
 * The key-rotation hints a failure may carry, in this tool's snake_case: where to pull a
 * re-signed token after `key_revoked`, and how stale the key set is after `jwks_stale`.
 */
export function rotationHints(result: VerificationFailure): Record<string, unknown> {
  return {
    ...(result.pullHint && {
      pull_hint: { issuer_origin: result.pullHint.issuerOrigin, handle: result.pullHint.handle },
    }),
    ...(result.cacheAgeSeconds !== undefined && { cache_age_seconds: result.cacheAgeSeconds }),
    ...(result.refreshHint && {
      refresh_hint: { jwks_uri: result.refreshHint.jwksUri, method: result.refreshHint.method },
    }),
  };
}

export function registerTools(tool: ToolRegistrar, options: { baseUrl: string }) {
  tool(
    'verify_delegation',
    "Verify a Proof of Delegation — the attestation that a domain authorized a specific agent artifact. Pass either the artifact's card (MCP server.json / A2A agent card) or a raw delegation token, PLUS two facts you established yourself: the artifact identity you resolved (the package you are installing, the endpoint you are calling) and the domain you expect to stand behind it. Both are required — a token can be copied into someone else's card, and any domain owner can mint a valid delegation naming someone else's package, so a verdict without both pins would mean 'some domain said something about some artifact'. WHERE THE IDENTITY MAY COME FROM: it is the artifact you are acting on, and never a value read from inside the artifact you are checking. A name in the artifact's own package.json, card or manifest is self-declared and editable by whoever ships it, so checking it against the delegation compares the artifact with itself. Resolve it afresh at call time instead of reusing a value from earlier in this conversation, which may already be stale. When no independently resolvable identity exists — a local or unpublished artifact — you have nothing to compare against, and that is the honest answer: report it rather than a mismatch, because a mismatch here reads as an accusation against the domain named in the delegation. The verifier walks signature → principal → delegate → revocation status, including the cascade down to the domain control proof. Requires no API key. What a verified result means: the expected domain's controller authorized this artifact for these scopes — NOT that the artifact is safe, audited or endorsed.",
    {
      card: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The MCP server card or A2A agent card to read the delegation from'),
      token: z.string().optional().describe('A raw delegation token, when you already have it instead of a card'),
      delegate: z
        .object({
          type: delegateTypeEnum.describe('Identifier type: https URL or package URL (purl)'),
          value: z.string().min(1).max(2048).describe('The artifact identifier YOU resolved — never a value read from inside the artifact you are checking, and resolved afresh rather than carried over from earlier in the conversation'),
        })
        .describe('The artifact identity you resolved independently. Required: this comparison is what defeats a copied token.'),
      expected_principal: z
        .string()
        .min(1)
        .max(253)
        .describe(
          'Required. The domain you expect to have authorized this artifact (e.g. postmarkapp.com) — an issuer binds the artifact to nothing, so any domain owner can mint a valid delegation for someone else\'s package. Without this pin the answer is only "some domain claims this".'
        ),
      required_scopes: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(32)
        .optional()
        .describe('Capability scopes the delegation must grant'),
      check_status: z
        .boolean()
        .optional()
        .describe('Default true. When false the signature and claims are checked but revocation is NOT — treat the result as "not revoked-checked", never as "not revoked".'),
    },
    async (args) => {
      const { card, token, delegate, expected_principal, required_scopes, check_status } = args;

      if ((card === undefined) === (token === undefined)) {
        return errorResult('invalid_arguments: supply exactly one of `card` or `token`');
      }

      try {
        const result = await verifyOneDelegation(
          { card, token, delegate, expected_principal, required_scopes, check_status },
          options.baseUrl,
        );

        if (!result.valid) {
          // A verdict, not a transport failure — returned as data so an agent can branch on
          // the reason instead of parsing an error string.
          return jsonResult({
            verified: false,
            reason: result.reason,
            outcome: result.outcome,
            message: result.message,
            ...rotationHints(result),
          });
        }

        return jsonResult({
          verified: true,
          status_checked: result.statusChecked,
          principal_checked: result.principalChecked,
          attests: `${result.delegation.principal} authorized ${result.delegation.delegate} for: ${result.delegation.scope.join(', ')}`,
          delegation: {
            issuer: result.delegation.issuer,
            principal: result.delegation.principal,
            delegate: result.delegation.delegate,
            scope: result.delegation.scope,
            control_proof: result.delegation.controlProof,
            delegation_id: result.delegation.delegationId,
            issued_at: result.delegation.issuedAt.toISOString(),
            expires_at: result.delegation.expiresAt.toISOString(),
          },
          disclaimer:
            'This attests domain authorization of the artifact only. It is not a statement that the artifact is safe, audited or endorsed.',
        });
      } catch (e) {
        return errorResult(`verification_failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const verifyItemSchema = z
    .object({
      card: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The MCP server card or A2A agent card to read the delegation from'),
      token: z.string().optional().describe('A raw delegation token, when you already have it instead of a card'),
      delegate: z
        .object({
          type: delegateTypeEnum.describe('Identifier type: https URL or package URL (purl)'),
          value: z.string().min(1).max(2048).describe('The artifact identifier YOU resolved — never a value read from inside the artifact you are checking, and resolved afresh rather than carried over from earlier in the conversation'),
        })
        .describe('The artifact identity you resolved independently. Required: this comparison is what defeats a copied token.'),
      expected_principal: z
        .string()
        .min(1)
        .max(253)
        .describe(
          'Required. The domain you expect to have authorized this artifact (e.g. postmarkapp.com) — an issuer binds the artifact to nothing, so any domain owner can mint a valid delegation for someone else\'s package. Without this pin the answer is only "some domain claims this".'
        ),
      required_scopes: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(32)
        .optional()
        .describe('Capability scopes the delegation must grant'),
    })
    .refine((item) => (item.card === undefined) !== (item.token === undefined), {
      message: 'each item must supply exactly one of `card` or `token`',
    });

  tool(
    'verify_delegations',
    'Batch-verify up to 50 Proof of Delegation artifacts in one call — the inventory half of the checker (h-proof-checker-mcp): re-check everything you already trust instead of one verify_delegation call per artifact. Each item takes the same shape verify_delegation requires (card XOR token, delegate, expected_principal, optional required_scopes) and follows the same rule about where identity comes from: each `delegate` is the artifact you are acting on, never a value read from inside the artifact you are checking, and resolved afresh at call time. Items are verified INDEPENDENTLY — no cross-item state, nothing persisted, one item failing never affects another item\'s result. This tool does NOT discover what you have installed and does NOT fetch anything on your behalf: it verifies material you already hold, the same trust boundary verify_delegation draws. Revocation is always checked (there is no check_status:false here — the point of a batch re-check is to see what changed since you last looked). Each result carries an `outcome`: confirmed_valid (verified), confirmed_invalid (a genuine negative verdict — revoked, expired, mismatched, malformed, and similar), no_claim_found (the artifact publishes no delegation at all — an absence, never an accusation), or unconfirmed (we could not reach the issuer or otherwise get a confident answer right now — NEVER treat this as a bad verdict). Requires no API key. `checked_at` on each result is the moment THAT item\'s own check completed, not one timestamp shared across the call.',
    {
      items: z.array(verifyItemSchema).min(1).max(50).describe('1-50 artifacts to verify in this call, each shaped like a verify_delegation call'),
    },
    async (args) => {
      const results = await Promise.all(
        args.items.map(async (item) => {
          try {
            const result = await verifyOneDelegation(item, options.baseUrl);
            const checked_at = new Date().toISOString();

            if (result.valid) {
              return {
                outcome: 'confirmed_valid' as const,
                verified: true,
                status_checked: result.statusChecked,
                checked_at,
              };
            }

            return {
              outcome: FAILURE_REASON_OUTCOME[result.reason],
              reason: result.reason,
              message: result.message,
              ...rotationHints(result),
              verified: false,
              checked_at,
            };
          } catch (e) {
            return {
              outcome: 'unconfirmed' as const,
              message: `verification_failed: ${e instanceof Error ? e.message : String(e)}`,
              verified: false,
              checked_at: new Date().toISOString(),
            };
          }
        }),
      );

      return jsonResult({ results });
    },
  );
}
