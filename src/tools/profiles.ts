import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

const themeSchema = z.object({
  primary_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Primary color (hex)'),
  background_type: z.enum(['solid', 'gradient']).optional().describe('Background type'),
  background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Background color (hex)'),
  gradient_start: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Gradient start color'),
  gradient_end: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Gradient end color'),
  font_style: z.enum(['default', 'modern', 'classic']).optional().describe('Font style'),
}).optional().describe('Profile theme settings');

const customLinksSchema = z.array(z.object({
  title: z.string().max(100).describe('Link title'),
  url: z.string().url().max(500).describe('Link URL'),
  icon: z.string().max(50).optional().describe('Icon identifier'),
  is_visible: z.boolean().optional().describe('Whether the link is visible'),
  display_order: z.number().int().min(0).optional().describe('Display order'),
})).max(20).optional().describe('Custom links (max 20)');

// A project's email branding (h-subaccount-branding-per-project): every message takes these from
// its own project, never from account settings.
const emailThemeSchema = z.enum(['dark', 'light']).optional().describe('Theme of this sub-account\'s emails');
const supportEmailSchema = z.string().email().max(254).optional().describe('Support email this sub-account\'s messages show');

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  // =========================================================================
  // Multi-Profile CRUD (via /api/v1/me/profiles — dual auth)
  // =========================================================================

  tool(
    'list_sub_accounts',
    'List every sub-account of the authenticated account, the primary one included.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/profiles');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'create_sub_account',
    'Create a new sub-account with optional display name, bio, avatar, business info, email branding (theme, support email), and theme settings.',
    {
      display_name: z.string().max(100).optional().describe('Display name'),
      bio: z.string().max(500).optional().describe('Profile bio'),
      avatar_url: z.string().max(100000).optional().describe('Avatar as base64 data URI or URL (~75KB limit)'),
      business_name: z.string().max(100).optional().describe('Business name'),
      is_business: z.boolean().optional().describe('Whether this is a business profile'),
      is_public: z.boolean().optional().describe('Whether the profile is publicly visible'),
      is_primary: z.boolean().optional().describe('Set as primary profile'),
      email_theme: emailThemeSchema,
      support_email: supportEmailSchema,
      theme: themeSchema,
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/me/profiles', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_sub_account',
    'Get one sub-account by ID, with its full details including theme, custom links, and verification display settings.',
    {
      profile_id: z.string().describe('Profile ID'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.get(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'update_sub_account',
    'Update a sub-account by ID. Supports changing display info, email branding (theme, support email), theme, custom links, and verification display settings.',
    {
      profile_id: z.string().describe('Profile ID'),
      display_name: z.string().max(100).optional().describe('Display name'),
      bio: z.string().max(500).optional().describe('Profile bio'),
      avatar_url: z.string().max(100000).optional().nullable().describe('Avatar (base64 or URL, null to remove)'),
      business_name: z.string().max(100).optional().describe('Business name'),
      is_business: z.boolean().optional().describe('Whether this is a business profile'),
      is_public: z.boolean().optional().describe('Whether the profile is publicly visible'),
      is_primary: z.boolean().optional().describe('Set as primary profile'),
      email_theme: emailThemeSchema,
      support_email: supportEmailSchema.nullable().describe('Support email this sub-account\'s messages show (null to remove)'),
      show_verification_dates: z.boolean().optional().describe('Show verification dates on the Public page'),
      show_proof_channels: z.boolean().optional().describe('Show proof channels on the Public page'),
      show_delegations: z.boolean().optional().describe('List the published, in-force delegations for the domains the profile shows (default true)'),
      theme: themeSchema,
      custom_links: customLinksSchema,
    },
    async ({ profile_id, ...body }) => {
      try {
        const result = await http.patch(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'delete_sub_account',
    'Delete a sub-account. Revokes its API keys, archives the approval channels and declines the pending requests created with its own keys, keeps its history but unlinks it, deletes its message templates, and retires its username for good. The last sub-account cannot be deleted; deleting the primary sub-account makes the oldest remaining one primary (the response names it). In a start_login session: one code first — start_2fa_for_action with action_type profile_delete and targets [this sub-account id]. With an API key alone only an EMPTY sub-account (no API keys, approval channels or pending requests) can be deleted; anything else answers owner_session_required. archive_default_linked is deliberately not offered here: archiving or cancelling everything linked only by default is an irreversible fan-out, so archive each item explicitly instead. Cannot be undone.',
    {
      profile_id: z.string().describe('Profile ID'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.del(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'set_primary_sub_account',
    'Make a sub-account the primary one. The previous primary sub-account becomes secondary.',
    {
      profile_id: z.string().describe('Profile ID to set as primary'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.post(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}/primary`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  // =========================================================================
  // Profile Proofs & Legacy Endpoints (via /api/v1/profiles/* — dual auth)
  // =========================================================================

  tool(
    'update_sub_account_page_proofs',
    'Update which verified assets (proofs) are displayed on one named sub-account. Controls visibility, privacy masking, ordering, and labels. For the primary sub-account in a signed-in session, update_public_page_proofs does the same.',
    {
      profile_id: z.string().describe('Profile ID'),
      proofs: z.array(z.object({
        asset_id: z.string().describe('Asset ID to display'),
        is_visible: z.boolean().optional().describe('Whether this proof is visible'),
        mask_level: z.enum(['full', 'partial', 'hidden']).optional().describe('Privacy masking level'),
        display_order: z.number().int().min(0).optional().describe('Display order'),
        label: z.string().max(50).optional().describe('Custom label (e.g. "Support Phone")'),
      })).max(50).describe('Proofs to display on profile'),
      proof_order: z.enum(['default', 'owner']).optional().describe('Who orders the shown proofs: `default` (domain, social, Telegram bot, email, phone, wallet, then display_order) or `owner` (display_order alone). Omitted, the profile keeps its current setting.'),
    },
    async ({ profile_id, proofs, proof_order }) => {
      try {
        const result = await http.put(`/api/v1/profiles/profiles/${encodeURIComponent(profile_id)}/proofs`, {
          proofs,
          ...(proof_order !== undefined && { proof_order }),
        });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'get_current_sub_account',
    'Get the current sub-account record: with a sub-account key, that key\'s own sub-account; otherwise the account\'s primary sub-account. The first call creates a primary sub-account if the account has none (never for a sub-account key, which gets profile_not_found). Returns profile details, theme, custom links, and public proof display settings. Its write twin is update_public_page (the same record). In the dashboard, the Profile page (https://proof.holdings/profile) edits whichever sub-account is selected there.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/profiles/me');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'update_public_page',
    'Update the record get_current_sub_account reads: a sub-account key\'s own sub-account, otherwise the primary sub-account (never creates one). Takes presentation fields only — display name, bio, avatar, theme, custom links, and verification display settings; business details, the primary flag and email branding go through update_sub_account. In the dashboard, the Profile page (https://proof.holdings/profile) edits whichever sub-account is selected there.',
    {
      display_name: z.string().max(100).optional().describe('Display name'),
      bio: z.string().max(500).optional().describe('Profile bio'),
      avatar_url: z.string().max(500000).refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), { message: 'Must be an HTTPS URL or base64 data URI' }).optional().nullable().describe('Avatar (HTTPS URL or base64 data URI, null to remove)'),
      is_public: z.boolean().optional().describe('Whether the profile is publicly visible'),
      show_verification_dates: z.boolean().optional().describe('Show verification dates'),
      show_proof_channels: z.boolean().optional().describe('Show proof channels'),
      show_delegations: z.boolean().optional().describe('List the published, in-force delegations for the domains the profile shows (default true)'),
      theme: themeSchema,
      custom_links: customLinksSchema,
    },
    async (args) => {
      try {
        const result = await http.put('/api/v1/profiles/me', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'list_public_page_proof_options',
    'List the verified proofs that can be shown on the Public page (each one eligible to be listed with update_public_page_proofs).',
    {
      profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional().describe('The sub-account whose shown proofs set each asset\'s is_public flag (24 hex characters); omitted, the primary'),
    },
    async (args) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (args.profile_id !== undefined) query.profile_id = args.profile_id;
        const result = await http.get('/api/v1/profiles/me/assets', query);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'rotate_callback_secret',
    'Rotate a sub-account\'s callback signing secret — the secret that signs every callback_url delivery of its verification requests — and return the new one. This is the only time it is returned, so store it now. Callback deliveries already queued keep the secret they were signed with. An account still delivering through its settings webhook URL is switched over to webhook endpoints first.',
    {
      profile_id: z.string().regex(/^[0-9a-fA-F]{24}$/).describe('Sub-account (profile) ID, 24 hex characters'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.post(`/api/v1/profiles/profiles/${encodeURIComponent(profile_id)}/callback-secret/rotate`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'preview_profile_deletion',
    'Preview what delete_sub_account would do to one sub-account, without changing anything: the counts the dashboard Delete sub-account dialog shows and the sub-account that would take its place, or why deletion is refused (allowed: false). Needs profiles:read; a key bound to a sub-account previews only its own.',
    {
      profile_id: z.string().describe('Sub-account ID'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.get(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}/deletion-preview`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
