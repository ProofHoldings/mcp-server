import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

import { CHALLENGE_IN_REPLY, WAIT_AFTER_REPLY } from '../src/types.js';

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

/**
 * `create_confirmation`'s `message`, which an agent fills in from what a tool description says.
 *
 * The description already stated the rule ("`message` must be a JSON ciphertext envelope, not
 * plaintext") while the PARAMETER hint one line below it said "Human-readable description of what
 * needs approval" — an instruction to send exactly what the server now refuses and the approval
 * page can never open. An agent reads both; the nearer one wins.
 */
describe('create_confirmation — message is an envelope, and says so where the agent fills it in', () => {
  const SOURCE = path.join(TOOLS_DIR, 'confirmations.ts');
  const BACKEND_VALIDATOR = path.join(HERE, '../../src/middleware/validate.ts');

  async function messageTexts(): Promise<string[]> {
    const tool = (await captureAllDescriptions()).find((t) => t.name === 'create_confirmation');
    if (!tool) throw new Error('create_confirmation is no longer registered');
    return tool.texts;
  }

  /**
   * A hint that CALLS the parameter human-readable text, as opposed to one that contrasts it
   * ("the envelope, NOT the human-readable text"). The distinction has to be finer than the word,
   * for the same reason the `qr_text` rule above is per-sentence: the correction itself needs to
   * name the wrong thing in order to rule it out.
   */
  function hintsCallingItHumanReadable(hint: string): string[] {
    return sentencesOf(hint).filter(
      (sentence) => /human-readable|plain ?text|plain English/i.test(sentence) && !/\bnot\b|\bnever\b|\brefused\b/i.test(sentence),
    );
  }

  it('describes the parameter as a ciphertext envelope, never as human-readable text', async () => {
    const texts = await messageTexts();
    const hints = texts.slice(1); // [0] is the tool description; the rest are field hints

    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((h) => /ciphertext envelope/i.test(h))).toBe(true);
    expect(hints.flatMap(hintsCallingItHumanReadable)).toEqual([]);
    // Not "plaintext is discouraged" — the API answers 400 `message_not_encrypted`.
    expect(hints.some((h) => /message_not_encrypted/.test(h))).toBe(true);
  });

  it('fails the hint that shipped before this fix', () => {
    // The verbatim pre-fix text. A rule that only fails a sentence invented for it has not been
    // shown to catch the defect it exists for.
    expect(hintsCallingItHumanReadable('Human-readable description of what needs approval')).toHaveLength(1);
  });

  it('does not present encryption as conditional on the config', async () => {
    const [description] = await messageTexts();
    // `createConfirmation` refuses a config without a keypair (400 `keypair_required`), so there
    // is no "when E2E is enabled" case — the conditional framing taught agents to try plaintext
    // first and find out from a human.
    expect(/when the HITL config has E2E encryption enabled/i.test(description)).toBe(false);
  });

  it('bounds the parameter the way the server bounds it', () => {
    // Read from each side rather than typed here: the tool advertised 2000 while the server
    // accepted 10000, so a long envelope was refused by the tool for a reason the API does not
    // have — and a smaller cap silently truncates nothing, it just makes the tool unusable.
    const toolSource = fs.readFileSync(SOURCE, 'utf8');
    const toolMax = toolSource.match(/message:\s*z\.string\(\)[^\n]*?\.max\((\d+)\)/)?.[1];
    expect(toolMax, 'no max() found on the message parameter').toBeDefined();

    const validatorSource = fs.readFileSync(BACKEND_VALIDATOR, 'utf8');
    const serverMax = validatorSource
      .match(/createConfirmationSchema\s*=\s*z\.object\(\{[\s\S]*?\n\}\)/)?.[0]
      ?.match(/message:\s*z\.string\(\)[^\n]*?\.max\((\d+)\)/)?.[1];
    expect(serverMax, 'no max() found on createConfirmationSchema.message').toBeDefined();

    expect(toolMax).toBe(serverMax);
  });
});

describe('get_current_user — says it needs a login session, because the key cannot reach it', () => {
  // `GET /api/v1/auth/me` is `jwtAuth` only, so an API key there is refused `invalid_token`. The
  // description promised "the API key owner", which sent an agent holding a key straight into that
  // refusal and read like a bad key (live review 2026-09-26, M4).
  it('names the login road and does not promise the key owner', async () => {
    const tool = (await captureAllDescriptions()).find((t) => t.name === 'get_current_user');
    expect(tool, 'get_current_user is not registered').toBeDefined();
    const [description] = tool!.texts;
    expect(description).toContain('start_login');
    expect(description).toContain('wait_for_login');
    expect(/API key owner/i.test(description)).toBe(false);
  });
});

describe('API key regeneration and usage — the new key has a new id, and usage covers the keys it replaced', () => {
  // `regenerate_api_key` used to promise the key kept its ID. The server issues a new id, so an agent
  // that believed it kept calling the old one and got 404s.
  it('regenerate_api_key says the new key has a new id and the old one stops working', async () => {
    const tool = (await captureAllDescriptions()).find((t) => t.name === 'regenerate_api_key');
    expect(tool).toBeDefined();
    const description = tool!.texts[0];
    expect(description).not.toMatch(/same ID/i);
    expect(description).toMatch(/new id/i);
    expect(description).toMatch(/old key stops working immediately/i);
  });

  it('get_api_key_usage says the counts cover the keys the key replaced', async () => {
    const tool = (await captureAllDescriptions()).find((t) => t.name === 'get_api_key_usage');
    expect(tool).toBeDefined();
    expect(tool!.texts[0]).toContain('replaced_key_ids');
  });
});

describe('challenge flows — the user sees only what the reply shows (W7)', () => {
  // Walkthrough 2026-10-02: the agent wrote "sending the link…" and called wait_for_login four
  // times; the link sat in a folded tool result. Both sets below are DERIVED from the descriptions —
  // a producer is whatever names render_auth_link in its OWN words (CHALLENGE_IN_REPLY names it too,
  // so it is stripped first, or carrying the sentence would be what makes a tool a producer), and a
  // waiter is a registered tool a producer tells the agent to wait on or poll.
  const WAITER_NAME = /\b(?:wait_for_\w+|poll_\w+|get_\w+_status)\b/g;
  const POLLED_NAME = /\bpoll (\w+)/gi;

  async function producersAndWaiters() {
    const tools = await captureAllDescriptions();
    const registered = new Set(tools.map((t) => t.name));
    const ownWords = (text: string) => text.replaceAll(CHALLENGE_IN_REPLY, '');
    const producers = tools.filter(
      (t) => t.name === 'render_auth_link' || t.texts.some((text) => ownWords(text).includes('render_auth_link')),
    );
    const named = (text: string) => [
      ...(text.match(WAITER_NAME) ?? []),
      ...[...text.matchAll(POLLED_NAME)].map((m) => m[1]),
    ];
    const waiterNames = [...new Set(producers.flatMap((t) => t.texts.flatMap(named)))].filter((name) =>
      registered.has(name),
    );
    const waiters = tools.filter((t) => waiterNames.includes(t.name));
    return { producers, waiterNames, waiters };
  }

  const carries = (t: CapturedTool, sentence: string) => t.texts.some((text) => text.includes(sentence));

  it('every description that names render_auth_link tells the agent to put the challenge in its reply', async () => {
    const { producers } = await producersAndWaiters();
    expect(producers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'start_login', 'create_account', 'start_2fa', 'start_2fa_for_action', 'start_add_phone',
        'create_session', 'create_chat_id_discovery', 'create_verification',
        'create_multi_channel_verification', 'render_auth_link',
      ]),
    );
    expect(producers.filter((t) => !carries(t, CHALLENGE_IN_REPLY)).map((t) => t.name)).toEqual([]);
  });

  it('every tool a challenge flow waits on says to show the challenge before waiting', async () => {
    const { waiterNames, waiters } = await producersAndWaiters();
    expect(waiterNames).toEqual(
      expect.arrayContaining([
        'wait_for_login', 'wait_for_account_creation', 'wait_for_2fa', 'get_add_phone_status', 'get_verification',
      ]),
    );
    expect(
      waiters.filter((t) => !carries(t, WAIT_AFTER_REPLY) && !carries(t, CHALLENGE_IN_REPLY)).map((t) => t.name),
    ).toEqual([]);
  });

  const claimsRendererPrints = (sentence: string) =>
    sentence.includes('render_auth_link') && /\bprints?\b/i.test(sentence);

  it('no sentence says render_auth_link prints anything — its output goes to the agent', async () => {
    const tools = await captureAllDescriptions();
    const offenders = tools.flatMap((t) =>
      t.texts.flatMap((text) => sentencesOf(text).filter(claimsRendererPrints).map((s) => `${t.name} — ${s}`)),
    );
    expect(offenders).toEqual([]);
  });

  it('fails the sentences start_login and create_account shipped with', () => {
    const shipped = [
      'On telegram/whatsapp pass `deep_link` to render_auth_link, which prints the clickable link and a QR code; in a chat client the link is what the user acts on, since they are usually on the same machine.',
      'On telegram/whatsapp pass `deep_link` to render_auth_link, which prints the clickable link and a QR code beneath it.',
    ];
    for (const sentence of shipped) expect(claimsRendererPrints(sentence)).toBe(true);
  });
});
