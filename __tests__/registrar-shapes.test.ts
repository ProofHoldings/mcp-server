/**
 * The registrar `createProofServer` hands every tool module accepts exactly two call shapes —
 * `(name, description, inputShape, handler)` and `(name, description, handler)` — and refuses any
 * other at startup (`m-mcp-tool-output-schemas`). `server.registerTool` is the only SDK call that
 * takes an `outputSchema`, so a shape the registrar guessed at would register a tool with a
 * misplaced handler or input, silently.
 *
 * One tool module is replaced per case, registering through the registrar in the shape under test;
 * the other modules register as they do in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const MODULE = '../src/tools/render-auth-link.js';
const handler = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

async function createWith(register: (tool: (...args: unknown[]) => unknown) => void) {
  vi.resetModules();
  vi.doMock(MODULE, () => ({ registerTools: register }));
  const { createProofServer } = await import('../src/factory.js');
  return () => createProofServer({ baseUrl: 'https://api.test' });
}

function registered(server: unknown) {
  return (server as { _registeredTools: Record<string, { handler: unknown; inputSchema?: unknown; outputSchema?: unknown }> })
    ._registeredTools;
}

afterEach(() => {
  vi.doUnmock(MODULE);
  vi.resetModules();
});

describe('the tool registrar', () => {
  it.each([
    ['five arguments', ['shape_probe', 'd', { a: z.string() }, { readOnlyHint: true }, handler]],
    ['two arguments', ['shape_probe', handler]],
    ['a non-string description', ['shape_probe', { description: 'd' }, handler]],
    ['a non-string name', [42, 'd', handler]],
    ['a non-function handler', ['shape_probe', 'd', { a: z.string() }, 'not a handler']],
    ['an input shape in the handler position', ['shape_probe', 'd', { a: z.string() }]],
  ])('refuses a registration with %s', async (_label, args) => {
    const create = await createWith((tool) => tool(...args));
    expect(create).toThrow(/unsupported shape/);
  });

  it('registers (name, description, inputShape, handler) with its input and handler in place', async () => {
    const shape = { a: z.string() };
    const create = await createWith((tool) => tool('shape_probe', 'd', shape, handler));
    const probe = registered(create().server).shape_probe;
    expect(probe).toBeDefined();
    expect(probe.handler).toBe(handler);
    expect(probe.inputSchema).toBeDefined();
  });

  it('registers (name, description, handler) with no input schema', async () => {
    const create = await createWith((tool) => tool('shape_probe', 'd', handler));
    const probe = registered(create().server).shape_probe;
    expect(probe).toBeDefined();
    expect(probe.handler).toBe(handler);
    expect(probe.inputSchema).toBeUndefined();
  });
});
