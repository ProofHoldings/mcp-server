import { z } from 'zod';
import QRCode from 'qrcode';
import type { ToolRegistrar } from '../types.js';
import { errorResult, CHALLENGE_IN_REPLY } from '../types.js';

export function registerTools(tool: ToolRegistrar) {
  tool(
    'render_auth_link',
    'Render an authorization or verification URL as a clickable link followed by a scannable QR code inside a fenced code block. This is a local computation tool — no HTTP request is made. Its output comes back to you, not to the user: copy the link, and the QR block inside its fence, into your reply.\n\nAgent usage: pass a LINK field from an earlier response — `deep_link` (create_session, create_chat_id_discovery always; start_login, create_account, start_2fa, start_2fa_for_action, start_add_phone on telegram/whatsapp ONLY, where on sms and email that field is empty or absent altogether and this tool rejects it either way), `challenge.deep_link` (create_verification, messenger channels only), or `telegram_deep_link` / `whatsapp_deep_link`.\n\nDo NOT pass `qr_text` to this tool: that field is a QR code already rendered as text, and this tool takes a link. When a response gives you `qr_text` and no link, print it verbatim inside a fenced code block instead — its rows only scan while they stay adjacent, so a blank line or wrapped row destroys the code.\n\n' + CHALLENGE_IN_REPLY,
    {
      url: z.string().url().describe('The link to render — e.g. a deep_link response field. Never a qr_text value: that is the link already rendered as QR art.'),
      label: z.string().max(200).optional().describe('Optional label to display above the link (e.g. "Verify your phone number")'),
    },
    async ({ url, label }) => {
      try {
        const qrText = await QRCode.toString(url, { type: 'terminal', small: true });

        const parts: string[] = [];
        if (label) {
          parts.push(label);
          parts.push('');
        }
        parts.push(url);
        parts.push('');
        parts.push('```');
        parts.push(qrText.trimEnd());
        parts.push('```');

        return {
          content: [{ type: 'text' as const, text: parts.join('\n') }],
        };
      } catch (e) {
        return errorResult(`Failed to render QR code: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
