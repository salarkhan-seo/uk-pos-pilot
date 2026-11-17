import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the TypeScript source of @uk-pos/shared-kernel
// (its package exports point at compiled dist/, which is what plain
// `node` uses at runtime). Without this alias, vitest would load dist/
// and `pnpm test` would silently pass against a stale build — the same
// pattern as apps/api/vitest.config.ts. The @uk-pos/db alias serves the
// same purpose for the Build-07 UI interaction tests, which seed PGlite
// exactly like the Build-06 E2E suite.
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
    testTimeout: 60000,
  },
});
