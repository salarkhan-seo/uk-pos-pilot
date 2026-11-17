import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// As in apps/api/vitest.config.ts: tests run against the TypeScript
// sources; the packages' exports point at compiled dist/ for `node`.
const src = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@uk-pos/db', replacement: src('./src/index.ts') },
      {
        find: '@uk-pos/shared-kernel',
        replacement: src('../shared-kernel/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // PGlite spins up a WASM engine per test file; keep the default pool
    // but allow the migration run its time.
    testTimeout: 120000,
  },
});
