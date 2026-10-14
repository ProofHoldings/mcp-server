/**
 * The key `proof-mcp login` saves, and how the stdio server finds it again.
 *
 * One JSON file, `~/.proof-holdings/credentials`, holding one entry per API base URL:
 *
 *   { "version": 1, "credentials": { "https://api.proof.holdings": { api_key, key_id, name, environment, created_at } } }
 *
 * Keyed by base URL so a key minted against staging (`PROOF_BASE_URL=https://api.staging…`) is never
 * sent to production, and a production login does not erase the staging one. `PROOF_API_KEY` always
 * wins over the file, the way `AWS_ACCESS_KEY_ID` wins over `~/.aws/credentials`.
 *
 * Node built-ins only: `server.ts` imports this on every start, before it knows whether a key exists,
 * so nothing here may pull in the command module or a third-party package.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * How every user-facing text names the login. Never a bare `proof-mcp login`: through `npx` (how most
 * clients run this package) `proof-mcp` is not on PATH, and `npx proof-mcp` resolves an UNSCOPED npm
 * package somebody else publishes — the instruction would run a stranger's code exactly when the
 * person is handling sign-in codes. `authBoundary.ts` imports nothing, so it and `http.ts` carry the
 * same literal; `__tests__/login-wording.test.ts` holds them to this one.
 */
export const LOGIN_COMMAND = 'npx @proof-holdings/mcp-server login';

export interface StoredCredential {
  api_key: string;
  key_id: string;
  name: string;
  environment: 'production' | 'test';
  created_at: string;
}

export interface CredentialsFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

/** The file exists but cannot be read or is not a credentials file this version understands. */
export class CredentialsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsFileError';
  }
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.proof-holdings', 'credentials');
}

/** The entry name for a base URL: origin plus path, no trailing slash (`https://api.proof.holdings`). */
export function credentialKey(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** `pk_live_…WXYZ` — enough to tell keys apart, never enough to use one. */
export function maskKey(key: string): string {
  const prefix = /^pk_(live|test)_/.exec(key)?.[0] ?? '';
  const rest = key.slice(prefix.length);
  return rest.length > 8 ? `${prefix}…${rest.slice(-4)}` : `${prefix}…`;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.api_key === 'string' && v.api_key.startsWith('pk_') &&
    typeof v.key_id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.created_at === 'string' &&
    (v.environment === 'production' || v.environment === 'test')
  );
}

/** The parsed file, `null` when there is none, `CredentialsFileError` when it is unreadable or malformed. */
export function readCredentialsFile(file: string): CredentialsFile | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CredentialsFileError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsFileError(`${file} is not valid JSON`);
  }
  const p = parsed as Partial<CredentialsFile> | null;
  if (!p || typeof p !== 'object' || p.version !== 1 || !p.credentials || typeof p.credentials !== 'object' || Array.isArray(p.credentials)) {
    throw new CredentialsFileError(`${file} is not a version 1 Proof credentials file`);
  }
  for (const [key, value] of Object.entries(p.credentials)) {
    if (!isStoredCredential(value)) throw new CredentialsFileError(`${file} has a malformed entry for ${key}`);
  }
  return p as CredentialsFile;
}

/**
 * Write the whole file: a temporary file opened 0600 next to it, then a rename over the old one, so a
 * crash leaves either the old file or the new one and never half of either. A NEW directory is made
 * 0700; an existing one (the self-refusal cache shares `~/.proof-holdings`) keeps its mode.
 */
function writeCredentialsFile(file: string, contents: CredentialsFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Save `cred` for `baseUrl`, keeping every other entry. Returns the entry it replaced, if any. */
export function saveCredential(file: string, baseUrl: string, cred: StoredCredential): StoredCredential | undefined {
  const current = readCredentialsFile(file) ?? { version: 1, credentials: {} };
  const key = credentialKey(baseUrl);
  const previous = current.credentials[key];
  writeCredentialsFile(file, { version: 1, credentials: { ...current.credentials, [key]: cred } });
  return previous;
}

/** Remove the entry for `baseUrl`. Returns what it removed; writes nothing when there was nothing. */
export function removeCredential(file: string, baseUrl: string): StoredCredential | undefined {
  const current = readCredentialsFile(file);
  const key = credentialKey(baseUrl);
  const previous = current?.credentials[key];
  if (!current || !previous) return undefined;
  const { [key]: _removed, ...rest } = current.credentials;
  writeCredentialsFile(file, { version: 1, credentials: rest });
  return previous;
}

export interface ResolvedKey {
  apiKey?: string;
  source: 'env' | 'file' | 'none';
  entry?: StoredCredential;
  /** One line for stderr when the file exists but could not be used. */
  notice?: string;
}

/**
 * The key the stdio server starts with: `PROOF_API_KEY` when set and non-empty, otherwise the saved
 * entry for exactly this base URL, otherwise none (public mode). A broken file never stops the server
 * from starting — it becomes a notice, and the server runs as if there were no file.
 */
export function resolveApiKey(opts: { envKey: string | undefined; baseUrl: string; file: string }): ResolvedKey {
  if (opts.envKey) return { apiKey: opts.envKey, source: 'env' };
  let contents: CredentialsFile | null;
  try {
    contents = readCredentialsFile(opts.file);
  } catch (e) {
    return {
      source: 'none',
      notice: `Notice: ignoring the saved credentials — ${(e as Error).message}. Fix or delete ${opts.file}, then run ${LOGIN_COMMAND}.`,
    };
  }
  if (!contents) return { source: 'none' };
  // `PROOF_BASE_URL: ""` is a common placeholder in client configs, and `??` keeps it. Before this
  // file existed such a server still started; it must not start crashing because a file now exists.
  let key: string;
  try {
    key = credentialKey(opts.baseUrl);
  } catch {
    return { source: 'none', notice: `Notice: PROOF_BASE_URL is not a URL (${JSON.stringify(opts.baseUrl)}), so the saved credentials were not read.` };
  }
  const entry = contents.credentials[key];
  return entry ? { apiKey: entry.api_key, source: 'file', entry } : { source: 'none' };
}
