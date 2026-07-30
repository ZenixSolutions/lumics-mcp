import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Contract tests hit a live tenant and are opt-in via LUMICS_CONTRACT_TESTS.
    // They are excluded from the default run so `npm test` never needs a token.
    exclude: process.env.LUMICS_CONTRACT_TESTS
      ? ['node_modules/**', 'dist/**']
      : ['node_modules/**', 'dist/**', 'tests/contract/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // RFC-001 open question 1, owner-approved: 80% lines on the layers where
      // defects actually live. No global gate — a repo-wide number would be
      // satisfied by testing trivia.
      include: ['src/api/**', 'src/tools/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
