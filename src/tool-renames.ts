/**
 * THE ONE SOURCE of the tool renames (m-fix-mcp-tool-contract-drift SC-10): the table Alex confirmed on
 * 11 Nov, 23 renamed and 7 kept, so the names follow the dashboard's own words ("approval channel",
 * "Your proofs", "sub-account", "Public page"). Every other place an old name could live is held to this
 * file: `__tests__/tool-renames.test.ts` (each `to` is registered, each `from` only when its row says
 * `alias`) and the repository sweep there (an old name appears only in this file and the release notes).
 *
 * `alias` (coordinator, 11 Nov: keep the old names for one release): `true` registers the old name TOO,
 * with a one-line deprecated description, the new tool's handler, input and annotations, and no output
 * schema — and every access rule reads it as the new name (`canonicalToolName`). 1.10.0 ships every row
 * `true`; the release named by `ALIASES_REMOVED_IN` flips them all to `false`, and that edit is the whole removal.
 */
/** The release that stops registering the deprecated aliases (renames shipped in 1.10.0). */
export const ALIASES_REMOVED_IN = '2.0.0';

export interface ToolRename {
  /** The name 1.x registered. */
  readonly from: string;
  /** The name it is registered under now. */
  readonly to: string;
  /** Register `from` too, as a deprecated alias of `to`. */
  readonly alias: boolean;
  /** What a caller migrating by hand should know beyond the name, when there is something. */
  readonly note?: string;
}

export const TOOL_RENAMES: readonly ToolRename[] = [
  { from: 'create_hitl', to: 'create_approval_channel', alias: true },
  { from: 'get_hitl', to: 'get_approval_channel', alias: true },
  { from: 'list_hitls', to: 'list_approval_channels', alias: true },
  { from: 'update_hitl', to: 'update_approval_channel', alias: true },
  {
    from: 'delete_hitl',
    to: 'archive_approval_channel',
    alias: true,
    note: 'Same call as before: the channel is archived (status archived), not erased.',
  },
  { from: 'get_hitl_keys', to: 'get_approval_channel_keys', alias: true },
  { from: 'upload_hitl_keys', to: 'upload_approval_channel_keys', alias: true },
  { from: 'delete_hitl_keys', to: 'delete_approval_channel_keys', alias: true },
  { from: 'request_hitl_authorization', to: 'request_approval_channel_authorization', alias: true },
  { from: 'list_assets', to: 'list_my_proofs', alias: true },
  { from: 'get_asset', to: 'get_my_proof', alias: true },
  { from: 'revoke_asset', to: 'revoke_my_proof', alias: true },
  { from: 'get_profile_assets', to: 'list_public_page_proof_options', alias: true },
  { from: 'list_profiles', to: 'list_sub_accounts', alias: true },
  { from: 'create_profile', to: 'create_sub_account', alias: true },
  { from: 'get_profile', to: 'get_sub_account', alias: true },
  { from: 'update_profile', to: 'update_sub_account', alias: true },
  { from: 'delete_profile', to: 'delete_sub_account', alias: true },
  { from: 'set_primary_profile', to: 'set_primary_sub_account', alias: true },
  { from: 'update_profile_proofs', to: 'update_sub_account_page_proofs', alias: true },
  { from: 'get_my_profile', to: 'get_current_sub_account', alias: true },
  { from: 'update_my_profile', to: 'update_public_page', alias: true },
  { from: 'update_public_proofs', to: 'update_public_page_proofs', alias: true },
];

const KEPT_REASON = 'already the dashboard\'s word: "proof"';

/** The names in the same vocabulary that stay, each with why — part of the confirmed table. */
export const KEPT_TOOL_NAMES: readonly { readonly name: string; readonly reason: string }[] = [
  { name: 'get_proof_status', reason: KEPT_REASON },
  { name: 'get_proof_token', reason: KEPT_REASON },
  { name: 'get_request_proofs', reason: KEPT_REASON },
  { name: 'list_reissued_proofs', reason: KEPT_REASON },
  { name: 'list_revoked_proofs', reason: KEPT_REASON },
  { name: 'revoke_proof', reason: KEPT_REASON },
  { name: 'validate_proof', reason: KEPT_REASON },
];

const ALIAS_TO_NAME: ReadonlyMap<string, string> = new Map(
  TOOL_RENAMES.filter((row) => row.alias).map((row) => [row.from, row.to]),
);

/** The registered deprecated aliases of `name` (empty unless a row of `TOOL_RENAMES` says `alias`). */
export function aliasesOf(name: string): string[] {
  return TOOL_RENAMES.filter((row) => row.alias && row.to === name).map((row) => row.from);
}

/** The tool a called name stands for: itself, or the new name when it is a registered alias. */
export function canonicalToolName(name: string): string {
  return ALIAS_TO_NAME.get(name) ?? name;
}

/** The one-line description an alias carries. */
export function aliasDescription(name: string): string {
  return `Deprecated: use ${name}`;
}
