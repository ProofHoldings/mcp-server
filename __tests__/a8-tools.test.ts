import { describe, it, expect, vi } from 'vitest';
import type { HttpClient } from '../src/http.js';
import { annotationsFor } from '../src/toolAnnotations.js';

// m-fix-mcp-tool-contract-drift SC-9 (audit §5a A8): the planned MCP rows that get a tool here, each
// pinned to the method and route it sends. Registration, parity and schemas are held by the shared
// guards (factory, input parity, output schemas, api-map); this file pins what each tool CALLS.

function mockHttp() {
  return { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}), put: vi.fn(), patch: vi.fn(), del: vi.fn().mockResolvedValue({}), baseUrl: 'https://api.proof.holdings' } as unknown as HttpClient & Record<'get' | 'post' | 'del', ReturnType<typeof vi.fn>>;
}

type Captured = { name: string; description: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
const MODULES: Record<string, () => Promise<unknown>> = {
  confirmations: () => import('../src/tools/confirmations.js'),
  'lookalike-watch': () => import('../src/tools/lookalike-watch.js'),
  delegations: () => import('../src/tools/delegations.js'),
  settings: () => import('../src/tools/settings.js'),
  phones: () => import('../src/tools/phones.js'),
  emails: () => import('../src/tools/emails.js'),
  profiles: () => import('../src/tools/profiles.js'),
};

async function capture(file: string, http: unknown): Promise<Captured[]> {
  const mod = (await MODULES[file]()) as { registerTools: (tool: unknown, http: unknown) => void };
  const tools: Captured[] = [];
  mod.registerTools((name: string, description: string, _schema: unknown, handler: Captured['handler']) => tools.push({ name, description, handler }), http);
  return tools;
}

const ID = '0123456789abcdef01234567';
const CASES: Array<{ file: string; tool: string; args: Record<string, unknown>; verb: 'get' | 'post' | 'del'; call: unknown[] }> = [
  { file: 'confirmations', tool: 'resend_confirmation', args: { id: ID }, verb: 'post', call: [`/api/v1/confirmations/${ID}/resend`, {}] },
  { file: 'lookalike-watch', tool: 'subscribe_lookalike_watch', args: { brand_tokens: ['proof'], notify_email: 'ops@proof.holdings' }, verb: 'post', call: ['/api/v1/lookalike-watch', { brand_tokens: ['proof'], notify_email: 'ops@proof.holdings' }] },
  { file: 'lookalike-watch', tool: 'get_lookalike_watch', args: {}, verb: 'get', call: ['/api/v1/lookalike-watch'] },
  { file: 'lookalike-watch', tool: 'cancel_lookalike_watch', args: {}, verb: 'del', call: ['/api/v1/lookalike-watch'] },
  { file: 'lookalike-watch', tool: 'list_lookalike_alerts', args: { page: 2, limit: 10 }, verb: 'get', call: ['/api/v1/lookalike-watch/alerts', { page: 2, limit: 10 }] },
  { file: 'lookalike-watch', tool: 'list_lookalike_reports', args: {}, verb: 'get', call: ['/api/v1/lookalike-watch/reports', {}] },
  { file: 'delegations', tool: 'get_delegation_carriers', args: { id: 'ph_dlg/x' }, verb: 'get', call: ['/api/v1/delegations/ph_dlg%2Fx/carriers'] },
  { file: 'settings', tool: 'get_company', args: {}, verb: 'get', call: ['/api/v1/me/company'] },
  { file: 'phones', tool: 'preview_phone_removal', args: { id: ID }, verb: 'get', call: [`/api/v1/me/phones/${ID}/removal-preview`] },
  { file: 'emails', tool: 'preview_email_removal', args: { id: ID }, verb: 'get', call: [`/api/v1/me/emails/${ID}/removal-preview`] },
  { file: 'profiles', tool: 'preview_profile_deletion', args: { profile_id: ID }, verb: 'get', call: [`/api/v1/me/profiles/${ID}/deletion-preview`] },
];

describe('A8 tools — each sends the route its api-map row names', () => {
  it.each(CASES)('$tool → $verb $call.0', async ({ file, tool, args, verb, call }) => {
    const http = mockHttp();
    const found = (await capture(file, http)).find((t) => t.name === tool);
    expect(found, `${tool} is not registered in ${file}.ts`).toBeDefined();
    await found!.handler(args);
    expect((http as unknown as Record<string, ReturnType<typeof vi.fn>>)[verb]).toHaveBeenCalledWith(...call);
  });

  it('the lookalike-watch module registers exactly its five tools', async () => {
    const names = (await capture('lookalike-watch', mockHttp())).map((t) => t.name).sort();
    expect(names).toEqual(['cancel_lookalike_watch', 'get_lookalike_watch', 'list_lookalike_alerts', 'list_lookalike_reports', 'subscribe_lookalike_watch']);
  });

  it('cancel is destructive; the reads are read-only; resend and subscribe are additive writes', () => {
    expect(annotationsFor('cancel_lookalike_watch')).toMatchObject({ destructiveHint: true });
    for (const name of ['get_lookalike_watch', 'list_lookalike_alerts', 'list_lookalike_reports', 'get_delegation_carriers', 'get_company', 'preview_phone_removal', 'preview_email_removal', 'preview_profile_deletion']) {
      expect(annotationsFor(name), name).toMatchObject({ readOnlyHint: true });
    }
    for (const name of ['resend_confirmation', 'subscribe_lookalike_watch']) {
      expect(annotationsFor(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });
});

describe('A8 descriptions — the coordinator rules (User Notes, ruling 6)', () => {
  it('resend_confirmation says it is a charged send and an empty balance is 402 with the top-up address', async () => {
    const d = (await capture('confirmations', mockHttp())).find((t) => t.name === 'resend_confirmation')!.description;
    expect(d).toMatch(/charged/i);
    expect(d).toContain('402 balance_empty');
    expect(d).toContain('https://proof.holdings/billing');
  });

  it('subscribe_lookalike_watch names the plan from the mirrored constant, not a typed price', async () => {
    const { LOOKALIKE_WATCH_FROM_PLAN } = await import('../src/tools/lookalike-watch.js');
    const d = (await capture('lookalike-watch', mockHttp())).find((t) => t.name === 'subscribe_lookalike_watch')!.description;
    expect(d).toContain(`the ${LOOKALIKE_WATCH_FROM_PLAN} plan and above`);
    expect(d).toContain('plan_upgrade_required');
  });
});
