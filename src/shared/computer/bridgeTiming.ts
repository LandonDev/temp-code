import { z } from 'zod'

/**
 * What one bridged computer call cost, leg by leg (docs/computer-protocol.md
 * "What the bridge costs"). The Mac measures its side and sends it with the
 * answer (`ComputerPeerAnswer.timing`); the box stamps its own side and the
 * round trip and joins them with `bridgeLegs`. A Mac thread's call fills the
 * same tally, so both hosts are measured by the same code. One line format
 * (`timingLine`) is written by the hosts and read back by the bridge proof
 * (`parseTimingLine`).
 */

const ms = z.number().int().nonnegative()

/** The Mac's side of one `mac.computer` call. Optional on the answer: an older Mac sends none. */
export const BridgeTimingSchema = z.object({
  /** handler entry to the answer built */
  macMs: ms,
  /** policy, the switch, availability, Away */
  checksMs: ms,
  /** the live session through the load guard (`ensureLive`) */
  guardMs: ms,
  /** `sessions.run`: the card, the service's requests, the pictures landed */
  runMs: ms,
  /** the service requests' round trips inside the run, summed */
  serviceMs: ms,
  /** the smart wait the service reported, summed over the observations */
  waitedMs: ms,
  /** reading and encoding the pictures */
  shotsMs: ms,
  /** their base64 length */
  shotChars: ms
})
export type BridgeTiming = z.infer<typeof BridgeTimingSchema>

/** The run's own tally: every service request's round trip and every observation's wait. */
export class CallTiming {
  serviceMs = 0
  waitedMs = 0
  addService(ms: number): void {
    this.serviceMs += Math.max(0, Math.round(ms))
  }
  addWaited(ms: number): void {
    this.waitedMs += Math.max(0, Math.round(ms))
  }
}

/** The box's stamps for one call, all from one clock. */
export interface BridgeStamps {
  /** the call reached the bridge */
  startedAt: number
  /** its turn came: behind the thread's queue and any wait for a reader */
  dispatchedAt: number
  /** right before the peer call went out */
  sentAt: number
  /** the reply arrived */
  repliedAt: number
  /** the outcome was built: pictures landed, the row mirrored, the ledger written */
  answeredAt: number
  timing?: BridgeTiming | null
}

export interface BridgeLegs {
  /** the call's whole time on the box */
  total: number
  /** waiting behind the thread's other calls */
  queue: number
  /** the box's own work before the send and after the reply */
  box: number
  /** reply minus the Mac's time: serialization, compression, the network, the box's parse; null without the Mac's timing */
  transit: number | null
  /** the Mac's handler, entry to answer built */
  mac: number | null
  /** the Mac's run inside it */
  run: number | null
}

const span = (from: number, to: number): number => Math.max(0, Math.round(to - from))

export function bridgeLegs(s: BridgeStamps): BridgeLegs {
  const trip = span(s.sentAt, s.repliedAt)
  const t = s.timing ?? null
  return {
    total: span(s.startedAt, s.answeredAt),
    queue: span(s.startedAt, s.dispatchedAt),
    box: span(s.dispatchedAt, s.sentAt) + span(s.repliedAt, s.answeredAt),
    transit: t ? Math.max(0, trip - t.macMs) : null,
    mac: t ? t.macMs : null,
    run: t ? t.runMs : null
  }
}

/** What the bridge added to a call: everything but its queue and the Mac's run; null without the Mac's timing. */
export const bridgeOverhead = (legs: BridgeLegs): number | null => (legs.run === null ? null : Math.max(0, legs.total - legs.queue - legs.run))

const LEG_ORDER = ['total', 'queue', 'box', 'transit', 'mac', 'run'] as const
type Value = string | number | null | undefined

const word = (v: Value): string => (v === null || v === undefined ? '-' : typeof v === 'number' ? String(Math.round(v)) : v.replace(/\s+/g, '_'))

/**
 * `timing total=812 queue=0 box=6 transit=48 mac=758 run=740 tool=computer_observe …`:
 * the legs present in their fixed order, `-` for an unknown one, then the extras.
 */
export function timingLine(legs: Partial<Record<(typeof LEG_ORDER)[number], number | null>>, extra: Record<string, Value> = {}): string {
  const parts = ['timing']
  for (const k of LEG_ORDER) if (k in legs) parts.push(`${k}=${word(legs[k])}`)
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${word(v)}`)
  return parts.join(' ')
}

export type TimingFields = Record<string, number | string | null>

/** The fields of a line `timingLine` wrote (anything before `timing` is ignored); null when the line holds none. */
export function parseTimingLine(line: string): TimingFields | null {
  const at = line.search(/(^|\s)timing(\s|$)/)
  if (at < 0) return null
  const out: TimingFields = {}
  for (const m of line.slice(at).matchAll(/(\w+)=(\S+)/g)) {
    const v = m[2]!
    out[m[1]!] = v === '-' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  return out
}
