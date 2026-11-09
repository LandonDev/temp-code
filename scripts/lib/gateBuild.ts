/**
 * The build a gate proof reads: `out/` must be HEAD's own, and a proof never
 * builds it. When gate.ts or release-publish.sh runs the build beside the
 * proofs it names a done file (TEMP_CODE_SOAK_BUILD_DONE), removed when the
 * build starts and touched once bundle-size passes; a proof waits for that
 * file alone, since out/ still holds the last run's valid stamp while the
 * build rewrites it. With no done file the stamp in out/bundle-map.json
 * decides (scripts/lib/soakJudge.ts `buildIsCurrent`), polled while another
 * process may be building. The soaks pass `orBuild` and build a stale tree
 * themselves; the store and computer proofs never do.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildIsCurrent, type BuildStamp } from './soakJudge'

export const GATE_BUILD_WAIT_MS = 10 * 60_000
export const STAMP_POLL_MS = 2_000
export const DONE_POLL_MS = 1_000

export interface GateBuildOptions {
  /** The checkout whose out/ the proof reads. */
  tree: string
  /** The done file; defaults to TEMP_CODE_SOAK_BUILD_DONE. */
  doneFile?: string
  timeoutMs?: number
  /** Called once when out/ is not HEAD's and no done file is named: the soak's own build. */
  orBuild?: () => void
  log?: (line: string) => void
  // Seams for the test.
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  exists?: (path: string) => boolean
  readStamp?: (tree: string) => BuildStamp
  headState?: (tree: string) => { head: string; clean: boolean }
}

/** out/bundle-map.json's `head`, or null when there is no build. */
export function readBuildStamp(tree: string): BuildStamp {
  try {
    return (JSON.parse(readFileSync(join(tree, 'out', 'bundle-map.json'), 'utf8')) as { head?: BuildStamp }).head ?? null
  } catch {
    return null
  }
}

export function treeHead(tree: string): { head: string; clean: boolean } {
  const git = (...a: string[]): string => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8' }).trim()
  return { head: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain', '--untracked-files=no') === '' }
}

const describe = (stamp: BuildStamp, state: { head: string; clean: boolean }): string =>
  `${stamp?.sha ? `${stamp.sha.slice(0, 8)}${stamp.clean ? '' : ', dirty'}` : 'none'}, HEAD ${state.head.slice(0, 8)}${state.clean ? '' : ' dirty'}`

/**
 * Resolves once out/ is the build to read: `done-file` when the named done
 * file appeared, `current` when the stamp is HEAD's, `built` when `orBuild`
 * ran. Throws past the timeout.
 */
export async function waitForGateBuild(opts: GateBuildOptions): Promise<'done-file' | 'current' | 'built'> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const exists = opts.exists ?? existsSync
  const readStamp = opts.readStamp ?? readBuildStamp
  const headState = opts.headState ?? treeHead
  const log = opts.log ?? (() => {})
  const until = now() + (opts.timeoutMs ?? GATE_BUILD_WAIT_MS)
  const minutes = Math.round((opts.timeoutMs ?? GATE_BUILD_WAIT_MS) / 60_000)
  const done = opts.doneFile ?? process.env.TEMP_CODE_SOAK_BUILD_DONE
  if (done) {
    let said = false
    while (!exists(done)) {
      if (now() > until) throw new Error(`the build never finished: no ${done} within ${minutes} minutes`)
      if (!said) log('waiting for the gate build to finish')
      said = true
      await sleep(DONE_POLL_MS)
    }
    log('the gate build finished: reading its out/')
    return 'done-file'
  }
  let said = false
  for (;;) {
    const stamp = readStamp(opts.tree)
    const state = headState(opts.tree)
    if (buildIsCurrent(stamp, state.head, state.clean)) return 'current'
    if (opts.orBuild) {
      log(`out/ is not HEAD's build (${describe(stamp, state)}): building first`)
      opts.orBuild()
      return 'built'
    }
    if (now() > until) throw new Error(`out/ is not HEAD's build (${describe(stamp, state)}) after ${minutes} minutes: run \`bunx electron-vite build\` first`)
    if (!said) log(`out/ is not HEAD's build (${describe(stamp, state)}): waiting for a build`)
    said = true
    await sleep(STAMP_POLL_MS)
  }
}
