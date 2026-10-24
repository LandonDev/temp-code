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
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const out = resolve(repo, 'scripts/.out/ios-client-test-server.mjs')

const bundle = spawnSync(
  resolve(repo, 'node_modules/.bin/esbuild'),
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
if (bundle.error || bundle.status !== 0) {
  console.error(`esbuild failed: ${bundle.error?.message ?? `exit ${bundle.status}`}`)
  process.exit(bundle.status ?? 1)
}

const server = spawn('node', [out], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: process.env })
type Ready = { ready: true; baseUrl: string; controlUrl: string; environmentId: string; keyId: string; key: string; operateKeyId: string; operateKey: string; operateOnlyKeyId: string; operateOnlyKey: string; threadA: string; threadB: string; projectId: string; workspaceId: string; planPath: string | null; threads: Record<string, string>; threadCrossHost?: string; second?: { baseUrl: string; environmentId: string; key: string; projectId?: string; thread?: string }; links?: { workspace: string; project: string }; relayHosts?: { environmentId: string; name: string; state: string }[]; adminKeyId?: string; adminKey?: string; seedBoxId?: string; deployLogLines?: number }
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

// The CLT's swift-package is broken on this Mac (see scripts/ios-test.sh): use the Xcode scripts/ios-xcode.sh picks.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TC_TEST_BASE_URL: ready.baseUrl,
  TC_TEST_CONTROL_URL: ready.controlUrl,
  TC_TEST_ENVIRONMENT_ID: ready.environmentId,
  TC_TEST_KEY_ID: ready.keyId,
  TC_TEST_KEY: ready.key,
  TC_TEST_THREAD_A: ready.threadA,
  TC_TEST_THREAD_B: ready.threadB,
  TC_TEST_PROJECT_ID: ready.projectId,
  TC_TEST_WORKSPACE_ID: ready.workspaceId,
  TC_TEST_OPERATE_KEY_ID: ready.operateKeyId,
  TC_TEST_OPERATE_KEY: ready.operateKey,
  TC_TEST_OPERATE_ONLY_KEY_ID: ready.operateOnlyKeyId,
  TC_TEST_OPERATE_ONLY_KEY: ready.operateOnlyKey,
  TC_TEST_THREAD_PLAN: ready.threads.planning ?? '',
  TC_TEST_THREAD_CHAT: ready.threads.chat ?? '',
  TC_TEST_PLAN_PATH: ready.planPath ?? '',
  // Thread 28's relayed seed (four fake Macs, one per state); `[]` on a server without it.
  TC_TEST_RELAY_HOSTS: JSON.stringify(ready.relayHosts ?? [])
}
// Every seeded thread by its key: `threads.notesFive` is TC_TEST_THREAD_NOTES_FIVE.
for (const [key, id] of Object.entries(ready.threads)) {
  env[`TC_TEST_THREAD_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`] = id
}
// The host detail's admin reads (iOS thread 21): the deploy job and its log, the sync lines.
if (ready.adminKey && ready.adminKeyId) {
  env.TC_TEST_ADMIN_KEY_ID = ready.adminKeyId
  env.TC_TEST_ADMIN_KEY = ready.adminKey
  env.TC_TEST_SEED_BOX_ID = ready.seedBoxId ?? ''
  env.TC_TEST_DEPLOY_LOG_LINES = String(ready.deployLogLines ?? 0)
}
// The second host (the same project on another machine) and the thread whose
// subagent runs there; the two-host live test is skipped without them.
if (ready.second && ready.threadCrossHost) {
  env.TC_TEST_SECOND_BASE_URL = ready.second.baseUrl
  env.TC_TEST_SECOND_ENVIRONMENT_ID = ready.second.environmentId
  env.TC_TEST_SECOND_KEY = ready.second.key
  env.TC_TEST_THREAD_CROSS_HOST = ready.threadCrossHost
  // One project across the two hosts: the link ids both copies carry, and the second host's copy.
  env.TC_TEST_SECOND_PROJECT_ID = ready.second.projectId ?? ''
  env.TC_TEST_SECOND_THREAD = ready.second.thread ?? ''
  env.TC_TEST_SECOND_WORKSPACE_LINK_ID = ready.links?.workspace ?? ''
  env.TC_TEST_SECOND_PROJECT_LINK_ID = ready.links?.project ?? ''
}
if (!env.DEVELOPER_DIR) {
  const selected = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout.trim()
  if (selected.includes('CommandLineTools')) {
    // scripts/ios-xcode.sh picks the highest-versioned Xcode; the package builds on any, so no minimum.
    const picked = spawnSync('sh', [resolve(repo, 'scripts/ios-xcode.sh')], { encoding: 'utf8', env: { ...env, TC_XCODE_MIN: '0' } })
    if (picked.status === 0 && picked.stdout.trim()) {
      env.DEVELOPER_DIR = picked.stdout.trim()
      console.log(`ios:test:client: using ${env.DEVELOPER_DIR}`)
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
