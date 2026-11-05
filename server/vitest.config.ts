import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Against a real shared Postgres, test files must not run at the same time.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
