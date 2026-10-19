import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
export default defineWorkersConfig({
  test: {
    poolOptions: { workers: {
      isolatedStorage: false,
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { ADMIN_KEY: 'test-admin', WEBHOOK_KEY: 'test-encryption-key' } }
    } }
  }
})
