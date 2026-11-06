// The glide proof's check (scripts/lib/group_glide_check.py, run by
// scripts/ios-sim-proof.sh `glide_set`) on hand-made reports in the shape the
// app writes (TranscriptView's groupGlideProof: `samples` as [t, offset,
// content height], `shown` as what is drawn: the presentation offset and each
// visible cell as [item, top on screen, height]).
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

/** Rows 8 and 9 above the group (item 10, 40 pt shut), rows 11 and 12 under it. */
const GROUP = 10
const D = 128
type Cell = [number, number, number]
type Shown = { t: number; offset: number; height: number; cells: Cell[] }
type Phase = { opening: boolean; atBottom: boolean; before: number[]; samples: number[][]; shown: Shown[] }

/** 0.9 s at 8 ms of a spring-like change; `draw(k)` lays the cells out at progress k (0 → 1). */
function phase(opening: boolean, atBottom: boolean, draw: (k: number, i: number) => Cell[], y0 = 1000): Phase {
  const samples: number[][] = []
  const shown: Shown[] = []
  const end = atBottom ? (opening ? y0 + D : y0 - D) : y0
  for (let i = 0; i < 112; i++) {
    const t = i * 0.008
    const k = i === 0 ? 0 : 1 - Math.exp(-t / 0.08)
    samples.push([t, i === 0 ? y0 : end, 4000 + (opening ? D : 0)])
    shown.push({ t, offset: y0, height: 600, cells: draw(k, i) })
  }
  return { opening, atBottom, before: [y0, 4000 + (opening ? 0 : D)], samples, shown }
}

/** The glide as it should look: the group's height on the spring, the rows under it with it (up) or still (bottom). */
function good(opening: boolean, atBottom: boolean): (k: number) => Cell[] {
  return (k) => {
    const grown = opening ? D * k : D * (1 - k)
    const lift = atBottom ? grown - (opening ? 0 : D) : 0
    const top = 200 - lift
    return [
      [8, top - 200, 100],
      [9, top - 100, 100],
      [GROUP, top, 40 + grown],
      [11, top + 40 + grown, 60],
      [12, top + 100 + grown, 60]
    ]
  }
}

const cycle = (atBottom: boolean, open = good(true, atBottom), fold = good(false, atBottom)): Phase[] =>
  [0, 1, 2].flatMap(() => [phase(true, atBottom, open), phase(false, atBottom, fold)])

function run(phases: Phase[], events: unknown[] = []): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'glide-check-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'glide.json'), JSON.stringify({ mode: 'bottom', group: 41, phases }))
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events))
  const out = spawnSync('python3', [check, join(dir, 'glide.json'), join(dir, 'events.json'), 'unfolded/bottom'], { encoding: 'utf8' })
  return { status: out.status, out: out.stdout + out.stderr }
}

describe('group_glide_check.py', () => {
  it('passes a glide at the bottom (the rows under the group still) and one up reading (the rows above still)', () => {
    expect(run(cycle(true)).status).toBe(0)
    expect(run(cycle(false)).status).toBe(0)
  })

  it('fails a cell that takes its new height in one frame and throws the rows under it', () => {
    const snap = (k: number, i: number): Cell[] => good(true, false)(i < 2 ? 0 : 1)
    const r = run(cycle(false, snap))
    expect(r.status).toBe(1)
    expect(r.out).toContain('in one frame: a jump, not a glide')
  })

  it('fails a reader up whose rows above the group moved, and a reader at the bottom whose rows under it moved', () => {
    const up = run(cycle(false, good(true, true), good(false, true)))
    expect(up.status).toBe(1)
    expect(up.out).toContain('the reader was up and rows above the group moved')
    const bottom = run(cycle(true, good(true, false), good(false, false)))
    expect(bottom.status).toBe(1)
    expect(bottom.out).toContain('the reader was at the bottom and rows under the group moved')
  })

  it('fails a row under the group drawn at its end while the group still folds (the table under it)', () => {
    const popped = (k: number): Cell[] => good(false, false)(k).map(([item, top, h]): Cell => (item === 11 ? [item, 240, h] : [item, top, h]))
    const r = run(cycle(false, good(true, false), popped))
    expect(r.status).toBe(1)
    expect(r.out).toContain('over the row under it')
  })

  it('fails a row that stops being drawn while it is still on screen (a leaving row with no still image)', () => {
    const gone = (k: number, i: number): Cell[] => good(true, false)(k).filter(([item]) => item !== 12 || i < 3)
    const r = run(cycle(false, gone))
    expect(r.status).toBe(1)
    expect(r.out).toContain('row 12 vanished')
  })

  it('fails a row that turns back, a tap that changed nothing, a missing tap, and a jumpUp in the events', () => {
    const bounce = (k: number, i: number): Cell[] => good(true, false)(i === 40 ? k - 0.3 : k)
    expect(run(cycle(false, bounce)).out).toContain('turned back')
    const still = run(cycle(false, () => good(true, false)(0), () => good(true, false)(0)).map((p) => ({ ...p, samples: p.samples.map(([t, y]) => [t, y, 4000]), before: [1000, 4000] })))
    expect(still.out).toContain('the content height never changed')
    expect(run(cycle(true).slice(1)).out).toContain('5 taps recorded')
    const jumped = run(cycle(true), [{ t: 1, key: 'jumpUp', from: null, to: '3200→2900 h 4100→4100 top 12' }])
    expect(jumped.status).toBe(1)
    expect(jumped.out).toContain('1 jumpUp events')
  })

  it("counts no jumpUp before the taps start: the reader-up run's own 700 pt scroll", () => {
    const scrolled = { t: 3000, key: 'jumpUp', from: null, to: '1938→1238 h 2326→2326 top -1' }
    const taps = { t: 3800, key: 'proof', from: 'scrolled-up', to: 'glide-taps' }
    expect(run(cycle(false), [scrolled, taps]).status).toBe(0)
    expect(run(cycle(false), [taps, { ...scrolled, t: 4200 }]).out).toContain('1 jumpUp events')
  })
})
