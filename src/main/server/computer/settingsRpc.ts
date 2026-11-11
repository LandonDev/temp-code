import type { ComputerAppVerdict, ComputerServiceState, ComputerSettings, ComputerSettingsPatch, ComputerSettingsPush } from '@shared/contract-computer'
import { PermissionsSchema, type Permissions } from '@shared/computer/protocol'
import { SESSION_IDLE_SETTING, sessionIdleMs } from '@shared/computer/scheduleRules'
import { execFileBudgeted, oneShotBudget, withBudget } from '../spawnBudget'
import { computerBinaryPath } from './binary'
import type { ComputerService } from './service'
import type { SettingsStore, TierVerdicts } from './verdicts'

/**
 * Settings → Computer use on the host (surfaces/settings/Computer.tsx): the
 * session tier's idle threshold, the apps the verdicts learned with Forget,
 * the two grants, and Try again on a service down after crashes. Every
 * method is `local`: these are this Mac's values. A change pushes
 * `computer-settings` to every client, at most once a second.
 */

/** One push a second at most. */
export const SETTINGS_PUSH_MS = 1_000
/** The one-shot `tc-computer permissions` read gives up after this. */
export const PERMISSIONS_TIMEOUT_MS = 3_000

export interface ComputerSettingsHost {
  service: Pick<ComputerService, 'state' | 'permissions' | 'retry'>
  verdicts: Pick<TierVerdicts, 'list' | 'forget' | 'onChange'>
}

export interface ComputerSettingsRpcOptions {
  /** null on a host where computer use cannot run */
  host: ComputerSettingsHost | null
  store: Pick<SettingsStore, 'getSetting' | 'setSetting'>
  /** binary.ts's `computerUnavailable`, asked at each one-shot read */
  unavailable: () => string | null
  /** the binary the one-shot read runs; computerBinaryPath() by default */
  bin?: () => string
}

export class ComputerSettingsRpc {
  private readonly listeners = new Set<(push: ComputerSettingsPush) => void>()
  private readonly stops: (() => void)[] = []
  private timer: NodeJS.Timeout | null = null
  private lastPush = 0

  constructor(private readonly opts: ComputerSettingsRpcOptions) {
    if (opts.host) this.stops.push(opts.host.verdicts.onChange(() => this.schedule()))
  }

  get(): ComputerSettings {
    const apps: ComputerAppVerdict[] = (this.opts.host?.verdicts.list() ?? []).map((v) => ({
      bundleId: v.bundleId,
      name: v.name ?? null,
      classes: v.classes,
      updatedAt: v.updatedAt
    }))
    return { sessionIdleMs: sessionIdleMs(this.opts.store.getSetting(SESSION_IDLE_SETTING)), apps }
  }

  /** The scheduler reads the threshold at every check, so it holds from the next one. */
  set(patch: ComputerSettingsPatch): ComputerSettings {
    if (patch.sessionIdleMs !== undefined) {
      this.opts.store.setSetting(SESSION_IDLE_SETTING, String(patch.sessionIdleMs))
      this.schedule()
    }
    return this.get()
  }

  forget(bundleId: string | null): ComputerSettings {
    this.opts.host?.verdicts.forget(bundleId)
    return this.get()
  }

  /** The service's own grants while it is up, else one `tc-computer permissions`; null where computer use is unavailable or the read failed. */
  async permissions(): Promise<Permissions | null> {
    const host = this.opts.host
    if (!host) return null
    const live = host.service.state().state === 'up' ? host.service.permissions() : null
    if (live) return live
    if (this.opts.unavailable()) return null
    try {
      const bin = this.opts.bin?.() ?? computerBinaryPath()
      const { stdout } = await withBudget(oneShotBudget, () => execFileBudgeted(bin, ['permissions'], { timeout: PERMISSIONS_TIMEOUT_MS }))
      return PermissionsSchema.parse(JSON.parse(stdout))
    } catch {
      return null
    }
  }

  async retry(): Promise<ComputerServiceState> {
    const host = this.opts.host
    if (!host) return { state: 'unavailable', reason: this.opts.unavailable() ?? 'computer use runs on a Mac', restarts: 0, permissions: null }
    return host.service.retry()
  }

  onPush(fn: (push: ComputerSettingsPush) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close(): void {
    for (const stop of this.stops.splice(0)) stop()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.lastPush = Date.now()
        const push: ComputerSettingsPush = { push: 'computer-settings', settings: this.get() }
        for (const fn of this.listeners) fn(push)
      },
      Math.max(0, this.lastPush + SETTINGS_PUSH_MS - Date.now())
    )
    this.timer.unref?.()
  }
}
