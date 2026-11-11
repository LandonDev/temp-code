import { LEARNED_VIAS, type IgnoredRoutes, type LearnedVia } from '@shared/computer/protocol'
import {
  COMPUTER_ACTIONS,
  TierVerdictSchema,
  VERDICT_MISSES_TO_RAISE,
  tierVerdictSetting,
  type ActionClass,
  type TierVerdict
} from '@shared/computer/tools'
import type { ComputerAction, ProbeReport, StepResult, Tier } from '@shared/computer/protocol'

/**
 * Per app, the lowest tier that worked for each action class
 * (docs/computer-protocol.md §5.2 and "Tier verdicts"), kept in the settings
 * row `computer.tiers.<bundleId>`. Each call's `tiers` comes from it: `ax`
 * first, `process` unless the class's verdict is `session`, `session` only
 * when the gate admits it. Apps with no bundle id keep no verdict.
 */

export interface SettingsStore {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  /** every row whose key starts with `prefix` (db.ts) */
  settingsWithPrefix(prefix: string): Map<string, string>
}

/** A verdict older than this is forgotten: an app update may have fixed it. */
export const VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const empty = (bundleId: string, now: number): TierVerdict => ({ bundleId, classes: {}, misses: {}, updatedAt: now })
/** The newest name wins; no name leaves the one kept. */
const named = (v: TierVerdict, name: string | undefined): TierVerdict => (name && name !== v.name ? { ...v, name } : v)
const VERDICT_PREFIX = tierVerdictSetting('')
const isLearned = (via: string | undefined): via is LearnedVia => (LEARNED_VIAS as readonly string[]).includes(via ?? '')

/**
 * A learned fallback route's misses (§24.1): `none` counts one up, `changed` clears it, `unknown`
 * leaves it. Only `hit`, `caret` and `scroll-page`: a bar at its end and a menu item that changes
 * nothing in the window are honest no-ops, and learning from them would demote the route.
 */
function learnVia(v: TierVerdict, step: StepResult): boolean {
  if (step.status !== 'ok' || step.effect === 'unknown' || !isLearned(step.input?.via)) return false
  const via = step.input.via
  const misses = { ...v.viaMisses }
  if (step.effect === 'none') misses[via] = (misses[via] ?? 0) + 1
  else if (misses[via] === undefined) return false
  else delete misses[via]
  if (Object.keys(misses).length) v.viaMisses = misses
  else delete v.viaMisses
  return true
}
const classOf = (action: Pick<ComputerAction, 'action'>): ActionClass | null => COMPUTER_ACTIONS[action.action].class

/** Pure: the next verdict after one step, or null when it learns nothing. */
export function nextVerdict(prev: TierVerdict | null, cls: ActionClass, step: StepResult, now: number, bundleId: string): TierVerdict | null {
  const v: TierVerdict = prev ? { ...prev, classes: { ...prev.classes }, misses: { ...prev.misses } } : empty(bundleId, now)
  // a fallback route is learned before the ax step's early return below
  if (learnVia(v, step) && step.status === 'ok' && step.tier === 'ax') {
    v.updatedAt = now
    return v
  }
  if (step.status === 'failed') {
    if (step.error.kind !== 'key_window_unavailable' || v.needsKeyWindow) return null
    v.needsKeyWindow = true
  } else if (step.status === 'ok') {
    if (step.tier === null || step.tier === 'ax' || step.effect === 'unknown') return null
    const misses = v.misses[cls] ?? 0
    if (step.tier === 'process') {
      if (step.effect === 'none') v.misses[cls] = misses + 1
      else {
        if (v.classes[cls] === 'process' && misses === 0) return null
        delete v.misses[cls]
        v.classes[cls] = 'process'
      }
    } else {
      if (step.effect !== 'changed' || misses < VERDICT_MISSES_TO_RAISE || v.classes[cls] === 'session') return null
      v.classes[cls] = 'session'
      delete v.misses[cls]
    }
  } else return null
  v.updatedAt = now
  return v
}

export class TierVerdicts {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: SettingsStore,
    private readonly clock: { now(): number } = Date
  ) {}

  get(bundleId: string | null): TierVerdict | null {
    if (!bundleId) return null
    return this.parse(this.store.getSetting(tierVerdictSetting(bundleId)))
  }

  /** Every verdict still kept: past-TTL and unreadable rows left out. */
  list(): TierVerdict[] {
    const out: TierVerdict[] = []
    for (const [key, raw] of this.store.settingsWithPrefix(VERDICT_PREFIX)) {
      const v = this.parse(raw)
      if (v && tierVerdictSetting(v.bundleId) === key) out.push(v)
    }
    return out
  }

  /** Settings → Computer use's Forget: one app's verdict, or every app's with null. Its classes, misses and probe go together, so the next call probes again. */
  forget(bundleId: string | null): void {
    const keys = bundleId === null ? [...this.store.settingsWithPrefix(VERDICT_PREFIX).keys()] : [tierVerdictSetting(bundleId)]
    let changed = false
    for (const key of keys) {
      if (this.store.getSetting(key) === null) continue
      this.store.setSetting(key, null)
      changed = true
    }
    if (changed) this.emit()
  }

  /** Called after every write and forget; answers its unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * The tiers for one step: 'ax' first, 'process' unless the class's verdict
   * is 'session', 'session' only when admitted. With 'session' admitted, a
   * class that missed at 'process' twice skips it, so the session step that
   * raises the verdict gets its chance.
   */
  tiersFor(bundleId: string | null, action: Pick<ComputerAction, 'action'>, sessionAdmitted: boolean): Tier[] {
    const cls = classOf(action)
    const v = this.get(bundleId)
    const tiers: Tier[] = ['ax']
    const skipProcess = cls !== null && (v?.classes[cls] === 'session' || (sessionAdmitted && (v?.misses[cls] ?? 0) >= VERDICT_MISSES_TO_RAISE))
    if (!skipProcess) tiers.push('process')
    if (sessionAdmitted) tiers.push('session')
    return tiers
  }

  /** Does this step need the session tier by the verdict alone? */
  needsSession(bundleId: string | null, action: Pick<ComputerAction, 'action'>): boolean {
    const cls = classOf(action)
    return cls !== null && this.get(bundleId)?.classes[cls] === 'session'
  }

  /**
   * What the service runs last for this app (§24.1): each learned route and each process class
   * that missed `VERDICT_MISSES_TO_RAISE` times in a row; undefined when there is none.
   */
  ignoredFor(bundleId: string | null): IgnoredRoutes | undefined {
    const v = this.get(bundleId)
    if (!v) return undefined
    const via = LEARNED_VIAS.filter((r) => (v.viaMisses?.[r] ?? 0) >= VERDICT_MISSES_TO_RAISE)
    const process = (Object.keys(v.misses) as ActionClass[]).filter((c) => (v.misses[c] ?? 0) >= VERDICT_MISSES_TO_RAISE)
    if (!via.length && !process.length) return undefined
    return { ...(via.length ? { via } : {}), ...(process.length ? { process } : {}) }
  }

  /** One step's verdict; `name` is the app's, kept on a verdict that learns, or one that lacks it or holds an older one. */
  learn(bundleId: string | null, action: Pick<ComputerAction, 'action'>, step: StepResult, name?: string): void {
    const cls = classOf(action)
    if (!bundleId || !cls) return
    const prev = this.get(bundleId)
    const next = nextVerdict(prev, cls, step, this.clock.now(), bundleId)
    if (next) this.save(named(next, name))
    else if (prev && name && prev.name !== name) this.save(named(prev, name))
  }

  /** input.probe's report: honoured sets the class to process, ignored puts it two misses in, a key window elsewhere is recorded. */
  learnProbe(bundleId: string, report: ProbeReport, name?: string): void {
    const now = this.clock.now()
    const v = this.get(bundleId) ?? empty(bundleId, now)
    for (const r of report.results) {
      if (r.outcome === 'honoured') {
        v.classes[r.class] = 'process'
        delete v.misses[r.class]
      } else if (r.outcome === 'ignored') v.misses[r.class] = VERDICT_MISSES_TO_RAISE
    }
    if (report.keyWindow !== 'target') v.needsKeyWindow = true
    this.save(named({ ...v, probedAt: now, updatedAt: now }, name))
  }

  /** A probe that failed is stamped too, so it never runs again for that app. */
  stampProbe(bundleId: string, name?: string): void {
    const now = this.clock.now()
    this.save(named({ ...(this.get(bundleId) ?? empty(bundleId, now)), probedAt: now, updatedAt: now }, name))
  }

  /** No verdict and never probed. */
  needsProbe(bundleId: string | null): boolean {
    const v = this.get(bundleId)
    return bundleId !== null && (v === null || v.probedAt === undefined) && !(v && Object.keys(v.classes).length)
  }

  private parse(raw: string | null): TierVerdict | null {
    if (!raw) return null
    try {
      const v = TierVerdictSchema.parse(JSON.parse(raw))
      return this.clock.now() - v.updatedAt > VERDICT_TTL_MS ? null : v
    } catch {
      return null
    }
  }

  private save(v: TierVerdict): void {
    this.store.setSetting(tierVerdictSetting(v.bundleId), JSON.stringify(TierVerdictSchema.parse(v)))
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}
