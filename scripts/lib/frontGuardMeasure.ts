/**
 * The pure half of scripts/mac/front-guard-measure.ts (docs/computer-protocol.md §23.9): what the
 * independent frontmost samples say about one case, and the report's table. The live half
 * launches the real apps; this half is tested in vitest on any host.
 */
import type { FrontReport, LaunchedWindow } from '../../src/shared/computer/protocol'

/** One change of the active app, as `computer-proof-probe frontwatch` prints it. */
export interface FrontSample {
  pid: number
  at: number
}

/** What the samples saw between a case's start and its end, beside what the service said. */
export interface Observed {
  /** another app than the person's was active at some point */
  raised: boolean
  /** how long the person's app was not in front, all spells together */
  awayMs: number
  /** the person's app was in front at the end */
  back: boolean
}

/**
 * The samples are changes, so each one holds until the next. The app active at `from` is the last
 * sample at or before it; an app active before the case and never changed counts as the person's.
 */
export function observeFront(samples: readonly FrontSample[], personPid: number, from: number, to: number): Observed {
  const sorted = [...samples].sort((a, b) => a.at - b.at)
  let current = [...sorted].reverse().find((s) => s.at <= from)?.pid ?? personPid
  let since = from
  let awayMs = 0
  let raised = false
  for (const s of sorted) {
    if (s.at <= from || s.at > to) continue
    if (current !== personPid) awayMs += s.at - since
    current = s.pid
    since = s.at
    if (current !== personPid) raised = true
  }
  if (current !== personPid) awayMs += to - since
  return { raised, awayMs, back: current === personPid }
}

export type CaseOutcome = 'ran' | 'skipped' | 'void' | 'failed'

export interface CaseRow {
  app: string
  action: string
  outcome: CaseOutcome
  why?: string
  /** from the call to its answer: the app finished launching or the item's window is readable */
  answerMs?: number
  /** what the service said: the result's front, or a late apps/frontRestored */
  front?: FrontReport
  late?: boolean
  observed?: Observed
  pointerMoved?: boolean
  window?: LaunchedWindow
  /** the app's windows that appeared or changed title, as the service said and as the lists before and after show */
  others?: LaunchedWindow[]
  changed?: string[]
}

const cell = (s: string): string => s.replace(/\|/g, '\\|')

function guardWords(r: CaseRow): string {
  if (!r.front?.raised) return 'not raised'
  const how = r.front.restored ?? 'raised'
  return `${how}${r.front.ms !== undefined ? ` ${r.front.ms} ms` : ''}${r.late ? ' (late)' : ''}`
}

/** The report's table: one row a case, its outcome first. */
export function reportTable(rows: readonly CaseRow[]): string {
  const head = '| App | Action | Outcome | Answer | Guard | Samples | Pointer | Window | Other windows |\n|---|---|---|---|---|---|---|---|---|'
  const lines = rows.map((r) => {
    if (r.outcome !== 'ran') return `| ${cell(r.app)} | ${cell(r.action)} | ${r.outcome}${r.why ? `: ${cell(r.why)}` : ''} | | | | | | |`
    const o = r.observed
    const samples = o ? `${o.raised ? `raised, away ${o.awayMs} ms` : 'never raised'}${o.back ? '' : ', not back'}` : ''
    const others = [...(r.others ?? []).map((w) => JSON.stringify(w.title)), ...(r.changed ?? [])].join(', ') || 'none'
    return [
      r.app,
      r.action,
      'ran',
      r.answerMs !== undefined ? `${r.answerMs} ms` : '',
      guardWords(r),
      samples,
      r.pointerMoved ? 'moved' : 'still',
      r.window ? JSON.stringify(r.window.title) : 'none',
      others
    ]
      .map((c) => cell(String(c)))
      .join(' | ')
      .replace(/^/, '| ')
      .replace(/$/, ' |')
  })
  return [head, ...lines].join('\n')
}

/** The titles that are new or changed between two lists of one app's windows, by id. */
export function changedWindows(before: readonly LaunchedWindow[], after: readonly LaunchedWindow[]): string[] {
  const was = new Map(before.map((w) => [w.id, w.title]))
  return after.flatMap((w) => {
    const old = was.get(w.id)
    if (old === undefined) return [`new ${JSON.stringify(w.title)}`]
    return old === w.title ? [] : [`${JSON.stringify(old)} is now ${JSON.stringify(w.title)}`]
  })
}
