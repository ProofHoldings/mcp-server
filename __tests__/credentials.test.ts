import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CredentialsFileError,
  credentialKey,
  maskKey,
  readCredentialsFile,
  removeCredential,
  resolveApiKey,
  saveCredential,
  type StoredCredential,
} from '../src/credentials.js';

const PROD = 'https://api.proof.holdings';
const STAGING = 'https://api.staging.proof.holdings';

function entry(overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    api_key: 'pk_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    key_id: '6720a1b2c3d4e5f6a7b8c9d0',
    name: 'proof-mcp login · laptop · 2026-10-13',
    environment: 'production',
    created_at: '2026-10-13T14:00:00.000Z',
    ...overrides,
  };
}

const posix = process.platform !== 'win32';

describe('credentials file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proof-cred-'));
    file = join(dir, 'home', '.proof-holdings', 'credentials');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('credentialKey', () => {
    it('is the origin plus path without a trailing slash', () => {
      expect(credentialKey('https://api.proof.holdings')).toBe('https://api.proof.holdings');
      expect(credentialKey('https://api.proof.holdings/')).toBe('https://api.proof.holdings');
      expect(credentialKey('https://API.Proof.Holdings:443/')).toBe('https://api.proof.holdings');
      expect(credentialKey('http://localhost:3000/proxy/')).toBe('http://localhost:3000/proxy');
    });
  });

  describe('maskKey', () => {
    it('keeps the environment prefix and the last four characters only', () => {
      expect(maskKey('pk_live_AAAAAAAAAAAAAAAAAAAAWXYZ')).toBe('pk_live_…WXYZ');
      expect(maskKey('pk_test_BBBBBBBBBBBBBBBBBBBB1234')).toBe('pk_test_…1234');
    });

    it('never returns more than four characters of an unrecognised value', () => {
      expect(maskKey('sk_something_secret_9876')).toBe('…9876');
      expect(maskKey('abc')).toBe('…');
    });
  });

  describe('readCredentialsFile', () => {
    it('returns null when the file does not exist', () => {
      expect(readCredentialsFile(file)).toBeNull();
    });

    it('refuses a file that is not valid JSON', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true });
      writeFileSync(file, '{not json');
      expect(() => readCredentialsFile(file)).toThrow(CredentialsFileError);
    });

    it('refuses a file with an unknown version or a malformed entry', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true });
      writeFileSync(file, JSON.stringify({ version: 2, credentials: {} }));
      expect(() => readCredentialsFile(file)).toThrow(CredentialsFileError);

      writeFileSync(file, JSON.stringify({ version: 1, credentials: { [PROD]: { ...entry(), api_key: 'not-a-key' } } }));
      expect(() => readCredentialsFile(file)).toThrow(CredentialsFileError);

      writeFileSync(file, JSON.stringify({ version: 1, credentials: { [PROD]: { ...entry(), environment: 'staging' } } }));
      expect(() => readCredentialsFile(file)).toThrow(CredentialsFileError);

      writeFileSync(file, JSON.stringify({ version: 1, credentials: [] }));
      expect(() => readCredentialsFile(file)).toThrow(CredentialsFileError);
    });
  });

  describe('saveCredential', () => {
    it('writes the documented shape, keyed by base URL', () => {
      expect(saveCredential(file, `${PROD}/`, entry())).toBeUndefined();
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      expect(parsed).toEqual({ version: 1, credentials: { [PROD]: entry() } });
    });

    it.runIf(posix)('creates the directory 0700 and the file 0600', () => {
      saveCredential(file, PROD, entry());
      expect(statSync(join(dir, 'home', '.proof-holdings')).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it.runIf(posix)('leaves the mode of an existing directory alone', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true, mode: 0o755 });
      saveCredential(file, PROD, entry());
      expect(statSync(join(dir, 'home', '.proof-holdings')).mode & 0o777).toBe(0o755);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('keeps other base URLs and returns the entry it replaced', () => {
      saveCredential(file, PROD, entry());
      saveCredential(file, STAGING, entry({ api_key: 'pk_test_STAGINGSTAGINGSTAGINGSTAG', environment: 'test', key_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' }));
      const replacement = entry({ api_key: 'pk_live_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEW', key_id: 'bbbbbbbbbbbbbbbbbbbbbbbb' });

      const previous = saveCredential(file, PROD, replacement);

      expect(previous).toEqual(entry());
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      expect(parsed.credentials[PROD]).toEqual(replacement);
      expect(parsed.credentials[STAGING].key_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('replaces the file by rename and leaves no temporary file behind', () => {
      saveCredential(file, PROD, entry());
      saveCredential(file, PROD, entry({ key_id: 'cccccccccccccccccccccccc' }));
      expect(readdirSync(join(dir, 'home', '.proof-holdings'))).toEqual(['credentials']);
    });

    it('refuses to overwrite a malformed file', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true });
      writeFileSync(file, '{not json');
      expect(() => saveCredential(file, PROD, entry())).toThrow(CredentialsFileError);
      expect(readFileSync(file, 'utf8')).toBe('{not json');
    });
  });

  describe('removeCredential', () => {
    it('removes only the given base URL and returns what it removed', () => {
      saveCredential(file, PROD, entry());
      saveCredential(file, STAGING, entry({ environment: 'test', api_key: 'pk_test_STAGINGSTAGINGSTAGINGSTAG' }));

      expect(removeCredential(file, PROD)).toEqual(entry());

      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(parsed.credentials)).toEqual([STAGING]);
    });

    it('returns undefined when there is nothing to remove, without creating a file', () => {
      expect(removeCredential(file, PROD)).toBeUndefined();
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('resolveApiKey', () => {
    it('uses PROOF_API_KEY when it is set, without reading the file', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true });
      writeFileSync(file, '{not json');
      expect(resolveApiKey({ envKey: 'pk_live_FROMENV', baseUrl: PROD, file })).toEqual({ apiKey: 'pk_live_FROMENV', source: 'env' });
    });

    it('falls through an empty PROOF_API_KEY to the saved key for this base URL', () => {
      saveCredential(file, PROD, entry());
      expect(resolveApiKey({ envKey: '', baseUrl: `${PROD}/`, file })).toEqual({
        apiKey: entry().api_key,
        source: 'file',
        entry: entry(),
      });
    });

    it('never uses a key saved for a different base URL', () => {
      saveCredential(file, STAGING, entry({ environment: 'test', api_key: 'pk_test_STAGINGSTAGINGSTAGINGSTAG' }));
      expect(resolveApiKey({ envKey: undefined, baseUrl: PROD, file })).toEqual({ source: 'none' });
    });

    it('reports no key when there is no file', () => {
      expect(resolveApiKey({ envKey: undefined, baseUrl: PROD, file })).toEqual({ source: 'none' });
    });

    it('turns a base URL that is not a URL into a notice instead of throwing', () => {
      saveCredential(file, PROD, entry());
      const result = resolveApiKey({ envKey: undefined, baseUrl: '', file });
      expect(result.source).toBe('none');
      expect(result.apiKey).toBeUndefined();
      expect(result.notice).toContain('PROOF_BASE_URL');
    });

    it('turns a malformed file into a notice and no key instead of throwing', () => {
      mkdirSync(join(dir, 'home', '.proof-holdings'), { recursive: true });
      writeFileSync(file, '{not json');
      const result = resolveApiKey({ envKey: undefined, baseUrl: PROD, file });
      expect(result.source).toBe('none');
      expect(result.apiKey).toBeUndefined();
      expect(result.notice).toContain(file);
    });
  });
});
