/**
 * `bun scripts/proof-bun.ts <script> [args]`: runs a gate proof under a Bun with `node:sqlite`,
 * whichever `bun` the package script found first (scripts/lib/proofBun.ts sqliteProofBun). It
 * imports nothing but node built-ins, so any Bun can load it. The proof stays this process's child,
 * in its group, so the gate's group kill and the proof order (scripts/lib/proofOrder.ts) still see it.
 */
import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { proofBunCandidates, runProofBun, sqliteProofBun } from './lib/proofBun'

const [script, ...args] = process.argv.slice(2)
if (!script) {
  console.error('usage: bun scripts/proof-bun.ts <script> [args]')
  process.exit(2)
}
const bun = sqliteProofBun(proofBunCandidates(process.execPath, process.env.HOME || homedir()), {
  executable: (path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  hasSqlite: (path) =>
    spawnSync(path, ['-e', 'require("node:sqlite")'], { stdio: 'ignore', timeout: 10_000 }).status === 0
})
if (!bun) {
  console.error(`no Bun with node:sqlite: tried ${proofBunCandidates(process.execPath, process.env.HOME || homedir()).join(', ')}`)
  process.exit(1)
}
if (realpathSync(bun) !== realpathSync(process.execPath)) console.log(`proof runtime: ${bun}`)
process.exit(await runProofBun(bun, resolve(script), args))
