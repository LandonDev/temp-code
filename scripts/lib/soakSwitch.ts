/**
 * The pure parts of the renderer soak's switch scene (`--scene switch` in
 * scripts/measure-renderer-soak.ts; docs/box.md "Switching workspaces"): a
 * click on a workspace in the rail, timed to the end of the first frame in
 * which the column holds that workspace's project cards and the title bar's
 * strip one of its threads (what a warm-up visit saw once it settled), and to
 * the first frame its landing thread's pane shows rows. Judged by
 * soakJudge.ts SWITCH_RULE; tested in scripts/soak-switch.test.ts.
 */
import { spread, type Spread } from './soakTyping'

/** What a workspace shows once settled: its cards' names, the strip's thread titles, the pane's thread. */
export interface SwitchView {
  cards: string[]
  chips: string[]
  pane: string | null
}

/** The page's reading of the window now, with the rows the pane draws. */
export interface SwitchReading extends SwitchView {
  rows: number
}

/** Whether a reading shows the workspace a warm-up saw: the same cards, and one of its threads in the strip (none when it had none). */
export function switchReady(now: SwitchView, expect: SwitchView): boolean {
  if (now.cards.length !== expect.cards.length || now.cards.some((c, i) => c !== expect.cards[i])) return false
  return expect.chips.length === 0 ? now.chips.length === 0 : now.chips.some((c) => expect.chips.includes(c))
}

/** One measured click: the target, the two times from the click (null when not seen within the window), what ran. */
export interface SwitchClick {
  target: string
  readyMs: number | null
  paneMs: number | null
  longTasks: { start: number; duration: number }[]
  frames: { duration: number; scripts: string[] }[]
  requests: Record<string, number>
  /** the threads with a pane mounted after the click, parked ones included (a warm switch back finds its pane here) */
  panes: string[]
}

export interface SwitchSummary {
  clicks: number
  /** click → column and strip */
  ready: Spread
  /** click → the landing thread's rows */
  pane: Spread
  missed: number
  longTasks: { count: number; maxMs: number }
  byTarget: Record<string, { ready: Spread; pane: Spread }>
}

export function summarizeSwitch(clicks: readonly SwitchClick[]): SwitchSummary {
  const times = (list: readonly SwitchClick[], key: 'readyMs' | 'paneMs'): number[] => list.flatMap((c) => (c[key] === null ? [] : [c[key]!]))
  const targets = [...new Set(clicks.map((c) => c.target))]
  const tasks = clicks.flatMap((c) => c.longTasks)
  return {
    clicks: clicks.length,
    ready: spread(times(clicks, 'readyMs')),
    pane: spread(times(clicks, 'paneMs')),
    missed: clicks.filter((c) => c.readyMs === null).length,
    longTasks: { count: tasks.length, maxMs: Math.round(Math.max(0, ...tasks.map((t) => t.duration)) * 10) / 10 },
    byTarget: Object.fromEntries(targets.map((t) => [t, { ready: spread(times(clicks.filter((c) => c.target === t), 'readyMs')), pane: spread(times(clicks.filter((c) => c.target === t), 'paneMs')) }]))
  }
}

const ms = (n: number | null): string => (n === null ? '–' : String(Math.round(n * 10) / 10))

/** The report: one row per click, then the spread by target. */
export function switchMarkdown(clicks: readonly SwitchClick[], summary: SwitchSummary): string[] {
  const requests = (r: Record<string, number>): string => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'
  return [
    '| click | workspace | → column and strip ms | → pane rows ms | long tasks (worst ms) | long frames | requests sent | panes mounted |',
    '|---|---|---|---|---|---|---|---|',
    ...clicks.map((c, i) => `| ${i + 1} | ${c.target} | ${ms(c.readyMs)} | ${ms(c.paneMs)} | ${c.longTasks.length}${c.longTasks.length ? ` (${Math.round(Math.max(...c.longTasks.map((t) => t.duration)))})` : ''} | ${c.frames.map((f) => `${Math.round(f.duration)} ms: ${f.scripts.join('; ') || 'no script named'}`).join(' / ') || 'none'} | ${requests(c.requests)} | ${c.panes.length} |`),
    '',
    '| workspace | column and strip p50 / p95 / max ms | pane rows p50 / p95 / max ms |',
    '|---|---|---|',
    ...Object.entries(summary.byTarget).map(([t, s]) => `| ${t} | ${ms(s.ready.p50)} / ${ms(s.ready.p95)} / ${ms(s.ready.max)} | ${ms(s.pane.p50)} / ${ms(s.pane.p95)} / ${ms(s.pane.max)} |`),
    `| all | ${ms(summary.ready.p50)} / ${ms(summary.ready.p95)} / ${ms(summary.ready.max)} | ${ms(summary.pane.p50)} / ${ms(summary.pane.p95)} / ${ms(summary.pane.max)} |`
  ]
}
