/**
 * The `outputSchema` each tool declares (`m-mcp-tool-output-schemas`).
 *
 * Three sources, disjoint and together complete (held so by
 * `src/__tests__/drift/mcp-output-schemas.test.ts`):
 * - the generated artifact (`./generated/output-schemas.ts`), for every tool that answers with an
 *   API body — proven, described or envelope, as its header explains;
 * - `LOCAL_OUTPUT_SCHEMA_TOOLS`, whose result this server builds itself, with the schema written
 *   beside the code that builds it;
 * - `OUTPUT_SCHEMA_EXEMPTIONS`, which declare none.
 *
 * Built once, at module load: the remote server builds a server per connection, and a schema is
 * the same for all of them.
 */
import { z } from 'zod';
import { OUTPUT_SCHEMAS, type OutputSchemaEntry } from './generated/output-schemas.js';
import { LOCAL_OUTPUT_SCHEMA_TOOLS, OUTPUT_SCHEMA_EXEMPTIONS } from './output-schema-lists.js';
import { TIMEOUT_ENVELOPE_PROPERTIES } from './types.js';
import { DELETE_DOMAIN_VERIFICATION_OUTPUT } from './tools/verifications.js';
import { VERIFY_DELEGATION_OUTPUT, VERIFY_DELEGATIONS_OUTPUT } from './tools/delegation-verify.js';

export { LOCAL_OUTPUT_SCHEMA_TOOLS, OUTPUT_SCHEMA_EXEMPTIONS };

const LOCAL_SCHEMAS: Record<string, z.ZodType> = {
  delete_domain_verification: DELETE_DOMAIN_VERIFICATION_OUTPUT,
  verify_delegation: VERIFY_DELEGATION_OUTPUT,
  verify_delegations: VERIFY_DELEGATIONS_OUTPUT,
};

/** A `wait_for_*` tool answers the terminal body or, on timeout, `pollUntilTerminal`'s pending envelope. */
function withTimeoutEnvelope(name: string, entry: OutputSchemaEntry): Record<string, unknown> {
  if (!name.startsWith('wait_for_')) return entry.schema;
  const properties = (entry.schema.properties ?? {}) as Record<string, unknown>;
  return { ...entry.schema, properties: { ...properties, ...TIMEOUT_ENVELOPE_PROPERTIES } };
}

const GENERATED_SCHEMAS = new Map<string, z.ZodType>(
  Object.entries(OUTPUT_SCHEMAS).map(([name, entry]) => [name, z.fromJSONSchema(withTimeoutEnvelope(name, entry) as never)]),
);

/** The schema `name` declares, or undefined for an exempt tool (and for a name no source knows). */
export function outputSchemaFor(name: string): z.ZodType | undefined {
  if (OUTPUT_SCHEMA_EXEMPTIONS.includes(name)) return undefined;
  return LOCAL_SCHEMAS[name] ?? GENERATED_SCHEMAS.get(name);
}
