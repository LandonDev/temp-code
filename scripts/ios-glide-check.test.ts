// The glide proof's check (scripts/lib/group_glide_check.py, run by
// scripts/ios-sim-proof.sh `glide_set`) on hand-made reports in the shape the
// app writes (TranscriptView's groupGlideProof: [t, offset, content height]).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const check = resolve(__dirname, 'lib', 'group_glide_check.py')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 0.9 s at 8 ms of a spring-like glide from `y0` by `dy`, the content growing by `dh`. */
function glide(y0: number, dy: number, h0: number, dh: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < 112; i++) {
    const t = i * 0.008
    const k = 1 - Math.exp(-t / 0.08)
    out.push([t, y0 + dy * k, h0 + dh])
  }
  return out
}
type Phase = { opening: boolean; atBottom: boolean; before: number[]; samples: number[][] }
/** Each tap's `before` is where the samples start, at the height the last tap left. */
const cycle = (atBottom: boolean, open: (y: number) => number[][], fold: (y: number) => number[][]): Phase[] =>
  [0, 1, 2].flatMap(() => {
    const opened = open(1000)
    const folded = fold(1000)
    return [
      { opening: true, atBottom, before: [opened[0][1], folded[folded.length - 1][2]], samples: opened },
      { opening: false, atBottom, before: [folded[0][1], opened[opened.length - 1][2]], samples: folded }
    ]
  })

function run(phases: Phase[], events: unknown[] = []): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'glide-check-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'glide.json'), JSON.stringify({ mode: 'bottom', group: 41, phases }))
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events))
  const out = spawnSync('python3', [check, join(dir, 'glide.json'), join(dir, 'events.json'), 'unfolded/bottom'], { encoding: 'utf8' })
  return { status: out.status, out: out.stdout + out.stderr }
}

describe('group_glide_check.py', () => {
  it('passes a reader at the bottom followed one way in steps, and a reader up who never moves', () => {
    expect(run(cycle(true, (y) => glide(y, 180, 4000, 180), (y) => glide(y + 180, -180, 4180, -180))).status).toBe(0)
    expect(run(cycle(false, (y) => glide(y, 0, 4000, 180), (y) => glide(y, 0, 4180, -180))).status).toBe(0)
  })

  it('fails a reader up whose offset moved: the rows above the group were thrown', () => {
    const r = run(cycle(false, (y) => glide(y, -120, 4000, 180), (y) => glide(y, 0, 4180, -180)))
    expect(r.status).toBe(1)
    expect(r.out).toContain('the reader was up and the offset moved 120')
  })

  it('fails a pin that snaps at the bottom, and an offset that turns back', () => {
    const snap = (y: number): number[][] => glide(y, 0, 4000, 180).map(([t, , h], i) => [t, i < 3 ? y : y + 180, h])
    const snapped = run(cycle(true, snap, (y) => glide(y + 180, -180, 4180, -180)))
    expect(snapped.status).toBe(1)
    expect(snapped.out).toContain('a jump, not a glide')
    const bounce = (y: number): number[][] => glide(y, 180, 4000, 180).map(([t, v, h], i) => [t, i === 40 ? v - 30 : v, h])
    const back = run(cycle(true, bounce, (y) => glide(y + 180, -180, 4180, -180)))
    expect(back.status).toBe(1)
    expect(back.out).toContain('the offset turned back')
  })

  it('fails a tap that changed nothing, a missing tap, and a jumpUp in the events', () => {
    const still = run(cycle(true, (y) => glide(y, 0, 4000, 0), (y) => glide(y, 0, 4000, 0)))
    expect(still.out).toContain('the content height never changed')
    expect(run(cycle(true, (y) => glide(y, 180, 4000, 180), (y) => glide(y + 180, -180, 4180, -180)).slice(1)).out).toContain('5 taps recorded')
    const jumped = run(cycle(true, (y) => glide(y, 180, 4000, 180), (y) => glide(y + 180, -180, 4180, -180)), [
      { t: 1, key: 'jumpUp', from: null, to: '3200→2900 h 4100→4100 top 12' }
    ])
    expect(jumped.status).toBe(1)
    expect(jumped.out).toContain('1 jumpUp events')
  })
})
