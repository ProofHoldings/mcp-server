/**
 * The built entrypoint, end to end: which invocations run a command and exit, which start the
 * server, and which key a started server picks up. Runs `dist/server.js`, so it needs a build first —
 * CI's MCP job builds before it tests; locally run `npm run build` (the suite is skipped without a
 * dist, rather than testing a stale one silently: a missing build is reported as skipped).
 *
 * HOME points at a temporary directory so the real `~/.proof-holdings/credentials` is never read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, '../dist/server.js');
const SAVED_KEY = 'pk_live_SAVEDSAVEDSAVEDSAVEDSAVED7777';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run to completion (commands), or until `until` appears on stderr and then stop it (a started server). */
function run(args: string[], home: string, until?: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.PROOF_API_KEY;
    delete env.PROOF_BASE_URL;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; stderr so far: ${stderr}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (until && stderr.includes(until)) child.kill();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function saveKey(home: string, baseUrl = 'https://api.proof.holdings', contents?: string): void {
  mkdirSync(join(home, '.proof-holdings'), { recursive: true });
  writeFileSync(
    join(home, '.proof-holdings', 'credentials'),
    contents ??
      JSON.stringify({
        version: 1,
        credentials: {
          [baseUrl]: {
            api_key: SAVED_KEY, key_id: '6720dddddddddddddddddddd', name: 'proof-mcp login · ci · 2026-10-13',
            environment: 'production', created_at: '2026-10-13T14:00:00.000Z',
          },
        },
      }),
  );
}

describe.skipIf(!existsSync(SERVER))('dist/server.js entrypoint', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proof-entry-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('`status` runs and exits without starting the server', async () => {
    const result = await run(['status'], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('npx @proof-holdings/mcp-server login');
    expect(result.stderr).not.toContain('public mode');
  });

  it('`status` reports a saved key masked', async () => {
    saveKey(home);
    const result = await run(['status'], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('pk_live_…7777');
    expect(result.stdout).not.toContain(SAVED_KEY);
  });

  it('`logout` removes the saved key and exits', async () => {
    saveKey(home);
    const result = await run(['logout'], home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('6720dddddddddddddddddddd');
  });

  it('a plain start uses the key saved for its base URL', async () => {
    saveKey(home);
    const result = await run([], home, 'Using the API key saved by');
    expect(result.stderr).toContain('(key 6720dddddddddddddddddddd)');
    expect(result.stderr).not.toContain('public mode');
    expect(result.stderr).not.toContain(SAVED_KEY);
  });

  it('a plain start ignores a key saved for another base URL', async () => {
    saveKey(home, 'https://api.staging.proof.holdings');
    const result = await run([], home, 'public mode');
    expect(result.stderr).not.toContain('Using the API key saved');
  });

  it('an argument that is not a command still starts the server', async () => {
    const result = await run(['--stdio'], home, 'public mode');
    expect(result.stderr).toContain('public mode');
  });

  it('the public-mode notice names the scoped login command, never a bare proof-mcp', async () => {
    // The notice is three lines; wait for its last one, or the child is stopped mid-notice.
    const result = await run([], home, 'then restart this server');
    expect(result.stderr).toContain('npx @proof-holdings/mcp-server login');
    expect(result.stderr).not.toContain('proof-mcp login');
  });

  it('an empty PROOF_BASE_URL with a credentials file still starts the server', async () => {
    saveKey(home);
    const result = await run([], home, 'public mode', { PROOF_BASE_URL: '' });
    expect(result.stderr).toContain('PROOF_BASE_URL');
    expect(result.stderr).toContain('public mode');
  });

  it('a malformed credentials file is a notice, and the server still starts', async () => {
    saveKey(home, undefined, '{not json');
    const result = await run([], home, 'public mode');
    expect(result.stderr).toContain('ignoring the saved credentials');
    expect(result.stderr).toContain('public mode');
  });
});
