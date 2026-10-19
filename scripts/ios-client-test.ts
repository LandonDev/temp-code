/**
 * bun run ios:test:client — the iOS client package's live tests against a
 * real server. Bundles and starts scripts/ios-client-test-server.ts (node,
 * the way every e2e script runs the server), reads its one JSON line, runs
 * `swift test` for ios/TempCodeClient with the server's address and key in
 * the TEST PROCESS ENVIRONMENT ONLY (never printed, never written), and
 * stops the server. Exit code is swift test's.
 *
 *   bun scripts/ios-client-test.ts            # every test, live ones included
 *   bun scripts/ios-client-test.ts --filter LiveServerTests
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const out = resolve(repo, 'scripts/.out/ios-client-test-server.mjs')

const bundle = spawnSync(
  'esbuild',
  [
    'scripts/ios-client-test-server.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    '--alias:@shared=./src/shared',
    '--alias:aliax-core=./node_modules/aliax-core/src',
    '--alias:electron=./scripts/electron-shim.mjs',
    `--outfile=${out}`,
    '--log-level=warning'
  ],
  { cwd: repo, stdio: 'inherit', env: process.env }
)
if (bundle.status !== 0) process.exit(bundle.status ?? 1)

const server = spawn('node', [out], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: process.env })
type Ready = { ready: true; baseUrl: string; controlUrl: string; environmentId: string; keyId: string; key: string; threadA: string; threadB: string; projectId: string }
const ready = await new Promise<Ready>((resolveReady, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('the test server did not come up in 60 s')), 60_000)
  server.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const line = buffer.split('\n').find((l) => l.startsWith('{') && l.includes('"ready":true'))
    if (!line) return
    clearTimeout(timer)
    resolveReady(JSON.parse(line) as Ready)
  })
  server.on('exit', (code) => reject(new Error(`the test server exited with ${code}`)))
}).catch((err) => {
  console.error(String(err))
  server.kill('SIGTERM')
  process.exit(1)
})
console.log(`ios:test:client: server on ${ready.baseUrl}, control on ${ready.controlUrl}, environment ${ready.environmentId}`)

// The CLT's swift-package is broken on this Mac (see scripts/ios-test.sh): use the newest Xcode.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TC_TEST_BASE_URL: ready.baseUrl,
  TC_TEST_CONTROL_URL: ready.controlUrl,
  TC_TEST_ENVIRONMENT_ID: ready.environmentId,
  TC_TEST_KEY_ID: ready.keyId,
  TC_TEST_KEY: ready.key,
  TC_TEST_THREAD_A: ready.threadA,
  TC_TEST_THREAD_B: ready.threadB,
  TC_TEST_PROJECT_ID: ready.projectId
}
if (!env.DEVELOPER_DIR) {
  const selected = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout.trim()
  if (selected.includes('CommandLineTools') && existsSync('/Applications')) {
    const xcodes = readdirSync('/Applications')
      .filter((n) => /^Xcode.*\.app$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (xcodes.length) {
      env.DEVELOPER_DIR = `/Applications/${xcodes[xcodes.length - 1]}/Contents/Developer`
      console.log(`ios:test:client: using ${xcodes[xcodes.length - 1]}`)
    }
  }
}

const started = Date.now()
const swift = spawnSync('swift', ['test', ...process.argv.slice(2)], {
  cwd: resolve(repo, 'ios/TempCodeClient'),
  stdio: 'inherit',
  env
})
console.log(`ios:test:client: swift test took ${((Date.now() - started) / 1000).toFixed(1)} s`)
server.kill('SIGTERM')
await new Promise<void>((done) => {
  const timer = setTimeout(() => {
    server.kill('SIGKILL')
    done()
  }, 5_000)
  server.on('exit', () => {
    clearTimeout(timer)
    done()
  })
})
process.exit(swift.status ?? 1)
