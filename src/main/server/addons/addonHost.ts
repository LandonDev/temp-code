import { randomUUID } from 'node:crypto'
import { exposedNames } from '@shared/addons'
import type { AddonRow, AddonStatus, AddonTool } from '@shared/contract-addons'
import { specDigest, type AddonStore } from '../addonStore'
import { harnessEnv } from '../drivers/binaries'
import { answer, Calls, WireGone } from '../gatewayWire'
import { guardInstanceEnv } from '../processGuard'
import {
  ADDON_BASE_ENV_KEYS,
  ADDON_CALL_TIMEOUT_MS,
  ADDON_HOST_EXIT_WINDOW_MS,
  ADDON_HOST_EXITS_BEFORE_DOWN,
  ADDON_HOST_RETRY_MS,
  type AddonCallResult,
  type AddonChildCall,
  type AddonHostLink,
  type AddonLaunch,
  type AddonMainCall,
  type AddonStartState,
  type AddonWireMessage,
  type SpawnAddonHost
} from './addonWire'
import { errorResult } from './downstream'
import { resolveGrant, type AddonGrantSource } from './grants'

/**
 * The add-on host as main sees it (plan section 4): it decides which rows
 * run here, keeps the utility process (addonHostSpawn.ts) running with the
 * current launches, answers its grant asks, writes its statuses and tool
 * lists into the store, and passes calls to it. The gateway's rule for its
 * process applies: an exit is respawned with the launches; three exits in a
 * minute and the host is down, every add-on failed, tried once more after
 * ADDON_HOST_RETRY_MS. Nothing downstream ever runs in this process.
 */

export const ADDON_HOST_DOWN = 'The add-on host kept exiting; it is tried again in 10 minutes'
export const ADDON_HOST_ABSENT = 'Add-ons do not run in this process'

export type AddonHostStore = Pick<AddonStore, 'list' | 'get' | 'onChange' | 'setStatus' | 'status' | 'tools' | 'setTools'>

export interface AddonHostOptions {
  store: AddonHostStore
  /** Absent: no add-on runs on this host (every add-on reads failed, ADDON_HOST_ABSENT); tests pass an in-memory link to runAddonChild. */
  spawnChild?: SpawnAddonHost
  grants: AddonGrantSource
  /** buildInfo.ts hostPlatform() */
  platform: () => string
  /** addonBaseEnv(): ADDON_BASE_ENV_KEYS picked from harnessEnv(), plus the guard's instance mark. */
  baseEnv?: () => Promise<Record<string, string>>
  /** Where a stdio server starts: the host's work root. */
  cwd: () => string
  trace?: boolean
  now?: () => number
  readyTimeoutMs?: number
  retryMs?: number
}

interface ChildState {
  link: AddonHostLink
  calls: Calls<AddonChildCall, AddonWireMessage>
  sent: boolean
  ready: boolean
  pid: number | null
  timer: ReturnType<typeof setTimeout> | null
}

/** What a stdio server starts from: the base keys of the harness environment and the guard's instance mark, never the app's own environment whole. */
export async function addonBaseEnv(): Promise<Record<string, string>> {
  const env = await harnessEnv()
  const out: Record<string, string> = {}
  for (const key of ADDON_BASE_ENV_KEYS) if (env[key] !== undefined) out[key] = env[key]!
  return { ...out, ...guardInstanceEnv() }
}

const goneError = () => new WireGone('the add-on host')

export class AddonHost {
  private child: ChildState | null = null
  private launches: AddonLaunch[] = []
  private exits: number[] = []
  private restarts = 0
  private down = false
  private stopped = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly listeners = new Set<(addonId: string) => void>()
  private readonly now: () => number

  constructor(private readonly options: AddonHostOptions) {
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    this.unsubscribe = this.options.store.onChange(() => this.reconcile())
    this.reconcile()
    if (this.options.spawnChild) this.spawn()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const child = this.child
    this.child = null
    if (child) this.dropChild(child)
    this.options.grants.close?.()
  }

  /** One downstream tool call. Throws `refused: <add-on> is <state>: <detail>` when the add-on is not ready here; a host that goes away mid-call answers isError naming the add-on. */
  async call(addonId: string, tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AddonCallResult> {
    const row = this.options.store.get(addonId)
    if (!row) throw new Error(`refused: no add-on ${addonId} here`)
    const status = this.options.store.status()[addonId]
    if (status?.state !== 'ready') throw new Error(`refused: ${row.name} is ${status?.state ?? 'starting'}${status?.detail ? `: ${status.detail}` : ''}`)
    const child = this.child
    if (!child?.ready) throw new Error(`refused: ${row.name} is starting: the add-on host is starting`)
    const callId = randomUUID()
    const timeoutMs = opts.timeoutMs ?? ADDON_CALL_TIMEOUT_MS
    const cancel = () => void child.calls.call({ m: 'cancel', callId }).catch(() => {})
    if (opts.signal?.aborted) return errorResult('The call was cancelled')
    opts.signal?.addEventListener('abort', cancel, { once: true })
    try {
      return await child.calls.call<AddonCallResult>({ m: 'call', addonId, tool, arguments: args, callId, timeoutMs }, { timeoutMs: timeoutMs + 5_000 })
    } catch (error) {
      if (error instanceof WireGone) return errorResult(`The add-on host went away during the call to ${row.name}`)
      return errorResult(`${row.name}: ${(error as Error).message}`)
    } finally {
      opts.signal?.removeEventListener('abort', cancel)
    }
  }

  /** The grant of one add-on (or every one, for null) changed: its client asks again. */
  grantsChanged(addonId: string | null): void {
    this.post({ t: 'grants.drop', addonId })
  }

  /** Restart one add-on's client now (the settings page's restart button, when it lands). */
  async restart(addonId: string): Promise<void> {
    const child = this.child
    if (child?.ready) await child.calls.call({ m: 'restart', addonId })
  }

  /** This host's tools of one add-on, from the store's cache; [] until it listed. */
  tools(addonId: string): AddonTool[] {
    return this.options.store.tools(addonId)?.tools ?? []
  }

  /** Status or tool changes, after the store has them (exposure.ts and the tools follow this). */
  onChange(fn: (addonId: string) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  status(): { pid: number | null; restarts: number; down: boolean } {
    return { pid: this.child?.ready ? this.child.pid : null, restarts: this.restarts, down: this.down }
  }

  // ── the rows ──────────────────────────────────────────────────────────

  /** Which rows run here, decided without the child; the launch set goes to it whole. */
  private reconcile(): void {
    if (this.stopped) return
    const { store } = this.options
    const rows = store.list()
    const platform = this.options.platform()
    const statuses = store.status()
    const launches: AddonLaunch[] = []
    const set = (row: AddonRow, state: AddonStatus['state'], detail?: string) => {
      const cur = statuses[row.id]
      if (cur?.state === state && cur.detail === detail) return
      store.setStatus(row.id, { state, tools: 0, ...(detail ? { detail } : {}), at: this.now() })
      this.emit(row.id)
    }
    for (const row of rows) {
      if (!row.enabled) set(row, 'off')
      else if (row.spec.platforms && !(row.spec.platforms as string[]).includes(platform)) set(row, 'other-platform')
      else {
        launches.push({ id: row.id, name: row.name, spec: row.spec, specDigest: specDigest(row.spec) })
        if (!this.options.spawnChild) set(row, 'failed', ADDON_HOST_ABSENT)
        else if (this.down) set(row, 'failed', ADDON_HOST_DOWN)
        else if (!statuses[row.id] || statuses[row.id]!.state === 'off' || statuses[row.id]!.state === 'other-platform') set(row, 'starting')
      }
    }
    const ids = new Set(rows.map((r) => r.id))
    for (const id of Object.keys(statuses))
      if (!ids.has(id)) {
        store.setStatus(id, null)
        this.emit(id)
      }
    const changed = JSON.stringify(launches) !== JSON.stringify(this.launches)
    this.launches = launches
    if (changed) this.post({ t: 'launches', launches })
  }

  private launched(addonId: string): boolean {
    return this.launches.some((l) => l.id === addonId)
  }

  private emit(addonId: string): void {
    for (const fn of this.listeners) {
      try {
        fn(addonId)
      } catch (error) {
        console.error('[addons] listener', error)
      }
    }
  }

  // ── the child ─────────────────────────────────────────────────────────

  private post(message: AddonWireMessage): void {
    if (this.child?.sent) this.child.link.wire.post(message)
  }

  private spawn(): void {
    let link: AddonHostLink
    try {
      link = this.options.spawnChild!()
    } catch (error) {
      this.childGone(null, `could not start (${(error as Error).message})`)
      return
    }
    const child: ChildState = { link, calls: new Calls<AddonChildCall, AddonWireMessage>(link.wire, (_m, ms) => new Error(`the add-on host did not answer in ${Math.round(ms / 1000)} s`)), sent: false, ready: false, pid: null, timer: null }
    this.child = child
    link.wire.onMessage((m) => this.fromChild(child, m))
    link.onExit((code) => this.childGone(child, `exited (${code ?? 'killed'})`))
    const readyMs = this.options.readyTimeoutMs ?? 15_000
    child.timer = setTimeout(() => {
      if (child.ready) return
      link.kill()
      this.childGone(child, `did not start in ${readyMs} ms`)
    }, readyMs)
    this.startState().then(
      (state) => {
        if (this.child !== child) return
        child.sent = true
        link.wire.post({ t: 'start', state })
      },
      (error) => {
        link.kill()
        this.childGone(child, `could not be told what to run (${(error as Error).message})`)
      }
    )
  }

  private async startState(): Promise<AddonStartState> {
    return {
      mainPid: process.pid,
      baseEnv: await (this.options.baseEnv ?? addonBaseEnv)(),
      cwd: this.options.cwd(),
      launches: this.launches,
      trace: this.options.trace ?? process.env.TEMP_CODE_ADDON_TRACE === '1'
    }
  }

  private fromChild(child: ChildState, m: AddonWireMessage): void {
    if (this.child !== child) return
    switch (m.t) {
      case 'ready':
        child.ready = true
        child.pid = m.pid
        if (child.timer) clearTimeout(child.timer)
        child.timer = null
        return
      case 'event': {
        const event = m.event
        if (!this.launched(event.addonId)) return
        if (event.e === 'status') {
          this.options.store.setStatus(event.addonId, event.status)
          this.emit(event.addonId)
        } else if (event.e === 'tools') {
          const row = this.options.store.get(event.addonId)
          if (!row || specDigest(row.spec) !== event.specDigest) return
          const names = exposedNames(row.name, event.tools)
          this.options.store.setTools(
            row.id,
            event.tools.map((t) => ({ name: t.name, exposed: names.get(t.name)!, description: t.description, inputSchema: t.inputSchema, ...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}) }))
          )
          this.emit(row.id)
        } else {
          const id = event.addonId
          void (async () => {
            try {
              await this.options.grants.refresh?.(id)
            } catch (error) {
              console.warn(`[addons] could not refresh the grant of ${id}: ${(error as Error).message}`)
            }
            this.grantsChanged(id)
          })()
        }
        return
      }
      case 'ask':
        answer(child.link.wire, m.id, () => this.answerChild(m.call as AddonMainCall))
        return
      case 'reply':
        child.calls.settle(m)
        return
    }
  }

  /** The only place a grant value leaves main: the answer to the child's ask, read fresh. */
  private async answerChild(call: AddonMainCall): Promise<unknown> {
    const row = this.options.store.get(call.addonId)
    if (!row) throw new Error(`no add-on ${call.addonId}`)
    return resolveGrant(row.spec, await this.options.grants.read(call.addonId))
  }

  private dropChild(child: ChildState): void {
    if (child.timer) clearTimeout(child.timer)
    child.calls.failAll(goneError())
    child.link.kill()
    try {
      child.link.wire.close()
    } catch {
      // already closed
    }
  }

  private childGone(child: ChildState | null, why: string): void {
    if (child) {
      if (this.child !== child) return
      this.child = null
      this.dropChild(child)
    }
    if (this.stopped) return
    const now = this.now()
    this.exits = [...this.exits.filter((t) => now - t < ADDON_HOST_EXIT_WINDOW_MS), now]
    if (this.exits.length >= ADDON_HOST_EXITS_BEFORE_DOWN) {
      console.warn(`[addons] the add-on host ${why}, ${this.exits.length} times in a minute: add-ons stay down for ${Math.round((this.options.retryMs ?? ADDON_HOST_RETRY_MS) / 60_000)} minutes`)
      this.down = true
      for (const launch of this.launches) {
        this.options.store.setStatus(launch.id, { state: 'failed', tools: 0, detail: ADDON_HOST_DOWN, at: this.now() })
        this.emit(launch.id)
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        if (this.stopped) return
        this.down = false
        this.exits = []
        this.spawn()
      }, this.options.retryMs ?? ADDON_HOST_RETRY_MS)
      this.retryTimer.unref?.()
      return
    }
    this.restarts++
    console.warn(`[addons] the add-on host ${why}; respawning`)
    this.spawn()
  }
}
