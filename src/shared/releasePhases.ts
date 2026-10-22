/**
 * The release's phase lines, as scripts/release-publish.sh prints them and
 * the app reads them (hostJobs.ts Publisher, batch.ts's publish step, the
 * board's foot). One fixed prefix, one line per event:
 *
 *   phase › gate                   the phase started
 *   phase ✓ gate 71s               it passed, in that long
 *   phase ✗ build 12s              it failed
 *   phase – gate skipped           it was skipped (GATE_SKIP=1)
 *   phase ✓ total 4m12s 1.0.283    the whole run, and the version published
 *
 * The script's phases are gate, build, sign, zip, pack, upload and feed;
 * the app that ran it adds `update` (its own download of what it just
 * published, update.ts). A box deploy's lines (box-update.sh) name their
 * stage with an upper-case word and a colon: SOURCE, MODULES, BUILD, TRIAL,
 * SNAPSHOT, COMMIT, PRUNE; `deployStageOf` maps them onto the same shape.
 */

export const PUBLISH_PHASES = ['gate', 'build', 'sign', 'zip', 'pack', 'upload', 'feed', 'update'] as const
export type PublishPhase = (typeof PUBLISH_PHASES)[number]

/** The script's own phases: what a run without the app's update counts. */
export const SCRIPT_PHASES: readonly PublishPhase[] = PUBLISH_PHASES.filter((p) => p !== 'update')

export const DEPLOY_STAGES = ['source', 'modules', 'build', 'trial', 'snapshot', 'commit', 'prune'] as const
export type DeployStage = (typeof DEPLOY_STAGES)[number]

export type PhaseLine =
  | { kind: 'start'; phase: string }
  | { kind: 'end'; phase: string; ok: boolean; ms: number }
  | { kind: 'skipped'; phase: string }
  | { kind: 'total'; ms: number; version: string | null }

const PHASE_LINE = /^phase ([›✓✗–]) (\S+)(?: (.+))?$/

/** "71s", "4m12s", "4m 12s", "1.2s", "2h3m" → ms; null for anything else. */
export function parseDuration(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)/g
  let ms = 0
  let seen = 0
  let m: RegExpExecArray | null
  let last = 0
  while ((m = re.exec(t))) {
    if (t.slice(last, m.index).trim()) return null
    last = re.lastIndex
    const n = Number(m[1])
    ms += n * (m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1_000)
    seen++
  }
  if (!seen || t.slice(last).trim()) return null
  return Math.round(ms)
}

/** ms → "71s", "4m12s", "1h02m": the script's own spelling, no spaces. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** One line of a publish log; null when it is not a phase line. */
export function parsePhaseLine(line: string): PhaseLine | null {
  const m = PHASE_LINE.exec(line.trim())
  if (!m) return null
  const [, mark, name, rest = ''] = m
  if (mark === '›') return { kind: 'start', phase: name }
  if (mark === '–') return { kind: 'skipped', phase: name }
  const [dur, ...tail] = rest.split(/\s+/).filter(Boolean)
  const ms = dur ? parseDuration(dur) : null
  if (name === 'total') {
    const version = tail.find((t) => /^v?\d+\.\d+\.\d+$/.test(t))?.replace(/^v/, '') ?? null
    return { kind: 'total', ms: ms ?? 0, version }
  }
  return { kind: 'end', phase: name, ok: mark === '✓', ms: ms ?? 0 }
}

export interface PhaseProgress {
  done: number
  total: number
  label?: string
}

/**
 * The run so far, from its lines: which phases ended and how long each
 * took, which one runs, the version and total the last line names.
 * `expected` is the phase list the progress counts against; a phase the
 * list does not name is kept in `times` but not counted.
 */
export class PhaseTracker {
  readonly times = new Map<string, number>()
  readonly failed = new Set<string>()
  readonly skipped = new Set<string>()
  running: string | null = null
  version: string | null = null
  totalMs: number | null = null
  private readonly expected: readonly string[]

  constructor(expected: readonly string[] = PUBLISH_PHASES) {
    this.expected = expected
  }

  /** Feed one line; the parsed event when it was a phase line. */
  feed(line: string): PhaseLine | null {
    const event = parsePhaseLine(line)
    if (!event) return null
    switch (event.kind) {
      case 'start':
        this.running = event.phase
        break
      case 'end':
        this.times.set(event.phase, event.ms)
        if (!event.ok) this.failed.add(event.phase)
        if (this.running === event.phase) this.running = null
        break
      case 'skipped':
        this.skipped.add(event.phase)
        if (this.running === event.phase) this.running = null
        break
      case 'total':
        this.totalMs = event.ms
        this.version = event.version
        this.running = null
        break
    }
    return event
  }

  /** Phases of the expected list that ended (passed, failed or skipped). */
  get done(): number {
    return this.expected.filter((p) => this.times.has(p) || this.skipped.has(p)).length
  }

  /** `done of total` with the running phase as the label; after the end, no label. */
  progress(): PhaseProgress {
    const p: PhaseProgress = { done: this.done, total: this.expected.length }
    if (this.running) p.label = this.running
    return p
  }

  /** "gate 71s · build 84s · sign 40s", in the expected order then the rest. */
  summary(): string {
    const order = [...this.expected, ...[...this.times.keys()].filter((k) => !this.expected.includes(k))]
    return order
      .filter((p) => this.times.has(p))
      .map((p) => `${p} ${formatDuration(this.times.get(p)!)}${this.failed.has(p) ? ' failed' : ''}`)
      .join(' · ')
  }
}

/** The stage a box-update line names ("SOURCE: release asset …" → source, "TRIAL PASS: …" → trial), else null. */
export function deployStageOf(line: string): DeployStage | null {
  const m = /^([A-Z]+)(?: PASS)?:/.exec(line.trim())
  if (!m) return null
  const word = m[1].toLowerCase()
  return (DEPLOY_STAGES as readonly string[]).includes(word) ? (word as DeployStage) : null
}

/** A box deploy's progress from its lines so far: stages seen of the whole list, the latest as the label. */
export function deployProgress(lines: readonly string[]): PhaseProgress {
  const seen = new Set<DeployStage>()
  let latest: DeployStage | null = null
  for (const line of lines) {
    const stage = deployStageOf(line)
    if (!stage) continue
    seen.add(stage)
    latest = stage
  }
  const p: PhaseProgress = { done: seen.size, total: DEPLOY_STAGES.length }
  if (latest) p.label = latest
  return p
}
