/** CGWindowList is front to back, in global points with a top-left origin. */
export interface WindowRect {
  x: number
  y: number
  w: number
  h: number
}
export interface CoverWindow extends WindowRect {
  id: number
  pid: number
  layer: number
  alpha: number
}

/** Fraction of a window covered by the union of opaque normal windows ahead of it. */
export function coveredFraction(target: WindowRect, covers: readonly WindowRect[]): number {
  if (
    ![target.x, target.y, target.w, target.h].every(Number.isFinite) ||
    target.w <= 0 ||
    target.h <= 0
  )
    return 0
  const clipped = covers.flatMap((r) => {
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) return []
    const x = Math.max(target.x, r.x),
      y = Math.max(target.y, r.y)
    const right = Math.min(target.x + target.w, r.x + r.w),
      bottom = Math.min(target.y + target.h, r.y + r.h)
    return right > x && bottom > y ? [{ x, y, w: right - x, h: bottom - y }] : []
  })
  const xs = [...new Set(clipped.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b)
  let area = 0
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1],
      right = xs[i]
    const spans = clipped
      .filter((r) => r.x <= left && r.x + r.w >= right)
      .map((r) => [r.y, r.y + r.h])
      .sort((a, b) => a[0] - b[0])
    let end = -Infinity,
      height = 0
    for (const [top, bottom] of spans) {
      height += Math.max(0, bottom - Math.max(top, end))
      end = Math.max(end, bottom)
    }
    area += (right - left) * height
  }
  return Math.min(1, area / (target.w * target.h))
}

export interface CoverageNote {
  window: number
  covered: boolean
  fraction: number
}
export function windowCoverage(
  windows: readonly CoverWindow[],
  pid: number,
  window?: number
): CoverageNote | null {
  const at = windows.findIndex(
    (w) => w.pid === pid && w.layer === 0 && (window === undefined || w.id === window)
  )
  if (at < 0) return null
  const fraction = coveredFraction(
    windows[at],
    windows.slice(0, at).filter((w) => w.layer === 0 && w.alpha >= 0.99)
  )
  return { window: windows[at].id, covered: fraction >= 0.999, fraction }
}

export interface ProbeCover {
  window: number
  layer: number
  /** the share of it the opaque windows ahead hide, 0 to 1 */
  fraction: number
  /** their owners' pids */
  by: number[]
}

/**
 * TC Probe's window at its own layer (it floats, layer 3) and what covers it: opaque windows of other apps ahead
 * of it in the list, on any layer. Null when it is not on screen at all, as on another Space or behind a
 * full-screen app. A proof whose check reads pixels the probe draws fails it as not judged while this is not
 * clear (`coverWord`), rather than judging the screen.
 */
export function probeCover(windows: readonly CoverWindow[], pid: number, window?: number): ProbeCover | null {
  const at = windows.findIndex((w) => w.pid === pid && (window === undefined ? w.layer === 0 || w.layer === 3 : w.id === window))
  if (at < 0) return null
  const ahead = windows.slice(0, at).filter((w) => w.pid !== pid && w.alpha >= 0.99 && coveredFraction(windows[at], [w]) > 0)
  return { window: windows[at].id, layer: windows[at].layer, fraction: coveredFraction(windows[at], ahead), by: [...new Set(ahead.map((w) => w.pid))] }
}

/** Null when the probe is on screen and uncovered; else the words a check fails with. */
export function coverWord(cover: ProbeCover | null): string | null {
  if (!cover) return 'not judged: TC Probe is not on screen (another Space or a full-screen app)'
  if (cover.fraction > 0) return `not judged: covered, ${Math.round(cover.fraction * 100)}% by pid ${cover.by.join(', ')}`
  return null
}
