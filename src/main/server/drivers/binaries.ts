import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderId } from '@shared/catalog'

const execFileP = promisify(execFile)

/**
 * Binary resolution + doctor checks (docs/PLAN.md M5, Aliax lessons):
 *  - a GUI app's PATH lacks node/homebrew, so resolve through a login
 *    shell (`zsh -lc`), which loads .zprofile but NOT .zshrc — that also
 *    dodges the user's `codex` shell-function wrapper
 *  - .zshrc-only PATH edits are common though (cursor-agent installs its
 *    symlink into ~/.local/bin and appends the line there), so the usual
 *    per-user bin dirs get appended — after the login PATH, so anything
 *    the login shell already exports still wins
 *  - lookup walks that PATH in-process rather than asking a shell: same
 *    list the child will get, and shell functions can't shadow a binary
 *  - children get the login PATH and never inherit ELECTRON_RUN_AS_NODE
 */

const EXTRA_BIN_DIRS = [
  '.local/bin',
  '.bun/bin',
  '.cargo/bin',
  '.local/share/cursor-agent',
  '.npm-global/bin'
].map((d) => join(homedir(), d))

let loginPathP: Promise<string> | null = null
export function loginPath(): Promise<string> {
  loginPathP ??= execFileP('/bin/zsh', ['-lc', 'echo -n "$PATH"'])
    .then((r) => r.stdout.trim())
    .catch(() => process.env.PATH ?? '')
    .then(async (path) => {
      const seen = new Set(path.split(':').filter(Boolean))
      const extra: string[] = []
      for (const dir of EXTRA_BIN_DIRS) {
        if (seen.has(dir)) continue
        if (await exists(dir)) extra.push(dir)
      }
      return extra.length ? `${path}:${extra.join(':')}` : path
    })
  return loginPathP
}

function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false
  )
}

/**
 * Environment for spawned harnesses.
 *
 * A CLI gets the login PATH and none of the host's own build vars. Running
 * under `bun run dev` exports NODE_ENV=development and a pile of npm_* and
 * ELECTRON_* leftovers; dropping them keeps a dev instance spawning children
 * in the same environment the installed app gives them, so what you test is
 * what ships. ELECTRON_RUN_AS_NODE in particular breaks any Electron child.
 */
export async function harnessEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await loginPath() }
  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key.startsWith('npm_')) delete env[key]
  }
  delete env.NODE_ENV
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.NODE
  return env
}

const binCache = new Map<string, Promise<string | null>>()
export function resolveBinary(name: string): Promise<string | null> {
  let p = binCache.get(name)
  if (!p) {
    p = (async () => {
      for (const dir of (await loginPath()).split(':')) {
        if (!dir) continue
        const candidate = join(dir, name)
        if (await executable(candidate)) return candidate
      }
      return null
    })()
    binCache.set(name, p)
  }
  return p
}

function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false
  )
}

export interface DoctorReport {
  found: boolean
  path?: string
  version?: string
  error?: string
}

const BIN_NAME: Record<ProviderId, string | null> = {
  claude: null, // the Agent SDK ships its own bundled CLI
  codex: 'codex',
  cursor: 'cursor-agent'
}

async function checkProvider(provider: ProviderId): Promise<DoctorReport> {
  const bin = BIN_NAME[provider]
  if (!bin) {
    // The Agent SDK bundles its own CLI — always available with the app.
    return { found: true, version: 'bundled Agent SDK' }
  }
  const path = await resolveBinary(bin)
  if (!path) return { found: false, error: `${bin} not found on the login-shell PATH` }
  try {
    const env = await harnessEnv()
    const { stdout } = await execFileP(path, ['--version'], { env, timeout: 15_000 })
    return { found: true, path, version: stdout.trim().split('\n')[0] }
  } catch (err) {
    return { found: true, path, error: err instanceof Error ? err.message : String(err) }
  }
}

let doctorCache: { at: number; report: Promise<Record<ProviderId, DoctorReport>> } | null = null

export function runDoctor(): Promise<Record<ProviderId, DoctorReport>> {
  if (doctorCache && Date.now() - doctorCache.at < 60_000) return doctorCache.report
  const report = (async () => {
    const [claude, codex, cursor] = await Promise.all([
      checkProvider('claude'),
      checkProvider('codex'),
      checkProvider('cursor')
    ])
    return { claude, codex, cursor }
  })()
  doctorCache = { at: Date.now(), report }
  return report
}
