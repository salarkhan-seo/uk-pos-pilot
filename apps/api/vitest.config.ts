import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the TypeScript sources of the workspace libraries
// (the packages' exports point at their compiled dist/, which is what
// plain `node` uses at runtime — see README "API build & boot").
// Without these aliases, vitest would load dist/ and `pnpm test` would
// silently pass against a stale build.
const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@uk-pos/db', replacement: src('../../packages/db/src/index.ts') },
      {
        find: '@uk-pos/shared-kernel',
        replacement: src('../../packages/shared-kernel/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each service test file spins up its own PGlite engine and applies
    // all 8 migrations; allow time for that.
    testTimeout: 180000,
  },
});
