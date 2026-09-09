import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

/**
 * Guards over the TEXT an agent reads — the tool descriptions themselves (`h-fix-mcp-agent-facing-text`).
 *
 * WHY THIS FILE EXISTS. A description is not documentation about the server; on the wire it IS the
 * server, because it is what the model reads before choosing a tool and the only thing it reads when
 * a call fails at the transport. `tools.test.ts` next door asserts what handlers DO; nothing asserted
 * what the descriptions SAY, and that is where the 2026-09-05 manual run found three defects.
 *
 * The first block pins the one that is mechanical rather than merely misleading. Every producer of
 * `qr_text` on the backend calls `generateQRCodeText()` — `QRCode.toString(text, { type: 'utf8' })` —
 * so `qr_text` is QR ART, never a URL. `render_auth_link` declares its input as `z.string().url()`.
 * A description pairing the two therefore instructs the caller to do something zod rejects, and a
 * live agent obeyed, failed, and improvised a PNG the harness refused to display.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(HERE, '../src/tools');

interface CapturedTool {
  module: string;
  name: string;
  /**
   * The tool description AND every `.describe()` hint on its input shape, nested ones included.
   *
   * Kept together on purpose. Round 3 of this task's review found the old narrow identity rule
   * surviving in a zod field hint while the tool description above it carried the new wide one — an
   * agent reads both, and a guard that captured only the description was blind to exactly the place
   * that defect hid.
   */
  texts: string[];
}

/**
 * Every tool description the modules in `src/tools` register.
 *
 * Captured through a mock registrar rather than off a built `McpServer` ON PURPOSE: the factory
 * appends an access notice to descriptions when it builds without a credential, and a guard over
 * what the modules THEMSELVES say must not be able to pass or fail because of that later addition.
 *
 * The second argument is handed to every module unchanged. It stands in for both shapes the real
 * registrars take — an `HttpClient` and the `{ baseUrl }` options object `delegation-verify` wants —
 * which is safe because registration only stores the handler; nothing here calls one.
 */
async function captureAllDescriptions(): Promise<CapturedTool[]> {
  const captured: CapturedTool[] = [];
  const files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));

  for (const file of files) {
    const mod = (await import(path.join(TOOLS_DIR, file))) as {
      registerTools?: (tool: unknown, dep?: unknown) => void;
    };
    if (typeof mod.registerTools !== 'function') continue;

    const tool = (name: string, description: string, shape?: unknown) => {
      captured.push({ module: file, name, texts: [description, ...hintsIn(shape)] });
    };
    const dependency = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      del: vi.fn(),
      baseUrl: 'https://api.proof.holdings',
    };
    mod.registerTools(tool as unknown, dependency);
  }

  return captured;
}

/**
 * Every `.describe()` hint on a tool's input shape, NESTED ONES INCLUDED.
 *
 * The nesting is the point rather than thoroughness for its own sake: the defect this half exists
 * for was found in `delegate.value` — one level down, inside a `z.object` — while the tool
 * description above it already carried the corrected rule. A top-level-only walk would have
 * reproduced exactly the blind spot it was added to close.
 *
 * Descends through zod's internal `_def.shape()` because there is no public API for it, and stops
 * at a depth of 3: these schemas are two levels deep at most, and a bound makes a cyclic or exotic
 * schema fail as a missed hint rather than as a hang.
 */
function hintsIn(shape: unknown, depth = 0): string[] {
  if (!shape || typeof shape !== 'object' || depth > 3) return [];

  const texts: string[] = [];
  for (const field of Object.values(shape as Record<string, unknown>)) {
    const description = (field as { description?: unknown })?.description;
    if (typeof description === 'string') texts.push(description);

    const nested = (field as { _def?: { shape?: unknown } })?._def?.shape;
    const inner = typeof nested === 'function' ? (nested as () => unknown)() : nested;
    texts.push(...hintsIn(inner, depth + 1));
  }
  return texts;
}

/**
 * Sentences, for a per-SENTENCE rule rather than a per-description one.
 *
 * A description-wide ban on the two names appearing together would forbid the very warning that
 * fixes this defect ("`qr_text` is not a link — do not pass it to render_auth_link"), so the rule
 * has to be finer than the document. A sentence is the unit in which an instruction is given, and
 * newlines split as hard as full stops because these descriptions are written as numbered steps.
 */
function sentencesOf(description: string): string[] {
  return description
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The two claims a sentence may not make, each a mechanical co-occurrence rather than a judgement:
 *
 *   1. `qr_text` named in the same sentence as `render_auth_link` — the tool's input is
 *      `z.string().url()`, so in one sentence those two can only read as "pass this to that".
 *   2. `qr_text` named in the same sentence as "URL" — every producer builds it with
 *      `QRCode.toString(text, { type: 'utf8' })`, so calling it a URL anywhere is false.
 *
 * Both rules are stated over sentences the capture actually yields; neither claims anything about
 * text outside a registered description, and neither judges whether a description is otherwise
 * correct. A sentence that must warn about `qr_text` says so without naming the tool or the word.
 */
function offendingSentences(description: string): string[] {
  return sentencesOf(description).filter((sentence) => {
    if (!sentence.includes('qr_text')) return false;
    return sentence.includes('render_auth_link') || /\bURLs?\b/i.test(sentence);
  });
}

describe('tool descriptions — SC-5: none tells the caller to pass qr_text to render_auth_link', () => {
  it('no registered description puts qr_text in a sentence with render_auth_link or with "URL"', async () => {
    const tools = await captureAllDescriptions();

    // Guard against a vacuous pass: an empty capture would satisfy the assertion trivially.
    expect(tools.length).toBeGreaterThan(100);

    // Anti-vacuity on the NEW half: if zod stopped exposing `.description` the hint list would be
    // empty everywhere and this guard would quietly shrink back to what it used to check.
    expect(tools.reduce((n, t) => n + t.texts.length - 1, 0)).toBeGreaterThan(100);

    const offenders = tools.flatMap((t) =>
      t.texts.flatMap((text) => offendingSentences(text).map((sentence) => `${t.module}:${t.name} — ${sentence}`)),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The control, and the reason it is written from history rather than invented: these are the
   * EXACT sentences the tools shipped with until this task. A guard that only fails a sentence
   * somebody made up for it has not been shown to catch the defect it exists for.
   */
  it.each([
    'Display the returned `qr_text` URL to the user using render_auth_link so they can scan or click it.',
    'Display the `qr_text` URL from start_2fa using render_auth_link before polling.',
    'The response includes a `qr_text` field (raw URL).',
    'For messaging channels, display the `qr_text` URL using render_auth_link.',
    'Display the returned deep_link / qr_text via render_auth_link.',
    'After creating a session, the response includes a hosted verification URL in the `qr_text` field.',
  ])('fails the sentence that shipped before this fix: %s', (sentence) => {
    expect(offendingSentences(sentence)).toHaveLength(1);
  });

  it('allows a warning that keeps the two apart, and a correct instruction', () => {
    const warning =
      'Pass `deep_link` to render_auth_link so the user can click or scan it. ' +
      '`qr_text` is that same link already rendered as QR art, so print it verbatim inside a fenced code block instead.';
    expect(offendingSentences(warning)).toEqual([]);
  });
});
