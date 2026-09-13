import { execFile } from 'node:child_process'
import { access, constants, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProviderId } from '@shared/catalog'
import { hasAppBridge } from '../apptools'

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

/**
 * scripts/app-mcp-bridge.mjs needs a plain node process — the packaged
 * app ships with `electronFuses.runAsNode: false`, so ELECTRON_RUN_AS_NODE
 * launches a second TempCode instead, which the single-instance lock then
 * kills. Prefer a real `node` (≥22, for the global WebSocket client) or
 * `bun` off the login PATH; the Electron-as-node trick is a last resort,
 * correct in dev (where the fuse is on) but not in a packaged build.
 */
export interface AppBridgeLaunch {
  command: string
  env: Record<string, string>
  note?: string
}

const MIN_BRIDGE_NODE_MAJOR = 22

async function nodeMajorVersion(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(path, ['--version'], { timeout: 10_000 })
    const major = Number(stdout.trim().replace(/^v/, '').split('.')[0])
    return Number.isFinite(major) ? major : null
  } catch {
    return null
  }
}

export async function resolveAppBridgeLaunch(): Promise<AppBridgeLaunch> {
  const node = await resolveBinary('node')
  if (node) {
    const major = await nodeMajorVersion(node)
    const note =
      major != null && major < MIN_BRIDGE_NODE_MAJOR
        ? `app-mcp-bridge.mjs wants node ${MIN_BRIDGE_NODE_MAJOR}+, found ${node} at ${major}`
        : undefined
    return { command: node, env: {}, note }
  }
  const bun = await resolveBinary('bun')
  if (bun) return { command: bun, env: {} }
  return {
    command: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    note: 'no node or bun on the login PATH — falling back to Electron-as-node, which only works in dev'
  }
}

export interface DoctorReport {
  found: boolean
  path?: string
  version?: string
  error?: string
}

const BIN_NAME: Record<ProviderId, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  grok: 'grok',
  opencode: 'opencode',
  pi: 'pi',
  omp: 'omp',
  fx: 'fx'
}

/** The ported harnesses resolve through their own finders (extra install
 *  dirs, fx's agent check); `--version` is not probed for them. */
const PORTED: Partial<Record<ProviderId, () => Promise<{ path: string }>>> = {}
async function portedResolver(provider: ProviderId): Promise<(() => Promise<{ path: string }>) | null> {
  if (!['grok', 'opencode', 'pi', 'omp', 'fx'].includes(provider)) return null
  if (!PORTED[provider]) {
    const child = await import('./harness/child')
    Object.assign(PORTED, {
      grok: child.resolveGrokBinary,
      opencode: child.resolveOpenCodeBinary,
      pi: child.resolvePiBinary,
      omp: child.resolveOmpBinary,
      fx: child.resolveFxBinary
    })
  }
  return PORTED[provider] ?? null
}

// ── claude: bundled SDK CLI vs standalone install ────────────────────
//
// The claude provider runs through the Agent SDK, which pins its own CLI
// build — and the API rejects requests from CLIs too old for a new model
// ("version 2.1.251 or newer is required"). `claude update` only touches
// the user's standalone install, so sessions spawn that standalone CLI
// whenever it's newer than the bundled one (pathToClaudeCodeExecutable);
// the bundled CLI remains the fallback and updates with app releases.

let bundledClaudeV: string | null | undefined
function bundledClaudeVersion(): string | null {
  if (bundledClaudeV === undefined) {
    try {
      const req = createRequire(import.meta.url)
      const manifest = req('@anthropic-ai/claude-agent-sdk/manifest.json') as { version?: string }
      bundledClaudeV = manifest.version ?? null
    } catch {
      bundledClaudeV = null
    }
  }
  return bundledClaudeV
}

const parseV = (v: string): number[] => (v.match(/\d+(\.\d+)+/)?.[0] ?? '0').split('.').map(Number)
const newerV = (a: string, b: string): boolean => {
  const [x, y] = [parseV(a), parseV(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

export interface ClaudeChoice {
  /** standalone CLI to spawn via pathToClaudeCodeExecutable; null = bundled */
  path: string | null
  version: string | null
}

let claudeChoiceP: Promise<ClaudeChoice> | null = null
export function resolveClaude(): Promise<ClaudeChoice> {
  claudeChoiceP ??= (async () => {
    const bundled = bundledClaudeVersion()
    const path = await resolveBinary('claude')
    if (path) {
      try {
        const env = await harnessEnv()
        const { stdout } = await execFileP(path, ['--version'], { env, timeout: 15_000 })
        const version = stdout.trim().split('\n')[0]
        if (!bundled || newerV(version, bundled)) return { path, version }
      } catch {
        // unusable standalone install — fall back to the bundled CLI
      }
    }
    return { path: null, version: bundled }
  })()
  return claudeChoiceP
}

async function checkProvider(provider: ProviderId): Promise<DoctorReport> {
  if (provider === 'claude') {
    const choice = await resolveClaude()
    if (choice.path) return { found: true, path: choice.path, version: choice.version ?? undefined }
    return {
      found: true,
      version: choice.version ? `${choice.version} (bundled)` : 'bundled Agent SDK'
    }
  }
  const bin = BIN_NAME[provider]
  const ported = await portedResolver(provider)
  if (ported) {
    try {
      const { path } = await ported()
      return withBridgeNote(provider, { found: true, path })
    } catch (err) {
      return { found: false, error: err instanceof Error ? err.message : `${bin} not found` }
    }
  }
  const path = await resolveBinary(bin)
  if (!path) return { found: false, error: `${bin} not found on the login-shell PATH` }
  try {
    const env = await harnessEnv()
    const { stdout } = await execFileP(path, ['--version'], { env, timeout: 15_000 })
    return withBridgeNote(provider, { found: true, path, version: stdout.trim().split('\n')[0] })
  } catch (err) {
    return withBridgeNote(provider, {
      found: true,
      path,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Only codex reaches the app tools through the stdio bridge (M10); cursor
 *  has no per-run MCP config to hand it one. */
function withBridgeNote(provider: ProviderId, report: DoctorReport): DoctorReport {
  if (provider !== 'codex' || report.error || hasAppBridge()) return report
  return { ...report, error: 'app tools unavailable for Codex' }
}

let doctorCache: { at: number; report: Promise<Record<ProviderId, DoctorReport>> } | null = null

export function runDoctor(): Promise<Record<ProviderId, DoctorReport>> {
  if (doctorCache && Date.now() - doctorCache.at < 60_000) return doctorCache.report
  const report = (async () => {
    const ids = Object.keys(BIN_NAME) as ProviderId[]
    const rows = await Promise.all(ids.map((id) => checkProvider(id)))
    return Object.fromEntries(ids.map((id, i) => [id, rows[i]])) as Record<ProviderId, DoctorReport>
  })()
  doctorCache = { at: Date.now(), report }
  return report
}

/**
 * Update a provider's CLI in place, then re-check it. claude and
 * cursor-agent self-update; codex has no self-updater, so the update
 * goes through whatever installed it (npm or homebrew, judged from the
 * binary's real path). Throws with the tool's own output on failure.
 */
export async function updateProvider(provider: ProviderId): Promise<DoctorReport> {
  const env = await harnessEnv()
  const opts = { env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }
  const fail = (err: unknown): never => {
    const e = err as Error & { stderr?: string; stdout?: string }
    const detail = (e.stderr || e.stdout || e.message || String(err)).trim().split('\n').slice(-4)
    throw new Error(detail.join('\n'))
  }
  if (provider === 'claude' || provider === 'cursor') {
    const bin = BIN_NAME[provider]
    const path = await resolveBinary(bin)
    if (!path) {
      throw new Error(
        provider === 'claude'
          ? 'no standalone Claude Code install found — the bundled CLI updates with app releases'
          : 'cursor-agent not found on the login-shell PATH'
      )
    }
    await execFileP(path, ['update'], opts).catch(fail)
  } else {
    const path = await resolveBinary('codex')
    if (!path) throw new Error('codex not found on the login-shell PATH')
    const real = await realpath(path)
    const cmd = real.includes('node_modules/@openai/codex')
      ? 'npm install -g @openai/codex@latest'
      : real.includes('/Cellar/')
        ? 'brew upgrade codex'
        : null
    if (!cmd) throw new Error(`can't tell how codex was installed (${real}) — update it manually`)
    await execFileP('/bin/zsh', ['-lc', cmd], opts).catch(fail)
  }
  // paths and versions may have moved — re-resolve everything
  binCache.clear()
  claudeChoiceP = null
  doctorCache = null
  return checkProvider(provider)
}
