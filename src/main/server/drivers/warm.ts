import { randomBytes } from 'node:crypto'

/**
 * Warm harness processes: one pre-spawned child per driver per host, started
 * before any thread needs it, so a new thread's first token does not wait on
 * process start and MCP attach.
 *
 * A warm process has no session and no account. It is spawned from the
 * exact spec (command, args, cwd, env) of the last thread that started, so
 * the next thread of the same shape (model, cwd, tool set, permission mode,
 * settings: all of it is in the args) adopts it whole; a thread of another
 * shape boots cold and the pool re-spawns to its shape. After an adoption a
 * replacement is spawned once the adopted thread has had a moment to boot.
 * Ten minutes without a thread start retires the warm process. None of this
 * is a session: nothing here is listed, counted, capped or load-guarded, it
 * is a child process the pool owns until a driver takes it.
 *
 * The one thing a spec cannot fix before the thread exists is who it is:
 * `rebind` names the env keys a driver sets per thread (the gateway's scoped
 * base URL); they are left out of the shape and the driver re-points them at
 * adoption (the gateway's `~w=` rebind for Claude).
 */

/** What a child is spawned from, as the driver's SDK computed it. */
export interface WarmSpec {
  command: string
  args: string[]
  cwd: string | undefined
  env: Record<string, string | undefined>
}

export interface WarmChild<T> {
  id: string
  key: string
  spec: WarmSpec
  proc: T
  spawnedAt: number
}

export interface WarmStatus {
  driver: string
  /** One row per warm process (at most one today). */
  warm: { id: string; ageMs: number; cwd: string | undefined }[]
  /** Whether a spawn is scheduled. */
  pending: boolean
  /** ms until the warm process retires with no thread start, null with none. */
  retiresInMs: number | null
  adopted: number
  spawned: number
}

export interface WarmPoolOptions<T> {
  driver: string
  /**
   * Spawn the child for `spec` under warm id `id`; `onExit` tells the pool
   * it died on its own. Resolves once the child exists (it may still be
   * booting: adopting a process that has been loading for 200 ms beats
   * starting one). Rejects when it cannot be spawned (nothing is retried
   * until the next thread start).
   */
  spawn: (id: string, spec: WarmSpec, onExit: () => void) => Promise<T>
  kill: (proc: T) => void
  /** Env keys that differ per thread and are rebound at adoption; left out of the shape. */
  rebind?: string[]
  /** Wait after an adoption or a cold start before spawning (the new thread boots first). Default 3 s. */
  replaceAfterMs?: number
  /** Retire the warm process this long after the last thread start. Default 10 min. */
  retireAfterMs?: number
  /** Whether warming is on right now (the gateway is up and ours). Default always. */
  enabled?: () => boolean
  now?: () => number
  log?: (line: string) => void
}

export const WARM_REPLACE_AFTER_MS = 3_000
export const WARM_RETIRE_AFTER_MS = 10 * 60_000

/** The shape of a spec: everything but the per-thread env keys, as one string. */
export function warmKey(spec: WarmSpec, rebind: string[] = []): string {
  const env = Object.entries(spec.env)
    .filter(([k, v]) => v !== undefined && !rebind.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd ?? null, env })
}

const pools = new Set<WarmPool<unknown>>()

export class WarmPool<T> {
  private child: WarmChild<T> | null = null
  private wanted: WarmSpec | null = null
  private spawnTimer: NodeJS.Timeout | null = null
  private retireTimer: NodeJS.Timeout | null = null
  private retireAt: number | null = null
  private spawning: Promise<void> | null = null
  private generation = 0
  private closed = false
  private adopted = 0
  private spawnedCount = 0
  private readonly now: () => number
  private readonly rebind: string[]
  private readonly replaceAfterMs: number
  private readonly retireAfterMs: number
  private readonly log: (line: string) => void

  constructor(private readonly options: WarmPoolOptions<T>) {
    this.now = options.now ?? Date.now
    this.rebind = options.rebind ?? []
    this.replaceAfterMs = options.replaceAfterMs ?? WARM_REPLACE_AFTER_MS
    this.retireAfterMs = options.retireAfterMs ?? WARM_RETIRE_AFTER_MS
    this.log = options.log ?? ((line) => console.log(line))
    pools.add(this as WarmPool<unknown>)
  }

  keyOf(spec: WarmSpec): string {
    return warmKey(spec, this.rebind)
  }

  /** The warm env for a spec: the spec's with the per-thread keys set to `values`. */
  envFor(spec: WarmSpec, values: Record<string, string>): Record<string, string | undefined> {
    const env = { ...spec.env }
    for (const k of this.rebind) delete env[k]
    return { ...env, ...values }
  }

  /**
   * A thread of `spec` is starting cold: this is now the shape to keep warm.
   * A warm process of another shape is retired; a spawn follows after the
   * replace delay. Every thread start pushes retirement out.
   */
  noteStart(spec: WarmSpec): void {
    if (this.closed) return
    this.wanted = spec
    this.touch()
    if (this.child && this.child.key !== this.keyOf(spec)) {
      this.log(`[warm] ${this.options.driver}: retiring the warm process (another shape started)`)
      this.discard()
    }
    if (!this.child) this.scheduleSpawn()
  }

  /**
   * The warm process, when its shape is `spec`'s: taken out of the pool and
   * handed to the caller, with a replacement scheduled. Null when there is
   * none or the shape differs (the caller boots cold; the pool re-shapes).
   */
  adopt(spec: WarmSpec): WarmChild<T> | null {
    if (this.closed) return null
    const key = this.keyOf(spec)
    const child = this.child
    if (!child || child.key !== key) {
      this.noteStart(spec)
      return null
    }
    this.child = null
    this.wanted = spec
    this.adopted++
    this.touch()
    this.scheduleSpawn()
    this.log(`[warm] ${this.options.driver}: adopted ${child.id} (${this.now() - child.spawnedAt} ms old)`)
    return child
  }

  /** Kill the warm process and cancel any spawn; the next thread start warms again. */
  retire(reason = 'retired'): void {
    this.cancelSpawn()
    if (this.child) this.log(`[warm] ${this.options.driver}: ${reason} ${this.child.id}`)
    this.discard()
    this.wanted = null
    this.retireAt = null
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = null
  }

  status(): WarmStatus {
    return {
      driver: this.options.driver,
      warm: this.child ? [{ id: this.child.id, ageMs: this.now() - this.child.spawnedAt, cwd: this.child.spec.cwd }] : [],
      pending: this.spawnTimer !== null || this.spawning !== null,
      retiresInMs: this.retireAt === null ? null : Math.max(0, this.retireAt - this.now()),
      adopted: this.adopted,
      spawned: this.spawnedCount
    }
  }

  /** Tests: wait for a scheduled or running spawn to settle. */
  async settled(): Promise<void> {
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer)
      this.spawnTimer = null
      this.spawnNow()
    }
    await this.spawning
  }

  close(): void {
    this.closed = true
    this.retire('closed')
    pools.delete(this as WarmPool<unknown>)
  }

  private touch(): void {
    this.retireAt = this.now() + this.retireAfterMs
    if (this.retireTimer) clearTimeout(this.retireTimer)
    this.retireTimer = setTimeout(() => {
      this.retireTimer = null
      this.retire('retired after 10 min without a thread start:')
    }, this.retireAfterMs)
    this.retireTimer.unref()
  }

  private scheduleSpawn(): void {
    if (this.spawnTimer || this.spawning || this.closed) return
    if (this.options.enabled && !this.options.enabled()) return
    this.spawnTimer = setTimeout(() => {
      this.spawnTimer = null
      this.spawnNow()
    }, this.replaceAfterMs)
    this.spawnTimer.unref()
  }

  private cancelSpawn(): void {
    if (this.spawnTimer) clearTimeout(this.spawnTimer)
    this.spawnTimer = null
    this.generation++
  }

  private spawnNow(): void {
    const spec = this.wanted
    if (!spec || this.child || this.closed || this.spawning) return
    if (this.options.enabled && !this.options.enabled()) return
    const id = `w${randomBytes(6).toString('hex')}`
    const generation = ++this.generation
    const key = this.keyOf(spec)
    this.spawning = this.options
      .spawn(id, spec, () => {
        if (this.child?.id === id) {
          this.log(`[warm] ${this.options.driver}: ${id} exited on its own`)
          this.child = null
        }
      })
      .then((proc) => {
        this.spawnedCount++
        if (generation !== this.generation || this.closed || this.child) {
          // Cancelled or superseded while spawning: not ours to keep.
          this.options.kill(proc)
          return
        }
        this.child = { id, key, spec, proc, spawnedAt: this.now() }
        this.log(`[warm] ${this.options.driver}: ${id} warm in ${spec.cwd ?? '(no cwd)'}`)
      })
      .catch((e: unknown) => {
        this.log(`[warm] ${this.options.driver}: spawn failed: ${(e as Error).message}`)
      })
      .finally(() => {
        this.spawning = null
      })
  }

  private discard(): void {
    const child = this.child
    this.child = null
    if (child) {
      try {
        this.options.kill(child.proc)
      } catch {
        // already gone
      }
    }
  }
}

/** Every pool's status, for the doctor and the Remote access pane. */
export const warmStatuses = (): WarmStatus[] => [...pools].map((p) => p.status())

/** Server stop: kill every warm process. */
export function closeWarmPools(): void {
  for (const p of [...pools]) p.close()
}
