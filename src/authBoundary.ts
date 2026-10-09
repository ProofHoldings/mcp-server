/**
 * The boundary between what this server answers with no account and what needs one
 * (`h-mcp-oauth-remote-wiring`).
 *
 * WHY IT LIVES HERE, and not inside a tool handler: the answer to "you need to sign in" is an HTTP
 * 401 carrying `WWW-Authenticate`, and that is what a client's OAuth stack reads. By the time a tool
 * handler runs, the response is already a JSON-RPC result — the same refusal delivered there is
 * text, not a challenge, and every measured client ignores it (`docs/mcp-oauth-client-probe.md`).
 * So the remote server has to classify the message BEFORE handing it to the transport, and this
 * module is the one place that classification is written down.
 *
 * WHERE IT SITS, and why not on `initialize`: the control measurement in the probe put a 401 on the
 * opening handshake and the human saw `Failed to connect — connection timed out after 30000ms`,
 * i.e. a broken connection rather than an invitation to sign in. Anonymous connection is a closed
 * criterion of `h-mcp-remote`, so the 401 lands on the TOOL CALL that needs an account and nowhere
 * else.
 */

/**
 * Tools that work with no credential at all.
 *
 * Derived from `PUBLIC_PATHS` in `./http.js` — the endpoints the HTTP client is allowed to call
 * with no bearer — plus the two tools that never touch our API: `verify_delegation` /
 * `verify_delegations` run `@proof-holdings/delegation-verifier` against an issuer's public
 * surfaces, and `render_auth_link` is local QR generation.
 *
 * `__tests__/auth-boundary.test.ts` compares this list against the tools the factory actually
 * registers, in BOTH directions: a name here that no tool answers to would refuse nothing while
 * reading exactly like a boundary, and anything the server registers that is not here must be
 * refused without a key.
 */
export const KEYLESS_TOOLS: ReadonlySet<string> = new Set([
  // Bootstrap: create an account and sign in, which is how a keyless caller stops being keyless.
  'create_account',
  'send_account_email',
  'wait_for_account_creation',
  'start_login',
  'wait_for_login',
  // Public verification surface: checking somebody else's proof is not an account operation.
  'validate_proof',
  'list_revoked_proofs',
  'verify_delegation',
  'verify_delegations',
  // Local computation, no HTTP at all.
  'render_auth_link',
]);

/**
 * Tools that WORK over a `start_login` session.
 *
 * Their endpoints are the caller's own account records — the paths `SESSION_AUTH_PREFIXES` in
 * `./http.ts` signs with the session token (plus `/api/v1/auth/me`). Every other keyed tool needs
 * the API key the client's Authenticate step grants, and the refusal below tells the caller which
 * side of that line the tool they asked for is on, BEFORE they walk the road. It used to say
 * "call start_login" to everyone; a human did, signed in through Telegram, and was refused again by
 * a second text that finally explained the difference (h-fix-mcp-refusal-roads).
 *
 * Hand-written here because the package cannot read docs/api-map.yaml at runtime, and held equal to
 * the truth in BOTH directions by `src/__tests__/drift/api-parity.test.ts` (`parseMcpSessionTools`
 * joins this set to the map through the paths the client signs) and by `validateMcpSessionToolCoverage`
 * in `scripts/validate-api-map.ts`. `__tests__/auth-boundary.test.ts` keeps it to registered tools
 * and disjoint from `KEYLESS_TOOLS`.
 */
export const SESSION_TOOLS: ReadonlySet<string> = new Set([
  'add_domain',
  'add_verification_provider',
  'cancel_user_request',
  'check_domain_credentials',
  'check_domain_email_status',
  'check_user_domain_verification',
  'claim_request_assets',
  'claim_username',
  'confirm_domain_email_code',
  'connect_cloudflare',
  'connect_dns_provider',
  'connect_godaddy',
  'create_api_key',
  'create_dns_credential',
  'create_user_request',
  'delete_dns_credential',
  'delete_domain',
  'extend_request',
  'get_2fa_status',
  'get_add_email_status',
  'get_add_phone_status',
  'get_api_key_usage',
  'get_current_user',
  'get_dns_providers',
  'get_domain',
  'get_user_domain_verification_status',
  'list_api_keys',
  'list_dns_credentials',
  'list_domains',
  'list_emails',
  'list_incoming_requests',
  'list_my_requests',
  'list_phones',
  'regenerate_api_key',
  'remove_email',
  'remove_phone',
  'resend_domain_email',
  'resend_email_otp',
  'revoke_api_key',
  'set_primary_email',
  'set_primary_phone',
  'setup_domain_email',
  'share_request_email',
  'start_2fa',
  'start_add_email',
  'start_add_phone',
  'start_domain_email_verification',
  'start_user_domain_verification',
  'update_public_proofs',
  'verify_2fa',
  'verify_2fa_magic_link',
  'verify_domain',
  'verify_domain_with_credentials',
  'verify_email_otp',
]);

/**
 * What a caller must do to open a tool, in the two channels a client delivers ANONYMOUSLY and
 * ALWAYS: the descriptions in `tools/list` and the `instructions` of the `initialize` result.
 *
 * WHY THE REFUSAL BELOW IS NOT ENOUGH, measured rather than reasoned. The 401 + `WWW-Authenticate`
 * is correct and stays — it is the entire reason an OAuth-capable client offers to authenticate. But
 * an MCP client raises that 401 as a TRANSPORT error: it throws before the body becomes a tool
 * result, so `authorizationRequiredBody` reaches probes and developers and never reaches the model.
 * On a live Claude Code session that gap was filled by the client's own guess — "the token expired",
 * said about a server that had never been handed a token. Returning the refusal as a plain result
 * instead would fix the reading and break the button (`docs/mcp-oauth-client-probe.md`), so the fact
 * is stated a second time, up front, where it is always readable.
 *
 * ONLY WHILE IT IS TRUE. With a credential in hand every notice would be noise, charged to the
 * agent's context on every `tools/list` for every tool — so a keyed server adds nothing at all.
 */
export interface AccessContext {
  /** The Streamable HTTP entrypoint. Changes the recipe, exactly as it does for `HttpClient`. */
  remote?: boolean;
  /** Whether this server was built with an API key. */
  hasCredential: boolean;
}

/** How to get an account here — the one sentence that differs between the two transports. */
function credentialRecipe(remote: boolean | undefined): string {
  return remote
    ? 'authenticate this client (in Claude Code: /mcp → this server → Authenticate)'
    : "set PROOF_API_KEY in this server's environment and restart it";
}

/**
 * The same recipe as an IMPERATIVE, for the per-tool notice.
 *
 * Separate from the sentence above because every registration outside `KEYLESS_TOOLS` pays for it.
 * Measured on the built server:
 * the full-prose form added 33.8 KB to 41.8 KB of descriptions — it doubled the anonymous
 * `tools/list`, which is the listing this whole epic exists to serve. The recipe survives; the
 * padding does not, and `instructions` carries the long form once.
 */
function shortRecipe(remote: boolean | undefined): string {
  return remote
    ? 'Authenticate this client (Claude Code: /mcp → Authenticate)'
    : 'Set PROOF_API_KEY and restart this server';
}

/**
 * The suffix appended to one tool's description, or `''` when the tool needs nothing.
 *
 * The session/keyed split is the same one `keyless_alternative` makes in the refusal, and it is
 * here for the same reason: telling every refused caller to run `start_login` walked a human
 * through an entire Telegram login and into a SECOND refusal that contradicted the first
 * (`h-fix-mcp-refusal-roads`).
 */
export function accessNoticeFor(tool: string, context: AccessContext): string {
  if (context.hasCredential) return '';
  if (KEYLESS_TOOLS.has(tool)) return '';

  const recipe = shortRecipe(context.remote);
  return SESSION_TOOLS.has(tool)
    ? `\n\nACCESS: needs a Proof account. ${recipe}, or sign in with start_login — a session opens this tool — then call this tool again.`
    : `\n\nACCESS: needs a Proof account. ${recipe}, then call this tool again. start_login does NOT open this tool.`;
}

/**
 * The `instructions` string of the `initialize` result — the one place the whole arrangement can be
 * stated once instead of per tool.
 *
 * Whether a given client actually shows this to its model is NOT assumed here; it is measured on a
 * live client as part of this task, and the per-tool notice above is what carries the fact when the
 * answer is no.
 */
export function serverInstructions(context: AccessContext): string {
  const opening =
    'Proof — identity and control verification (proof.holdings): verification requests across SMS, ' +
    'messenger and biometric channels, human approvals, proof tokens, delegations and public profiles.';

  if (context.hasCredential) {
    return (
      `${opening} This connection is authenticated. Which tools work depends on the SCOPES of the key it ` +
      'carries, not on this server: a tool outside them answers 403 insufficient_scope naming the scope it ' +
      'wanted, which is a different problem from needing an account. A tool that answers user_session_required ' +
      'needs a sign-in session as well as the key: a separate sign-in the user confirms on their phone or ' +
      'email (start_login, then wait_for_login), which opens your own account records (emails, phones, ' +
      "domains, API keys, 2FA, DNS credentials, verification requests, your public profile's username and " +
      'proof list).'
    );
  }

  // DERIVED from the set rather than retyped beside it: the keyless surface has widened three times
  // in this epic, and a prose list would go on claiming an account is needed for a tool that needs
  // none, with every gate green. Nothing hand-written describes the set either — a sentence
  // categorising what these tools "cover" is true of today's ten and silently false of the
  // eleventh, which is the same drift one clause later.
  const keyless = [...KEYLESS_TOOLS].sort().join(', ');

  // The 401 paragraph is REMOTE-ONLY. On stdio there is no HTTP layer to answer 401: the refusal is
  // an `api_key_required` the handler returns as readable text, so an opaque failure there really is
  // a crashed process or a call that outlived the client's timeout. Telling the agent otherwise
  // would hand it a pre-written wrong cause — the same defect as "the token expired".
  const opaqueFailure = context.remote
    ? 'If a tool call fails at the transport with no readable explanation, the usual cause is this server ' +
      'answering 401 to ask for authentication — the refusal carries its reason in a body most clients ' +
      'discard, so no expired token is involved: authenticate, then make the call again. A session left ' +
      'idle for a long time is the other cause: this server drops idle sessions, and the next call on a ' +
      'dropped one needs a reconnect rather than a credential.'
    : 'A tool that needs an account answers a readable `api_key_required` result rather than failing, so ' +
      'an opaque failure here is not a credential problem — it is a crashed server process or a call that ' +
      "outlived your client's request timeout.";

  return [
    `${opening} This connection is ANONYMOUS — nothing has been signed in yet.`,
    `Works right now with no account: ${keyless}.`,
    `Everything else needs a Proof account, and each such tool says so in its own description. Two roads: ${credentialRecipe(
      context.remote,
    )} and then CALL THE TOOL AGAIN — some clients replay it for you, Claude Code does not. That grants an API key, whose SCOPES then decide which tools work (a tool outside them answers 403 insufficient_scope, not a request to sign in). Or call start_login and wait_for_login, which signs ` +
      'in a session that opens only your own account records — emails, phones, domains, API keys, 2FA, DNS ' +
      "credentials, verification requests, your public profile's username and proof list.",
    opaqueFailure,
  ].join('\n\n');
}

/**
 * RFC 9728 — the document our `WWW-Authenticate` names in `resource_metadata`.
 *
 * A DELIBERATE SECOND COPY of `PROTECTED_RESOURCE_METADATA_PATH` in the backend's
 * `src/constants/mcpOauth.ts`. This package is its own build and published separately, so it cannot
 * import from `src/`; the two are held together by text instead —
 * `src/__tests__/drift/mcp-oauth-remote-wiring.test.ts` reads this literal out of this file and
 * compares it with the constant. Rename either side without the other and that suite goes red,
 * which is the only thing standing between "the header points at a document" and "the header points
 * at a 404 while every test is green".
 */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** Absolute address of the protected-resource document for a given API origin. */
export function resourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${PROTECTED_RESOURCE_METADATA_PATH}`;
}

/**
 * The `WWW-Authenticate` value. Form taken from the run that actually worked — all three clients
 * followed `resource_metadata` from this exact shape (`mcp/probe/oauth-probe.mjs`).
 */
export function authorizationChallenge(baseUrl: string): string {
  return `Bearer realm="proof", resource_metadata="${resourceMetadataUrl(baseUrl)}"`;
}

export interface AuthorizationRequiredBody {
  error: 'authorization_required';
  error_description: string;
  /**
   * `GET /api/v1/mcp/connect` — the machine-readable connection document, for the CLIENT. It was
   * called `login_url` until a human opened it in a browser expecting a sign-in page and got raw
   * JSON. There is no page that connects an MCP client: connecting happens inside the client.
   */
  connect_instructions_url: string;
  /**
   * What `start_login` gets this caller — true PER TOOL. For a tool in `SESSION_TOOLS` it is a
   * working road; for any other keyed tool it says so plainly, instead of sending them down it.
   */
  keyless_alternative: string;
}

/**
 * Stands in for the name of a `tools/call` that did not give one. It never matches a real tool, so
 * it cannot collide with `KEYLESS_TOOLS`, and the refusal below recognises it.
 */
export const MALFORMED_TOOL_NAME = '<unnamed>';

/**
 * The refusal for a `tools/call` that named no tool.
 *
 * Its own body because it is its own situation: such a call is classified KEYED (fail-closed), but
 * answering it with "the tool <unnamed> needs a Proof account. Sign in…" would send somebody whose
 * message was malformed off to authenticate, which fixes nothing. The 401 and the challenge stay —
 * the classification is what they follow from — while the words say what is actually wrong.
 */
export function malformedToolCallBody(): { error: 'invalid_request'; error_description: string } {
  return {
    error: 'invalid_request',
    error_description:
      'This tools/call named no tool, so there is nothing to run — and nothing to authorize either. ' +
      'Send params.name with the tool you meant.',
  };
}

/**
 * The human half of the refusal, written for the WORST measured client rather than the best.
 *
 * MCP Inspector replays the call by itself and Claude Desktop does it after one button press, so
 * neither user ever reads this. Claude Code turns toward OAuth, stops before the browser step,
 * needs a separate `claude mcp login`, and does NOT replay the call — for that person this text is
 * the entire instruction, which is why it names the action twice over rather than reporting a
 * state.
 *
 * `connect_instructions_url` is the existing public `GET /api/v1/mcp/connect` (`h-mcp-showcase`) rather than a new
 * address. Nothing here makes a network call: `start_login` would be the more direct link, but it
 * CREATES a login session, so calling it from a 401 handler would hand any anonymous caller a
 * generator of Redis entries. It is named in the text instead, for clients that cannot speak OAuth
 * at all.
 */
export function authorizationRequiredBody(baseUrl: string, tool: string): AuthorizationRequiredBody {
  const sessionReaches = SESSION_TOOLS.has(tool);
  return {
    error: 'authorization_required',
    error_description:
      `The tool "${tool}" needs a Proof account. Sign in, then CALL THE TOOL AGAIN — some clients ` +
      'replay the call for you, Claude Code does not. Connecting happens inside the client; there is ' +
      'no web page for it. In Claude Code: /mcp → this server → Authenticate, or `claude mcp login ' +
      '<server>` in a separate terminal window (it needs an interactive terminal). Then repeat the ' +
      'call yourself.',
    connect_instructions_url: `${baseUrl.replace(/\/+$/, '')}/api/v1/mcp/connect`,
    keyless_alternative: sessionReaches
      ? 'No OAuth support in your client? Call start_login — it returns a sign-in link, and ' +
        'render_auth_link turns that link into a QR code — then wait_for_login. This tool works over ' +
        'that signed-in session.'
      : 'start_login will NOT unlock this tool. A signed-in session covers only your own account ' +
        'records — emails, phones, domains, API keys, 2FA, DNS credentials, verification requests, ' +
        "your public profile's username and proof list. This tool needs the API key that connecting grants.",
  };
}

/**
 * The refusal for a request whose credential does not match the session it names.
 *
 * A separate text because it is a different situation, not a different tool: nothing the caller
 * asked for is wrong, the session id and the token simply belong to two different connections. The
 * challenge beside it is the same, so a client that lost its token still turns toward the
 * authorization server instead of retrying forever.
 */
export function sessionCredentialMismatchBody(): { error: 'authorization_required'; error_description: string } {
  return {
    error: 'authorization_required',
    error_description:
      'This session was opened with a different credential. A session belongs to the token that ' +
      'opened it — reconnect to start a new one rather than reusing this session id.',
  };
}

/** One tool call that needs an account. `malformed` means the call named no tool at all. */
export interface KeyedToolCall {
  name: string;
  malformed: boolean;
}

/**
 * Names of the tool calls in this JSON-RPC message that need an account.
 *
 * FAIL-CLOSED on every axis: a name that is not in `KEYLESS_TOOLS` is keyed, including one that
 * matches no tool at all — a typo must break a tool rather than open a hole. Anything that is not a
 * `tools/call` (the handshake, `tools/list`, notifications, an unparseable body) contributes
 * nothing, because refusing those is the arrangement the probe measured as a broken connection.
 *
 * `registered`, when the caller holds it, is the set of names the session's server answers to. A
 * well-formed name outside it is then skipped rather than keyed, so the SDK refuses it as an unknown
 * tool instead of the caller being sent to sign in over a typo (M9, live review 2026-09-26). That
 * opens nothing — no registered tool answers to such a name — and the typo protection above still
 * holds, since a keyed tool missing from `KEYLESS_TOOLS` is registered and therefore still keyed.
 * One bound, stated rather than implied: the SDK looks the name up in a plain object, so an
 * inherited name (`constructor`, `toString`) resolves to a prototype member, not to nothing, and what
 * refuses it is the SDK's own `enabled` check ("Tool constructor disabled") — a property of the
 * dependency, not of this gate.
 * Without the set (the opening request, before any server exists) the rule stays fully fail-closed.
 */
export function keyedToolsIn(body: unknown, registered?: ReadonlySet<string>): KeyedToolCall[] {
  const messages = Array.isArray(body) ? body : [body];
  const keyed: KeyedToolCall[] = [];

  for (const message of messages) {
    const entry = message as { method?: unknown; params?: { name?: unknown } } | null | undefined;
    if (!entry || typeof entry !== 'object') continue;
    if (entry.method !== 'tools/call') continue;
    const name = entry.params?.name;
    // A `tools/call` whose name is missing or not a string is KEYED, under a placeholder —
    // `continue` would have made a malformed call the one shape that walks past the gate.
    //
    // REACHABLE, and stated so rather than waved away: on the remote transport this classification
    // runs BEFORE the message reaches the SDK, so the SDK's schema never gets to refuse it. Which
    // is why "malformed" is carried as a FLAG rather than inferred later from the placeholder
    // string: a caller may send `params.name: "<unnamed>"`, and deciding at the refusal by
    // comparing strings would answer that caller "this call named no tool" — a sentence about a
    // message they did not send. The decision belongs where the evidence is.
    if (typeof name !== 'string' || !name) {
      keyed.push({ name: MALFORMED_TOOL_NAME, malformed: true });
      continue;
    }
    if (registered && !registered.has(name)) continue;
    if (!KEYLESS_TOOLS.has(name)) keyed.push({ name, malformed: false });
  }

  return keyed;
}
