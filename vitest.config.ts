import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// The sibling verifier package sits next to this one only in the monorepo. The public mirror
// (ProofHoldings/mcp-server) has none, so there the suite resolves the published verifier `npm ci`
// installs — the one the published server runs on. Keyed on the package rather than on its entry
// point, so that inside the monorepo a moved `src/index.ts` still fails to resolve, loudly.
const IN_MONOREPO = existsSync(new URL('../packages/delegation-verifier/package.json', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['__tests__/integration/**', 'node_modules/**'],
  },
  resolve: {
    alias: IN_MONOREPO ? {
      // Tests resolve the verifier's SOURCE, never `node_modules`. That keeps the suite green on
      // a fresh clone with no install of the sibling and no build step, and makes an uncommitted
      // verifier change visible here immediately — neither of which depends on whether the
      // package is on npm, so this alias stayed when the build-time workarounds for the then
      // unpublished verifier were retired (release runbook §8 step 8). Running the server for real
      // needs the dependency installed: a plain `npm ci` resolves it from the registry, and
      // `npm run verifier:link` from the repo root links the sibling over it without a manifest
      // edit (what CI's `verifier-tests` job does).
      '@proof-holdings/delegation-verifier': new URL(
        '../packages/delegation-verifier/src/index.ts',
        import.meta.url
      ).pathname,
    } : {},
  },
});
