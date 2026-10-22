/**
 * The simulator proof against a local server: boots scripts/ios-client-
 * test-server.ts, hands its pairing link to scripts/ios-sim-proof.sh through
 * the process environment, and stops the server. A rehearsal of the box run
 * (same script, a link from `tc-local remote.pairings.create` there).
 *
 *   bun scripts/ios-sim-proof-local.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const out = resolve(repo, 'scripts/.out/ios-client-test-server.mjs')
const bundle = spawnSync(resolve(repo, 'node_modules/.bin/esbuild'), ['scripts/ios-client-test-server.ts', '--bundle', '--platform=node', '--format=esm', '--packages=external', '--alias:@shared=./src/shared', '--alias:aliax-core=./node_modules/aliax-core/src', '--alias:electron=./scripts/electron-shim.mjs', `--outfile=${out}`, '--log-level=warning'], { cwd: repo, stdio: 'inherit' })
if (bundle.error || bundle.status !== 0) {
  console.error(`esbuild failed: ${bundle.error?.message ?? `exit ${bundle.status}`}`)
  process.exit(bundle.status ?? 1)
}

const server = spawn('node', [out], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] })
const ready = await new Promise<{ baseUrl: string; controlUrl: string; pairingLink: string; pairingLinkOperate: string; adminPairing?: string }>((ok, bad) => {
  let buffer = ''
  const timer = setTimeout(() => bad(new Error('the test server did not come up in 60 s')), 60_000)
  server.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const line = buffer.split('\n').find((l) => l.startsWith('{') && l.includes('"ready":true'))
    if (!line) return
    clearTimeout(timer)
    ok(JSON.parse(line))
  })
  server.on('exit', (code) => bad(new Error(`the test server exited with ${code}`)))
}).catch((err) => {
  console.error(String(err))
  server.kill('SIGTERM')
  process.exit(1)
})
console.log(`ios-sim-proof-local: server on ${ready.baseUrl}`)
const proof = spawnSync('sh', [resolve(repo, 'scripts/ios-sim-proof.sh')], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    TC_TEST_PAIR_LINK: ready.pairingLink,
    // The steering shots pair with a key that may act; the control panel tells the script what landed.
    TC_TEST_PAIR_LINK_OPERATE: ready.pairingLinkOperate,
    // The host detail's admin reads (the host-extras set): deploy, its log, the sync lines.
    TC_TEST_PAIR_LINK_ADMIN: ready.adminPairing ?? '',
    TC_TEST_CONTROL_URL: ready.controlUrl,
    TC_TEST_PAIR_NAME: 'Local test server',
    TC_TEST_THREAD: process.env.TC_TEST_THREAD ?? 'Thread A',
    TC_TEST_SEARCH: process.env.TC_TEST_SEARCH ?? 'hello',
    // The last shot wants the host gone: the proof asks the control server to quit.
    TC_PROOF_KILL_CMD: `curl -s -X POST ${ready.controlUrl}/quit`
  }
})
server.kill('SIGTERM')
process.exit(proof.status ?? 1)
