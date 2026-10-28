import { describe, expect, it } from 'vitest'
import { NOT_DEV_RUNNER, notDevServer, underRunner } from './devServerRules'

describe("the repository's own proofs are never dev servers", () => {
  it('refuses the measured command lines, by the listener or any process above it', () => {
    for (const line of [
      'bun --preload scripts/lib/electron-stub.ts scripts/e2e-queue.ts',
      'node scripts/.out/e2e-quota-routing.mjs',
      '/srv/agents/home/.bun/bin/bun scripts/e2e-cross-host-threads.ts --fast',
      'bun --preload scripts/lib/electron-stub.ts scripts/capture-swift-fixtures.ts'
    ]) {
      expect(NOT_DEV_RUNNER.test(line), line).toBe(true)
      expect(notDevServer(41234, 'node', line), line).toBe('a test run or the gate')
      expect(underRunner(['node /tmp/tc-e2e/fake-provider.mjs', line]), line).toBe(true)
    }
  })
  it('still admits dev servers', () => {
    for (const line of ['bun run dev', 'node node_modules/.bin/vite', 'next dev', 'bun src/server.ts', 'node scripts/serve.mjs', 'bun scripts/dev-proxy.ts']) {
      expect(NOT_DEV_RUNNER.test(line), line).toBe(false)
      expect(notDevServer(5173, 'node', line), line).toBeNull()
    }
  })
})
