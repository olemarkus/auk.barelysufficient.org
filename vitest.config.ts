import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.vitest.ts'],
    pool: 'forks',
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      enabled: false,
      reporter: ['text'],
      include: ['lib/**/*.ts'],
      exclude: ['test/**', '**/*.d.ts', 'lib/HomeyBleTransport.ts'],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
});
