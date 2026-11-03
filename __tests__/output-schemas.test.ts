/**
 * Every tool declares an output schema, and every result it returns validates against it
 * (`m-mcp-tool-output-schemas`).
 *
 * The SDK turns an `outputSchema` mismatch into an `isError` result on EVERY call, so a schema
 * narrower than what the API sends turns a working tool into a failing one. This suite therefore
 * calls every tool for real — through an in-memory client, against a recording `fetch` — and
 * checks four things the schemas could get wrong:
 *
 * - (a) `tools/list` gives every tool but the exemptions an `outputSchema`;
 * - (b) no advertised schema closes an object (`additionalProperties: false` at any depth);
 * - (c) every call returns a non-error result carrying `structuredContent`, which means it passed
 *   the SDK's own `validateToolOutput` on the server and the `Client`'s check on this side. A
 *   PROVEN tool is answered with each real controller body recorded for its operation
 *   (`src/generated/output-samples.json`) and must pass with every one of them;
 * - (d) the first request each mapped tool sends is the operation the artifact maps it to, so the
 *   map that decides each schema is true rather than trusted;
 * - (f) a described envelope carries only a `description` on each property.
 *
 * The client signs in first (the `factory.test.ts` pattern): without a login session every
 * session-only tool refuses before any request leaves the process. A second, keyed-only pass checks
 * that a refusal is still a refusal — an error result, which the SDK does not validate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';
import { OUTPUT_SCHEMAS } from '../src/generated/output-schemas.js';
import { LOCAL_OUTPUT_SCHEMA_TOOLS, OUTPUT_SCHEMA_EXEMPTIONS } from '../src/output-schema.js';
import { jsonResult } from '../src/types.js';

type Json = Record<string, unknown>;
type Tool = { name: string; inputSchema: Json; outputSchema?: Json };

const SAMPLES = JSON.parse(
  readFileSync(join(__dirname, '../src/generated/output-samples.json'), 'utf8'),
) as Record<string, Json[]>;

const ARTIFACT_TOOLS = Object.keys(OUTPUT_SCHEMAS);
const ALL_TOOLS = [...ARTIFACT_TOOLS, ...LOCAL_OUTPUT_SCHEMA_TOOLS, ...OUTPUT_SCHEMA_EXEMPTIONS].sort();

/** `'GET /api/v1/x/{id} 200'` → a matcher for the method and path of a real request. */
function operationMatcher(operation: string) {
  const [method, template] = operation.split(' ');
  const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
  return (request: { method: string; path: string }) => request.method === method && pattern.test(request.path);
}

/** A literal segment outranks a placeholder: `/webhook-deliveries/stats` is not `/webhook-deliveries/{id}`. */
const placeholders = (operation: string) => (operation.match(/\{/g) ?? []).length;
const SAMPLE_MATCHERS = Object.keys(SAMPLES)
  .sort((a, b) => placeholders(a) - placeholders(b))
  .map((entry) => ({ entry, matches: operationMatcher(entry) }));

// ---- Arguments, synthesized from the input schema each tool ADVERTISES ----

/** One value per string pattern the tools use; the first that matches a pattern is taken. */
const PATTERN_CANDIDATES = [
  '0123456789abcdef01234567',
  'a@example.com',
  `ph_ctl_${'0'.repeat(32)}`,
  `ph_dlg_${'0'.repeat(32)}`,
  '+14155550123',
  'US.abcdefghijklmnop',
  'sample_user',
  '2026-01',
  '1d',
  '#112233',
  'https://example.com/sample',
];

function sampleFor(schema: Json, name: string): unknown {
  if (Array.isArray(schema.anyOf)) return sampleFor(schema.anyOf[0] as Json, name);
  if (Array.isArray(schema.oneOf)) return sampleFor(schema.oneOf[0] as Json, name);
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type) {
    case 'string': {
      if (typeof schema.pattern === 'string') {
        const pattern = new RegExp(schema.pattern);
        const hit = PATTERN_CANDIDATES.find((candidate) => pattern.test(candidate));
        if (!hit) throw new Error(`no sample value matches ${name}'s pattern ${schema.pattern}`);
        return hit;
      }
      if (schema.format === 'uri') return 'https://example.com/sample';
      if (schema.format === 'email') return 'a@example.com';
      return 'sample'.padEnd(Number(schema.minLength ?? 0), 'x');
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'array': {
      const count = Math.max(1, Number(schema.minItems ?? 1));
      return Array.from({ length: count }, () => sampleFor((schema.items ?? {}) as Json, name));
    }
    case 'object':
      return argsFor(schema, name);
    default:
      return 'sample';
  }
}

/** Required properties only: an optional one is left out, the way most callers send it. */
function argsFor(schema: Json, name: string): Json {
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const required = (schema.required ?? []) as string[];
  return Object.fromEntries(required.map((key) => [key, sampleFor(properties[key], `${name}.${key}`)]));
}

/**
 * Tools whose input refinements a schema-only synthesis cannot satisfy, each with a reason.
 * Filled from what the suite reports, never guessed.
 */
const DELEGATION_ITEM = { token: 'header.payload.signature', delegate: { type: 'purl', value: 'pkg:npm/sample' }, expected_principal: 'example.com' };
const ARG_OVERRIDES: Record<string, Json> = {
  // `card` XOR `token` is a refinement the advertised schema cannot express.
  verify_delegation: DELEGATION_ITEM,
  verify_delegations: { items: [DELEGATION_ITEM] },
};

// ---- Recording fetch ----

const requests: Array<{ method: string; path: string }> = [];
let sampleIndex = 0;
let nextResponse: (() => Response) | undefined;
const originalFetch = globalThis.fetch;

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

const recorder = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url);
  const request = { method: (init?.method ?? 'GET').toUpperCase(), path: target.pathname };
  requests.push(request);
  if (nextResponse) {
    const response = nextResponse();
    nextResponse = undefined;
    return response;
  }
  const sample = SAMPLE_MATCHERS.find((m) => m.matches(request));
  const bodies = sample ? SAMPLES[sample.entry] : undefined;
  return json(bodies ? bodies[sampleIndex % bodies.length] : {});
});

async function connect(signIn: boolean) {
  const instance = createProofServer({ apiKey: 'pk_test_x', baseUrl: 'https://api.test' });
  if (signIn) {
    nextResponse = () => json({ ok: true }, { 'set-cookie': 'token=SESSION_JWT; Path=/; HttpOnly' });
    await instance.http.post('/api/v1/auth/sessions/verify', {});
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide);
  const client = new Client({ name: 'output-schemas-test', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return { client, tools: tools as Tool[] };
}

type Call = { isError: boolean; text: string; structured: unknown; requests: Array<{ method: string; path: string }> };

async function call(client: Client, tool: Tool, index = 0): Promise<Call> {
  requests.length = 0;
  sampleIndex = index;
  // A wait gets the shortest budget it accepts: the recorder never answers a terminal status unless
  // the sample carries one, so every wait runs to its timeout and returns the pending envelope.
  const timeout = ((tool.inputSchema.properties ?? {}) as Record<string, Json>).timeout_seconds;
  const waits = tool.name.startsWith('wait_for_') && timeout ? { timeout_seconds: Number(timeout.minimum ?? 1) } : {};
  const args = { ...argsFor(tool.inputSchema, tool.name), ...waits, ...ARG_OVERRIDES[tool.name] };
  try {
    const result = (await client.callTool({ name: tool.name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
      structuredContent?: unknown;
    };
    return {
      isError: Boolean(result.isError),
      text: (result.content ?? []).map((c) => c.text ?? '').join('\n'),
      structured: result.structuredContent,
      requests: [...requests],
    };
  } catch (e) {
    return { isError: true, text: `client threw: ${(e as Error).message}`, structured: undefined, requests: [...requests] };
  }
}

function closedObjectPaths(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => closedObjectPaths(child, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const own = (node as Json).additionalProperties === false ? [path] : [];
  return [...own, ...Object.entries(node as Json).flatMap(([key, child]) => closedObjectPaths(child, `${path}.${key}`))];
}

// ---- The signed-in pass ----

let signedIn: { client: Client; tools: Tool[] };
const toolByName = (name: string) => {
  const tool = signedIn.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tools/list has no ${name}`);
  return tool;
};

beforeAll(async () => {
  globalThis.fetch = recorder as unknown as typeof fetch;
  signedIn = await connect(true);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('jsonResult (SC-3)', () => {
  it('keeps the text exactly as before and adds an object body as structuredContent', () => {
    const body = { id: 'x', nested: { list: [1, 2] } };
    expect(jsonResult(body)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
      structuredContent: body,
    });
  });

  it.each([
    ['an array', [1, 2]],
    ['null', null],
    ['a string', 'plain'],
  ])('answers %s as text only — structuredContent must be an object', (_label, body) => {
    expect(jsonResult(body)).toEqual({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });
  });
});

describe('tools/list', () => {
  it('lists exactly the tools the artifact, the local schemas and the exemptions account for', () => {
    expect(signedIn.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
  });

  it('(a) gives every tool except the exemptions an outputSchema', () => {
    const missing = signedIn.tools.filter((t) => !t.outputSchema && !OUTPUT_SCHEMA_EXEMPTIONS.includes(t.name)).map((t) => t.name);
    const exemptWithSchema = signedIn.tools.filter((t) => t.outputSchema && OUTPUT_SCHEMA_EXEMPTIONS.includes(t.name)).map((t) => t.name);
    expect({ missing, exemptWithSchema }).toEqual({ missing: [], exemptWithSchema: [] });
  });

  it('(b) closes no object anywhere in an advertised output schema', () => {
    const closed = signedIn.tools.flatMap((t) => closedObjectPaths(t.outputSchema).map((p) => `${t.name} ${p}`));
    expect(closed).toEqual([]);
  });

  it('(f) a described envelope carries only a description on each property', () => {
    const described = ARTIFACT_TOOLS.filter((name) => OUTPUT_SCHEMAS[name as keyof typeof OUTPUT_SCHEMAS].precision === 'described');
    expect(described.length).toBeGreaterThan(0);
    const offenders = described.flatMap((name) =>
      Object.entries((toolByName(name).outputSchema?.properties ?? {}) as Record<string, Json>)
        .filter(([, property]) => Object.keys(property).some((key) => key !== 'description'))
        .map(([property]) => `${name}.${property}`),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * (g) An installed MCP runs against TOMORROW's API, so a proven schema may carry only a constraint
 * no compatible API change can violate: names, types, nesting, `required`, and the enum of a `oneOf`
 * discriminator. Never a closed value set, a pattern or a length bound — the SDK compat gate lets
 * those widen (a literal set gaining a value is not a break), and a schema that refused the wider
 * value would fail every call on every published version the day the backend deployed.
 */
/**
 * An ALLOWLIST, not the generator's own list: the rule is what a schema may carry, so a value bound
 * the generator forgot (`exclusiveMinimum`, `maxItems`, …) is an offender here without being named.
 */
const STRUCTURAL_KEYWORDS = new Set(['$schema', 'type', 'properties', 'items', 'required', 'anyOf', 'allOf', 'oneOf', 'additionalProperties', 'description']);
const DISCRIMINATOR_KEYWORDS = new Set(['enum', 'const']);
/** zod bounds every advertised integer by the safe-integer range; no API value can exceed it. */
const isSafeIntegerBound = (key: string, value: unknown) =>
  (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) || (key === 'maximum' && value === Number.MAX_SAFE_INTEGER);

/** The key telling a `oneOf`'s branches apart: a required single-value property of every branch. */
function discriminatorOf(branches: Json[]): string | undefined {
  return Object.keys((branches[0]?.properties ?? {}) as Json).find((key) =>
    branches.every((branch) => {
      const property = ((branch.properties ?? {}) as Record<string, Json>)[key];
      const single = property && ('const' in property || (Array.isArray(property.enum) && property.enum.length === 1));
      return single && ((branch.required ?? []) as string[]).includes(key);
    }),
  );
}

function widenableConstraintPaths(node: unknown, path = '$', discriminator = false): string[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => widenableConstraintPaths(child, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const record = node as Json;
  const own = Object.entries(record)
    .filter(([key, value]) => !STRUCTURAL_KEYWORDS.has(key) && !(discriminator && DISCRIMINATOR_KEYWORDS.has(key)) && !isSafeIntegerBound(key, value))
    .map(([key]) => `${path}.${key}`);
  const branches = Array.isArray(record.oneOf) ? (record.oneOf as Json[]) : undefined;
  const key = branches && discriminatorOf(branches);
  const nested = Object.entries(record).flatMap(([name, child]) => {
    if (name === 'properties' && child && typeof child === 'object') {
      return Object.entries(child as Json).flatMap(([field, value]) => widenableConstraintPaths(value, `${path}.properties.${field}`));
    }
    if (name === 'oneOf' && branches) {
      return branches.flatMap((branch, i) =>
        Object.entries(branch).flatMap(([bName, bChild]) =>
          bName === 'properties' && bChild && typeof bChild === 'object'
            ? Object.entries(bChild as Json).flatMap(([field, value]) =>
                widenableConstraintPaths(value, `${path}.oneOf[${i}].properties.${field}`, field === key),
              )
            : widenableConstraintPaths(bChild, `${path}.oneOf[${i}].${bName}`),
        ),
      );
    }
    return widenableConstraintPaths(child, `${path}.${name}`);
  });
  return [...own, ...nested];
}

describe('(g) a proven schema accepts what a compatible API change can send', () => {
  const proven = ARTIFACT_TOOLS.filter((name) => OUTPUT_SCHEMAS[name as keyof typeof OUTPUT_SCHEMAS].precision === 'proven');

  it('carries only structural keywords, and an enum only on a oneOf discriminator', () => {
    expect(proven.length).toBeGreaterThan(30);
    const offenders = proven.flatMap((name) => widenableConstraintPaths(toolByName(name).outputSchema).map((p) => `${name} ${p}`));
    expect(offenders).toEqual([]);
  });

  it('a channel added to the API later still validates (list_verifications)', async () => {
    const [body] = SAMPLES['GET /api/v1/verifications 200'];
    const later = structuredClone(body) as { data: Json[] };
    later.data[0].channel = 'a_channel_added_later';
    nextResponse = () => json(later);
    const result = await call(signedIn.client, toolByName('list_verifications'));
    expect({ isError: result.isError, text: result.isError ? result.text : '' }).toEqual({ isError: false, text: '' });
  });

  it('an amount the session route stores unvalidated still validates (get_verification_request)', async () => {
    const [body] = SAMPLES['GET /api/v1/verification-requests/{id} 200'];
    const stored = { ...structuredClone(body), action_context: { title: 'Pay', amount: 0 } };
    nextResponse = () => json(stored);
    const result = await call(signedIn.client, toolByName('get_verification_request'));
    expect({ isError: result.isError, text: result.isError ? result.text : '' }).toEqual({ isError: false, text: '' });
  });

  it('an id in a format the API adopts later still validates (list_verifications)', async () => {
    const [body] = SAMPLES['GET /api/v1/verifications 200'];
    const later = structuredClone(body) as { data: Json[] };
    later.data[0].id = 'ver_not-an-object-id';
    nextResponse = () => json(later);
    const result = await call(signedIn.client, toolByName('list_verifications'));
    expect({ isError: result.isError, text: result.isError ? result.text : '' }).toEqual({ isError: false, text: '' });
  });
});

describe('(c) every call returns structuredContent that passes the SDK check', { timeout: 20_000 }, () => {
  it.each(ALL_TOOLS.filter((name) => !OUTPUT_SCHEMA_EXEMPTIONS.includes(name)))('%s', async (name) => {
    const tool = toolByName(name);
    const entry = OUTPUT_SCHEMAS[name as keyof typeof OUTPUT_SCHEMAS];
    const proven = entry?.precision === 'proven';
    const runs = proven ? Math.max(...entry.operations.map((op: string) => SAMPLES[op]?.length ?? 0)) : 1;
    if (proven) expect(runs).toBeGreaterThan(0);
    for (let index = 0; index < runs; index++) {
      const result = await call(signedIn.client, tool, index);
      expect({ name, index, isError: result.isError, text: result.isError ? result.text : '' }).toEqual({
        name,
        index,
        isError: false,
        text: '',
      });
      // SC-3: the text is the same body, so a client that reads only text loses nothing.
      expect(result.structured).toBeTypeOf('object');
      expect(JSON.parse(result.text)).toEqual(result.structured);
    }
  });
});

describe('(d) each mapped tool sends the operation it is mapped to', { timeout: 20_000 }, () => {
  it.each(ARTIFACT_TOOLS)('%s', async (name) => {
    const { operations } = OUTPUT_SCHEMAS[name as keyof typeof OUTPUT_SCHEMAS];
    const result = await call(signedIn.client, toolByName(name));
    const first = result.requests[0];
    expect(first, `${name} sent no request`).toBeDefined();
    expect({ name, first, mapped: operations.some((op: string) => operationMatcher(op)(first)) }).toEqual({
      name,
      first,
      mapped: true,
    });
  });
});

describe('a keyed-only client: a refusal stays a refusal', () => {
  it('session tools refuse with an error result, which the SDK does not validate', async () => {
    const keyed = await connect(false);
    const refused: string[] = [];
    const broken: string[] = [];
    for (const tool of keyed.tools) {
      const result = await call(keyed.client, tool);
      if (result.text.includes('Output validation error')) broken.push(tool.name);
      else if (result.isError && result.text.includes('user_session_required')) refused.push(tool.name);
    }
    expect(broken).toEqual([]);
    expect(refused.length).toBeGreaterThan(10);
  }, 120_000);
});
