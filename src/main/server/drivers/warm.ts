import { randomBytes } from 'node:crypto'

/**
 * Warm harness processes: pre-spawned children per driver per host, started
 * before any thread needs them, so a new thread's first token does not wait
 * on process start and MCP attach.
 *
 * A warm process has no session and no account. It is spawned from the
 * exact spec (command, args, cwd, env) of a thread that started, so the next
 * thread of the same shape (model, cwd, tool set, permission mode, settings:
 * all of it is in the args) adopts it whole. The pool keeps one warm process
 * for each of the last WARM_SHAPES shapes started, newest first: a root, a
 * subagent and a master differ in their tool lists, and one slot made them
 * evict each other (132 of 380 new threads adopted). A fourth shape retires
 * the shape that started longest ago. After an adoption the shape's
 * replacement waits for the adopted thread to boot, unless the shape is in a
 * burst (started twice within WARM_BURST_MS), when it spawns at once so the
 * next start of the burst adopts too. Each shape retires on its own ten
 * minutes after its last start. No warm process is spawned while memory is
 * under the admission floor (setWarmMemoryFloor). None of this is a session:
 * nothing here is listed, counted or capped, it is a child process the pool
 * owns until a driver takes it.
 *
 * A start that finds no warm process of its shape logs the first field it
 * differs on from the nearest warm one (`[warm] claude: miss (tools) 2
 * warm`), counted per field in the status.
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
  /** One row per warm process, newest shape first. */
  warm: { id: string; ageMs: number; cwd: string | undefined; retiresInMs: number | null }[]
  /** Whether a spawn is scheduled or running. */
  pending: boolean
  /** ms until the soonest shape retires with no thread start, null with none. */
  retiresInMs: number | null
  adopted: number
  spawned: number
  /** Starts that found no warm process of their shape, by the first field they differed on. */
  misses: Record<string, number>
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
  /** Retire a shape this long after its last start. Default 10 min, or TEMP_CODE_WARM_RETIRE_MS. */
  retireAfterMs?: number
  /** Shapes kept warm at once. Default WARM_SHAPES. */
  shapes?: number
  /** Whether warming is on right now (the gateway is up and ours). Default always. */
  enabled?: () => boolean
  now?: () => number
  log?: (line: string) => void
}

export const WARM_REPLACE_AFTER_MS = 3_000
export const WARM_RETIRE_AFTER_MS = 10 * 60_000
export const WARM_SHAPES = 3
export const WARM_BURST_MS = 60_000

/** The shape of a spec: everything but the per-thread env keys, as one string. */
export function warmKey(spec: WarmSpec, rebind: string[] = []): string {
  return JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd ?? null, env: shapeEnv(spec, rebind) })
}

function shapeEnv(spec: WarmSpec, rebind: string[]): [string, string | undefined][] {
  return Object.entries(spec.env)
    .filter(([k, v]) => v !== undefined && !rebind.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** The field a CLI flag decides, in the miss log's words. */
const FLAG_FIELD: Record<string, string> = {
  model: 'model',
  effort: 'effort',
  'permission-mode': 'permission',
  'allow-dangerously-skip-permissions': 'permission',
  'permission-prompt-tool': 'permission',
  allowedTools: 'tools',
  disallowedTools: 'tools',
  tools: 'tools',
  'mcp-config': 'tools',
  'strict-mcp-config': 'tools',
  settings: 'settings',
  resume: 'resume'
}
const FIELD_ORDER = ['resume', 'model', 'effort', 'tools', 'permission', 'settings', 'cwd']

/** `--flag value` and `--flag=value` pairs; a flag with no value is `true`; anything else is positional. */
function flagsOf(args: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
    const value = eq > 0 ? arg.slice(eq + 1) : i + 1 < args.length && !args[i + 1].startsWith('--') ? args[++i] : 'true'
    flags.set(name, flags.has(name) ? `${flags.get(name)}\0${value}` : value)
  }
  if (positional.length) flags.set('_', positional.join('\0'))
  return flags
}

/** Every field `a` and `b` differ on, the miss log's order first. */
export function shapeDiff(a: WarmSpec, b: WarmSpec, rebind: string[] = []): string[] {
  const fields = new Set<string>()
  const fa = flagsOf(a.args)
  const fb = flagsOf(b.args)
  for (const name of new Set([...fa.keys(), ...fb.keys()])) {
    if (fa.get(name) !== fb.get(name)) fields.add(FLAG_FIELD[name] ?? (name === '_' ? 'args' : name))
  }
  if ((a.cwd ?? null) !== (b.cwd ?? null)) fields.add('cwd')
  if (JSON.stringify(shapeEnv(a, rebind)) !== JSON.stringify(shapeEnv(b, rebind))) fields.add('env')
  if (a.command !== b.command) fields.add('command')
  const rank = (f: string): number => {
    const i = FIELD_ORDER.indexOf(f)
    return i >= 0 ? i : f === 'env' ? FIELD_ORDER.length + 1 : f === 'command' ? FIELD_ORDER.length + 2 : FIELD_ORDER.length
  }
  return [...fields].sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : 1))
}

/**
 * The field a start missed on: `resume` for a resumed thread, `empty` with
 * no warm process, else the first field it differs on from the nearest warm
 * process (the one it differs from least).
 */
export function missField(spec: WarmSpec, warm: WarmSpec[], rebind: string[] = []): string {
  if (flagsOf(spec.args).has('resume')) return 'resume'
  let best: string[] | null = null
  for (const w of warm) {
    const diff = shapeDiff(spec, w, rebind)
    if (!best || diff.length < best.length) best = diff
  }
  return best?.[0] ?? 'empty'
}

let memoryLow: () => boolean = () => false

/** The admission floor (admission.ts memoryLow): no warm spawn while it holds. */
export function setWarmMemoryFloor(low: () => boolean): void {
  memoryLow = low
}

interface Shape<T> {
  key: string
  spec: WarmSpec
  /** start times inside the burst window, oldest first */
  starts: number[]
  child: WarmChild<T> | null
  spawnTimer: NodeJS.Timeout | null
  spawning: Promise<void> | null
  generation: number
  retireTimer: NodeJS.Timeout | null
  retireAt: number
}

const pools = new Set<WarmPool<unknown>>()

export class WarmPool<T> {
  /** newest start first, at most `maxShapes` */
  private shapes: Shape<T>[] = []
  private closed = false
  private adopted = 0
  private spawnedCount = 0
  private misses: Record<string, number> = {}
  private floorLogged = false
  private readonly now: () => number
  private readonly rebind: string[]
  private readonly replaceAfterMs: number
  private readonly retireAfterMs: number
  private readonly maxShapes: number
  private readonly log: (line: string) => void

  constructor(private readonly options: WarmPoolOptions<T>) {
    this.now = options.now ?? Date.now
    this.rebind = options.rebind ?? []
    this.replaceAfterMs = options.replaceAfterMs ?? WARM_REPLACE_AFTER_MS
    this.retireAfterMs = options.retireAfterMs ?? (Number(process.env.TEMP_CODE_WARM_RETIRE_MS) || WARM_RETIRE_AFTER_MS)
    this.maxShapes = options.shapes ?? WARM_SHAPES
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
   * A thread of `spec` is starting cold: its shape moves to the front, a
   * fourth shape retires the oldest, and a spawn of its shape follows (at
   * once in a burst, else after the replace delay). Every start of a shape
   * pushes that shape's retirement out.
   */
  noteStart(spec: WarmSpec): void {
    if (this.closed) return
    const shape = this.front(spec)
    if (!shape.child) this.scheduleSpawn(shape)
  }

  /**
   * The warm process of `spec`'s shape: taken out of the pool and handed to
   * the caller, with a replacement scheduled. Null when there is none (the
   * caller boots cold; the miss is logged with the field it differed on).
   */
  adopt(spec: WarmSpec): WarmChild<T> | null {
    if (this.closed) return null
    const key = this.keyOf(spec)
    const child = this.shapes.find((s) => s.key === key)?.child ?? null
    if (!child) {
      this.miss(spec)
      this.noteStart(spec)
      return null
    }
    const shape = this.front(spec)
    shape.child = null
    this.adopted++
    this.scheduleSpawn(shape)
    this.log(`[warm] ${this.options.driver}: adopted ${child.id} (${this.now() - child.spawnedAt} ms old)`)
    return child
  }

  /**
   * A start that found no warm process of its shape, counted and logged by
   * why: the field it differs on (missField), `refilling` when its shape's
   * process is still to come, `memory` while warming is held. Also called
   * for a start that never asks the pool (a resumed thread).
   */
  miss(spec: WarmSpec): string {
    const warm = this.shapes.flatMap((s) => (s.child ? [s.child.spec] : []))
    const key = this.keyOf(spec)
    const field =
      missField(spec, [], this.rebind) === 'resume'
        ? 'resume'
        : memoryLow()
          ? 'memory'
          : this.shapes.some((s) => s.key === key)
            ? 'refilling'
            : missField(spec, warm, this.rebind)
    this.misses[field] = (this.misses[field] ?? 0) + 1
    this.log(`[warm] ${this.options.driver}: miss (${field}) ${warm.length} warm`)
    return field
  }

  /** Kill every warm process and cancel every spawn; the next thread start warms again. */
  retire(reason = 'retired'): void {
    for (const shape of [...this.shapes]) this.drop(shape, reason)
  }

  status(): WarmStatus {
    const now = this.now()
    const retires = this.shapes.map((s) => Math.max(0, s.retireAt - now))
    return {
      driver: this.options.driver,
      warm: this.shapes.flatMap((s) =>
        s.child ? [{ id: s.child.id, ageMs: now - s.child.spawnedAt, cwd: s.child.spec.cwd, retiresInMs: Math.max(0, s.retireAt - now) }] : []
      ),
      pending: this.shapes.some((s) => s.spawnTimer !== null || s.spawning !== null),
      retiresInMs: retires.length ? Math.min(...retires) : null,
      adopted: this.adopted,
      spawned: this.spawnedCount,
      misses: { ...this.misses }
    }
  }

  /** Tests: run every scheduled spawn now and wait for the spawns to settle. */
  async settled(): Promise<void> {
    for (const shape of this.shapes) {
      if (shape.spawnTimer) {
        clearTimeout(shape.spawnTimer)
        shape.spawnTimer = null
        this.spawnNow(shape)
      }
    }
    await Promise.all(this.shapes.map((s) => s.spawning))
  }

  close(): void {
    this.closed = true
    this.retire('closed')
    pools.delete(this as WarmPool<unknown>)
  }

  /** The shape of `spec` at the front, its start recorded and its retirement pushed out; a shape past the cap retires. */
  private front(spec: WarmSpec): Shape<T> {
    const key = this.keyOf(spec)
    const now = this.now()
    let shape = this.shapes.find((s) => s.key === key)
    if (shape) {
      this.shapes = [shape, ...this.shapes.filter((s) => s !== shape)]
      shape.spec = spec
    } else {
      shape = { key, spec, starts: [], child: null, spawnTimer: null, spawning: null, generation: 0, retireTimer: null, retireAt: now }
      this.shapes.unshift(shape)
      for (const old of this.shapes.splice(this.maxShapes)) this.drop(old, 'retiring the oldest shape:')
    }
    shape.starts = [...shape.starts.filter((t) => now - t < WARM_BURST_MS), now]
    this.touch(shape)
    return shape
  }

  private touch(shape: Shape<T>): void {
    shape.retireAt = this.now() + this.retireAfterMs
    if (shape.retireTimer) clearTimeout(shape.retireTimer)
    shape.retireTimer = setTimeout(() => {
      shape.retireTimer = null
      this.drop(shape, `retired after ${Math.round(this.retireAfterMs / 1000)} s without a start of its shape:`)
    }, this.retireAfterMs)
    shape.retireTimer.unref?.()
  }

  private canWarm(): boolean {
    if (this.closed || (this.options.enabled && !this.options.enabled())) return false
    if (memoryLow()) {
      if (!this.floorLogged) this.log(`[warm] ${this.options.driver}: not warming, memory is under the floor`)
      this.floorLogged = true
      return false
    }
    this.floorLogged = false
    return true
  }

  private scheduleSpawn(shape: Shape<T>): void {
    if (shape.spawnTimer || shape.spawning || !this.canWarm()) return
    // A burst (the shape started twice inside the window) refills at once.
    const delay = shape.starts.length >= 2 ? 0 : this.replaceAfterMs
    shape.spawnTimer = setTimeout(() => {
      shape.spawnTimer = null
      this.spawnNow(shape)
    }, delay)
    shape.spawnTimer.unref?.()
  }

  private spawnNow(shape: Shape<T>): void {
    if (shape.child || shape.spawning || !this.shapes.includes(shape) || !this.canWarm()) return
    const spec = shape.spec
    const id = `w${randomBytes(6).toString('hex')}`
    const generation = ++shape.generation
    shape.spawning = this.options
      .spawn(id, spec, () => {
        if (shape.child?.id === id) {
          this.log(`[warm] ${this.options.driver}: ${id} exited on its own`)
          shape.child = null
        }
      })
      .then((proc) => {
        this.spawnedCount++
        if (generation !== shape.generation || this.closed || shape.child || !this.shapes.includes(shape)) {
          // Cancelled or superseded while spawning: not ours to keep.
          this.options.kill(proc)
          return
        }
        shape.child = { id, key: shape.key, spec, proc, spawnedAt: this.now() }
        this.log(`[warm] ${this.options.driver}: ${id} warm in ${spec.cwd ?? '(no cwd)'} (${this.shapes.filter((s) => s.child).length} warm)`)
      })
      .catch((e: unknown) => {
        this.log(`[warm] ${this.options.driver}: spawn failed: ${(e as Error).message}`)
      })
      .finally(() => {
        shape.spawning = null
      })
  }

  /** Take a shape out of the pool: its process killed, its timers and any spawn in flight cancelled. */
  private drop(shape: Shape<T>, reason: string): void {
    this.shapes = this.shapes.filter((s) => s !== shape)
    if (shape.spawnTimer) clearTimeout(shape.spawnTimer)
    if (shape.retireTimer) clearTimeout(shape.retireTimer)
    shape.spawnTimer = null
    shape.retireTimer = null
    shape.generation++
    const child = shape.child
    shape.child = null
    if (!child) return
    this.log(`[warm] ${this.options.driver}: ${reason} ${child.id}`)
    try {
      this.options.kill(child.proc)
    } catch {
      // already gone
    }
  }
}

/** Every pool's status, for the doctor and the Remote access pane. */
export const warmStatuses = (): WarmStatus[] => [...pools].map((p) => p.status())

/** Kill every warm process now; the next thread start warms again. */
export function retireWarmPools(): void {
  for (const p of pools) p.retire('retired on request:')
}

/** Server stop: kill every warm process. */
export function closeWarmPools(): void {
  for (const p of [...pools]) p.close()
}
