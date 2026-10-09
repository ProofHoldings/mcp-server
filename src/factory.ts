import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { HttpClient } from './http.js';
import { accessNoticeFor, serverInstructions, type AccessContext } from './authBoundary.js';
import { annotationsFor } from './toolAnnotations.js';

import { registerTools as registerVerifications } from './tools/verifications.js';
import { registerTools as registerVerificationRequests } from './tools/verification-requests.js';
import { registerTools as registerProofs } from './tools/proofs.js';
import { registerTools as registerSessions } from './tools/sessions.js';
import { registerTools as registerAssets } from './tools/assets.js';
import { registerTools as registerAuth } from './tools/auth.js';
import { registerTools as registerSettings } from './tools/settings.js';
import { registerTools as registerTemplates } from './tools/templates.js';
import { registerTools as registerWebhookDeliveries } from './tools/webhook-deliveries.js';
import { registerTools as registerBilling } from './tools/billing.js';
import { registerTools as registerProfiles } from './tools/profiles.js';
import { registerTools as registerEmails } from './tools/emails.js';
import { registerTools as registerPhones } from './tools/phones.js';
import { registerTools as registerApiKeys } from './tools/api-keys.js';
import { registerTools as registerTwofa } from './tools/twofa.js';
import { registerTools as registerDomains } from './tools/domains.js';
import { registerTools as registerDnsCredentials } from './tools/dns-credentials.js';
import { registerTools as registerUserRequests } from './tools/user-requests.js';
import { registerTools as registerUserDomainVerify } from './tools/user-domain-verify.js';
import { registerTools as registerPublicProfiles } from './tools/public-profiles.js';
import { registerTools as registerAuthorizations } from './tools/authorizations.js';
import { registerTools as registerConfirmations } from './tools/confirmations.js';
import { registerTools as registerHitl } from './tools/hitl.js';
import { registerTools as registerHitlKeys } from './tools/hitl-keys.js';
import { registerTools as registerProofMe } from './tools/proof-me.js';
import { registerTools as registerCircles } from './tools/circles.js';
import { registerTools as registerDelegations } from './tools/delegations.js';
import { registerTools as registerDelegationVerify } from './tools/delegation-verify.js';
import { registerTools as registerAuthFlows } from './tools/auth-flows.js';
import { registerTools as registerAccounts } from './tools/accounts.js';
import { registerTools as registerRenderAuthLink } from './tools/render-auth-link.js';

export interface ProofServerOptions {
  /** API key (Bearer). Absent → public mode, exactly as on the stdio path. */
  apiKey?: string;
  baseUrl: string;
  /**
   * Set by the REMOTE entrypoint. The only thing it changes is what a "you need a key" refusal
   * tells the user to do: the stdio instruction (set `PROOF_API_KEY`, restart the server) is
   * impossible on a server run by somebody else.
   */
  remote?: boolean;
}

export interface ProofServerInstance {
  server: McpServer;
  http: HttpClient;
  /** Every tool name registered on `server`, collected by the registrar below as it registers them. */
  toolNames: ReadonlySet<string>;
}

/**
 * Builds one MCP server with its own HTTP client.
 *
 * Why a factory at all (`h-mcp-remote`, SC-4): the stdio entrypoint serves exactly one user, so one
 * `HttpClient` per process is correct there. The remote server serves many, and `HttpClient` keeps
 * `sessionToken` / `refreshToken` as INSTANCE fields written by `captureSetCookie` — sharing one
 * across connections would hand the next user the previous user's logged-in session. So the unit of
 * isolation is the connection, and this function is that unit.
 *
 * The registration list below is the ONLY copy in the package: `server.ts` calls this rather than
 * repeating it. A second copy would work on the day it was written and drift one module at a time
 * afterwards, with both paths green — `__tests__/factory.test.ts` pins both the list's completeness
 * against `src/tools` and the absence of a second copy in `server.ts`.
 */
export function createProofServer(options: ProofServerOptions): ProofServerInstance {
  const http = new HttpClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    remote: options.remote,
    // The client introduces itself in the MCP handshake, after this is built; read its name per call.
    agentName: () => server.server.getClientVersion()?.name,
  });

  const access: AccessContext = { remote: options.remote, hasCredential: Boolean(options.apiKey) };

  const server = new McpServer(
    {
      name: 'proof-holdings',
      // The version every client reads back from `initialize`, and the one a user quotes in a bug
      // report. A LITERAL rather than a read of `mcp/package.json` — a CHOICE, not a constraint;
      // the manifest is reachable from here. What makes the literal safe is the pin below, never
      // that choice. Held equal to the manifest by
      // `src/__tests__/drift/delegation-publication.test.ts` (h-npm-registry-release). If this is
      // ever replaced by a real read, delete the pin in the same change: a pin over a derived
      // value guards nothing.
      version: '1.4.0',
    },
    { instructions: serverInstructions(access) },
  );

  const bound = server.tool.bind(server);
  const toolNames = new Set<string>();

  /**
   * The registrar every module below is handed, wrapping `server.tool` so the access notice is
   * appended in ONE place (`h-fix-mcp-agent-facing-text`, SC-1).
   *
   * Editing 176 descriptions by hand would have put the same sentence in 176 places, drifting one
   * tool at a time, and each copy would have had to know the transport it was registered on —
   * which a description literal cannot. Here the classification in `authBoundary.ts` is read once,
   * beside the connection that determines it. The signature is `server.tool`'s own, and only the
   * description argument is touched: a registration whose second argument is not a string is passed
   * through untouched rather than being coerced, because the SDK accepts several call shapes and a
   * wrapper that assumes one would corrupt the others.
   */
  const tool = ((...args: unknown[]) => {
    const [name, description] = args;
    const registered = (
      typeof name === 'string' && typeof description === 'string'
        ? (bound as (...a: unknown[]) => RegisteredTool)(name, description + accessNoticeFor(name, access), ...args.slice(2))
        : (bound as (...a: unknown[]) => RegisteredTool)(...args)
    );
    // Stamped after registration rather than passed as an argument, so the modules' call shape —
    // which the tool counters and the tests' capture mock both read — stays exactly as it is.
    if (typeof name === 'string') {
      registered.update({ annotations: annotationsFor(name) });
      toolNames.add(name);
    }
    return registered;
  }) as typeof bound;

  registerVerifications(tool, http);
  registerVerificationRequests(tool, http);
  registerProofs(tool, http);
  registerSessions(tool, http);
  registerAssets(tool, http);
  registerAuth(tool, http);
  registerSettings(tool, http);
  registerTemplates(tool, http);
  registerWebhookDeliveries(tool, http);
  registerBilling(tool, http);
  registerProfiles(tool, http);
  registerEmails(tool, http);
  registerPhones(tool, http);
  registerApiKeys(tool, http);
  registerTwofa(tool, http);
  registerDomains(tool, http);
  registerDnsCredentials(tool, http);
  registerUserRequests(tool, http);
  registerUserDomainVerify(tool, http);
  registerPublicProfiles(tool, http);
  registerAuthorizations(tool, http);
  registerConfirmations(tool, http);
  registerHitl(tool, http);
  registerHitlKeys(tool, http);
  registerProofMe(tool, http);
  registerCircles(tool, http);
  registerDelegations(tool, http);
  // Takes the base URL rather than the HTTP client: verifying a third party's delegation runs
  // against PUBLIC surfaces only and carries no API key.
  registerDelegationVerify(tool, { baseUrl: options.baseUrl });
  registerAuthFlows(tool, http);
  registerAccounts(tool, http);
  registerRenderAuthLink(tool);

  return { server, http, toolNames };
}
