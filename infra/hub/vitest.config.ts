import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { ADMIN_KEY: 'test-admin', WEBHOOK_KEY: 'test-encryption-key' } }
    })
  ]
})
