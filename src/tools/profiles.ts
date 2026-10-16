import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, errorResult } from '../types.js';
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
const emailThemeSchema = z.enum(['dark', 'light']).optional().describe('Theme of this project\'s emails');
const supportEmailSchema = z.string().email().max(254).optional().describe('Support email this project\'s messages show');

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  // =========================================================================
  // Multi-Profile CRUD (via /api/v1/me/profiles — dual auth)
  // =========================================================================

  tool(
    'list_profiles',
    'List all profiles for the authenticated account. Returns all profiles including primary and secondary.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/me/profiles');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'create_profile',
    'Create a new profile with optional display name, bio, avatar, business info, email branding (theme, support email), and theme settings.',
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
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_profile',
    'Get a specific profile by ID. Returns full profile details including theme, custom links, and verification display settings.',
    {
      profile_id: z.string().describe('Profile ID'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.get(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_profile',
    'Update a profile by ID. Supports changing display info, email branding (theme, support email), theme, custom links, and verification display settings.',
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
      support_email: supportEmailSchema.nullable().describe('Support email this project\'s messages show (null to remove)'),
      show_verification_dates: z.boolean().optional().describe('Show verification dates on public profile'),
      show_proof_channels: z.boolean().optional().describe('Show proof channels on public profile'),
      theme: themeSchema,
      custom_links: customLinksSchema,
    },
    async ({ profile_id, ...body }) => {
      try {
        const result = await http.patch(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`, body);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'delete_profile',
    'Delete a project (profile). Revokes its API keys, archives the HITL setups and declines the pending requests created with its own keys, keeps its history but unlinks it, deletes its message templates, and retires its username for good. The last project cannot be deleted; deleting the primary project makes the oldest remaining one primary (the response names it). In a start_login session: one code first — start_2fa_for_action with action_type profile_delete and targets [this project id]. With an API key alone only an EMPTY project (no API keys, HITL setups or pending requests) can be deleted; anything else answers owner_session_required. Cannot be undone.',
    {
      profile_id: z.string().describe('Profile ID'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.del(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'set_primary_profile',
    'Set a profile as the primary profile. The previous primary profile becomes secondary.',
    {
      profile_id: z.string().describe('Profile ID to set as primary'),
    },
    async ({ profile_id }) => {
      try {
        const result = await http.post(`/api/v1/me/profiles/${encodeURIComponent(profile_id)}/primary`);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // =========================================================================
  // Profile Proofs & Legacy Endpoints (via /api/v1/profiles/* — dual auth)
  // =========================================================================

  tool(
    'update_profile_proofs',
    'Update which verified assets (proofs) are displayed on a specific profile. Controls visibility, privacy masking, ordering, and labels.',
    {
      profile_id: z.string().describe('Profile ID'),
      proofs: z.array(z.object({
        asset_id: z.string().describe('Asset ID to display'),
        is_visible: z.boolean().optional().describe('Whether this proof is visible'),
        mask_level: z.enum(['full', 'partial', 'hidden']).optional().describe('Privacy masking level'),
        display_order: z.number().int().min(0).optional().describe('Display order'),
        label: z.string().max(50).optional().describe('Custom label (e.g. "Support Phone")'),
      })).max(50).describe('Proofs to display on profile'),
    },
    async ({ profile_id, proofs }) => {
      try {
        const result = await http.put(`/api/v1/profiles/profiles/${encodeURIComponent(profile_id)}/proofs`, { proofs });
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_my_profile',
    'Get the current user\'s primary profile. Returns profile details, theme, custom links, and public proof display settings.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/profiles/me');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'update_my_profile',
    'Update the current user\'s primary profile. Supports display name, bio, avatar, theme, custom links, and verification display settings.',
    {
      display_name: z.string().max(100).optional().describe('Display name'),
      bio: z.string().max(500).optional().describe('Profile bio'),
      avatar_url: z.string().max(500000).refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), { message: 'Must be an HTTPS URL or base64 data URI' }).optional().nullable().describe('Avatar (HTTPS URL or base64 data URI, null to remove)'),
      is_public: z.boolean().optional().describe('Whether the profile is publicly visible'),
      show_verification_dates: z.boolean().optional().describe('Show verification dates'),
      show_proof_channels: z.boolean().optional().describe('Show proof channels'),
      theme: themeSchema,
      custom_links: customLinksSchema,
    },
    async (args) => {
      try {
        const result = await http.put('/api/v1/profiles/me', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  tool(
    'get_profile_assets',
    'Get available verified assets that can be displayed on the user\'s profile. Returns assets eligible for public proof display.',
    {},
    async () => {
      try {
        const result = await http.get('/api/v1/profiles/me/assets');
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return errorResult(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
