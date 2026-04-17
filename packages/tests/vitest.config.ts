import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // Force Vite to re-bundle dependencies on each run so that changes to
  // dynamic-workflows are picked up.
  cacheDir: '.vite-test-cache',
  optimizeDeps: {
    force: true,
  },
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['dynamic-workflows'],
        },
      },
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
