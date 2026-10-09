# @proof-holdings/mcp-server

MCP (Model Context Protocol) server for the [proof.holdings](https://proof.holdings) API. Exposes 172 tools for AI agents to create verifications, validate proofs, manage assets, and more.

## Two ways to connect

**Hosted — nothing to install.** The same tools are served over HTTP at
`https://api.proof.holdings/mcp`. Any MCP client or agent framework with HTTP transport can
connect — add the URL as a remote MCP server in its settings (the config key varies by client).
Authentication happens in the browser the first time a tool needs an account. As a config fragment:

```json
{ "mcpServers": { "proof": { "type": "http", "url": "https://api.proof.holdings/mcp" } } }
```

⚠️ **Versions before `1.1.0` predate the delegation tools and the keyless public mode** and expose
an older, smaller surface than this README describes. If a client is pinned to `1.0.0`, upgrade it
or use the hosted server above. `GET /api/v1/mcp/connect` always serves the current instructions.

**Local — this package.** Installs and runs as a stdio server:

```bash
npm install -g @proof-holdings/mcp-server
```

Or run directly with npx (no install needed):

```bash
npx @proof-holdings/mcp-server
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROOF_API_KEY` | No | — | API key (`pk_live_...` or `pk_test_...`). Without it the server still starts in **public mode**: the keyless tools (account bootstrap, login, proof and delegation verification) work, and every other tool answers `api_key_required`. |
| `PROOF_BASE_URL` | No | `https://api.proof.holdings` | API base URL |

Get your API key from the [proof.holdings dashboard](https://proof.holdings/dashboard/api-keys).

## Client Setup

Add the following to your MCP client config file:

```json
{
  "mcpServers": {
    "proof-holdings": {
      "command": "npx",
      "args": ["-y", "@proof-holdings/mcp-server"],
      "env": {
        "PROOF_API_KEY": "pk_live_your_key_here"
      }
    }
  }
}
```

Config file location by client:

| Client | Config file |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` in your project root |
| Claude Code | Run `claude mcp add proof-holdings -- npx -y @proof-holdings/mcp-server` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

If installed globally (`npm install -g @proof-holdings/mcp-server`), use `"command": "proof-mcp"` and remove the `"args"` field.

## Tools (172 tools)

Group totals are exact. The tables name the tools you are most likely to reach for rather than all
of them — your MCP client's own `tools/list` is the complete, current list, and it is the one this
server answers from.

### Verifications & requests (29 tools)

| Tool | Description |
|---|---|
| `create_verification` | Create a verification challenge |
| `get_verification` | Get verification status |
| `submit_verification_code` | Submit a verification code |
| `trigger_verification` | Trigger a verification check |
| `wait_for_verification` | Poll until it completes |
| `create_multi_channel_verification` | One phone, up to three channels, first completion wins |
| `create_verification_request` | Create a multi-asset request |
| `get_request_by_reference` | Look a request up by reference id |

### Domains & DNS (23 tools)

| Tool | Description |
|---|---|
| `add_domain` | Add a domain to verify |
| `verify_domain` | Check the challenge record and mint the proof |
| `connect_cloudflare` | Connect Cloudflare so records are written for you |
| `verify_domain_with_credentials` | Prove control using stored credentials |
| `setup_domain_email` | Set up sending from the domain |

### Account, settings & billing (37 tools)

| Tool | Description |
|---|---|
| `get_platform_summary` | One-call snapshot of the account |
| `get_usage` | Quota and usage for the period |
| `search` | Search across the account |
| `create_account` | Bootstrap a new account (no key needed) |
| `create_api_key` | Create a scoped API key |
| `list_assets` | List verified assets and their proof handles |

### HITL approvals & consent (22 tools)

| Tool | Description |
|---|---|
| `create_hitl` | Create a human-approval configuration |
| `create_confirmation` | Send an approval request to a person |
| `wait_for_confirmation` | Poll until a person approves or denies |
| `create_authorization` | Ask a person to consent to being contacted |
| `revoke_authorization` | Withdraw a consent |

### Circles & Proof of Me (15 tools)

| Tool | Description |
|---|---|
| `create_circle` | Create a circle of trusted contacts |
| `add_circle_member` | Add a contact |
| `invite_circle_member` | Send a single-use enrollment link |
| `create_identity_challenge` | Run a cross-channel identity check |

### Public profiles (16 tools)

| Tool | Description |
|---|---|
| `create_profile` | Create a public profile |
| `claim_username` | Claim a public username |
| `update_public_proofs` | Choose which proofs a profile shows |

### Templates & webhooks (11 tools)

| Tool | Description |
|---|---|
| `list_templates` | List message templates |
| `render_template` | Render a template with variables |
| `list_webhook_deliveries` | List webhook deliveries |
| `retry_webhook_delivery` | Retry a failed delivery |

### Delegations & proofs (10 tools)

| Tool | Description |
|---|---|
| `create_delegation` | Authorize an artifact from a domain you have proven |
| `revoke_delegation` | Revoke a delegation |
| `verify_delegation` | Check whether an artifact is authorized by the domain it claims |
| `validate_proof` | Verify a signed proof token (no key needed) |
| `get_proof_status` | Read a proof's status by its public handle |
| `list_revoked_proofs` | Read the revocation list (no key needed) |

### Sign-in & sessions (9 tools)

| Tool | Description |
|---|---|
| `start_login` | Begin a sign-in (no key needed) |
| `wait_for_login` | Poll until sign-in completes |
| `get_current_user` | Who the current session belongs to |
| `render_auth_link` | Render a sign-in link for the user to open |

## Test Mode

Use a test-mode API key (`pk_test_*`) to interact with the API without creating real verifications. Test-mode keys are available in your [dashboard](https://proof.holdings/dashboard/api-keys).

## Transport

Two transports ship in this package:

- **stdio** (default, `mcp-server` / `proof-mcp`) — the server communicates over stdin/stdout. One
  user per process; this is what a client launches locally.
- **Streamable HTTP** (`node dist/remote.js`) — a remote server that many users connect to over the
  network by URL, with no install. A connection starts ANONYMOUS — the keyless surface (account
  bootstrap, login, proof and delegation verification) works with no credential at all — and a tool
  that needs an account answers `401` with a `WWW-Authenticate` challenge naming the authorization
  server, which is what a standards-compliant client follows to sign in. The 401 lands on the TOOL
  CALL and never on a bare `initialize` or `tools/list` FOR AN ANONYMOUS CONNECTION: measured
  against live clients, refusing an anonymous handshake reads to the user as a connection timeout
  rather than as an invitation to log in. Three shapes are refused at the handshake instead — a
  presented token that does not resolve (there the 401 is what makes a client refresh), a request
  whose credential does not match the session it names, and an opening batch that smuggles a keyed
  tool call alongside `initialize`. A
  signed-in client sends the API key it was granted in the `Authorization` header — the only place a
  credential is read, never a query parameter — and each connection gets its own server and HTTP
  client, so one user's key or session can never reach another. `PORT` (default 3100),
  `MCP_MAX_SESSIONS` (default 100), `MCP_SESSION_TTL_MS` (default 30 min, counted from the last POST
  the server ACCEPTED — one it answered below 400. A POST refused before any work happens does not
  postpone it, whether the refusal is ours (body over 4MB) or the transport's (unparseable or empty
  body, unsupported `mcp-protocol-version`, a second `initialize`); and an open event stream is a
  connection, not activity, so a session whose only traffic is that stream ages out. **The official
  client does not recover from this on its
  own**: measured against SDK 1.27.1, the stream's reconnect gives up after two attempts and the
  next tool call fails with `unknown_session` until the host reconnects the server. Size the TTL
  with that in mind — it is a memory bound paid for in reconnects, not a transparent one);
  `/healthz` reports the live session count.

## Delegation (`_meta`)

The server card (`server.json`) can carry a **Proof of Delegation** publication under the
namespaced `_meta` key `holdings.proof/delegation`:

```json
{
  "_meta": {
    "holdings.proof/delegation": { "token": "<delegation JWT>" }
  }
}
```

The token is an ES256 JWT minted by [proof.holdings](https://proof.holdings) attesting exactly
one thing: **the controller of the `principal` domain authorized the `delegate` artifact for the
listed scopes.** It is not a statement that the server is safe, audited, or endorsed. A verifier
checks the signature against the issuer JWKS, then compares `principal` and `delegate` to facts
it resolved itself — a token copied into another package fails that comparison, because its
`delegate` names the genuine artifact. Details: [Delegations — API reference](https://proof.holdings/docs/api#delegations).

When the card is published through the official MCP registry, the same entry is nested under
`_meta["io.modelcontextprotocol.registry/publisher-provided"]` — readers should check both
locations.

Maintainers: the entry is written by the fail-closed publish tool, never by hand — from the
repository root, after the delegation is minted for `pkg:npm/@proof-holdings/mcp-server`:

```bash
npm run delegation:publish -- --target mcp --token <jwt>
# or mint + publish in one step (needs PROOF_API_KEY):
npm run delegation:publish -- --target mcp --mint \
  --control-proof ph_ctl_<32hex> --scope proof-verification
```

The tool refuses any token whose claims do not name this exact package with
`principal: proof.holdings` (the same check `--target a2a` performs against the A2A agent
card's own `url` before regenerating `/.well-known/agent-card.json`). Besides `server.json`,
`--target mcp` writes the website card's source (`web/src/lib/geo/mcp-delegation-publication.json`)
and regenerates `/.well-known/mcp/server-card.json` and `/.well-known/mcp.json`, so it needs
`web/node_modules` installed. For either target, if the card-regeneration step fails after the
source file is written, just re-run the command — the token is already validated and the
regeneration is idempotent. The website cards reach readers only with the next website deploy.

### Verifying someone else's delegation (`verify_delegation`)

This server also **checks** delegations, not just publishes one. The `verify_delegation` tool
runs the reference verifier ([`@proof-holdings/delegation-verifier`](https://github.com/ProofHoldings/delegation-verifier))
over another server's card and needs **no API key** — verification runs against public surfaces
only.

```jsonc
{
  "card": { /* the MCP server.json or A2A agent card you fetched */ },
  "delegate": { "type": "purl", "value": "pkg:npm/postmark-mcp" },
  "expected_principal": "postmarkapp.com"
}
```

Both pins are **required**, and they close different attacks:

- `delegate` must be the artifact identity **you** resolved — the package you are about to
  install, the endpoint you are about to call. Never copy it out of the card being checked: a
  published token is a bearer artifact, so comparing it against a field of the same card would
  bless a token pasted in from somewhere else.
- `expected_principal` is the domain you expect to stand behind it. An issuer binds the
  artifact to nothing, so any domain owner can mint a genuine, signature-valid delegation
  naming someone else's package. Without this pin a verdict would only mean "some domain
  claims this".

### Re-checking everything you already trust (`verify_delegations`)

`verify_delegation` answers "is this one good, right now, because you asked". If an agent has
already resolved and verified thirty-five artifacts, re-verifying them one call at a time does
not scale — `verify_delegations` batch-checks up to 50 in a single call, also with **no API key**.

```jsonc
{
  "items": [
    { "card": { /* ... */ }, "delegate": { "type": "purl", "value": "pkg:npm/postmark-mcp" }, "expected_principal": "postmarkapp.com" },
    { "token": "<jwt>", "delegate": { "type": "url", "value": "https://example.com/mcp" }, "expected_principal": "example.com" }
  ]
}
```

Each item takes exactly the shape `verify_delegation` requires (`card` XOR `token`, `delegate`,
`expected_principal`, optional `required_scopes`) and is verified **independently** — no
cross-item state, nothing persisted, and one item failing never affects another item's result.
Revocation is always checked (there is no `check_status: false` on this tool — the entire point
of a batch re-check is to see what changed).

**Two things this tool deliberately does NOT do:**

- **It does not discover what you have installed.** You must already hold each artifact's
  `card` or `token`. It has no DNS-pointer resolution and fetches no caller-supplied URL —
  the same trust boundary `verify_delegation` already draws, kept narrow on purpose (see
  `src/services/delegationPointer/resolve.ts`'s documented gaps in the main repository, which
  this tool stays outside of).
- **It does not run continuously.** Each call is a single point-in-time check. There is no
  cadence, no scheduler, no push notification — call it again whenever you want a fresh answer.

Each result in `results[]` carries an `outcome`, one of four buckets:

| Outcome | Meaning |
| --- | --- |
| `confirmed_valid` | The delegation verified — same meaning as `verify_delegation`'s `verified: true`. |
| `confirmed_invalid` | A genuine negative verdict: revoked, suspended, expired, a mismatched principal or delegate, an ungranted scope, or a malformed/untrusted/badly-signed token. |
| `no_claim_found` | The artifact publishes no delegation at all. An absence, never an accusation. |
| `unconfirmed` | We could not reach the issuer or otherwise get a confident answer right now (e.g. its JWKS or status endpoint is unreachable). **Never treat this as a bad verdict** — it means "ask again later", not "revoked". |

A result also carries `checked_at` — the ISO timestamp of the moment **that item's own check**
completed, not one timestamp shared across the whole call — so "established locally" is never
presented as "established by reaching us, at this moment" without saying which.

### ⚠️ Release order (maintainers)

`package.json` declares `@proof-holdings/delegation-verifier` as a **runtime** dependency, so the
range it names has to be resolvable on the registry before this package is uploaded:

**`@proof-holdings/delegation-verifier` is published BEFORE `@proof-holdings/mcp-server`, on every
release that moves the range.** This server is launched via `npx` by every documented client, so a
release whose dependency the registry cannot resolve makes `npx @proof-holdings/mcp-server` fail
with E404 for everyone until the verifier lands. A run of
`.github/workflows/publish-packages.yml` with `target: all` enforces the order by its step order;
a publish by hand from a terminal has nothing enforcing it but `docs/runbooks/npm-release.md`.

Working on the verifier and the server together does not need a publish. Link the sibling instead:

```bash
npm run verifier:link   # cd mcp && npm install ../packages/delegation-verifier --no-save
```

The test suite needs no link at all: it resolves the verifier's SOURCE through a vitest alias
rather than `node_modules`, so it is green on a fresh clone and picks up an uncommitted verifier
change without a build.

## Requirements

- Node.js >= 18.0.0
- A proof.holdings API key for the keyed tools. The server starts and answers the keyless ones
  without it — see Configuration above.

## Links

- [proof.holdings](https://proof.holdings) — Product website
- [API Documentation](https://proof.holdings/docs/api) — REST API reference
- [Dashboard](https://proof.holdings/dashboard) — Manage your account and API keys

## License

[MIT](LICENSE)
