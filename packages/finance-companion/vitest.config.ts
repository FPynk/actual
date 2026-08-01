import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
