import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GATE_LOG_TAIL, type GateStep } from '@shared/gate'
import { trackChild } from './spawnBudget'

/**
 * One gate step as a child process (shared/gate.ts says where each runs):
 * `typecheck` is `bun run typecheck` in a branch's worktree, `gate` is
 * `bun scripts/gate.ts --tier commit [--since <ref>]` on the project
 * checkout, `release` is `bun scripts/release.ts "<notes>"` there. Output
 * is one merged stream; the caller hears every line (the batch streams the
 * gate's `✓ step 12s` lines as its detail) and gets the tail back.
 *
 * Seam: `TEMP_CODE_GATE_STUB=<json>` (or `stub` on the options) is a list of
 * rules `{ step, branch?, ok, log? }`; the first rule whose step (and
 * branch, when named) matches decides the run and no command is spawned,
 * so a proof never runs the real gate on a scratch repo. An unmatched step
 * passes with a one-line log.
 */

export interface GateRunOptions {
  cwd: string
  step: GateStep
  /** the branch under test, for the row and the stub's match */
  branch: string
  /** `gate`: `--since <ref>`, the commit tier's path map decides the tiers */
  since?: string
  /** `release`: the notes */
  notes?: string
  onLine?: (line: string) => void
  env?: NodeJS.ProcessEnv
  stub?: string | null
  timeoutMs?: number
}

export interface GateRunResult {
  ok: boolean
  /** the last GATE_LOG_TAIL lines */
  log: string
  ms: number
  exitCode: number | null
}

export interface GateStubRule {
  step: GateStep
  branch?: string
  ok: boolean
  log?: string
}

export const DEFAULT_GATE_TIMEOUT_MS = 60 * 60_000

/** bun as the app finds it: BUN_INSTALL, the user's ~/.bun, Homebrew, else PATH. */
export function bunBinary(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, 'bin', 'bun') : null,
    join(env.HOME ?? homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun'
  ]
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? 'bun'
}

/** The child's environment: the post-commit hook's GIT_* dropped (every
 *  git call in a test would act as the hook's commit; release.ts says the
 *  same), and bun's own directory ahead of PATH, since the steps gate.ts
 *  and release.ts spawn say `bun` by name and the app's service on the box
 *  has no bun on its PATH. */
export function gateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_'))) as NodeJS.ProcessEnv
  const bun = bunBinary(env)
  if (bun.startsWith('/')) {
    const dir = dirname(bun)
    const path = (out.PATH ?? '').split(':').filter(Boolean)
    if (!path.includes(dir)) out.PATH = [dir, ...path].join(':')
  }
  return out
}

export function gateCommand(opts: Pick<GateRunOptions, 'step' | 'since' | 'notes'>): string[] {
  switch (opts.step) {
    case 'typecheck':
      return ['run', 'typecheck']
    case 'gate':
      return ['scripts/gate.ts', '--tier', 'commit', ...(opts.since ? ['--since', opts.since] : [])]
    case 'release':
      return ['scripts/release.ts', opts.notes?.trim() || 'batch release']
  }
}

export function parseGateStub(raw: string | null | undefined): GateStubRule[] | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    const list = Array.isArray(v) ? v : [v]
    return list.filter((r): r is GateStubRule => !!r && typeof r === 'object' && 'step' in r && 'ok' in r)
  } catch {
    return null
  }
}

function stubbed(rules: GateStubRule[], opts: GateRunOptions): GateRunResult {
  const rule = rules.find((r) => r.step === opts.step && (!r.branch || r.branch === opts.branch))
  const ok = rule?.ok ?? true
  const log = rule?.log ?? `stub: ${opts.step} ${ok ? 'passed' : 'failed'} on ${opts.branch}`
  for (const line of log.split('\n')) if (line.trim()) opts.onLine?.(line)
  return { ok, log: tailOf(log), ms: 0, exitCode: ok ? 0 : 1 }
}

export function tailOf(log: string, n = GATE_LOG_TAIL): string {
  const lines = log.split('\n').filter((l) => l.trim())
  return lines.slice(-n).join('\n')
}

/** Runs the step and answers its outcome; never throws for a red run. */
export function runGateStep(opts: GateRunOptions): Promise<GateRunResult> {
  const rules = parseGateStub(opts.stub ?? process.env.TEMP_CODE_GATE_STUB)
  if (rules) return Promise.resolve(stubbed(rules, opts))
  return new Promise((resolve) => {
    const started = Date.now()
    const env = gateEnv(opts.env ?? process.env)
    const lines: string[] = []
    let partial = ''
    const feed = (chunk: Buffer): void => {
      partial += chunk.toString('utf8')
      const parts = partial.split('\n')
      partial = parts.pop() ?? ''
      for (const raw of parts) {
        const line = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        if (!line.trim()) continue
        lines.push(line)
        if (lines.length > GATE_LOG_TAIL * 5) lines.splice(0, lines.length - GATE_LOG_TAIL * 5)
        opts.onLine?.(line)
      }
    }
    let child
    try {
      child = trackChild(spawn(bunBinary(env), gateCommand(opts), { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, log: `could not start ${opts.step}: ${msg}`, ms: Date.now() - started, exitCode: null })
      return
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const timer = setTimeout(() => {
      lines.push(`${opts.step} timed out after ${Math.round((opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS) / 60_000)} min`)
      child.kill('SIGKILL')
    }, opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS)
    child.on('error', (err) => {
      lines.push(`could not start ${opts.step}: ${err.message}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (partial.trim()) feed(Buffer.from('\n'))
      resolve({ ok: code === 0, log: tailOf(lines.join('\n')), ms: Date.now() - started, exitCode: code })
    })
  })
}
