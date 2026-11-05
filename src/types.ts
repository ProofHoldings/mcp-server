import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { boundText } from './validationRewrite.js';

export type ToolRegistrar = McpServer['tool'];

export const credentialsSchema = z
  .record(z.string(), z.string().max(2000))
  .refine((obj) => Object.keys(obj).length <= 20, {
    message: 'Too many credential fields (max 20)',
  })
  .describe('Provider-specific credential key-value pairs');

/** Canonical BSUID regex — must match src/utils/hitl-crypto.ts BSUID_REGEX */
export const BSUID_REGEX = /^[A-Z]{2}\.[a-zA-Z0-9]{10,140}$/;

/** Canonical asset-type enum — must match src/middleware/validate.ts verificationTypeSchema */
export const VERIFICATION_TYPE_VALUES = [
  'phone', 'email', 'domain', 'social', 'wallet', 'account', 'telegram_bot',
] as const;

/** Canonical channel enum — must match src/middleware/validate.ts verificationChannelSchema */
export const VERIFICATION_CHANNEL_VALUES = [
  'whatsapp', 'telegram', 'sms',
  'email',
  'dns', 'http', 'auto',
  'github', 'google', 'facebook', 'x', 'linkedin', 'instagram', 'youtube', 'tiktok',
  'ethereum', 'solana', 'bitcoin',
  'coinbase', 'kraken',
  'telegram_bot_token',
] as const;

/**
 * The channels a verification can be completed on today — the `live` ones in the API's
 * src/config/channelAvailability.ts, held equal by src/__tests__/drift/mcp-user-request-contract.test.ts.
 * A planned channel is refused 400 `channel_not_available`, so a tool offering it offers a call that fails.
 */
export const LIVE_CHANNEL_VALUES = [
  'whatsapp', 'telegram', 'sms',
  'email',
  'dns', 'http', 'auto',
  'telegram_bot_token',
] as const;

export const ERROR_MESSAGE_MAX_CHARS = 1000;

export const ENVELOPE_RETRYABLE: Readonly<Record<string, boolean>> = {
  invalid_arguments: false,
  internal_error: false,
  not_found: false,
  unauthorized: false,
  '2fa_required': false,
  rate_limited: false,
  timeout: true,
  network_error: true,
  service_unavailable: true,
  rate_limit_exceeded: true,
  http_429: true,
  http_502: true,
  http_503: true,
  http_504: true,
  artifact_claim_busy: true,
  artifact_claim_unavailable: true,
  audit_unavailable: true,
  decline_check_unavailable: true,
  delegation_status_unavailable: true,
  domain_proof_status_unavailable: true,
  domain_renewal_unavailable: true,
  eligibility_unavailable: true,
  export_unavailable: true,
  identity_check_unavailable: true,
  jwks_unavailable: true,
  key_release_unavailable: true,
  proof_issuance_unavailable: true,
  proof_revocation_failed: true,
  resend_too_soon: true,
  resend_unavailable: true,
  send_material_unavailable: true,
  server_busy: true,
  session_binding_unavailable: true,
  session_not_revoked: true,
  session_renewal_unavailable: true,
  sessions_not_ended: true,
  signing_unavailable: true,
  status_list_unavailable: true,
  twofa_unavailable: true,
  verification_unavailable: true,
  webhook_enqueue_failed: true,
  webhook_settings_changing: true,
  auth_lockout: false,
  export_rate_limited: false,
  identity_declined: false,
  identity_rate_limited: false,
  session_locked: false,
  too_many_attempts: false,
  too_many_pending_requests: false,
  transfer_limit_exceeded: false,
  too_many_connections: false,
  authorization_unavailable: false,
  challenge_delivery_failed: false,
  billing_unavailable: false,
  email_service_unavailable: false,
  sse_disabled: false,
  webhook_secret_not_configured: false,
  webhook_verification_unavailable: false,
};

const CODE_PREFIX = /^([a-z0-9][a-z0-9_]*): ([\s\S]*)$/;
const VALIDATION_PREFIX = /^MCP error -32602: ?/;

export interface ErrorEnvelope {
  error: string;
  message: string;
  retryable: boolean;
}

export function errorEnvelope(text: string): ErrorEnvelope {
  if (VALIDATION_PREFIX.test(text)) {
    return {
      error: 'invalid_arguments',
      message: boundText(text.replace(VALIDATION_PREFIX, ''), ERROR_MESSAGE_MAX_CHARS),
      retryable: false,
    };
  }
  const match = CODE_PREFIX.exec(text);
  if (!match) {
    return { error: 'internal_error', message: boundText(text, ERROR_MESSAGE_MAX_CHARS), retryable: false };
  }
  const code = match[1];
  return {
    error: code,
    message: boundText(match[2], ERROR_MESSAGE_MAX_CHARS),
    retryable: Object.hasOwn(ENVELOPE_RETRYABLE, code) ? ENVELOPE_RETRYABLE[code] : false,
  };
}

/**
 * A tool's successful result: the body as compact JSON text, and the same body as `structuredContent`
 * for the tool's declared `outputSchema` (`m-mcp-tool-output-schemas`). The SDK refuses a result
 * with no `structuredContent` from a tool that declares a schema, so every object body carries it.
 */
export function jsonResult(data: unknown) {
  const text = { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? { ...text, structuredContent: data as Record<string, unknown> }
    : text;
}

export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(errorEnvelope(message)) }],
    isError: true,
  };
}

/**
 * Default `timeout_seconds` for every tool that waits through `pollUntilTerminal`.
 *
 * Under a minute on purpose: the MCP SDK's default request timeout is 60 s
 * (`DEFAULT_REQUEST_TIMEOUT_MSEC`), and this server sends no progress notification that could
 * extend it, so a wait longer than that is cut off by the CLIENT while the server is still polling —
 * `MCP error -32001: Request timed out`, measured live with the old default of 120 s while a human
 * was scanning the QR code. The 10-minute figure in docs/POLLING_CONTRACT.md is for SDK waits that
 * own their own clock; a tool call does not. Callers may still pass a longer value if their client
 * allows it, and on timeout the tool answers "pending — call again" rather than an error.
 */
export const WAIT_DEFAULT_SECONDS = 50;

/**
 * Carried by every description that hands a person a challenge to act on (W7, walkthrough
 * 2026-10-02). A tool result reaches the model, not the human — Claude Code folds it away — so an
 * agent that "presented" a link through `render_auth_link` and then waited left the person staring
 * at "sending the link…" until the session expired. `tool-descriptions.test.ts` derives who must
 * carry this from the descriptions themselves.
 */
export const CHALLENGE_IN_REPLY =
  "The user does not see tool results — most clients fold them away, render_auth_link's output included. " +
  'Before you wait or poll, put what the user must act on into your own reply text: the link itself (not a ' +
  'sentence announcing it), the SMS text and number, or a note to check their inbox.';

/**
 * The waiting side of `CHALLENGE_IN_REPLY`. Conditional, because the same waits also serve
 * challenges this agent never showed (a verification created elsewhere, a status check).
 */
export const WAIT_AFTER_REPLY =
  'Before calling this for a challenge you created, make sure your reply text already shows the user what to ' +
  'act on — the link itself, the SMS text and number, or a note to check their inbox; a link that appeared ' +
  'only in a tool result is one they never saw.';

// Polling contract: docs/POLLING_CONTRACT.md
const POLL_INITIAL_INTERVAL_MS = 2000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_MAX_INTERVAL_MS = 30_000;
const POLL_JITTER_MAX_MS = 500;
const POLL_ERROR_BACKOFF_FACTOR = 2;

/** Returned by `withinBudget` when the wait ran out before the poll answered. */
const POLL_BUDGET_SPENT = Symbol('poll budget spent');

/**
 * Bound ONE poll by what is left of the wait.
 *
 * Without this the budget governed only when a new ITERATION may begin. The request started inside
 * the last permitted iteration was bounded by `HttpClient`'s own 30 s timeout instead, so against a
 * degraded API a 50 s wait could answer at ~71 s — past the 60 s at which the CLIENT kills the call
 * with `MCP error -32001: Request timed out`, which is the exact failure this whole task exists to
 * remove. The abandoned request is not cancelled here (the fetch fn is an opaque closure); the HTTP
 * client's own AbortController still ends it, and its rejection is swallowed so it cannot surface
 * later as an unhandled rejection with nobody listening.
 */
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<T | typeof POLL_BUDGET_SPENT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<typeof POLL_BUDGET_SPENT>((resolve) => {
        timer = setTimeout(() => resolve(POLL_BUDGET_SPENT), Math.max(0, remainingMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fields of the pending envelope `pollUntilTerminal` answers on timeout, named here beside the
 * code that builds it. Every `wait_for_*` tool's output schema carries them (descriptions only, like
 * the rest of a described schema), merged in by `outputSchemaFor` in `./output-schema.ts`.
 */
export const TIMEOUT_ENVELOPE_PROPERTIES: Record<string, { description: string }> = {
  status: { description: '"pending" when the wait ran out before a terminal state; otherwise the resource\'s own status' },
  last_status: { description: 'On timeout: the last non-terminal status observed, or null when none was' },
  waited_seconds: { description: 'On timeout: seconds actually waited' },
  timeout_seconds: { description: 'On timeout: the wait budget this call was given' },
  message: { description: 'On timeout: what to do next (call the tool again with the same identifier)' },
};

export async function pollUntilTerminal(
  fetch: () => Promise<Record<string, unknown>>,
  terminalStatuses: string[],
  timeoutSeconds: number,
  label: string,
) {
  const timeoutMs = timeoutSeconds * 1000;
  const start = Date.now();
  let interval = POLL_INITIAL_INTERVAL_MS;
  let lastStatus: string | null = null;

  while (Date.now() - start < timeoutMs) {
    let polled: Record<string, unknown> | typeof POLL_BUDGET_SPENT;

    try {
      polled = await withinBudget(fetch(), timeoutMs - (Date.now() - start));
    } catch (e: unknown) {
      const statusCode = (e as { statusCode?: number }).statusCode;
      if (statusCode === 429 || (statusCode && statusCode >= 500)) {
        interval = Math.min(interval * POLL_ERROR_BACKOFF_FACTOR, POLL_MAX_INTERVAL_MS);
        const jitter = Math.random() * POLL_JITTER_MAX_MS;
        if (Date.now() - start + interval + jitter >= timeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, interval + jitter));
        continue;
      }
      throw e;
    }

    if (polled === POLL_BUDGET_SPENT) break;
    const result = polled;

    const status = result.status as string | undefined;
    if (status && terminalStatuses.includes(status)) {
      return jsonResult(result);
    }
    if (status) lastStatus = status;

    const jitter = Math.random() * POLL_JITTER_MAX_MS;
    if (Date.now() - start + interval + jitter >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, interval + jitter));
    interval = Math.min(interval * POLL_BACKOFF_FACTOR, POLL_MAX_INTERVAL_MS);
  }
  // "Not yet" is not a failure: the human may still be finishing the step. An `isError` here made
  // agents report the login as failed and stop; a pending status is what makes them poll again.
  //
  // `status` describes the WAIT, `last_status` the RESOURCE — they are not the same fact. For most
  // of these tools the two coincide, but a verification request has two non-terminal statuses, so a
  // flat `pending` there would overwrite a real `partial` with a different, also-real value and
  // invite an agent to re-drive a flow that is already half done. It is the last NON-TERMINAL
  // status actually seen — a terminal one returns above and never reaches here — and null when no
  // poll ever returned one at all (every attempt hit a retryable error, or every body arrived
  // without a `status`). Inventing a value for that case would be the same defect twice.
  //
  // `waited_seconds` is what ELAPSED, `timeout_seconds` the budget it was given. They are usually
  // different: the loop breaks as soon as the NEXT interval would overrun, so a 50 s budget stops
  // waiting at about 42 s. Reporting the budget under a name that says "waited" is the same
  // substitution of the subject of the report for the subject of the measurement that this whole
  // envelope exists to undo, and an agent pacing its retries off that field would be ~17% out.
  const waitedSeconds = Math.round((Date.now() - start) / 1000);
  return jsonResult({
    status: 'pending',
    last_status: lastStatus,
    waited_seconds: waitedSeconds,
    timeout_seconds: timeoutSeconds,
    message:
      `${label} has not reached a terminal state after ${waitedSeconds} seconds and is still running ` +
      `(last observed status: ${lastStatus ?? 'unknown'}) — call this tool again with the same identifier to keep waiting.`,
  });
}
