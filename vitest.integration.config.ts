import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
