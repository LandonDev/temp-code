// The performance proof's checker (scripts/lib/ios_perf_check.py, run by
// scripts/ios-sim-proof.sh `perf_set`) on hand-made reports in the shape the
// app writes (ios/TempCode/Sources/Perf/PerfRun.swift `PerfReport`).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const check = resolve(__dirname, 'lib', 'ios_perf_check.py')
const shipped = JSON.parse(readFileSync(resolve(__dirname, 'lib', 'ios_perf_gates.json'), 'utf8')) as Record<string, boolean>
const GATES = ['scroll-cpu', 'batch-turn', 'scale', 'keystroke', 'rest', 'load-only', 'bodies-per-batch', 'refolds', 'rows-built', 'keystroke-bodies', 'jumps', 'jump-up', 'late-frames']
const RUNS = ['scale-short', 'scale-build', 'follow', 'scroll-idle', 'scroll-busy', 'type-idle', 'type-busy', 'rest', 'master']
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Report = Record<string, unknown>
const dist = (p95: number, worst = p95 * 2): Report => ({ count: 1000, p50: p95 / 2, p95, p99: p95 * 1.2, worst, mean: p95 / 2 })
const quietBodies = { projectShellBody: 0, threadScreenBody: 0, transcriptBody: 0, bottomDockBody: 0, composerBarBody: 0, transcriptRowBody: 0, composerRowBody: 0 }

/** A pass that meets every target. */
function good(): Record<string, Report> {
  const base = (run: string): Report => ({
    run,
    sessionId: 'ios-perf-build',
    seconds: 20,
    frames: dist(16.7, 20),
    late: 2,
    hitchMsPerS: 1,
    cpuMs: dist(4, 9),
    cpuMsPerS: 6,
    batchCpuMs: dist(1.2),
    batchRows: dist(12),
    keyCpuMs: dist(2, 5),
    counters: { refolds: 2, offsetWritesMoving: 0 },
    jumps: [],
    jumpCount: [1, 0],
    worstJumpPt: 4,
    travelPt: [30_000, 30_000],
    jumpUps: 0,
    liveTurnRows: 40,
    keys: 140,
    wraps: 3,
    keyboardHeight: 336
  })
  const reports: Record<string, Report> = {}
  for (const run of RUNS) reports[run] = base(run)
  reports.follow = { ...reports.follow, loadOnly: { ...quietBodies }, loadOnlySeconds: 4, stream: { transcriptBody: 900, batches: 1000 }, streamSeconds: 20 }
  reports['type-idle'] = { ...reports['type-idle'], typing: { ...quietBodies, composerBarBody: 1 } }
  return reports
}

function write(reports: Record<string, Report>, load = '{ 4.00 5.00 6.00 }'): string {
  const dir = mkdtempSync(join(tmpdir(), 'perf-check-'))
  dirs.push(dir)
  for (const [run, report] of Object.entries(reports)) {
    writeFileSync(join(dir, `${run}.json`), JSON.stringify(report))
    writeFileSync(join(dir, `${run}.load.txt`), load)
  }
  return dir
}

function gatesFile(on: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'perf-gates-'))
  dirs.push(dir)
  const path = join(dir, 'gates.json')
  writeFileSync(path, JSON.stringify(Object.fromEntries(GATES.map((g) => [g, on.includes(g)]))))
  return path
}

function run(passes: Record<string, Report>[], on: string[] = GATES, baseline: Record<string, Report>[] = [], load?: string): { status: number | null; out: string } {
  const args = [check, '--gates', gatesFile(on), '--cores', '16', ...passes.map((p) => write(p, load))]
  if (baseline.length) args.push('--baseline', ...baseline.map((p) => write(p)))
  const out = spawnSync('python3', args, { encoding: 'utf8' })
  return { status: out.status, out: out.stdout + out.stderr }
}

/** The baseline app's passes: the same shape with ten times the late frames. */
const slow = (): Record<string, Report> => Object.fromEntries(Object.entries(good()).map(([k, r]) => [k, { ...r, late: 20 }]))
const change = (run: string, patch: Report): Record<string, Report> => {
  const reports = good()
  reports[run] = { ...reports[run], ...patch }
  return reports
}

describe('ios_perf_check.py', () => {
  it('passes three passes that meet every target, with the baseline beside them', () => {
    const r = run([good(), good(), good()], GATES, [slow(), slow(), slow()])
    expect(r.out).toContain('ios-perf-check: PASS (13 gates on)')
    expect(r.status).toBe(0)
  })

  it('reads a CPU target from the best pass: one loaded pass fails nothing', () => {
    const loaded = change('scroll-idle', { cpuMs: dist(14, 40) })
    expect(run([good(), loaded, good()], ['scroll-cpu']).status).toBe(0)
    const r = run([loaded, loaded, loaded], ['scroll-cpu'])
    expect(r.status).toBe(5)
    expect(r.out).toContain('scroll-idle: main-thread CPU per interval p95 14')
  })

  it('holds a count in every pass: one bad pass fails', () => {
    const refolded = change('type-busy', { counters: { refolds: 40, offsetWritesMoving: 0 } })
    const r = run([good(), refolded, good()], ['refolds'])
    expect(r.status).toBe(5)
    expect(r.out).toContain('40 whole refolds')
  })

  it.each([
    ['batch-turn', 'follow', { batchCpuMs: dist(6) }, 'an applied batch costs p95 6'],
    ['scale', 'scale-build', { batchCpuMs: dist(9) }, '12,000 rows cost 7.5 times 600 rows'],
    ['keystroke', 'type-busy', { keyCpuMs: dist(5, 30) }, 'a keystroke costs p95 5'],
    ['keystroke', 'type-idle', { keys: 12 }, '12 of 140 keys went in'],
    ['rest', 'rest', { cpuMsPerS: 48 }, '48 ms of main-thread CPU per second'],
    ['load-only', 'follow', { loadOnly: { ...quietBodies, projectShellBody: 41 } }, 'projectShellBody ran 41 times'],
    ['bodies-per-batch', 'follow', { stream: { transcriptBody: 3000, batches: 1000 } }, 'the transcript ran 3000 times for 1000 batches'],
    ['rows-built', 'scale-build', { batchRows: dist(9000) }, '9000 rows built per batch at p95, the live turn holds 40'],
    ['keystroke-bodies', 'type-idle', { typing: { ...quietBodies, composerBarBody: 140 } }, 'the composer bar ran 140 times'],
    ['keystroke-bodies', 'type-idle', { typing: { ...quietBodies, transcriptBody: 3 } }, 'transcriptBody ran 3 times'],
    ['jumps', 'scroll-idle', { jumpCount: [1, 2] }, '2 rows jumped on the warm pass'],
    ['jumps', 'scroll-busy', { jumpCount: [9, 0] }, '9 rows jumped in 30000 pt of the cold pass'],
    ['jumps', 'scroll-idle', { worstJumpPt: 120 }, 'a row jumped 120 pt'],
    ['jumps', 'scroll-idle', { travelPt: [0, 0] }, 'nothing was scrolled'],
    ['jump-up', 'follow', { jumpUps: 1 }, 'follow: 1 jumpUp'],
    ['jump-up', 'scroll-busy', { counters: { refolds: 0, offsetWritesMoving: 3 } }, 'wrote the offset 3 times while the reader moved']
  ] as const)('%s fails when %s misses its target', (gate, name, patch, words) => {
    const bad = change(name, patch as Report)
    const r = run([bad, bad, bad], [gate])
    expect(r.out).toContain(words)
    expect(r.status).toBe(5)
    // The same reports with the gate off are a report, never a failure.
    const off = run([bad, bad, bad], [])
    expect(off.status).toBe(0)
    expect(off.out).toMatch(new RegExp(`${gate}\\s+off miss`))
  })

  it('holds late frames to half the baseline, and hitch time only under a quiet Mac', () => {
    expect(run([good(), good(), good()], ['late-frames']).out).toContain('no baseline passes were given')
    const late = change('scroll-idle', { late: 15 })
    const r = run([late, late, late], ['late-frames'], [slow(), slow(), slow()])
    expect(r.status).toBe(5)
    expect(r.out).toContain("scroll-idle: 45 late frames against the baseline's 60")
    const hitching = change('follow', { hitchMsPerS: 30 })
    expect(run([hitching, hitching, hitching], ['late-frames'], [slow(), slow(), slow()]).out).toContain('30 ms of hitch per second at a load of 4.0')
    // The same hitches under a load above the core count judge nothing.
    expect(run([hitching, hitching, hitching], ['late-frames'], [slow(), slow(), slow()], '{ 48.00 50.00 60.00 }').status).toBe(0)
  })

  it('fails a gate that is on when its run measured nothing', () => {
    const none = good()
    delete none['scroll-busy']
    const r = run([none, good(), good()], ['scroll-cpu'])
    expect(r.status).toBe(5)
    expect(r.out).toContain('scroll-busy: 2 of 3 passes measured')
    const noted = change('rest', { note: 'the transcript did not load' })
    expect(run([noted, noted, noted], ['rest']).out).toContain('rest: 0 of 3 passes measured')
    const still = change('master', { cpuMs: { count: 0, p50: 0, p95: 0, p99: 0, worst: 0, mean: 0 } })
    expect(run([still, still, still], ['scroll-cpu']).out).toContain('master: no interval was recorded')
  })

  it('prints one line a run and pass for the findings file', () => {
    const r = run([good(), good()], [])
    expect(r.out.split('\n').filter((l) => l.startsWith('ios-perf: scroll-idle')).length).toBe(2)
  })
})

describe('ios_perf_gates.json', () => {
  it('names every gate the checker judges, and nothing else', () => {
    expect(Object.keys(shipped).sort()).toEqual([...GATES].sort())
    const source = readFileSync(check, 'utf8')
    for (const gate of GATES) expect(source, gate).toContain(`self.gate('${gate}'`)
  })
})
