import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProviderId } from '@shared/catalog'

const execFileP = promisify(execFile)

/**
 * Binary resolution + doctor checks (docs/PLAN.md M5, Aliax lessons):
 *  - a GUI app's PATH lacks node/homebrew, so resolve through a login
 *    shell (`zsh -lc`), which loads .zprofile but NOT .zshrc — that also
 *    dodges the user's `codex` shell-function wrapper
 *  - children get the login PATH and never inherit ELECTRON_RUN_AS_NODE
 */

let loginPathP: Promise<string> | null = null
export function loginPath(): Promise<string> {
  loginPathP ??= execFileP('/bin/zsh', ['-lc', 'echo -n "$PATH"'])
    .then((r) => r.stdout.trim())
    .catch(() => process.env.PATH ?? '')
  return loginPathP
}

/** Environment for spawned harnesses. */
export async function harnessEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: await loginPath() }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

const binCache = new Map<string, Promise<string | null>>()
export function resolveBinary(name: string): Promise<string | null> {
  let p = binCache.get(name)
  if (!p) {
    p = execFileP('/bin/zsh', ['-lc', `command -v ${name}`])
      .then((r) => {
        const line = r.stdout.trim().split('\n').at(-1) ?? ''
        return line.startsWith('/') ? line : null
      })
      .catch(() => null)
    binCache.set(name, p)
  }
  return p
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
