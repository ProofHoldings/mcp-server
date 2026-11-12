import { z } from 'zod';
import type { HttpClient } from '../http.js';
import type { ToolRegistrar } from '../types.js';
import { jsonResult, apiErrorResult } from '../types.js';
import { ApiError } from '../http.js';

export function registerTools(tool: ToolRegistrar, http: HttpClient) {
  tool(
    'claim_username',
    'Claim a unique username for the authenticated user\'s Public page. Usernames must be 3-30 characters, alphanumeric and underscores only.',
    {
      username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).describe('Username to claim (3-30 chars, alphanumeric and underscores)'),
      profile_id: z.string().max(64).optional().describe('The sub-account the username is for (its `id` from list_sub_accounts). Omitted: the primary sub-account.'),
    },
    async (args) => {
      try {
        const result = await http.post('/api/v1/profiles/me/username', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );

  tool(
    'update_public_page_proofs',
    'Update which verified proofs are visible on the public page of the primary sub-account (the one get_current_sub_account reads), including visibility, masking, and display order. Needs a signed-in session. To do the same for a named sub-account, use update_sub_account_page_proofs.',
    {
      proofs: z.array(z.object({
        asset_id: z.string().describe('Asset ID to display'),
        is_visible: z.boolean().optional().describe('Whether the proof is visible on the Public page'),
        mask_level: z.enum(['full', 'partial', 'hidden']).optional().describe('How much of the proof value to show'),
        display_order: z.number().int().min(0).optional().describe('Display position (0-based)'),
        label: z.string().max(50).optional().describe('Custom label for the proof'),
      })).max(50).describe('Array of proof display configurations (max 50)'),
      proof_order: z.enum(['default', 'owner']).optional().describe('Who orders the shown proofs: `default` (domain, social, Telegram bot, email, phone, wallet, then display_order) or `owner` (display_order alone). Omitted, the profile keeps its current setting.'),
    },
    async (args) => {
      try {
        const result = await http.put('/api/v1/profiles/me/proofs', args);
        return jsonResult(result);
      } catch (e) {
        if (e instanceof ApiError) return apiErrorResult(e);
        throw e;
      }
    },
  );
}
