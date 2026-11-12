/**
 * Every tool's input keys equal its operation's inputs in the OpenAPI document — path parameters,
 * query parameters and request-body properties — in BOTH directions, except the reasoned entries of
 * `src/input-parity-exemptions.ts` (`m-true-response-components-phase3`, T6).
 *
 * A tool that omits an input the API takes leaves an agent unable to do what the API offers; a tool
 * that offers an input the API ignores promises an agent something it does not get. The keys are
 * read as the tools ADVERTISE them, through `tools/list` on a real in-memory client, and the
 * operation inputs from `src/generated/operation-inputs.json`, which the root drift suite holds to
 * the OpenAPI document. Path parameters match by name with case and underscores folded and by
 * suffix (`profile_id` fills `{profileId}`, `id` fills `{id}`); any other spelling is a listed alias.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProofServer } from '../src/factory.js';
import {
  INPUT_PARITY_EXEMPTIONS,
  PATH_PARAM_ALIASES,
  TOOLS_WITHOUT_OPERATION,
} from '../src/input-parity-exemptions.js';
import { canonicalToolName } from '../src/tool-renames.js';

type Location = 'path' | 'query' | 'body';
type OperationInputs = Record<string, { operations: string[]; inputs: Record<string, Location> }>;
type Difference = { tool: string; key: string; side: 'spec_only' | 'tool_only' };

const ARTIFACT = JSON.parse(
  readFileSync(join(__dirname, '../src/generated/operation-inputs.json'), 'utf8'),
) as OperationInputs;

const fold = (name: string) => name.replace(/_/g, '').toLowerCase();

/** The differences between one tool's advertised keys and its operation's inputs. */
export function differences(tool: string, toolKeys: string[], inputs: Record<string, Location>): Difference[] {
  const unmatched = new Set(toolKeys);
  const found: Difference[] = [];
  for (const [key, location] of Object.entries(inputs)) {
    const alias = PATH_PARAM_ALIASES.find((a) => a.tool === tool && a.param === key);
    const match = alias && unmatched.has(alias.key)
      ? alias.key
      : toolKeys.find((k) => unmatched.has(k) && (fold(k) === fold(key) || (location === 'path' && fold(k).endsWith(fold(key)))))
        ?? toolKeys.find((k) => unmatched.has(k) && location === 'path' && fold(key).endsWith(fold(k)));
    if (match) unmatched.delete(match);
    else found.push({ tool, key, side: 'spec_only' });
  }
  for (const key of unmatched) found.push({ tool, key, side: 'tool_only' });
  return found;
}

const exempt = (d: Difference) =>
  INPUT_PARITY_EXEMPTIONS.some((e) => e.tool === d.tool && e.key === d.key && e.side === d.side);

let advertised: Map<string, { type: unknown; keys: string[] }>;

beforeAll(async () => {
  const instance = createProofServer({ apiKey: 'pk_test_x', baseUrl: 'https://api.test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.server.connect(serverSide);
  const client = new Client({ name: 'input-parity-test', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  // A deprecated alias takes its tool's input (`tool-renames.test.ts`), so the tools are what is judged.
  advertised = new Map(tools.filter((t) => canonicalToolName(t.name) === t.name).map((t) => [
    t.name,
    { type: t.inputSchema.type, keys: Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>) },
  ]));
});

describe('MCP tool inputs against the OpenAPI document', () => {
  it('reads every registered tool, each with a root object input (anti-vacuity)', () => {
    expect(advertised.size).toBeGreaterThan(150);
    const notObjects = [...advertised].filter(([, t]) => t.type !== 'object').map(([name]) => name);
    expect(notObjects).toEqual([]);
  });

  it('maps every registered tool to operations, or lists it as having none', () => {
    const none = TOOLS_WITHOUT_OPERATION.map((t) => t.tool);
    expect([...advertised.keys()].filter((name) => !ARTIFACT[name] && !none.includes(name))).toEqual([]);
    expect(none.filter((name) => !advertised.has(name) || ARTIFACT[name])).toEqual([]);
  });

  it('offers what each operation takes and nothing it does not, outside the listed decisions', () => {
    const all = [...advertised].filter(([name]) => ARTIFACT[name])
      .flatMap(([name, t]) => differences(name, t.keys, ARTIFACT[name].inputs));
    expect(all.filter((d) => !exempt(d)).map((d) => `${d.tool} ${d.side} ${d.key}`)).toEqual([]);
  });

  it('lists no exemption or alias that no longer matches a real difference', () => {
    const real = [...advertised].filter(([name]) => ARTIFACT[name])
      .flatMap(([name, t]) => differences(name, t.keys, ARTIFACT[name].inputs));
    const stale = INPUT_PARITY_EXEMPTIONS
      .filter((e) => !real.some((d) => d.tool === e.tool && d.key === e.key && d.side === e.side))
      .map((e) => `${e.tool} ${e.side} ${e.key}`);
    const staleAliases = PATH_PARAM_ALIASES
      .filter((a) => !advertised.get(a.tool)?.keys.includes(a.key) || ARTIFACT[a.tool]?.inputs[a.param] !== 'path')
      .map((a) => `${a.tool} ${a.key}→${a.param}`);
    expect([...stale, ...staleAliases]).toEqual([]);
  });

  it('catches a planted difference in each direction (control)', () => {
    expect(differences('probe', ['id', 'extra'], { id: 'path', wanted: 'query' })).toEqual([
      { tool: 'probe', key: 'wanted', side: 'spec_only' },
      { tool: 'probe', key: 'extra', side: 'tool_only' },
    ]);
    expect(differences('probe', ['profile_id'], { profileId: 'path' })).toEqual([]);
    expect(differences('probe', ['profile_id'], { profileId: 'query' })).toEqual([]);
    expect(differences('probe', ['profile'], { profileId: 'query' })).toEqual([
      { tool: 'probe', key: 'profileId', side: 'spec_only' },
      { tool: 'probe', key: 'profile', side: 'tool_only' },
    ]);
  });
});
