/**
 * The pure parts of the renderer soak's scroll scene (`--scene scroll` in
 * scripts/measure-renderer-soak.ts; docs/box.md "Scrolling while threads
 * work"): four scrollers (the master's transcript, its board, the rail's
 * workspaces and the workspace column) each turned by the wheel at 60 Hz,
 * then flung (CDP `Input.synthesizeScrollGesture`), under the board's load,
 * every frame's interval read from requestAnimationFrame. Judged by
 * soakJudge.ts SCROLL_RULE; tested in scripts/soak-scroll.test.ts.
 */
import { spread, type Spread } from './soakTyping'

export type ScrollSurface = 'transcript' | 'board' | 'rail' | 'column'
export const SCROLL_SURFACES: readonly ScrollSurface[] = ['transcript', 'board', 'rail', 'column']
export type ScrollMode = 'wheel' | 'fling'

/** One wheel tick: when it is sent, from the start, and how far it turns. */
export interface WheelTick {
  at: number
  deltaY: number
}

/**
 * The wheel's ticks: `hz` a second for `ms`, `step` px each, from `from` px
 * into a scroll range of `range` px, turning back at either end. A range too
 * short for a tick goes nowhere (no ticks).
 */
export function wheelPlan(ms: number, hz: number, step: number, range: number, from: number): WheelTick[] {
  if (range < step) return []
  const ticks: WheelTick[] = []
  let at = Math.min(range, Math.max(0, from))
  // Up from the bottom, down from anywhere else.
  let dir = at >= range ? -1 : 1
  for (let i = 0; i * 1000 < ms * hz; i++) {
    if ((dir > 0 && at + step > range) || (dir < 0 && at - step < 0)) dir = -dir
    at += dir * step
    ticks.push({ at: Math.round((i * 1000) / hz), deltaY: dir * step })
  }
  return ticks
}

/** What a stretch of scrolling recorded on the page. */
export interface FrameRun {
  /** milliseconds between animation frames while it ran */
  intervals: number[]
  ms: number
  scrolledPx: number
  longTasks: { start: number; duration: number }[]
  /** long animation frames past 50 ms, with their heaviest scripts */
  frames: { duration: number; scripts: string[] }[]
}

export interface FrameSummary {
  frames: number
  fps: number
  /** frames the display showed while no new one was drawn */
  dropped: number
  longestMs: number
  /** frames slower than 32 ms (two at 60 Hz, four at 120 Hz) */
  over32: number
  interval: Spread
  longTasks: { count: number; maxMs: number }
  scrolledPx: number
}

/** The display's frame: the median interval of an idle run. */
export function displayInterval(intervals: readonly number[]): number {
  const sorted = [...intervals].filter((v) => v > 0).sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 1000 / 60
}

export function summarizeFrames(run: FrameRun, displayMs: number): FrameSummary {
  const seconds = run.ms / 1000
  return {
    frames: run.intervals.length,
    fps: seconds > 0 ? Math.round((run.intervals.length / seconds) * 10) / 10 : 0,
    dropped: run.intervals.reduce((n, i) => n + Math.max(0, Math.round(i / displayMs) - 1), 0),
    longestMs: Math.round(Math.max(0, ...run.intervals) * 10) / 10,
    over32: run.intervals.filter((i) => i > 32).length,
    interval: spread(run.intervals),
    longTasks: { count: run.longTasks.length, maxMs: Math.round(Math.max(0, ...run.longTasks.map((t) => t.duration))) },
    scrolledPx: Math.round(run.scrolledPx)
  }
}

/** One surface in one mode: its summary, or why it was not scrolled. */
export interface ScrollResult {
  surface: ScrollSurface
  mode: ScrollMode
  summary: FrameSummary | null
  skipped: string | null
  frames: { duration: number; scripts: string[] }[]
}

export function scrollMarkdown(results: readonly ScrollResult[], displayMs: number): string[] {
  const hz = Math.round(1000 / displayMs)
  return [
    `The display draws a frame every ${displayMs.toFixed(1)} ms (${hz} Hz) at rest.`,
    '',
    '| surface | mode | fps | dropped | longest ms | over 32 ms | interval p50 / p95 / p99 ms | long tasks (worst ms) | scrolled px | long frames |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const s = r.summary
      if (!s) return `| ${r.surface} | ${r.mode} | – | – | – | – | – | – | – | ${r.skipped} |`
      const long = r.frames.map((f) => `${Math.round(f.duration)} ms: ${f.scripts.join('; ') || 'no script named'}`).join(' / ') || 'none'
      return `| ${r.surface} | ${r.mode} | ${s.fps} | ${s.dropped} | ${s.longestMs} | ${s.over32} | ${s.interval.p50} / ${s.interval.p95} / ${s.interval.p99} | ${s.longTasks.count}${s.longTasks.count ? ` (${s.longTasks.maxMs})` : ''} | ${s.scrolledPx} | ${long} |`
    })
  ]
}
