/**
 * The renderer soak's fixed load (scripts/measure-renderer-soak.ts on the
 * synthetic host, scripts/lib/soakHost.ts): what a busy box sends a desktop
 * window, as data, and a driver that turns it into events over an injected
 * clock. The figures follow the box on 2026-11-01 (sixteen threads of one
 * batch running under their master, one of them on screen):
 *
 *   meta   every child's meta changes once every 2 s (8 a second in all)
 *   delta  the focused child streams 20 text deltas a second, two more
 *          children 5 a second each
 *   tool   the focused child makes a tool call every 5 s
 *   log    the master's running shell step prints 5 lines a second
 *
 * The chat scene (`--scene chat`, CHAT_PROFILE) is one plain thread with
 * the focused child's own load and nothing around it: its meta every 2 s,
 * 20 deltas a second and a tool call every 5 s; no batch, no other stream,
 * no shell step.
 *
 * The driver owes each stream floor((t + phase) × rate) emissions at time
 * t and pays them on every tick, so a slow tick catches up instead of
 * drifting, and the meta stream's phases spread the sixteen children over
 * its period instead of firing them together. The host decides what an
 * emission becomes on the wire; the test (scripts/soak-load.test.ts) holds
 * the rates over 60 s of fake time.
 *
 * A burst cadence (`--burst <ms>`, `BurstCadence`) holds the focused
 * child's deltas and lets what it owes leave together every `everyMs`
 * ± 30%, with a stall of BURST_STALL_MS every BURST_STALL_EVERY_MS: the
 * shape a box thread reached the Mac in on 2026-11-05 (docs/TRANSCRIPT.md
 * "The stream reveals a phrase at a time").
 */

export type SoakKind = 'meta' | 'delta' | 'tool' | 'log'

/** One stream of the load: a kind, the child it is about (null for the master), and its rate. */
export interface SoakStream {
  kind: SoakKind
  /** index into the batch's children; null for a stream of the master itself */
  child: number | null
  perSecond: number
  /** where in its period the stream starts, 0 to 1 */
  phase: number
}

export interface SoakProfile {
  /** batch children under the pinned master */
  children: number
  /** the child whose transcript the soak window shows */
  focused: number
  /** two more children whose transcripts stream behind it */
  streamers: number[]
  streams: SoakStream[]
}

export const SOAK_CHILDREN = 16
export const SOAK_FOCUSED = 0
export const SOAK_STREAMERS = [1, 2]

function profile(): SoakProfile {
  const streams: SoakStream[] = []
  for (let child = 0; child < SOAK_CHILDREN; child++) streams.push({ kind: 'meta', child, perSecond: 0.5, phase: child / SOAK_CHILDREN })
  streams.push({ kind: 'delta', child: SOAK_FOCUSED, perSecond: 20, phase: 0 })
  for (const child of SOAK_STREAMERS) streams.push({ kind: 'delta', child, perSecond: 5, phase: child / 10 })
  streams.push({ kind: 'tool', child: SOAK_FOCUSED, perSecond: 0.2, phase: 0.5 })
  streams.push({ kind: 'log', child: null, perSecond: 5, phase: 0.3 })
  return { children: SOAK_CHILDREN, focused: SOAK_FOCUSED, streamers: [...SOAK_STREAMERS], streams }
}

export const SOAK_PROFILE: SoakProfile = profile()

/** The scenes the soak measures: the master's board beside a streaming child, or one plain chat. */
export type SoakScene = 'board' | 'chat'

export const CHAT_PROFILE: SoakProfile = {
  children: 1,
  focused: 0,
  streamers: [],
  streams: SOAK_PROFILE.streams.filter((s) => s.child === SOAK_FOCUSED).map((s) => ({ ...s }))
}

export function profileOf(scene: SoakScene): SoakProfile {
  return scene === 'chat' ? CHAT_PROFILE : SOAK_PROFILE
}

/** What the profile declares a second, by kind. */
export function declaredRates(p: SoakProfile = SOAK_PROFILE): Record<SoakKind, number> {
  const rates: Record<SoakKind, number> = { meta: 0, delta: 0, tool: 0, log: 0 }
  for (const s of p.streams) rates[s.kind] += s.perSecond
  return rates
}

/** One emission: the stream's kind, its child, and the stream's own count so far (0-based). */
export interface SoakEmit {
  kind: SoakKind
  child: number | null
  n: number
}

/** The clock the driver reads and ticks on; the real one is Date.now and setInterval. */
export interface SoakClock {
  now(): number
  every(ms: number, fn: () => void): () => void
}

export const realClock: SoakClock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  }
}

export const SOAK_TICK_MS = 25

/** A burst's release time varies this much either way. */
export const BURST_JITTER = 0.3
/** Every this long the focused stream stalls… */
export const BURST_STALL_EVERY_MS = 10_000
/** …for this long, then releases what it held. */
export const BURST_STALL_MS = 1_000

/** The focused child's deltas leave in bursts: what is owed, every `everyMs` ± BURST_JITTER, held through a stall. */
export interface BurstCadence {
  everyMs: number
  /** 0 to 1; Math.random by default */
  random?: () => number
}

export interface SoakDriver {
  stop(): void
  counts(): Record<SoakKind, number>
}

/** Whether a burst may leave at `ms` into the load: not inside a stall
 *  (the last BURST_STALL_MS of each BURST_STALL_EVERY_MS). */
export function burstOpen(ms: number): boolean {
  return ms % BURST_STALL_EVERY_MS < BURST_STALL_EVERY_MS - BURST_STALL_MS
}

/** Runs the profile from now until stop(): each tick pays every stream what it owes. */
export function startLoad(
  sink: (emit: SoakEmit) => void,
  clock: SoakClock = realClock,
  p: SoakProfile = SOAK_PROFILE,
  burst: BurstCadence | null = null
): SoakDriver {
  const start = clock.now()
  const paid = p.streams.map(() => 0)
  const counts: Record<SoakKind, number> = { meta: 0, delta: 0, tool: 0, log: 0 }
  const random = burst?.random ?? Math.random
  const bursty = (s: SoakStream): boolean => burst !== null && s.kind === 'delta' && s.child === p.focused
  let release = 0
  const tick = (): void => {
    const ms = clock.now() - start
    const seconds = ms / 1000
    // The focused stream's next burst: due, and not inside a stall.
    const releasing = burst !== null && ms >= release && burstOpen(ms)
    if (releasing) release = ms + burst!.everyMs * (1 - BURST_JITTER + 2 * BURST_JITTER * random())
    p.streams.forEach((s, i) => {
      if (bursty(s) && !releasing) return
      const owed = Math.floor(seconds * s.perSecond + s.phase)
      while (paid[i]! < owed) {
        const n = paid[i]!
        paid[i] = n + 1
        counts[s.kind]++
        sink({ kind: s.kind, child: s.child, n })
      }
    })
  }
  const cancel = clock.every(SOAK_TICK_MS, tick)
  return {
    stop: cancel,
    counts: () => ({ ...counts })
  }
}
