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
      // package is on npm, so this alias is not a workaround waiting to be retired (the `file:`
      // repointing in CI and in `Dockerfile` is; see the release runbook). Running the server
      // for real still needs the dependency installed (`npm run verifier:link` from the repo root
      // links the sibling; a plain `npm ci` resolves it from the registry).
      '@proof-holdings/delegation-verifier': new URL(
        '../packages/delegation-verifier/src/index.ts',
        import.meta.url
      ).pathname,
    },
  },
});
