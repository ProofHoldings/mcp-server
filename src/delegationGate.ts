import { readFileSync } from 'node:fs';

import { installProofHoldings } from '@proof-holdings/delegation-self-refusal';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Our own Proof of Delegation gate (m-delegation-publish-registries B.7): mcp-server and the hosted
 * MCP refuse every tool call once THEIR delegation is revoked, suspended or expired, and pick a
 * renewed one up themselves (`@proof-holdings/delegation-self-refusal`, contract
 * `docs/mcp-delegation-gate-contract.md`).
 *
 * The gate always checks against the ISSUER's API, never `PROOF_BASE_URL`: the token was issued by
 * production, and a server pointed at staging must not be refused for asking the wrong issuer.
 * Nothing it adds is private — the token is the one published on proof.holdings's domain card, and
 * the `proof_holdings_status` tool reports only that delegation's public facts.
 */
export const DELEGATION_META_KEY = 'holdings.proof/delegation';

/**
 * The mcp-server delegation token the package carries in its own `package.json` `_meta` — the copy
 * the npm tarball ships (`scripts/publish-delegation-card.ts --target mcp` writes it). Resolved
 * relative to this module, which is `src/` in the tests and `dist/` when installed: both sit one level
 * below the manifest. Undefined when the manifest carries none, which leaves the server ungated.
 */
export function readOwnDelegationToken(manifestUrl: URL = new URL('../package.json', import.meta.url)): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { _meta?: Record<string, { token?: unknown }> };
    const token = manifest._meta?.[DELEGATION_META_KEY]?.token;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Gates `server` on `token`; a missing or empty token installs nothing. */
export function installDelegationGate(server: McpServer, token: string | undefined): boolean {
  if (!token) return false;
  installProofHoldings(server as unknown as Parameters<typeof installProofHoldings>[0], { token });
  return true;
}
