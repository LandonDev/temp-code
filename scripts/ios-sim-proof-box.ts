/**
 * The simulator proof against the box: mints one read-only pairing on the
 * box over key SSH (`tc-local remote.pairings.create`), hands its link to
 * scripts/ios-sim-proof.sh through the process environment, and afterwards
 * revokes the key the pairing produced and the pairing itself. Nothing here
 * prints the code or a key; the proof script scrubs its own output.
 *
 *   bun scripts/ios-sim-proof-box.ts
 *   TC_ORIGIN overrides https://tempcode.landonhale.com; TC_SIM, TC_PROOF_DIR,
 *   TC_TEST_SEARCH and TC_TEST_THREAD pass through to the proof script.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const ORIGIN = (process.env.TC_ORIGIN ?? 'https://tempcode.landonhale.com').replace(/\/+$/, '')
const runName = `ios proof ${Date.now()}`

function local(method: string, params: unknown = {}): unknown {
  const quoted = JSON.stringify(params).replaceAll("'", "'\\''")
  const result = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', 'box', `tc-local ${method} '${quoted}'`], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`box tc-local ${method} failed`)
  return JSON.parse(result.stdout.toString())
}

const pairing = local('remote.pairings.create', { name: runName, audience: 'client', caps: ['read'] }) as { code: string }
console.log(`ios-sim-proof-box: pairing minted on the box for ${ORIGIN}`)
let status = 1
try {
  const proof = spawnSync('sh', [resolve(repo, 'scripts/ios-sim-proof.sh')], {
    cwd: repo,
    stdio: 'inherit',
    env: {
      ...process.env,
      TC_TEST_PAIR_LINK: `${ORIGIN}/pair#${pairing.code}`,
      TC_TEST_PAIR_NAME: process.env.TC_TEST_PAIR_NAME ?? 'The box',
      TC_TEST_SEARCH: process.env.TC_TEST_SEARCH ?? 'the',
      TC_PROOF_DIR: process.env.TC_PROOF_DIR ?? '/tmp/tc-ios-proof-box'
    }
  })
  status = proof.status ?? 1
} finally {
  try {
    const keys = local('remote.keys.list') as { id: string; name: string }[]
    for (const key of keys.filter((key) => key.name.startsWith(runName))) local('remote.keys.revoke', { id: key.id })
    const pairings = local('remote.pairings.list') as { id: string; name: string }[]
    for (const item of pairings.filter((item) => item.name.startsWith(runName))) local('remote.pairings.revoke', { id: item.id })
    console.log('ios-sim-proof-box: the test key and pairing are revoked')
  } catch {
    console.error('ios-sim-proof-box: could not revoke the test credentials; revoke them on the box by hand')
    status = status || 1
  }
}
process.exit(status)
