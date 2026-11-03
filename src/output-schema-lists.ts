/**
 * The two tool sets that take no schema from the generated artifact (`m-mcp-tool-output-schemas`).
 *
 * Imports nothing, on purpose: `scripts/generate-mcp-output-schemas.ts` reads these lists from the
 * repository root, and a module that pulled in zod or the artifact it is about to regenerate could
 * not be read there. The artifact, these two lists and `outputSchemaFor` in `./output-schema.ts`
 * account for every registered tool, each exactly once — `src/__tests__/drift/mcp-output-schemas.test.ts`
 * holds the three disjoint and complete.
 */

/** Tools that declare no `outputSchema`, each for a reason the result itself gives. */
export const OUTPUT_SCHEMA_EXEMPTIONS: readonly string[] = [
  // Returns QR art as text for the agent to copy into its reply; there is no structured result to type.
  'render_auth_link',
];

/**
 * Tools whose result the MCP server builds itself, so their schema is written beside the code that
 * builds it rather than generated from an API response.
 */
export const LOCAL_OUTPUT_SCHEMA_TOOLS: readonly string[] = [
  // The API answers 204; the tool reports `{ deleted, id }`.
  'delete_domain_verification',
  // Verdicts produced locally by @proof-holdings/delegation-verifier; no API operation exists.
  'verify_delegation',
  'verify_delegations',
];
