import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import release from '../../release.json'
import { version as appVersion } from '../../package.json'
import type { BuildFacts } from '../shared/deployDrift'

/**
 * What this process runs: the release number every green master commit
 * bumps (release.json `n`, package.json `1.0.N`) and the commit it was
 * built from. Both ride in the hello frame and `/api/hello`, so every host
 * can say what the others run, and the deploy-drift mark compares the
 * number with master's (deployDrift.ts).
 *
 * The sha has two sources. A published Mac build carries it in the bundled
 * package.json under `tempcodeBuild.sha` (scripts/release-publish.sh passes
 * it through electron-builder's extraMetadata, the way the e2e harness
 * block rides). The box runs a detached clone (box-update.sh) and a dev
 * instance runs the tree, so there `.git/HEAD` names the commit, through a
 * worktree's `gitdir:` file, a symbolic ref and packed-refs when needed.
 */
export interface BuildInfo {
  /** release.json `n`. */
  release: number
  /** package.json's version, `1.0.N`. */
  version: string
  /** The full commit sha, or null when neither source has one. */
  sha: string | null
}

const SHA = /^[0-9a-f]{40}$/

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** `tempcodeBuild.sha` of the package.json at `appPath`, when a build recorded one. */
export function bundledBuildSha(appPath: string): string | null {
  const text = readText(join(appPath, 'package.json'))
  if (!text) return null
  try {
    const sha = (JSON.parse(text) as { tempcodeBuild?: { sha?: unknown } }).tempcodeBuild?.sha
    return typeof sha === 'string' && SHA.test(sha.trim()) ? sha.trim() : null
  } catch {
    return null
  }
}

/** The git dir of a checkout: `.git` itself, or the dir a worktree's `.git` file points at. */
function gitDir(appPath: string): string | null {
  const dotGit = join(appPath, '.git')
  let st
  try {
    st = statSync(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  const text = readText(dotGit)
  const m = text?.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!m) return null
  return isAbsolute(m[1]) ? m[1] : resolve(appPath, m[1])
}

function readRef(dir: string, ref: string): string | null {
  const direct = readText(join(dir, ref))?.trim()
  if (direct && SHA.test(direct)) return direct
  const packed = readText(join(dir, 'packed-refs'))
  if (!packed) return null
  for (const line of packed.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/)
    if (name === ref && sha && SHA.test(sha)) return sha
  }
  return null
}

/** The commit `.git/HEAD` names at `appPath`, or null when it is not a checkout. */
export function checkoutSha(appPath: string): string | null {
  const dir = gitDir(appPath)
  if (!dir) return null
  const head = readText(join(dir, 'HEAD'))?.trim()
  if (!head) return null
  if (SHA.test(head)) return head
  const m = head.match(/^ref:\s*(\S+)/)
  if (!m) return null
  // A worktree keeps its own HEAD; branches and packed-refs are the main repo's.
  const common = readText(join(dir, 'commondir'))?.trim()
  const dirs = [dir, ...(common ? [isAbsolute(common) ? common : resolve(dir, common)] : [])]
  for (const d of dirs) {
    const sha = readRef(d, m[1])
    if (sha) return sha
  }
  return null
}

export function readBuildSha(appPath: string): string | null {
  return bundledBuildSha(appPath) ?? checkoutSha(appPath)
}

/** This process's build: the bundled release number and version, the sha from `appPath`. */
export function buildInfo(appPath?: string): BuildInfo {
  return { release: release.n, version: appVersion, sha: appPath ? readBuildSha(appPath) : null }
}

/** This host's platform as every host decision reads it (the hello's
 *  `build.platform`, the settings home of a linked project, the box's id
 *  winning a link conflict). `TEMP_CODE_BUILD_PLATFORM` lets an isolated
 *  instance of a proof play a Mac on the box (scripts/e2e-linked-projects.ts). */
export function hostPlatform(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEMP_CODE_BUILD_PLATFORM?.trim() || process.platform
}

/** The hello's `build`: this build plus the platform that decides how it is brought up to master. */
export function buildFacts(appPath?: string, platform: string = hostPlatform()): BuildFacts {
  return { ...buildInfo(appPath), platform }
}

/** Where a checkout's package.json lives for a path inside it (tests and tools). */
export function checkoutRootOf(path: string): string {
  let dir = path
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
  return dir
}
