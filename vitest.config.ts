import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['__tests__/integration/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
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
    },
  },
});
