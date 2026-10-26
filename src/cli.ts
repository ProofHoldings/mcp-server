/**
 * `proof-mcp login | logout | status` — signing the stdio server in from a terminal.
 *
 * `login` is the `gh auth login` / `aws sso login` shape on OUR login channels, not OAuth: start an
 * ordinary login session (the one the website uses), show its challenge here — the deep link and the
 * server-rendered terminal QR for Telegram and WhatsApp, the text and the numbers for SMS, a code
 * prompt for email — then the `api_key_create` step-up on a second channel, then mint a real API key
 * and save it with `credentials.ts`. The phone approves; nothing opens a browser (this package may
 * not spawn processes).
 *
 * `server.ts` imports this module only when one of the three commands is given, so a normal server
 * start never loads it.
 */
import { hostname as osHostname } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ApiError, HttpClient } from './http.js';
import { validScopes } from './tools/api-keys.js';
import {
  CredentialsFileError,
  LOGIN_COMMAND,
  credentialKey,
  defaultCredentialsPath,
  maskKey,
  readCredentialsFile,
  removeCredential,
  saveCredential,
  type StoredCredential,
} from './credentials.js';

export interface CliIO {
  print(line: string): void;
  error(line: string): void;
  prompt(question: string): Promise<string>;
  isTTY: boolean;
}

export interface CommandOptions {
  baseUrl: string;
  envKey: string | undefined;
  io?: CliIO;
  file?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  hostname?: () => string;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const CHANNELS = ['telegram', 'whatsapp', 'sms', 'email'] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_LABEL: Record<Channel, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };

/** Both polls are limited to 60 requests a minute per IP; every 2 s stays well inside that. */
const POLL_INTERVAL_MS = 2_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NAME_MAX = 100;
/** The step-up refusals a different choice can fix — anything else ends the login. */
const STEP_UP_RETRY_CODES = new Set(['same_channel', 'no_email', 'no_other_email', 'invalid_email']);
const WRONG_CODE_CODES = new Set(['invalid_code', 'validation_error']);
const REVOKE_HINT = 'dashboard → API keys, or the revoke_api_key tool';

const USAGE: Record<string, string> = {
  login: [
    `Usage: ${LOGIN_COMMAND} [--channel telegram|whatsapp|sms|email] [--email <address>] [--test] [--scopes <a,b,…>]`,
    '',
    'Signs in with your phone or email, confirms on a second channel, creates an API key and saves it in',
    '~/.proof-holdings/credentials for the API in PROOF_BASE_URL (default https://api.proof.holdings).',
    'The MCP server uses that key from its next start unless PROOF_API_KEY is set.',
    '',
    '  --channel   how to log in (asked when omitted)',
    '  --email     log in by email with this address',
    '  --test      create a test key (pk_test_) instead of a live one',
    '  --scopes    comma-separated scopes instead of full access',
  ].join('\n'),
  logout: 'Usage: npx @proof-holdings/mcp-server logout\n\nRemoves the key the login command saved for this API from ~/.proof-holdings/credentials.\nThe key keeps working until you revoke it.',
  status: 'Usage: npx @proof-holdings/mcp-server status\n\nShows which API key the MCP server would start with, and where it comes from.',
};

/** Ends the login with a message for the person; anything else thrown is a bug and propagates. */
class LoginFailed extends Error {}

/** Every resource group of the scope list as `<group>:*` — full access, the default Alex chose. */
export function defaultScopes(): string[] {
  return [...new Set(validScopes.map((scope) => scope.split(':')[0]))].map((group) => `${group}:*`);
}

/**
 * One readline interface per question, closed after it: between questions (while polling) stdin is
 * left alone, so Ctrl+C is an ordinary SIGINT. DURING a question readline owns Ctrl+C and, with no
 * listener, only pauses the stream — the person would be stuck at the prompt — hence the handler.
 */
function terminalIO(): CliIO {
  return {
    print: (line) => { process.stdout.write(`${line}\n`); },
    error: (line) => { process.stderr.write(`${line}\n`); },
    prompt: async (question) => {
      const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => {
        rl.close();
        process.stdout.write('\n');
        process.exit(130);
      });
      try {
        return await rl.question(question);
      } catch (e) {
        // Ctrl+D (end of input) rejects the question with ABORT_ERR: a cancel, like Ctrl+C above.
        if ((e as NodeJS.ErrnoException).code === 'ABORT_ERR') {
          process.stdout.write('\n');
          process.exit(130);
        }
        throw e;
      } finally {
        rl.close();
      }
    },
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

export async function runCommand(command: string, argv: string[], opts: CommandOptions): Promise<number> {
  const io = opts.io ?? terminalIO();
  const ctx: Context = {
    io,
    baseUrl: opts.baseUrl,
    envKey: opts.envKey || undefined,
    file: opts.file ?? defaultCredentialsPath(),
    sleep: opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: opts.now ?? Date.now,
    hostname: opts.hostname ?? osHostname,
  };
  if (command === 'login') return login(ctx, argv);
  if (command === 'logout') return logout(ctx, argv);
  if (command === 'status') return status(ctx, argv);
  io.error(`Unknown command: ${command}. Commands: login, logout, status.`);
  return EXIT_USAGE;
}

interface Context {
  io: CliIO;
  baseUrl: string;
  envKey: string | undefined;
  file: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  hostname: () => string;
}

// ── login ───────────────────────────────────────────────────────────────────────────────────────

interface LoginFlags {
  channel?: string;
  email?: string;
  test?: boolean;
  scopes?: string;
  help?: boolean;
}

function parseLoginFlags(argv: string[]): LoginFlags {
  return parseArgs({
    args: argv,
    options: {
      channel: { type: 'string' },
      email: { type: 'string' },
      test: { type: 'boolean' },
      scopes: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

async function login(ctx: Context, argv: string[]): Promise<number> {
  const { io } = ctx;
  let flags: LoginFlags;
  try {
    flags = parseLoginFlags(argv);
  } catch (e) {
    io.error(`${(e as Error).message}\n\n${USAGE.login}`);
    return EXIT_USAGE;
  }
  if (flags.help) {
    io.print(USAGE.login);
    return EXIT_OK;
  }

  // Everything that can be refused without the network is refused before it.
  let url: URL;
  try {
    url = new URL(ctx.baseUrl);
  } catch {
    io.error(`PROOF_BASE_URL is not a URL: ${JSON.stringify(ctx.baseUrl)}`);
    return EXIT_USAGE;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    io.error(
      `The login sends sign-in codes and your session to ${ctx.baseUrl}, so it needs https:// ` +
        '(plain http is allowed only for localhost).',
    );
    return EXIT_USAGE;
  }
  if (flags.channel !== undefined && !(CHANNELS as readonly string[]).includes(flags.channel)) {
    io.error(`--channel must be one of ${CHANNELS.join(', ')} (got "${flags.channel}").`);
    return EXIT_USAGE;
  }
  if (flags.email !== undefined && flags.channel !== undefined && flags.channel !== 'email') {
    io.error('--email logs in by email; it cannot be combined with another --channel.');
    return EXIT_USAGE;
  }
  let scopes = defaultScopes();
  if (flags.scopes !== undefined) {
    scopes = flags.scopes.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = scopes.filter((s) => !(validScopes as readonly string[]).includes(s));
    if (scopes.length === 0 || unknown.length > 0) {
      io.error(
        scopes.length === 0
          ? '--scopes needs at least one scope.'
          : `Unknown scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Valid scopes: ${validScopes.join(', ')}.`,
      );
      return EXIT_USAGE;
    }
  }
  if (!io.isTTY) {
    io.error(
      'The login needs an interactive terminal: it asks which channel confirms the new key and, for email, ' +
        'for the code. Run it in a terminal, or put an existing key in PROOF_API_KEY.',
    );
    return EXIT_USAGE;
  }
  // A file we cannot read is never overwritten: it may hold keys for other APIs.
  try {
    readCredentialsFile(ctx.file);
  } catch (e) {
    if (!(e instanceof CredentialsFileError)) throw e;
    io.error(`${e.message}. Fix or delete it, then run ${LOGIN_COMMAND} again.`);
    return EXIT_FAILED;
  }

  // No key and no retries: the login routes are public, `captureSetCookie` keeps the session the
  // verified poll sets, and the 2FA and key routes then ride it. A retried POST would start a second
  // login or, worse, mint a second key whose first copy nobody saw.
  const http = new HttpClient({ baseUrl: ctx.baseUrl, maxRetries: 0 });

  try {
    const channel = (flags.channel as Channel | undefined) ?? (flags.email !== undefined ? 'email' : await choose(
      io,
      'Log in with:',
      CHANNELS.map((c) => ({ label: CHANNEL_LABEL[c], value: c })),
    ));
    try {
      await logIn(ctx, http, channel, flags.email);
      io.print('Logged in.');
      return await mintAndSave(ctx, http, io, channel, flags.test, scopes);
    } finally {
      // The verified poll hands this client a refresh token, so the session would stay on the
      // account's signed-in devices for days with nobody holding it. End it on every return path.
      if (http.hasSessionToken()) await endSignInSession(io, http);
    }
  } catch (e) {
    if (e instanceof LoginFailed) {
      io.error(e.message);
      return EXIT_FAILED;
    }
    throw e;
  }
}

/** Best-effort: a failed logout never changes the login's outcome, it only says where to finish it. */
async function endSignInSession(io: CliIO, http: HttpClient): Promise<void> {
  try {
    await http.post('/api/v1/auth/logout');
  } catch {
    io.error(
      'The sign-in session could not be ended. Sign it out in the dashboard: Settings → Security → Signed-in devices.',
    );
  }
}

async function mintAndSave(
  ctx: Context,
  http: HttpClient,
  io: CliIO,
  channel: Channel,
  test: boolean | undefined,
  scopes: string[],
): Promise<number> {
  const environment = test ? 'test' : 'production';
  const name = keyName(ctx.hostname(), ctx.now());
  await stepUp(ctx, http, channel);
  const key = await mintKey(ctx, http, { name, environment, scopes }, () => stepUp(ctx, http, channel));

  const entry: StoredCredential = {
    api_key: key.key,
    key_id: key.id,
    name: key.name ?? name,
    environment: key.environment ?? environment,
    created_at: key.created_at ?? new Date(ctx.now()).toISOString(),
  };
  let previous: StoredCredential | undefined;
  try {
    previous = saveCredential(ctx.file, ctx.baseUrl, entry);
  } catch (e) {
    // The key exists on the server but is not saved: say which one, so it can be revoked.
    throw new LoginFailed(
      `The key "${entry.name}" (${entry.key_id}) was created but could not be saved: ${(e as Error).message}. ` +
        `Revoke it (${REVOKE_HINT}) and run ${LOGIN_COMMAND} again.`,
    );
  }

  io.print('');
  io.print(
    `Saved API key "${entry.name}" (${entry.key_id}, ${maskKey(entry.api_key)}${entry.environment === 'test' ? ', test' : ''}) ` +
      `for ${credentialKey(ctx.baseUrl)} in ${ctx.file}.`,
  );
  io.print('The MCP server uses it from its next start; PROOF_API_KEY, when set, takes precedence.');
  if (previous) {
    io.print(
      `It replaces the key saved earlier, "${previous.name}" (${previous.key_id}), which still works until you revoke it: ${REVOKE_HINT}.`,
    );
  }
  return EXIT_OK;
}

/** `proof-mcp login · <host> · <date>`, cut to the API's 100-character limit by shortening the host. */
function keyName(host: string, now: number): string {
  const prefix = 'proof-mcp login · ';
  const suffix = ` · ${new Date(now).toISOString().slice(0, 10)}`;
  return `${prefix}${(host || 'this computer').slice(0, NAME_MAX - prefix.length - suffix.length)}${suffix}`;
}

async function choose<T>(io: CliIO, title: string, options: Array<{ label: string; value: T }>): Promise<T> {
  io.print('');
  io.print(title);
  options.forEach((option, i) => io.print(`  ${i + 1}) ${option.label}`));
  for (;;) {
    const answer = Number((await io.prompt(`Choose 1-${options.length}: `)).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return options[answer - 1].value;
    io.error(`Type a number from 1 to ${options.length}.`);
  }
}

interface SmsDid {
  did?: string;
  label?: string;
  flag?: string;
  qr_text?: string;
}

/** The display fields login starts and 2FA starts share. */
interface Challenge {
  channel?: string;
  expires_at?: string;
  deep_link?: string;
  qr_text?: string;
  instructions?: string;
  sms_message?: string;
  sms_dids?: Record<string, SmsDid | undefined>;
  suggested_region?: string;
  email?: string;
}

interface LoginStart extends Challenge {
  id: string;
}

interface StepUpStart extends Challenge {
  session_id?: string;
  second_method_recommended?: boolean;
  requires_email_selection?: boolean;
  available_emails?: Array<{ id: string; email: string; is_primary?: boolean }>;
}

interface CreatedKey {
  id: string;
  key: string;
  name?: string;
  environment?: 'production' | 'test';
  created_at?: string;
}

function failure(e: unknown, what: string): LoginFailed {
  if (e instanceof ApiError) return new LoginFailed(`${what}: ${e.message}`);
  throw e;
}

function isTransient(e: ApiError): boolean {
  return e.statusCode === 0 || e.statusCode === 429 || e.statusCode >= 500;
}

/** Print a messenger or SMS challenge. Email challenges are handled by the code prompts. */
function showChallenge(io: CliIO, r: Challenge): void {
  io.print('');
  if (r.deep_link) {
    io.print(r.instructions ?? 'Open this link on your phone:');
    io.print(`  ${r.deep_link}`);
    if (r.qr_text) {
      io.print('');
      io.print('Or scan this code with your phone:');
      io.print(r.qr_text);
    }
    return;
  }
  if (r.sms_message) {
    const dids = Object.entries(r.sms_dids ?? {})
      .filter((entry): entry is [string, SmsDid & { did: string }] => typeof entry[1]?.did === 'string' && entry[1].did !== '')
      .sort(([a], [b]) => Number(b === r.suggested_region) - Number(a === r.suggested_region));
    if (dids.length === 0) throw new LoginFailed('The server returned no number to text. Try another channel.');
    io.print(`Text this message from your phone: ${r.sms_message}`);
    io.print('to one of these numbers:');
    for (const [, d] of dids) io.print(`  ${d.flag ? `${d.flag} ` : ''}${d.label ?? ''}: ${d.did}`);
    const first = dids[0][1];
    if (first.qr_text) {
      io.print('');
      io.print(`Or scan this code to open the message to ${first.label ?? first.did}:`);
      io.print(first.qr_text);
    }
    return;
  }
  throw new LoginFailed('The server returned a challenge this version cannot show. Try another channel.');
}

/** Poll until `verified`; a 404 or the deadline means the challenge expired. Network blips are ridden out. */
async function waitForVerified(ctx: Context, http: HttpClient, path: string, expiresAt: string | undefined, expired: string): Promise<void> {
  const deadline = Date.parse(expiresAt ?? '') || ctx.now() + 600_000;
  ctx.io.print('Waiting for your confirmation… (Ctrl+C to cancel)');
  for (;;) {
    try {
      const r = await http.get<{ status?: string }>(path);
      if (r.status === 'verified') return;
      if (r.status === 'expired' || r.status === 'failed') throw new LoginFailed(expired);
    } catch (e) {
      if (e instanceof LoginFailed) throw e;
      if (!(e instanceof ApiError)) throw e;
      if (e.statusCode === 404) throw new LoginFailed(expired);
      if (!isTransient(e)) throw failure(e, 'Could not check the confirmation');
    }
    if (ctx.now() >= deadline) throw new LoginFailed(expired);
    await ctx.sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Prompt for a mailed code until it is accepted. An empty answer checks the status instead, for
 * someone who opened the link in the email rather than typing the code.
 */
async function enterCode(ctx: Context, http: HttpClient, submitPath: string, statusPath: string, expired: string): Promise<void> {
  const { io } = ctx;
  io.print('Type the code from the email. If you opened the link in the email instead, just press Enter.');
  for (;;) {
    const code = (await io.prompt('Code: ')).trim();
    try {
      if (!code) {
        const r = await http.get<{ status?: string }>(statusPath);
        if (r.status === 'verified') return;
        io.print('Not confirmed yet. Type the code, or press Enter once you have opened the link.');
        continue;
      }
      await http.post(submitPath, { code });
      return;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (WRONG_CODE_CODES.has(e.code)) {
        io.error('Wrong code. Try again.');
        continue;
      }
      if (e.statusCode === 404) throw new LoginFailed(expired);
      throw failure(e, 'Could not check the code');
    }
  }
}

async function logIn(ctx: Context, http: HttpClient, channel: Channel, emailFlag: string | undefined): Promise<void> {
  const { io } = ctx;
  let email = emailFlag;
  while (channel === 'email' && (email === undefined || !email.includes('@'))) {
    if (email !== undefined) io.error('That does not look like an email address.');
    email = (await io.prompt('Email address: ')).trim();
  }
  let start: LoginStart;
  try {
    start = await http.post<LoginStart>('/api/v1/auth/sessions', channel === 'email' ? { channel, email } : { channel });
  } catch (e) {
    throw failure(e, 'Could not start the login');
  }
  const expired = `The login request expired before it was confirmed. Run ${LOGIN_COMMAND} again.`;
  const statusPath = `/api/v1/auth/sessions/${encodeURIComponent(start.id)}`;
  if (channel === 'email') {
    io.print('');
    io.print(`We sent a code to ${start.email ?? email}.`);
    await enterCode(ctx, http, `${statusPath}/submit`, statusPath, expired);
  } else {
    showChallenge(io, start);
    await waitForVerified(ctx, http, statusPath, start.expires_at, expired);
  }
  if (!http.hasSessionToken()) {
    throw new LoginFailed(`The login was confirmed, but no session came back. Run ${LOGIN_COMMAND} again.`);
  }
}

/** The `api_key_create` step-up, on a channel the person picks — the login channel offered last. */
async function stepUp(ctx: Context, http: HttpClient, loginChannel: Channel): Promise<void> {
  const { io } = ctx;
  const order: Channel[] = [...CHANNELS.filter((c) => c !== loginChannel), loginChannel];
  const options = order.map((c) => ({ label: c === loginChannel ? `${CHANNEL_LABEL[c]} (used to log in)` : CHANNEL_LABEL[c], value: c }));
  io.print('');
  io.print('Creating an API key needs one more confirmation, preferably on a different channel.');
  for (;;) {
    const channel = await choose(io, 'Confirm with:', options);
    let r: StepUpStart;
    try {
      // Never `targets`: the key routes consume an UNTARGETED grant, and a targeted one is refused.
      r = await http.post<StepUpStart>('/api/v1/me/2fa/start', { action_type: 'api_key_create', channel });
      if (r.requires_email_selection) {
        if (!r.available_emails?.length) throw new LoginFailed('The server asked which email to use but listed none. Choose another channel.');
        const emailId = await choose(
          io,
          'Send the code to:',
          (r.available_emails ?? []).map((e) => ({ label: `${e.email}${e.is_primary ? ' (primary)' : ''}`, value: e.id })),
        );
        r = await http.post<StepUpStart>('/api/v1/me/2fa/start', { action_type: 'api_key_create', channel, email_id: emailId });
      }
    } catch (e) {
      if (e instanceof ApiError && STEP_UP_RETRY_CODES.has(e.code)) {
        io.error(e.message);
        continue;
      }
      throw failure(e, 'Could not start the confirmation');
    }
    if (!r.session_id) throw new LoginFailed(`The server did not start a confirmation. Run ${LOGIN_COMMAND} again.`);
    if (r.second_method_recommended) {
      io.print(
        'Your account has a single sign-in method, so this confirmation uses it again. Add a second sign-in ' +
          'method in the dashboard so future confirmations can use a different channel.',
      );
    }
    const expired = `The confirmation expired before it was approved. Run ${LOGIN_COMMAND} again.`;
    const statusPath = `/api/v1/me/2fa/${encodeURIComponent(r.session_id)}`;
    if ((r.channel ?? channel) === 'email') {
      io.print('');
      io.print(`We sent a code to ${r.email ?? 'your email'}.`);
      await enterCode(ctx, http, `${statusPath}/verify`, statusPath, expired);
    } else {
      showChallenge(io, r);
      await waitForVerified(ctx, http, statusPath, r.expires_at, expired);
    }
    return;
  }
}

async function mintKey(
  ctx: Context,
  http: HttpClient,
  body: { name: string; environment: 'production' | 'test'; scopes: string[] },
  stepUpAgain: () => Promise<void>,
): Promise<CreatedKey> {
  for (let attempt = 0; ; attempt++) {
    try {
      const key = await http.post<CreatedKey>('/api/v1/me/api-keys', body);
      if (typeof key.key !== 'string' || !key.key.startsWith('pk_') || typeof key.id !== 'string') {
        throw new LoginFailed(`The server answered without a key. Check the dashboard → API keys, then run ${LOGIN_COMMAND} again.`);
      }
      return key;
    } catch (e) {
      if (e instanceof LoginFailed) throw e;
      if (e instanceof ApiError && e.code === '2fa_required' && attempt === 0) {
        ctx.io.print('The confirmation lapsed before the key was created. Confirm once more.');
        await stepUpAgain();
        continue;
      }
      if (e instanceof ApiError && (e.code === 'timeout' || e.code === 'network_error')) {
        throw new LoginFailed(
          'The request to create the key got no answer, so the key may or may not exist. Check the dashboard → ' +
            `API keys (revoke any key you do not recognise), then run ${LOGIN_COMMAND} again.`,
        );
      }
      throw failure(e, 'Could not create the API key');
    }
  }
}

// ── logout / status ─────────────────────────────────────────────────────────────────────────────

function parseHelpOnly(ctx: Context, command: 'logout' | 'status', argv: string[]): number | 'run' {
  let help: boolean | undefined;
  try {
    help = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }).values.help;
  } catch (e) {
    ctx.io.error(`${(e as Error).message}\n\n${USAGE[command]}`);
    return EXIT_USAGE;
  }
  if (help) {
    ctx.io.print(USAGE[command]);
    return EXIT_OK;
  }
  return 'run';
}

/** The entry name for PROOF_BASE_URL, or `undefined` after saying it is not a URL. */
function baseUrlKey(ctx: Context): string | undefined {
  try {
    return credentialKey(ctx.baseUrl);
  } catch {
    ctx.io.error(`PROOF_BASE_URL is not a URL: ${JSON.stringify(ctx.baseUrl)}`);
    return undefined;
  }
}

function logout(ctx: Context, argv: string[]): number {
  const parsed = parseHelpOnly(ctx, 'logout', argv);
  if (parsed !== 'run') return parsed;
  const { io } = ctx;
  const where = baseUrlKey(ctx);
  if (where === undefined) return EXIT_USAGE;
  let removed: StoredCredential | undefined;
  try {
    removed = removeCredential(ctx.file, ctx.baseUrl);
  } catch (e) {
    if (!(e instanceof CredentialsFileError)) throw e;
    io.error(`${e.message}. Fix or delete it by hand.`);
    return EXIT_FAILED;
  }
  if (!removed) {
    io.print(`No key is saved for ${where}; nothing to remove.`);
    return EXIT_OK;
  }
  io.print(`Removed the saved key "${removed.name}" (${removed.key_id}, ${maskKey(removed.api_key)}) for ${where}.`);
  io.print(`The key itself still works until you revoke it: ${REVOKE_HINT}.`);
  if (ctx.envKey) io.print('PROOF_API_KEY is still set in this environment, so a server started from here keeps a key.');
  return EXIT_OK;
}

function status(ctx: Context, argv: string[]): number {
  const parsed = parseHelpOnly(ctx, 'status', argv);
  if (parsed !== 'run') return parsed;
  const { io } = ctx;
  const where = baseUrlKey(ctx);
  if (where === undefined) return EXIT_USAGE;
  let saved: StoredCredential | undefined;
  let problem: string | undefined;
  try {
    saved = readCredentialsFile(ctx.file)?.credentials[where];
  } catch (e) {
    if (!(e instanceof CredentialsFileError)) throw e;
    problem = e.message;
  }
  if (ctx.envKey) {
    io.print(`The MCP server uses PROOF_API_KEY (${maskKey(ctx.envKey)}) for ${where}.`);
    if (saved) io.print(`The key saved by the login command ("${saved.name}", ${saved.key_id}) is ignored while PROOF_API_KEY is set.`);
  } else if (saved) {
    io.print(`The MCP server uses the key saved by the login command for ${where}:`);
    io.print(`  "${saved.name}" (${saved.key_id}, ${maskKey(saved.api_key)}, ${saved.environment}), created ${saved.created_at}`);
    io.print(`  saved in ${ctx.file}`);
  } else if (!problem) {
    io.print(`No API key for ${where}: PROOF_API_KEY is not set and no login is saved for it.`);
    io.print(`Run ${LOGIN_COMMAND} to sign in.`);
  }
  if (problem) {
    io.error(`${problem}. Fix or delete it, then run ${LOGIN_COMMAND}.`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}
