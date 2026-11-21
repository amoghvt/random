import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
  },
});
