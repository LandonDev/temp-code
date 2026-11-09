/**
 * What every section of the config-dir spike shares: the run's context (its
 * dirs, the CLIs it found, the fakes, the dev instance), the evidence record,
 * per-run directories and environments, and the read-only listings of the
 * person's own config dirs around the runs that keep the real HOME.
 */
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WarmSpec } from '../../src/main/server/drivers/warm'
import { treeDiff, type TreeDiff, type TreeEntry } from './configDirSpike'
import { listTree, run, type FakeAnthropic, type FakeResponses } from './spikeFakes'

export type Harness = 'claude' | 'codex' | 'muse'

export interface Evidence {
  id: string
  harness: Harness
  host: string
  title: string
  at: string
  cli: { path: string | null; version: string | null } | null
  /** Variables the probe set on the CLI (values redacted at write). */
  env: Record<string, string>
  /** Variables the probe removed from the inherited environment. */
  unset: string[]
  argv: string[] | null
  commands: string[]
  observed: Record<string, unknown>
  status: 'ok' | 'partial' | 'fail' | 'skip' | 'error'
  verdict: string
}

export interface Experiment {
  id: string
  harness: Harness
  title: string
  run: (ev: Evidence) => Promise<void>
}

export interface Dev {
  gatewayPort: number
  claudeAccount: string | null
  codexAccount: string | null
  claudeAccounts: number
  codexAccounts: number
}

export interface Ctx {
  host: string
  run: string
  /** `$TMPDIR/tc-config-spike/<run>`: every run's tree. */
  root: string
  /** `scripts/.out/config-dir-spike/<host>`: the evidence. */
  out: string
  repo: string
  upstream: boolean
  loginPath: string
  claude: { login: string | null; loginVersion: string | null; bundled: string | null; bundledVersion: string | null; choice: string | null; choiceVersion: string | null }
  codexBin: string | null
  museBin: string | null
  anth: FakeAnthropic
  codexFront: FakeResponses
  museFront: FakeResponses
  caPath: string
  mcpScript: string
  dev: Dev | null
  claudeAccountOverride: string | null
  codexAccountOverride: string | null
  /** Specs the SDK computed, by run, for C3e. */
  specs: Record<string, { spec: WarmSpec; delivery: string; root: string }>
  /** Owned codex homes and their temp HOMEs, by run, for X2e. */
  codexHomes: Record<string, { home: string; tempHome: string }>
  codexAccepted: boolean | null
  museAccepted: boolean | null
  codexModel: string | null
  /** The recorded `GET /muse-code/models` answer (M0b), when the branch has it. */
  museModelsPath: string
}

let current: Ctx | null = null
export const setCtx = (c: Ctx): void => {
  current = c
}
export const ctx = (): Ctx => {
  if (!current) throw new Error('the spike context is not set')
  return current
}

export interface RunDirs {
  /** The run's own tree. */
  dir: string
  /** Its temp HOME: anything a CLI writes here is a leak. */
  home: string
  /** Its owned config root. */
  config: string
  /** The CLI's working directory. */
  cwd: string
}

export function mkRun(id: string): RunDirs {
  const dir = join(ctx().root, id)
  const dirs = { dir, home: join(dir, 'home'), config: join(dir, 'config'), cwd: join(dir, 'work') }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  return dirs
}

/** The inherited environment less `strip`, on the login PATH, marked with the run. */
export function baseEnv(strip: RegExp): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) if (!strip.test(k)) env[k] = v
  env.PATH = ctx().loginPath
  env.TC_SPIKE_RUN = ctx().run
  return env
}

/**
 * Every codex and Muse child runs behind a proxy that does not exist, loopback
 * exempt: whatever a CLI sends anywhere but the fakes (codex's model refresh
 * to chatgpt.com, an update check) fails on the machine instead of leaving it.
 */
export const EGRESS_GUARD: Record<string, string> = {
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost,::1',
  no_proxy: '127.0.0.1,localhost,::1'
}

/** Note on the evidence what the probe set and removed. */
export function noteEnv(ev: Evidence, set: Record<string, string>, unset: string[] = []): void {
  ev.env = { ...ev.env, ...set }
  ev.unset = [...new Set([...ev.unset, ...unset])].sort()
}

export const firstLine = (s: unknown): string => String(s ?? '').trim().split('\n')[0]?.slice(0, 300) ?? ''
export const errText = (e: unknown): string => firstLine(e instanceof Error ? e.message : e)
export const isProbeName = (s: string): boolean => /tc[-_]/.test(s)
export const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]

/** Each check true, false or not run (null) becomes the verdict line and the status. */
export function judge(ev: Evidence, checks: Record<string, boolean | null>, note = ''): void {
  ev.observed.checks = checks
  const parts = Object.entries(checks).map(([k, v]) => `${k} ${v === null ? '-' : v ? 'yes' : 'no'}`)
  ev.verdict = `${parts.join(', ')}${note ? `; ${note}` : ''}`
  const vals = Object.values(checks).filter((v): v is boolean => v !== null)
  ev.status = !vals.length ? 'skip' : vals.every(Boolean) ? 'ok' : vals.some(Boolean) ? 'partial' : 'fail'
}

export function skip(ev: Evidence, why: string): void {
  ev.status = 'skip'
  ev.verdict = `skipped: ${why}`
}

/** The person's own config dirs, read-only, two levels deep: names, sizes, mtimes. */
export function personalListing(): Record<string, TreeEntry[]> {
  const h = homedir()
  return {
    '.claude': listTree(join(h, '.claude'), 2),
    '.claude.json': listTree(join(h, '.claude.json')),
    '.codex': listTree(join(h, '.codex'), 2),
    '.config/muse': listTree(join(h, '.config', 'muse'), 2)
  }
}

/** What changed in the person's dirs between two listings: paths only. Other threads on the host write there too. */
export function personalDiff(before: Record<string, TreeEntry[]>, after: Record<string, TreeEntry[]>): Record<string, { added: string[]; removed: string[]; changed: string[] }> {
  const out: Record<string, { added: string[]; removed: string[]; changed: string[] }> = {}
  for (const key of Object.keys(before)) {
    const d: TreeDiff = treeDiff(before[key], after[key] ?? [])
    out[key] = { added: d.added.map((e) => e.path), removed: d.removed.map((e) => e.path), changed: d.changed.map((e) => e.path) }
  }
  return out
}

/** Entries by path and kind, the shape the inventories record. */
export const inventory = (entries: TreeEntry[]): string[] => entries.map((e) => `${e.kind === 'dir' ? 'd' : e.kind === 'link' ? 'l' : 'f'} ${e.path}${e.target ? ` -> ${e.target}` : ''}`)

/** The first `bin` on `path`, walked in-process as binaries.ts resolveBinary does. */
export function which(bin: string, path: string): string | null {
  for (const dir of path.split(':').filter(Boolean)) {
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // not here
    }
  }
  return null
}

/** The login shell's PATH plus the per-user bin dirs the app appends (binaries.ts EXTRA_BIN_DIRS). */
export async function loginPath(): Promise<string> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const r = await run(shell, ['-lc', 'printf %s "$PATH"'], { timeoutMs: 15_000 })
  const path = r.stdout.trim() || process.env.PATH || ''
  const seen = new Set(path.split(':'))
  const extra = ['.local/bin', '.bun/bin', '.cargo/bin', '.npm-global/bin'].map((d) => join(homedir(), d)).filter((d) => !seen.has(d) && existsSync(d))
  return extra.length ? `${path}:${extra.join(':')}` : path
}

export async function versionOf(bin: string | null, args = ['--version']): Promise<string | null> {
  if (!bin) return null
  const r = await run(bin, args, { timeoutMs: 30_000, env: { ...process.env, PATH: ctx().loginPath } })
  return r.code === 0 ? firstLine(r.stdout) : null
}

/** Compare two dotted versions: positive when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = (a.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number)
  const pb = (b.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export async function gitInit(dir: string): Promise<void> {
  await run('git', ['init', '-q', dir], { timeoutMs: 15_000 })
}
