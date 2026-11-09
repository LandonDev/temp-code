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
}

/** A verdict older than this is forgotten: an app update may have fixed it. */
export const VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000

const empty = (bundleId: string, now: number): TierVerdict => ({ bundleId, classes: {}, misses: {}, updatedAt: now })
const classOf = (action: Pick<ComputerAction, 'action'>): ActionClass | null => COMPUTER_ACTIONS[action.action].class

/** Pure: the next verdict after one step, or null when it learns nothing. */
export function nextVerdict(prev: TierVerdict | null, cls: ActionClass, step: StepResult, now: number, bundleId: string): TierVerdict | null {
  const v: TierVerdict = prev ? { ...prev, classes: { ...prev.classes }, misses: { ...prev.misses } } : empty(bundleId, now)
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
  constructor(
    private readonly store: SettingsStore,
    private readonly clock: { now(): number } = Date
  ) {}

  get(bundleId: string | null): TierVerdict | null {
    if (!bundleId) return null
    const raw = this.store.getSetting(tierVerdictSetting(bundleId))
    if (!raw) return null
    try {
      const v = TierVerdictSchema.parse(JSON.parse(raw))
      return this.clock.now() - v.updatedAt > VERDICT_TTL_MS ? null : v
    } catch {
      return null
    }
  }

  /** The tiers for one step: 'ax' first, 'process' unless the class's verdict is 'session', 'session' only when admitted. */
  tiersFor(bundleId: string | null, action: Pick<ComputerAction, 'action'>, sessionAdmitted: boolean): Tier[] {
    const tiers: Tier[] = ['ax']
    if (!this.needsSession(bundleId, action)) tiers.push('process')
    if (sessionAdmitted) tiers.push('session')
    return tiers
  }

  /** Does this step need the session tier by the verdict alone? */
  needsSession(bundleId: string | null, action: Pick<ComputerAction, 'action'>): boolean {
    const cls = classOf(action)
    return cls !== null && this.get(bundleId)?.classes[cls] === 'session'
  }

  learn(bundleId: string | null, action: Pick<ComputerAction, 'action'>, step: StepResult): void {
    const cls = classOf(action)
    if (!bundleId || !cls) return
    const next = nextVerdict(this.get(bundleId), cls, step, this.clock.now(), bundleId)
    if (next) this.save(next)
  }

  /** input.probe's report: honoured sets the class to process, ignored puts it two misses in, a key window elsewhere is recorded. */
  learnProbe(bundleId: string, report: ProbeReport): void {
    const now = this.clock.now()
    const v = this.get(bundleId) ?? empty(bundleId, now)
    for (const r of report.results) {
      if (r.outcome === 'honoured') {
        v.classes[r.class] = 'process'
        delete v.misses[r.class]
      } else if (r.outcome === 'ignored') v.misses[r.class] = VERDICT_MISSES_TO_RAISE
    }
    if (report.keyWindow !== 'target') v.needsKeyWindow = true
    this.save({ ...v, probedAt: now, updatedAt: now })
  }

  /** A probe that failed is stamped too, so it never runs again for that app. */
  stampProbe(bundleId: string): void {
    const now = this.clock.now()
    this.save({ ...(this.get(bundleId) ?? empty(bundleId, now)), probedAt: now, updatedAt: now })
  }

  /** No verdict and never probed. */
  needsProbe(bundleId: string | null): boolean {
    const v = this.get(bundleId)
    return bundleId !== null && (v === null || v.probedAt === undefined) && !(v && Object.keys(v.classes).length)
  }

  private save(v: TierVerdict): void {
    this.store.setSetting(tierVerdictSetting(v.bundleId), JSON.stringify(TierVerdictSchema.parse(v)))
  }
}
