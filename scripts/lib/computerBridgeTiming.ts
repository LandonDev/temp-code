import type { TimingFields } from '../../src/shared/computer/bridgeTiming'

/**
 * The bridge proof's timing leg (scripts/e2e-computer-bridge.ts;
 * docs/computer-protocol.md "What the bridge costs"): the same call from a box
 * thread and from a Mac thread, in interleaved pairs, each side timed around
 * its own `app.computer` request. The added time per pair is the bridge's
 * cost; the legs from the hosts' timing lines say where it went. The first
 * pair opens the sessions and takes the guard slot, so it is reported apart.
 */

export type TimingKind = 'observe' | 'observe-shot' | 'set-value'
export const TIMING_KINDS: readonly TimingKind[] = ['observe', 'observe-shot', 'set-value']
export type TimingMode = 'gate' | 'full'

export interface TimingSample {
  kind: TimingKind
  /** 0 is the cold pair */
  pair: number
  /** the box half's own timing of its local app.computer request */
  bridgedMs: number
  /** the orchestrator's timing of the Mac instance's local request */
  localMs: number
  /** the box's `[computer-bridge] timing` line for the bridged call, parsed */
  legs?: TimingFields | null
}

export const BRIDGE_TIMING_RULE = {
  pairs: 10,
  /** loopback (`--gate`): box call minus Mac call */
  addedMedianMs: 40,
  addedP90Ms: 100,
  /** loopback: the box's own work plus the Mac's wrapper (everything but the run), median */
  ownMedianMs: 25,
  /** the full mode over the network: added time of a call without a picture, over the measured round trip, median */
  overRoundTripMs: 40
} as const

/** Judged in each mode; the rest are reported. A picture over the network is bytes on the uplink, recorded, never judged. */
const JUDGED: Record<TimingMode, readonly TimingKind[]> = { gate: ['observe', 'observe-shot', 'set-value'], full: ['observe', 'set-value'] }

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Nearest rank. */
export function p90(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]!
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The box's own legs plus the Mac's wrapper: everything of the bridged call but the Mac's run and the wire. */
export function ownMs(legs: TimingFields | null | undefined): number | null {
  const box = num(legs?.box)
  const mac = num(legs?.mac)
  const run = num(legs?.run)
  return box === null || mac === null || run === null ? null : box + Math.max(0, mac - run)
}

export interface TimingRow {
  kind: TimingKind
  judged: boolean
  n: number
  added: { median: number | null; p90: number | null }
  bridged: { median: number | null; p90: number | null }
  local: { median: number | null; p90: number | null }
  own: number | null
  legs: Record<'box' | 'transit' | 'mac' | 'run' | 'service' | 'waited', number | null>
  shotChars: number | null
  cold: { bridgedMs: number; localMs: number } | null
  skipped?: string
}

export interface TimingVerdict {
  ok: boolean
  failures: string[]
  rows: TimingRow[]
}

export interface TimingContext {
  /** the box half's ping round trip, median (ms) */
  roundTripMs?: number | null
  /** the sink's upload rate (Mbit/s), reported beside the pictures */
  uploadMbps?: number | null
  /** a kind not run, with its line (Screen Recording off) */
  skipped?: Partial<Record<TimingKind, string>>
}

const stat = (xs: number[]) => ({ median: median(xs), p90: p90(xs) })

export function timingRows(samples: readonly TimingSample[], mode: TimingMode, ctx: TimingContext = {}): TimingRow[] {
  return TIMING_KINDS.map((kind) => {
    const all = samples.filter((s) => s.kind === kind)
    const coldOne = all.find((s) => s.pair === 0)
    const warm = all.filter((s) => s.pair !== 0)
    const leg = (k: string): number | null => median(warm.flatMap((s) => (num(s.legs?.[k]) === null ? [] : [num(s.legs?.[k])!])))
    const owns = warm.flatMap((s) => (ownMs(s.legs) === null ? [] : [ownMs(s.legs)!]))
    return {
      kind,
      judged: JUDGED[mode].includes(kind),
      n: warm.length,
      added: stat(warm.map((s) => s.bridgedMs - s.localMs)),
      bridged: stat(warm.map((s) => s.bridgedMs)),
      local: stat(warm.map((s) => s.localMs)),
      own: median(owns),
      legs: { box: leg('box'), transit: leg('transit'), mac: leg('mac'), run: leg('run'), service: leg('service'), waited: leg('waited') },
      shotChars: leg('shotChars'),
      cold: coldOne ? { bridgedMs: coldOne.bridgedMs, localMs: coldOne.localMs } : null,
      ...(ctx.skipped?.[kind] ? { skipped: ctx.skipped[kind] } : {})
    }
  })
}

/** Judge the warm pairs against BRIDGE_TIMING_RULE. A kind skipped by name passes; a judged kind with no pairs fails. */
export function judgeBridgeTiming(samples: readonly TimingSample[], mode: TimingMode, ctx: TimingContext = {}): TimingVerdict {
  const rows = timingRows(samples, mode, ctx)
  const failures: string[] = []
  const R = BRIDGE_TIMING_RULE
  if (mode === 'full' && num(ctx.roundTripMs) === null) failures.push('full mode: no measured round trip to judge against')
  for (const row of rows) {
    if (!row.judged || row.skipped) continue
    if (!row.n) {
      failures.push(`${row.kind}: no pairs ran`)
      continue
    }
    const med = row.added.median!
    if (mode === 'gate') {
      if (med > R.addedMedianMs) failures.push(`${row.kind}: added ${fmt(med)} ms median, over ${R.addedMedianMs}`)
      if (row.added.p90! > R.addedP90Ms) failures.push(`${row.kind}: added ${fmt(row.added.p90)} ms p90, over ${R.addedP90Ms}`)
      if (row.own === null) failures.push(`${row.kind}: no timing lines from the box to split the legs`)
      else if (row.own > R.ownMedianMs) failures.push(`${row.kind}: the box's own work and the Mac's wrapper ${fmt(row.own)} ms median, over ${R.ownMedianMs}`)
    } else if (num(ctx.roundTripMs) !== null) {
      const bound = ctx.roundTripMs! + R.overRoundTripMs
      if (med > bound) failures.push(`${row.kind}: added ${fmt(med)} ms median, over the round trip ${fmt(ctx.roundTripMs)} + ${R.overRoundTripMs}`)
    }
  }
  return { ok: failures.length === 0, failures, rows }
}

const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? '-' : String(Math.round(v)))

/** The report's table: one line per kind, every number in ms but the bytes. */
export function timingTable(verdict: TimingVerdict, ctx: TimingContext = {}): string {
  const head = 'kind          n  added p50/p90  box p50/p90  mac p50/p90  own  box  transit  mac  run  service  waited  shotChars  cold box/mac'
  const lines = [head]
  for (const r of verdict.rows) {
    if (r.skipped) {
      lines.push(`${r.kind.padEnd(12)}  skipped: ${r.skipped}`)
      continue
    }
    lines.push(
      [
        r.kind.padEnd(12),
        String(r.n).padStart(2),
        `${fmt(r.added.median)}/${fmt(r.added.p90)}`.padStart(14),
        `${fmt(r.bridged.median)}/${fmt(r.bridged.p90)}`.padStart(11),
        `${fmt(r.local.median)}/${fmt(r.local.p90)}`.padStart(11),
        fmt(r.own).padStart(4),
        fmt(r.legs.box).padStart(4),
        fmt(r.legs.transit).padStart(7),
        fmt(r.legs.mac).padStart(4),
        fmt(r.legs.run).padStart(4),
        fmt(r.legs.service).padStart(7),
        fmt(r.legs.waited).padStart(6),
        fmt(r.shotChars).padStart(9),
        r.cold ? `${r.cold.bridgedMs}/${r.cold.localMs}` : '-',
        r.judged ? '' : '(reported)'
      ].join('  ').trimEnd()
    )
  }
  const link = [num(ctx.roundTripMs) !== null ? `round trip ${fmt(ctx.roundTripMs)} ms` : null, num(ctx.uploadMbps) !== null ? `upload ${ctx.uploadMbps!.toFixed(1)} Mbit/s` : null].filter(Boolean)
  if (link.length) lines.push(link.join(', '))
  for (const f of verdict.failures) lines.push(`✗ ${f}`)
  return lines.join('\n')
}
