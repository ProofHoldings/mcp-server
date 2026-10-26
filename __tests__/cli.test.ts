import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runCommand, defaultScopes, type CliIO } from '../src/cli.js';
import { LOGIN_COMMAND, saveCredential, type StoredCredential } from '../src/credentials.js';
import { validScopes } from '../src/tools/api-keys.js';

const BASE = 'https://api.proof.holdings';
const SECRET_KEY = 'pk_live_SECRETSECRETSECRETSECRETWXYZ';
const SESSION_JWT = 'eyJhbGciOiJIUzI1NiJ9.session.jwt';
const REFRESH = 'refresh-token-value-0123456789';

// ── fake API ────────────────────────────────────────────────────────────────────────────────────
// Each step names the request it expects and the response the backend gives. Shapes are copied
// from the controllers (createAuthSession, getAuthSessionStatus, submitAuthCode, start2FA,
// verify2FAEmail, get2FAStatus, createAPIKey).

interface Step {
  method: string;
  path: string | RegExp;
  status?: number;
  body?: unknown;
  cookies?: boolean;
  /** Runs when the request reaches this step, before the response — to change local state mid-flow. */
  onRequest?: () => void;
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// A signed-in login ends its session with `POST /api/v1/auth/logout` (logout in the auth controller
// answers `{ success, message }`). The fake answers it on its own, outside the queue, so every
// signed-in test keeps its step list; `logout` picks a refusal and `onLogout` runs when it is sent.
interface LogoutAnswer {
  logout?: number | 'network';
  onLogout?: () => void;
}

const LOGOUT_PATH = '/api/v1/auth/logout';

function fakeApi(steps: Step[], logoutAnswer: LogoutAnswer = {}) {
  const seen: Seen[] = [];
  const queue = [...steps];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ method, path: url.pathname, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && url.pathname === LOGOUT_PATH) {
      logoutAnswer.onLogout?.();
      if (logoutAnswer.logout === 'network') throw new TypeError('fetch failed');
      const status = logoutAnswer.logout ?? 200;
      const body = status === 200 ? { success: true, message: 'Logged out successfully' } : err('unauthorized', 'Not authenticated');
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    const step = queue.shift();
    if (!step) throw new Error(`unexpected request ${method} ${url.pathname}`);
    const pathOk = typeof step.path === 'string' ? step.path === url.pathname : step.path.test(url.pathname);
    if (step.method !== method || !pathOk) throw new Error(`expected ${step.method} ${step.path}, got ${method} ${url.pathname}`);
    step.onRequest?.();
    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    if (step.cookies) {
      responseHeaders.append('Set-Cookie', `token=${SESSION_JWT}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      responseHeaders.append('Set-Cookie', `refresh_token=${REFRESH}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    }
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: responseHeaders });
  });
  return { fetchMock, seen, remaining: () => queue.length };
}

// ── scripted terminal ───────────────────────────────────────────────────────────────────────────

function fakeIO(answers: string[], isTTY = true) {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];
  const io: CliIO = {
    print: (line) => { out.push(line); },
    error: (line) => { err.push(line); },
    prompt: async (question) => {
      questions.push(question);
      const next = queue.shift();
      if (next === undefined) throw new Error(`no scripted answer for prompt: ${question}`);
      return next;
    },
    isTTY,
  };
  return { io, out, err, questions, all: () => [...out, ...err].join('\n') };
}

// ── backend responses ───────────────────────────────────────────────────────────────────────────

const QR = '█▀▀▀▀▀█ ▄▀ █▀▀▀▀▀█\n█ ███ █ ▀█ █ ███ █';
const expiresIn = (seconds: number) => new Date(Date.parse('2026-10-13T14:00:00Z') + seconds * 1000).toISOString();

const loginStart = {
  telegram: {
    id: 'auth_0123456789abcdef0123456789abcdef', type: 'login', channel: 'telegram', status: 'pending',
    deep_link: 'https://t.me/ProofHoldingsBot?start=auth_0123456789abcdef0123456789abcdef', expires_at: expiresIn(600),
    qr_code: 'data:image/png;base64,AAAA', qr_text: QR, fallback_code: 'ABC123',
    fallback_message: 'Log in to Proof Holdings ABC123', instructions: 'Open Telegram and tap the link to log in',
  },
  whatsapp: {
    id: 'auth_1123456789abcdef0123456789abcdef', type: 'login', channel: 'whatsapp', status: 'pending',
    deep_link: 'https://wa.me/15550001111?text=Login%20ABC123', expires_at: expiresIn(600),
    qr_code: 'data:image/png;base64,AAAA', qr_text: QR, fallback_code: 'ABC123',
    fallback_message: 'Log in to Proof Holdings ABC123', instructions: 'Open WhatsApp and send the login message',
  },
  sms: {
    id: 'auth_2123456789abcdef0123456789abcdef', type: 'login', channel: 'sms', status: 'pending',
    deep_link: '', expires_at: expiresIn(600), sms_code: 'ABC123', sms_message: 'Log in to Proof Holdings ABC123',
    sms_dids: {
      americas: { did: '+15550001111', label: 'Americas', flag: '🇺🇸', qr_code: 'data:x', qr_text: 'QR-AMERICAS' },
      europe: { did: '+37060000000', label: 'Europe', flag: '🇪🇺', qr_code: 'data:x', qr_text: 'QR-EUROPE' },
    },
    suggested_region: 'europe', instructions: 'Tap your region to send SMS',
  },
  email: {
    id: 'auth_3123456789abcdef0123456789abcdef', type: 'login', channel: 'email', status: 'pending',
    deep_link: '', expires_at: expiresIn(600), email: 'alex@example.com', email_sent: true,
    instructions: 'Check your email for a verification code or click the magic link',
  },
} as const;

function verifiedPoll(channel: string) {
  return {
    id: 'auth_x', type: 'login', channel, status: 'verified',
    created_at: '2026-10-13T14:00:00Z', verified_at: '2026-10-13T14:00:30Z', user_id: '6720a1b2c3d4e5f6a7b8c9d0',
  };
}

const twofaTelegram = {
  session_id: '2fa_abcdef', channel: 'telegram', status: 'pending', expires_at: expiresIn(600),
  deep_link: 'https://t.me/ProofHoldingsBot?start=2fa_abcdef', qr_code: 'data:x', qr_text: 'QR-2FA',
  instructions: 'Open Telegram and tap the link to verify',
};
const twofaEmail = {
  session_id: '2fa_email1', channel: 'email', status: 'pending', expires_at: expiresIn(600),
  email: 'a***@example.com', email_sent: true, instructions: 'Check your email for the verification code',
};
const twofaVerified = {
  session_id: '2fa_abcdef', status: 'verified', action_type: 'api_key_create',
  verified_at: '2026-10-13T14:01:00Z', grant_expires_at: '2026-10-13T14:06:00Z', grant_single_use: true,
};
const keyCreated = {
  // createAPIKey echoes the name it was sent.
  id: '6720ffffffffffffffffffff', key: SECRET_KEY, name: 'proof-mcp login · alex-laptop · 2026-10-13', prefix: 'pk_live_',
  environment: 'production', scopes: [], profile_id: null, created_at: '2026-10-13T14:01:05.000Z',
  warning: 'Store this key securely.',
};
const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });

// The happy path after the login is verified: Telegram login, WhatsApp step-up, key minted.
function stepUpAndMint(channelAnswer = '1'): { answers: string[]; steps: Step[] } {
  return {
    answers: [channelAnswer],
    steps: [
      { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp', deep_link: 'https://wa.me/1555?text=Verify%20X' } },
      { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: { session_id: '2fa_abcdef', status: 'pending', action_type: 'api_key_create' } },
      { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
      { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated },
    ],
  };
}

describe('proof-mcp commands', () => {
  let dir: string;
  let file: string;
  const originalFetch = globalThis.fetch;
  const noSleep = async () => {};
  const now = () => Date.parse('2026-10-13T14:00:00Z');
  const hostname = () => 'alex-laptop';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proof-cli-'));
    file = join(dir, '.proof-holdings', 'credentials');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  function run(command: string, argv: string[], io: CliIO, overrides: { baseUrl?: string; envKey?: string } = {}) {
    return runCommand(command, argv, {
      baseUrl: overrides.baseUrl ?? BASE, envKey: overrides.envKey, io, file, sleep: noSleep, now, hostname,
    });
  }

  function saved(): Record<string, StoredCredential> {
    return JSON.parse(readFileSync(file, 'utf8')).credentials;
  }

  describe('login over each channel', () => {
    it('telegram: shows the link and the server QR, polls, steps up, mints and saves', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: { ...verifiedPoll('telegram'), status: 'pending' } },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: verifiedPoll('telegram'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(tail.answers);

      const code = await run('login', ['--channel', 'telegram'], t.io);

      expect(code).toBe(0);
      expect(api.remaining()).toBe(0);
      expect(t.out.join('\n')).toContain(loginStart.telegram.deep_link);
      expect(t.out.join('\n')).toContain(QR);
      // The login start is anonymous, the 2FA and key routes ride the captured session.
      expect(api.seen[0].headers.Authorization).toBeUndefined();
      expect(api.seen[0].body).toEqual({ channel: 'telegram' });
      expect(api.seen[3].headers.Authorization).toBe(`Bearer ${SESSION_JWT}`);
      expect(api.seen[6].headers.Authorization).toBe(`Bearer ${SESSION_JWT}`);
      expect(saved()[BASE]).toEqual({
        api_key: SECRET_KEY, key_id: keyCreated.id, name: 'proof-mcp login · alex-laptop · 2026-10-13',
        environment: 'production', created_at: keyCreated.created_at,
      });
    });

    it('whatsapp: shows the wa.me link and QR', async () => {
      const tail = stepUpAndMint('2');
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.whatsapp },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.whatsapp.id}`, body: verifiedPoll('whatsapp'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(tail.answers);

      expect(await run('login', ['--channel', 'whatsapp'], t.io)).toBe(0);
      expect(t.out.join('\n')).toContain(loginStart.whatsapp.deep_link);
    });

    it('sms: shows the message and the numbers, the suggested region first with its QR', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.sms },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.sms.id}`, body: verifiedPoll('sms'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(tail.answers);

      expect(await run('login', ['--channel', 'sms'], t.io)).toBe(0);
      const out = t.out.join('\n');
      expect(out).toContain('Log in to Proof Holdings ABC123');
      expect(out).toContain('+37060000000');
      expect(out).toContain('+15550001111');
      expect(out.indexOf('+37060000000')).toBeLessThan(out.indexOf('+15550001111'));
      expect(out).toContain('QR-EUROPE');
      expect(out).not.toContain('QR-AMERICAS');
    });

    it('email: asks for the address, then the code, and submits it', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.email },
        { method: 'POST', path: `/api/v1/auth/sessions/${loginStart.email.id}/submit`, status: 400, body: err('invalid_code', 'Invalid code', { remaining_attempts: 4 }) },
        { method: 'POST', path: `/api/v1/auth/sessions/${loginStart.email.id}/submit`, body: { success: true, user_id: 'u', status: 'verified' }, cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['4', 'alex@example.com', '000000', '123456', ...tail.answers]);

      expect(await run('login', [], t.io)).toBe(0);
      expect(api.seen[0].body).toEqual({ channel: 'email', email: 'alex@example.com' });
      expect(api.seen[2].body).toEqual({ code: '123456' });
      expect(t.all()).toMatch(/wrong code/i);
    });

    it('email: --email picks the channel and skips both prompts', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.email },
        { method: 'POST', path: `/api/v1/auth/sessions/${loginStart.email.id}/submit`, body: { success: true, user_id: 'u', status: 'verified' }, cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['123456', ...tail.answers]);

      expect(await run('login', ['--email', 'alex@example.com'], t.io)).toBe(0);
      expect(api.seen[0].body).toEqual({ channel: 'email', email: 'alex@example.com' });
    });

    it('email: an empty answer checks whether the magic link already signed the session in', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.email },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.email.id}`, body: verifiedPoll('email'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['', ...tail.answers]);

      expect(await run('login', ['--email', 'alex@example.com'], t.io)).toBe(0);
    });

    it('email: asks again for an answer that is not an email address', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.email },
        { method: 'POST', path: `/api/v1/auth/sessions/${loginStart.email.id}/submit`, body: { success: true, user_id: 'u', status: 'verified' }, cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['4', 'alex', 'alex@example.com', '123456', ...tail.answers]);

      expect(await run('login', [], t.io)).toBe(0);
      expect(t.all()).toContain('does not look like an email address');
      expect(api.seen[0].body).toEqual({ channel: 'email', email: 'alex@example.com' });
    });

    it('email: a locked session ends the login', async () => {
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.email },
        { method: 'POST', path: `/api/v1/auth/sessions/${loginStart.email.id}/submit`, status: 429, body: err('session_locked', 'Too many failed attempts. Please request a new verification code.') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['999999']);

      expect(await run('login', ['--email', 'alex@example.com'], t.io)).toBe(1);
      expect(t.all()).toContain('Too many failed attempts');
    });

    it('a session that disappears (404) ends with a message to log in again', async () => {
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, status: 404, body: err('session_not_found', 'Session not found or expired') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(t.all()).toMatch(/expired/i);
      expect(t.all()).toContain(`${LOGIN_COMMAND} again`);
    });

    it('a session past its expires_at stops polling', async () => {
      let clock = Date.parse('2026-10-13T14:00:00Z');
      const pending = { ...verifiedPoll('telegram'), status: 'pending' };
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: { ...loginStart.telegram, expires_at: expiresIn(4) } },
        { method: 'GET', path: /\/api\/v1\/auth\/sessions\//, body: pending },
        { method: 'GET', path: /\/api\/v1\/auth\/sessions\//, body: pending },
        { method: 'GET', path: /\/api\/v1\/auth\/sessions\//, body: pending },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      const code = await runCommand('login', ['--channel', 'telegram'], {
        baseUrl: BASE, envKey: undefined, io: t.io, file, hostname, now: () => clock,
        sleep: async (ms) => { clock += ms; },
      });

      expect(code).toBe(1);
      expect(t.all()).toMatch(/expired/i);
    });

    it('transient poll failures are ridden out', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, status: 503, body: err('service_unavailable', 'down') },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, status: 429, body: err('rate_limited', 'slow down') },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: verifiedPoll('telegram'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(tail.answers);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
    });

    it('challenge_delivery_failed says so and exits non-zero', async () => {
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 503, body: err('challenge_delivery_failed', 'We could not send the email. Try again or use another channel.') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      expect(await run('login', ['--email', 'alex@example.com'], t.io)).toBe(1);
      expect(t.all()).toContain('We could not send the email');
      expect(api.remaining()).toBe(0);
    });

    it('asks for the channel when --channel is not given', async () => {
      const tail = stepUpAndMint();
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.whatsapp },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.whatsapp.id}`, body: verifiedPoll('whatsapp'), cookies: true },
        ...tail.steps,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['2', ...tail.answers]);

      expect(await run('login', [], t.io)).toBe(0);
      expect(api.seen[0].body).toEqual({ channel: 'whatsapp' });
    });

    it('needs an interactive terminal and sends nothing without one', async () => {
      const api = fakeApi([]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([], false);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(2);
      expect(api.fetchMock).not.toHaveBeenCalled();
      expect(t.all()).toMatch(/interactive terminal/i);
    });

    it('rejects unknown flags and channels as usage errors', async () => {
      const api = fakeApi([]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      expect(await run('login', ['--bogus'], fakeIO([]).io)).toBe(2);
      expect(await run('login', ['--channel', 'pigeon'], fakeIO([]).io)).toBe(2);
      expect(await run('logout', ['--channel', 'sms'], fakeIO([]).io)).toBe(2);
      expect(api.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the api_key_create step-up', () => {
    function loggedIn(): Step[] {
      return [
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: verifiedPoll('telegram'), cookies: true },
      ];
    }
    const mint: Step = { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated };

    it('lists the login channel last and never sends targets', async () => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
        mint,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      const menu = t.out.join('\n');
      expect(menu.indexOf('WhatsApp')).toBeLessThan(menu.indexOf('Telegram (used to log in)'));
      expect(api.seen[2].body).toEqual({ action_type: 'api_key_create', channel: 'whatsapp' });
      expect(t.out.join('\n')).toContain('QR-2FA');
    });

    it.each([
      ['same_channel', 'Choose a different channel than the one you logged in with.'],
      ['no_email', 'Add an email address to your account first.'],
      ['no_other_email', 'Your only email is the one you logged in with.'],
      ['invalid_email', 'Invalid email selection.'],
    ])('%s prints the server message and asks again', async (code, message) => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', status: 400, body: err(code, message) },
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
        mint,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['3', '1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(t.all()).toContain(message);
      expect(t.questions.length).toBe(2);
    });

    it('requires_email_selection lists the emails and restarts with the chosen email_id', async () => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', body: {
          requires_email_selection: true,
          available_emails: [
            { id: 'e1e1e1e1e1e1e1e1e1e1e1e1', email: 'work@example.com', is_primary: true },
            { id: 'e2e2e2e2e2e2e2e2e2e2e2e2', email: 'home@example.com', is_primary: false },
          ],
          message: 'Please select which email to use for 2FA verification.',
        } },
        { method: 'POST', path: '/api/v1/me/2fa/start', body: twofaEmail },
        { method: 'POST', path: '/api/v1/me/2fa/2fa_email1/verify', status: 400, body: err('invalid_code', 'Invalid verification code') },
        { method: 'POST', path: '/api/v1/me/2fa/2fa_email1/verify', body: { status: 'verified', verified_at: 'x', grant_expires_at: 'y', grant_single_use: true } },
        mint,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      // menu: 1 WhatsApp, 2 SMS, 3 Email, 4 Telegram → Email; then the second address; then two codes
      const t = fakeIO(['3', '2', '111111', '222222']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(api.seen[3].body).toEqual({ action_type: 'api_key_create', channel: 'email', email_id: 'e2e2e2e2e2e2e2e2e2e2e2e2' });
      expect(api.seen[5].body).toEqual({ code: '222222' });
      expect(t.out.join('\n')).toContain('home@example.com');
    });

    it('an email selection that lists no address ends the login instead of asking forever', async () => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { requires_email_selection: true, available_emails: [], message: 'Please select which email to use for 2FA verification.' } },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['3']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(t.all()).toMatch(/listed none/i);
    });

    it('prints the advice when the account has only one method', async () => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, second_method_recommended: true } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
        mint,
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['4']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(t.all()).toMatch(/second sign-in method/i);
    });

    it('a step-up that disappears (404) ends the login', async () => {
      const api = fakeApi([
        ...loggedIn(),
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', status: 404, body: err('not_found', '2FA session not found or expired') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(t.all()).toMatch(/expired/i);
    });
  });

  describe('ending the sign-in session', () => {
    // The verified poll hands the CLI a refresh token, so the session it signed in with stays on the
    // account's signed-in devices for days unless the CLI ends it (l-fix-mcp-1-7-1-followups).
    const signedIn: Step[] = [
      { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
      { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: verifiedPoll('telegram'), cookies: true },
      { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
      { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
    ];
    const mint: Step = { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated };
    const logouts = (seen: Seen[]) => seen.filter((s) => s.method === 'POST' && s.path === LOGOUT_PATH);

    it('logs out last, with the session, once the key is minted and saved', async () => {
      let savedAtLogout: StoredCredential | undefined;
      const api = fakeApi([...signedIn, mint], { onLogout: () => { savedAtLogout = saved()[BASE]; } });
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(api.remaining()).toBe(0);
      const last = api.seen[api.seen.length - 1];
      expect(last).toMatchObject({ method: 'POST', path: LOGOUT_PATH });
      expect(last.headers.Authorization).toBe(`Bearer ${SESSION_JWT}`);
      expect(logouts(api.seen)).toHaveLength(1);
      expect(api.seen[api.seen.length - 2]).toMatchObject({ method: 'POST', path: '/api/v1/me/api-keys' });
      expect(savedAtLogout?.api_key).toBe(SECRET_KEY);
      expect(t.err).toEqual([]);
    });

    it.each([
      ['a network failure', 'network' as const],
      ['a refusal (401)', 401],
      ['a server error (500)', 500],
    ])('a logout that fails with %s keeps the saved key and exit 0, and says where to sign it out', async (_label, logout) => {
      const api = fakeApi([...signedIn, mint], { logout });
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(logouts(api.seen)).toHaveLength(1);
      expect(saved()[BASE].api_key).toBe(SECRET_KEY);
      expect(t.err).toHaveLength(1);
      expect(t.err[0]).toMatch(/sign-in session could not be ended/i);
      expect(t.err[0]).toMatch(/Signed-in devices/);
    });

    it('a mint refused after signing in still ends the session, and reports the refusal', async () => {
      const api = fakeApi([
        ...signedIn,
        { method: 'POST', path: '/api/v1/me/api-keys', status: 403, body: err('account_scheduled_for_deletion', 'This account is scheduled for deletion. Cancel the deletion to continue.') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(logouts(api.seen)).toHaveLength(1);
      expect(api.seen[api.seen.length - 1].headers.Authorization).toBe(`Bearer ${SESSION_JWT}`);
      expect(t.all()).toContain('scheduled for deletion');
    });

    it('a key minted but not saved still ends the session, and names the key to revoke', async () => {
      // The read before login sees no file; once the key is minted the credentials path becomes a
      // directory, so the save fails for any user. A read-only directory would not: CI runs as root.
      const api = fakeApi([...signedIn, { ...mint, onRequest: () => mkdirSync(join(file, 'blocker'), { recursive: true }) }]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(logouts(api.seen)).toHaveLength(1);
      expect(t.all()).toContain('was created but could not be saved');
      expect(t.all()).toContain(keyCreated.id);
    });

    it('a login that never signed in sends no logout', async () => {
      const api = fakeApi([
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, status: 404, body: err('not_found', 'Session not found') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      expect(await run('login', ['--channel', 'telegram'], fakeIO([]).io)).toBe(1);
      expect(logouts(api.seen)).toHaveLength(0);
    });
  });

  describe('minting the key', () => {
    function upToGrant(): Step[] {
      return [
        { method: 'POST', path: '/api/v1/auth/sessions', status: 201, body: loginStart.telegram },
        { method: 'GET', path: `/api/v1/auth/sessions/${loginStart.telegram.id}`, body: verifiedPoll('telegram'), cookies: true },
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
      ];
    }

    it('defaultScopes is every resource group of validScopes as <group>:*', () => {
      const groups = [...new Set(validScopes.map((s) => s.split(':')[0]))];
      expect(defaultScopes()).toEqual(groups.map((g) => `${g}:*`));
      expect(defaultScopes()).toContain('billing:*');
      expect(defaultScopes()).toContain('auth:*');
      expect(defaultScopes().length).toBeLessThanOrEqual(20);
    });

    it('sends the name, production environment and every scope group by default', async () => {
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated }]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      expect(await run('login', ['--channel', 'telegram'], fakeIO(['1']).io)).toBe(0);
      expect(api.seen[4].body).toEqual({
        name: 'proof-mcp login · alex-laptop · 2026-10-13', environment: 'production', scopes: defaultScopes(),
      });
    });

    it('--test and --scopes change the request', async () => {
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: { ...keyCreated, key: 'pk_test_TESTTESTTESTTESTTESTTESTTEST', environment: 'test' } }]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      expect(await run('login', ['--channel', 'telegram', '--test', '--scopes', 'proofs:read, verifications:*'], fakeIO(['1']).io)).toBe(0);
      expect(api.seen[4].body).toEqual({
        name: 'proof-mcp login · alex-laptop · 2026-10-13', environment: 'test', scopes: ['proofs:read', 'verifications:*'],
      });
      expect(saved()[BASE].environment).toBe('test');
    });

    it('an unknown scope is a usage error before anything is sent', async () => {
      const api = fakeApi([]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      expect(await run('login', ['--channel', 'telegram', '--scopes', 'proofs:read,root:*'], t.io)).toBe(2);
      expect(t.all()).toContain('root:*');
      expect(api.fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the name within 100 characters on a long hostname', async () => {
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated }]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      const code = await runCommand('login', ['--channel', 'telegram'], {
        baseUrl: BASE, envKey: undefined, io: fakeIO(['1']).io, file, sleep: noSleep, now, hostname: () => 'h'.repeat(300),
      });

      expect(code).toBe(0);
      const name = (api.seen[4].body as { name: string }).name;
      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.startsWith('proof-mcp login · hhh')).toBe(true);
      expect(name.endsWith(' · 2026-10-13')).toBe(true);
    });

    it('a lapsed grant (403 2fa_required) runs the step-up once more, then mints', async () => {
      const api = fakeApi([
        ...upToGrant(),
        { method: 'POST', path: '/api/v1/me/api-keys', status: 403, body: err('2fa_required', 'Two-factor verification required', { action_type: 'api_key_create' }) },
        { method: 'POST', path: '/api/v1/me/2fa/start', body: { ...twofaTelegram, channel: 'whatsapp' } },
        { method: 'GET', path: '/api/v1/me/2fa/2fa_abcdef', body: twofaVerified },
        { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;

      expect(await run('login', ['--channel', 'telegram'], fakeIO(['1', '1']).io)).toBe(0);
      expect(api.remaining()).toBe(0);
    });

    it('an account scheduled for deletion gets the server message and a non-zero exit', async () => {
      const api = fakeApi([
        ...upToGrant(),
        { method: 'POST', path: '/api/v1/me/api-keys', status: 403, body: err('account_scheduled_for_deletion', 'This account is scheduled for deletion. Cancel the deletion to continue.') },
      ]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(t.all()).toContain('scheduled for deletion');
    });

    it('never tells anyone to run a bare proof-mcp command (that unscoped npm name is not ours)', async () => {
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 403, body: err('account_scheduled_for_deletion', 'Scheduled for deletion.') }]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);
      await run('login', ['--channel', 'telegram'], t.io);
      for (const usage of [['login', '--help'], ['logout', '--help'], ['status', '--help']]) await run(usage[0], usage.slice(1), t.io);
      await run('login', ['--channel', 'telegram'], fakeIO([], false).io);
      // The key's NAME carries "proof-mcp login · <host> · <date>": a label, not an instruction.
      expect(t.all()).not.toMatch(/proof-mcp login(?! ·)/);
      expect(t.all()).not.toMatch(/proof-mcp (logout|status)/);
    });

    it('never prints the key or the session token', async () => {
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated }]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(t.all()).not.toContain(SECRET_KEY);
      expect(t.all()).not.toContain(SESSION_JWT);
      expect(t.all()).not.toContain(REFRESH);
      expect(t.all()).toContain('pk_live_…WXYZ');
      expect(t.all()).toContain(keyCreated.id);
    });

    it('re-login replaces only this base URL and reports the previous key', async () => {
      const old: StoredCredential = {
        api_key: 'pk_live_OLDOLDOLDOLDOLDOLDOLDOLDOLD0000', key_id: '6720aaaaaaaaaaaaaaaaaaaa',
        name: 'proof-mcp login · old · 2026-10-01', environment: 'production', created_at: '2026-10-01T00:00:00Z',
      };
      const staging: StoredCredential = { ...old, key_id: '6720bbbbbbbbbbbbbbbbbbbb', environment: 'test', api_key: 'pk_test_STAGINGSTAGINGSTAGING1111' };
      saveCredential(file, BASE, old);
      saveCredential(file, 'https://api.staging.proof.holdings', staging);
      const api = fakeApi([...upToGrant(), { method: 'POST', path: '/api/v1/me/api-keys', status: 201, body: keyCreated }]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO(['1']);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(0);
      expect(saved()[BASE].key_id).toBe(keyCreated.id);
      expect(saved()['https://api.staging.proof.holdings']).toEqual(staging);
      expect(t.all()).toContain(old.key_id);
      expect(t.all()).toMatch(/revoke/i);
    });

    it('stops before any request when the existing file is malformed', async () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{not json');
      const api = fakeApi([]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      expect(await run('login', ['--channel', 'telegram'], t.io)).toBe(1);
      expect(api.fetchMock).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe('{not json');
    });
  });

  describe('base URL rule', () => {
    it('refuses plain http to a remote host before sending anything', async () => {
      const api = fakeApi([]);
      globalThis.fetch = api.fetchMock as typeof fetch;
      const t = fakeIO([]);

      expect(await run('login', ['--channel', 'telegram'], t.io, { baseUrl: 'http://api.example.com' })).toBe(2);
      expect(api.fetchMock).not.toHaveBeenCalled();
      expect(t.all()).toMatch(/https/i);
    });

    it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://api.staging.proof.holdings'])(
      'allows %s',
      async (baseUrl) => {
        const api = fakeApi([{ method: 'POST', path: '/api/v1/auth/sessions', status: 503, body: err('challenge_delivery_failed', 'nope') }]);
        globalThis.fetch = api.fetchMock as typeof fetch;
        expect(await run('login', ['--channel', 'telegram'], fakeIO([]).io, { baseUrl })).toBe(1);
        expect(api.fetchMock).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('logout and status', () => {
    const entry: StoredCredential = {
      api_key: SECRET_KEY, key_id: '6720cccccccccccccccccccc', name: 'proof-mcp login · alex-laptop · 2026-10-13',
      environment: 'production', created_at: '2026-10-13T14:01:05.000Z',
    };

    beforeEach(() => {
      globalThis.fetch = vi.fn(async () => { throw new Error('logout and status must not call the network'); }) as typeof fetch;
    });

    it('logout removes this base URL only and says the key still works until revoked', async () => {
      saveCredential(file, BASE, entry);
      saveCredential(file, 'https://api.staging.proof.holdings', { ...entry, environment: 'test', api_key: 'pk_test_STAGINGSTAGINGSTAGING1111' });
      const t = fakeIO([]);

      expect(await run('logout', [], t.io)).toBe(0);
      expect(Object.keys(saved())).toEqual(['https://api.staging.proof.holdings']);
      expect(t.all()).toContain(entry.key_id);
      expect(t.all()).toMatch(/until you revoke it/i);
      expect(t.all()).not.toContain(SECRET_KEY);
    });

    it('logout with nothing saved says so and exits 0', async () => {
      const t = fakeIO([]);
      expect(await run('logout', [], t.io)).toBe(0);
      expect(t.all()).toMatch(/nothing to remove/i);
    });

    it('status reports PROOF_API_KEY first, masked', async () => {
      saveCredential(file, BASE, entry);
      const t = fakeIO([]);
      expect(await run('status', [], t.io, { envKey: 'pk_live_FROMENVFROMENVFROMENV9999' })).toBe(0);
      expect(t.all()).toContain('PROOF_API_KEY');
      expect(t.all()).toContain('pk_live_…9999');
      expect(t.all()).not.toContain('pk_live_FROMENVFROMENVFROMENV9999');
    });

    it('status reports the saved key for this base URL', async () => {
      saveCredential(file, BASE, entry);
      const t = fakeIO([]);
      expect(await run('status', [], t.io)).toBe(0);
      expect(t.all()).toContain(entry.key_id);
      expect(t.all()).toContain('pk_live_…WXYZ');
      expect(t.all()).toContain(BASE);
      expect(t.all()).not.toContain(SECRET_KEY);
    });

    it('status with no key says how to log in', async () => {
      const t = fakeIO([]);
      expect(await run('status', [], t.io)).toBe(0);
      expect(t.all()).toContain(LOGIN_COMMAND);
    });

    it.each(['logout', 'status', 'login'])('%s with a PROOF_BASE_URL that is not a URL is a usage error, not a crash', async (command) => {
      saveCredential(file, BASE, entry);
      const t = fakeIO([]);
      expect(await run(command, command === 'login' ? ['--channel', 'telegram'] : [], t.io, { baseUrl: '' })).toBe(2);
      expect(t.all()).toContain('PROOF_BASE_URL');
    });

    it('status on a malformed file reports it and exits 1', async () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{not json');
      const t = fakeIO([]);
      expect(await run('status', [], t.io)).toBe(1);
      expect(t.all()).toContain(file);
    });
  });
});
