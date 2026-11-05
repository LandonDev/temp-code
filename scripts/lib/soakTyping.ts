/**
 * The pure parts of the renderer soak's typing scene (`--scene typing` in
 * scripts/measure-renderer-soak.ts; docs/box.md "Typing on a busy master"):
 * the seeded prose and cadence the window is typed with, the phases of a
 * hand run and of the gate, the readings each phase reduces to, and its
 * report. The rule they are judged by is soakJudge.ts TYPING_RULE; the
 * tests are scripts/soak-typing.test.ts.
 *
 * A phase types into the master's composer, rests 1 s, checks the text
 * exactly and clears the field:
 *
 *   idle   the load paused, paced keys (a seeded 60-120 ms apart)
 *   busy   the whole load, paced keys
 *   fast   the whole load, keys 30-40 ms apart (key repeat speed)
 *   burst  keys back to back (the text and long tasks only: its latency
 *          is the queue's)
 *   paste  one paste of 2,000 characters
 *
 * A keystroke's latency is from its event's timestamp to the end of the
 * main-thread work of the next frame (a MessageChannel message posted from
 * the next requestAnimationFrame): the frame that paints the character.
 */

export type TypingPhaseName = 'idle' | 'busy' | 'fast' | 'burst' | 'paste'

export interface TypingPhase {
  name: TypingPhaseName
  /** keys typed, or characters pasted */
  count: number
  /** the gap before each key: paced, fast, or none */
  cadence: 'paced' | 'fast' | 'none'
}

/** The phases: a hand run types more; a run against the box has no pause, so no idle phase. */
export function typingPhases(gate: boolean, canPause: boolean): TypingPhase[] {
  const phases: TypingPhase[] = [
    { name: 'idle', count: gate ? 100 : 300, cadence: 'paced' },
    { name: 'busy', count: gate ? 200 : 300, cadence: 'paced' },
    { name: 'fast', count: gate ? 100 : 300, cadence: 'fast' },
    { name: 'burst', count: gate ? 1_000 : 2_000, cadence: 'none' },
    { name: 'paste', count: 2_000, cadence: 'none' }
  ]
  return canPause ? phases : phases.filter((p) => p.name !== 'idle')
}

const SENTENCES = [
  'The editor should keep each letter in order while many threads report their work. ',
  'I am writing a long note to see how quickly the field draws my words. ',
  'Every batch child lands its branch and the board says so beside the chat. ',
  'Nothing here should wait for the board, the rail or the live edits to finish. ',
  'When the master settles it reads the reports and decides what runs next. '
]

/** A seeded generator: the same seed gives the same text and the same gaps on every run. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s
  }
}

/** `n` characters of plain prose (letters, spaces and punctuation; no newline), seeded. */
export function typingProse(n: number, seed = 7): string {
  const next = lcg(seed)
  let out = ''
  while (out.length < n) out += SENTENCES[next() % SENTENCES.length]
  return out.slice(0, n)
}

/** The gap before each key of a phase, ms: paced 60-120, fast 30-40, none 0. */
export function typingGaps(cadence: TypingPhase['cadence'], n: number, seed = 123_456_789): number[] {
  const next = lcg(seed)
  return Array.from({ length: n }, () => (cadence === 'paced' ? 60 + (next() % 61) : cadence === 'fast' ? 30 + (next() % 11) : 0))
}

export interface Spread {
  n: number
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

/** Nearest-rank percentiles, to a tenth of a millisecond. */
export function spread(values: readonly number[]): Spread {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const at = (q: number): number | null => (sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]! * 10) / 10 : null)
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }
}

/** The first index where the field's text differs from what was typed, or null when it matches. */
export function firstDifference(expected: string, actual: string): number | null {
  if (expected === actual) return null
  let i = 0
  while (i < Math.min(expected.length, actual.length) && expected[i] === actual[i]) i++
  return i
}

/** What the page recorded in one phase's window (measure-renderer-soak.ts TYPING_OBSERVERS). */
export interface TypingRecords {
  /** per keystroke: its event's timestamp, when its handler ran, and the end of the next frame's work */
  keys: { stamp: number; handler: number; frame: number | null }[]
  /** Event Timing entries of 16 ms or more, the longest per interaction */
  events: { interactionId: number; duration: number }[]
  longTasks: { start: number; duration: number }[]
  /** long-animation-frame entries over 50 ms, with their three longest scripts */
  frames: { start: number; duration: number; blocking: number; scripts: { invoker: string; fn: string; url: string; duration: number }[] }[]
  /** the store's counters over the window */
  store: { flushes: number; metaFlushes: number; masterMetas: number; liveEdits: number }
  windowMs: number
}

export interface PhaseSummary {
  phase: TypingPhaseName
  count: number
  seconds: number
  /** keystroke → the end of the next frame's main-thread work, ms */
  frame: Spread
  /** keystroke → its handler, ms */
  inputDelay: Spread
  /** Event Timing: interactions of 16 ms or more, and the p95 over every keystroke (those without an entry count under 16) */
  events: { over16: number; p95: number | null; max: number | null }
  longTasks: { count: number; totalMs: number; maxMs: number }
  /** the long animation frames' worst offenders, by script */
  frames: { count: number; worst: { duration: number; scripts: string[] }[] }
  store: { flushesPerS: number; metaFlushesPerS: number; masterMetasPerS: number; liveEditsPerS: number }
  text: { ok: boolean; firstDifference: number | null; expected: number; actual: number }
}

const round = (n: number): number => Math.round(n * 10) / 10

export function summarizePhase(phase: TypingPhase, records: TypingRecords, expected: string, actual: string): PhaseSummary {
  const keyed = phase.name !== 'paste'
  const seconds = records.windowMs / 1000
  const perS = (n: number): number => (seconds ? round(n / seconds) : 0)
  const durations = records.events.map((e) => e.duration)
  // Every keystroke counts once; one with no entry took under 16 ms.
  const interactions = keyed ? Math.max(records.keys.length, durations.length) : durations.length
  const all = [...durations, ...Array.from({ length: interactions - durations.length }, () => 0)]
  const eventP95 = all.length ? spread(all).p95 : null
  const diff = firstDifference(expected, actual)
  return {
    phase: phase.name,
    count: phase.count,
    seconds: round(seconds),
    frame: spread(keyed ? records.keys.flatMap((k) => (k.frame === null ? [] : [k.frame - k.stamp])) : []),
    inputDelay: spread(keyed ? records.keys.map((k) => k.handler - k.stamp) : []),
    events: { over16: durations.length, p95: eventP95 === 0 ? null : eventP95, max: durations.length ? round(Math.max(...durations)) : null },
    longTasks: {
      count: records.longTasks.length,
      totalMs: round(records.longTasks.reduce((s, t) => s + t.duration, 0)),
      maxMs: round(Math.max(0, ...records.longTasks.map((t) => t.duration)))
    },
    frames: {
      count: records.frames.length,
      worst: [...records.frames]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 3)
        .map((f) => ({ duration: round(f.duration), scripts: f.scripts.map((s) => `${s.fn || s.invoker || '?'} ${round(s.duration)} ms${s.url ? ` (${s.url.split('/').pop()})` : ''}`) }))
    },
    store: {
      flushesPerS: perS(records.store.flushes),
      metaFlushesPerS: perS(records.store.metaFlushes),
      masterMetasPerS: perS(records.store.masterMetas),
      liveEditsPerS: perS(records.store.liveEdits)
    },
    text: { ok: diff === null, firstDifference: diff, expected: expected.length, actual: actual.length }
  }
}

const cell = (s: Spread, keys: (keyof Spread)[] = ['p50', 'p95', 'p99', 'max']): string => (s.n ? keys.map((k) => s[k] ?? '–').join(' / ') : '–')

/** The report's table: one row per phase. */
export function typingMarkdown(phases: PhaseSummary[]): string[] {
  const rows = phases.map((p) => {
    const events = p.events.over16 ? `${p.events.over16}; p95 ${p.events.p95 ?? '<16'}, max ${p.events.max}` : 'none'
    const text = p.text.ok ? 'exact' : `differs at ${p.text.firstDifference} (${p.text.actual} of ${p.text.expected})`
    const store = `${p.store.flushesPerS} / ${p.store.masterMetasPerS} / ${p.store.liveEditsPerS}`
    return `| ${p.phase} | ${p.count} | ${p.seconds} | ${cell(p.frame)} | ${cell(p.inputDelay, ['p50', 'p95', 'max'])} | ${events} | ${p.longTasks.count} / ${p.longTasks.totalMs} / ${p.longTasks.maxMs} | ${p.frames.count} | ${store} | ${text} |`
  })
  const worst = phases.flatMap((p) => p.frames.worst.map((f) => `- ${p.phase}: ${f.duration} ms frame: ${f.scripts.join('; ') || 'no script named'}`))
  return [
    '| phase | keys | s | key → frame p50 / p95 / p99 / max ms | input delay p50 / p95 / max ms | events ≥ 16 ms | long tasks n / total / worst ms | long frames > 50 ms | flushes / master metas / live edits a second | text |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    ...(worst.length ? ['', 'The longest animation frames and what ran in them:', '', ...worst] : [])
  ]
}
