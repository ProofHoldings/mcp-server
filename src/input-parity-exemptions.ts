/**
 * Where a tool's input keys may differ from its operation's inputs in the OpenAPI document
 * (`m-true-response-components-phase3`, T6). Each entry is a decision with its reason, never a
 * deferral: `__tests__/input-parity.test.ts` fails on a difference no entry covers AND on an entry
 * that no longer matches a real difference.
 *
 * Imports nothing, on purpose: `src/__tests__/drift/mcp-operation-inputs.test.ts` reads this file from
 * the repository root, where the MCP package's zod cannot be loaded.
 */

export type InputParityExemption = {
  tool: string;
  key: string;
  /** `spec_only`: the operation takes it and the tool does not offer it. `tool_only`: the reverse. */
  side: 'spec_only' | 'tool_only';
  reason: string;
};

const CLIENT_SIDE_WAIT = 'How long the tool polls before it returns; it never reaches the API.';

export const INPUT_PARITY_EXEMPTIONS: readonly InputParityExemption[] = [
  ...[
    'wait_for_2fa',
    'wait_for_account_creation',
    'wait_for_chat_id_discovery',
    'wait_for_confirmation',
    'wait_for_login',
    'wait_for_request',
    'wait_for_session',
    'wait_for_verification',
  ].map((tool) => ({ tool, key: 'timeout_seconds', side: 'tool_only' as const, reason: CLIENT_SIDE_WAIT })),
  // SC-19: a dashboard SESSION names the environment it reads on the delivery routes
  // (`sessionEnvironment`, `src/middleware/testMode.ts`). This server calls them with an API key,
  // whose own environment decides and whose parameter is not read — offering it would do nothing.
  ...['list_webhook_deliveries', 'get_webhook_stats', 'get_webhook_delivery', 'retry_webhook_delivery'].map((tool) => ({
    tool,
    key: 'environment',
    side: 'spec_only' as const,
    reason: 'Read for a dashboard session only. This server calls the delivery routes with an API key, whose own environment decides; the parameter is not read for a key.',
  })),
  {
    tool: 'delete_profile',
    key: 'archive_default_linked',
    side: 'spec_only',
    reason: 'An irreversible fan-out an agent would trigger implicitly; an agent archives each item explicitly instead.',
  },
  {
    tool: 'upload_hitl_keys',
    key: 'force',
    side: 'spec_only',
    reason: 'Acknowledges the key-rotation cascade, which overwrites the keys every approver enrolled against; the owner confirms it in the dashboard.',
  },
  {
    tool: 'start_login',
    key: 'return_to',
    side: 'spec_only',
    reason: 'The dashboard page a browser sign-in returns to; an agent signs in without a browser.',
  },
  ...['outcome', 'outcome_timeout_seconds'].map((key) => ({
    tool: 'create_verification_request',
    key,
    side: 'spec_only' as const,
    reason:
      'A request that waits for the relying party\'s outcome needs that outcome reported (POST /verification-requests/{id}/assets/{assetIndex}/outcome), which has no MCP tool; an agent that opted in could not answer, and every person\'s chat would wait out the window.',
  })),
  {
    tool: 'create_delegation',
    key: 'scope',
    side: 'spec_only',
    reason: 'Deprecated since delegation schema 2.0: the API accepts it from the released 1.x SDKs and ignores it, so a tool offering it would invite a value that does nothing.',
  },
  {
    tool: 'update_settings',
    key: 'branding',
    side: 'spec_only',
    reason: 'Retired: the API answers 400 branding_moved, and branding is set on each sub-account with update_profile.',
  },
  ...(['spec_only', 'tool_only'] as const).map((side) => ({
    tool: 'list_reissued_proofs',
    key: side === 'spec_only' ? 'reissued_since' : 'since',
    side,
    reason: 'The tool names it `since`, as each SDK\'s list-reissued method does, and sends it as the operation\'s `reissued_since`.',
  })),
];

/** A path segment a tool fills from an input of another name. */
export const PATH_PARAM_ALIASES: readonly { tool: string; key: string; param: string; reason: string }[] = [
  { tool: 'export_data', key: 'export_id', param: 'jobId', reason: 'The export the tool reads is the job the API names.' },
];

/** Registered tools with no API operation, so nothing to compare. */
export const TOOLS_WITHOUT_OPERATION: readonly { tool: string; reason: string }[] = [
  { tool: 'render_auth_link', reason: 'Renders a sign-in link the agent already holds; it calls no API.' },
  { tool: 'verify_delegation', reason: 'Verified locally by @proof-holdings/delegation-verifier.' },
  { tool: 'verify_delegations', reason: 'Verified locally by @proof-holdings/delegation-verifier.' },
];
