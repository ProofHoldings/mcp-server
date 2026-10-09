import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * What each tool does to the caller's account, stated to the CLIENT (live review 2026-09-26, M5).
 *
 * With no annotations an MCP client must assume every tool may be destructive, so a read is gated
 * behind the same confirmation as `revoke_api_key`, and the dangerous tools get no warning of their
 * own. `factory.ts` stamps these onto every registration in one place.
 *
 * Two sets, and everything outside both is an ADDITIVE write (`destructiveHint: false` is the MCP
 * meaning of "performs only additive updates"). Written as names rather than derived at runtime
 * because the registrar never sees what a handler calls; `__tests__/factory.test.ts` derives the
 * same split from the HTTP method each handler calls and requires the two to agree in both
 * directions, so a new tool that deletes and is missing here goes red rather than advertising itself
 * as additive.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // Local or third-party reads: no call to our API at all.
  'render_auth_link',
  'verify_delegation',
  'verify_delegations',
  // POSTs that compute and store nothing.
  'validate_proof',
  'preview_template',
  'preview_profile_template',
  'render_template',
  // GETs. `export_data` is deliberately absent: it spends the once-per-24h export allowance.
  'get_webhook_stats',
  'list_webhook_deliveries',
  'get_webhook_delivery',
  'get_current_user',
  'list_auth_sessions',
  'get_session',
  'wait_for_session',
  'get_user_domain_verification_status',
  'get_verification_request',
  'get_request_proofs',
  'list_verification_requests',
  'get_request_by_reference',
  'wait_for_request',
  'list_emails',
  'get_add_email_status',
  'get_authorization',
  'list_authorizations',
  'export_authorizations',
  'list_domains',
  'get_domain',
  'get_dns_providers',
  'check_domain_credentials',
  'check_domain_email_status',
  'get_verification',
  'list_verifications',
  'list_verified_users',
  'get_verified_user',
  'wait_for_verification',
  'get_multi_channel_verification_status',
  'get_subscription',
  'list_circles',
  'get_circle',
  'list_circle_members',
  'list_circle_member_channels',
  'get_identity_challenge',
  'list_delegations',
  'get_delegation',
  'list_api_keys',
  'list_assets',
  'get_asset',
  'get_usage',
  'get_platform_summary',
  'get_settings',
  'search',
  'get_self_api_key',
  'get_api_key_usage',
  'list_dns_credentials',
  'wait_for_login',
  'wait_for_account_creation',
  'list_phones',
  'get_add_phone_status',
  'get_proof_status',
  'list_revoked_proofs',
  'list_profiles',
  'get_profile',
  'list_profile_templates',
  'get_my_profile',
  'get_profile_assets',
  'list_templates',
  'get_default_templates',
  'get_template',
  'get_hitl_keys',
  'get_2fa_status',
  'wait_for_2fa',
  'list_my_requests',
  'list_incoming_requests',
  'get_hitl',
  'list_hitls',
  'poll_chat_id_discovery',
  'wait_for_chat_id_discovery',
  'get_confirmation',
  'list_confirmations',
  'wait_for_confirmation',
]);

/**
 * Writes that remove, revoke, overwrite or replace something that already exists. Every tool
 * sending `PUT`, `PATCH` or `DELETE` is here, plus the POSTs that do the same under a create-shaped
 * verb: a revoked delegation or proof is terminal, a regenerated key invalidates the old one, the
 * DNS-connect tools upsert the ACCOUNT's stored provider credential (replacing the token every other
 * domain uses), and making a profile primary — directly or by creating one with `is_primary` —
 * demotes the current primary.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  // DELETE
  'revoke_api_key',
  'revoke_asset',
  'revoke_auth_session',
  'revoke_authorization',
  'delete_circle',
  'remove_circle_member',
  'remove_circle_member_channel',
  'delete_dns_credential',
  'delete_domain',
  'delete_domain_verification',
  'remove_email',
  'delete_hitl_keys',
  'delete_hitl',
  'remove_phone',
  'delete_profile',
  'delete_profile_template',
  'delete_template',
  'cancel_user_request',
  'cancel_verification_request',
  // PUT / PATCH
  'set_primary_email',
  'set_primary_phone',
  'upload_hitl_keys',
  'update_profile_template',
  'update_profile_proofs',
  'update_my_profile',
  'update_public_proofs',
  'update_template',
  'update_circle',
  'update_hitl',
  'update_profile',
  'update_settings',
  // POSTs that end or replace something
  'revoke_delegation',
  'revoke_proof',
  'regenerate_api_key',
  'connect_cloudflare',
  'connect_godaddy',
  'connect_dns_provider',
  'add_verification_provider',
  'create_dns_credential',
  'set_primary_profile',
  'create_profile',
]);

export function annotationsFor(tool: string): ToolAnnotations {
  if (READ_ONLY_TOOLS.has(tool)) return { readOnlyHint: true };
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(tool) };
}
