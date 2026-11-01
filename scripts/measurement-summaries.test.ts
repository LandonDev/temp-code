import { describe, expect, it } from 'vitest'
import { profileSummary, type CpuProfile } from './profile-summary'
import { sendsSummary, stallsSummary } from './stalls-summary'

describe('profile summary', () => {
  it('weights samples by their deltas, merges matching frames, and sums descendants', () => {
    const frame = (functionName: string, url = '', lineNumber = -1) => ({ functionName, url, lineNumber })
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2, 4, 5, 6, 7] },
        { id: 2, callFrame: frame('parent', 'app.ts', 9), children: [3] },
        { id: 3, callFrame: frame('child', 'app.ts', 19) },
        { id: 4, callFrame: frame('child', 'app.ts', 19) },
        { id: 5, callFrame: frame('(idle)') },
        { id: 6, callFrame: frame('(program)') },
        { id: 7, callFrame: frame('(garbage collector)') }
      ],
      samples: [2, 3, 4, 5, 6, 7], timeDeltas: [1000, 2000, 3000, 1000, 1000, 2000]
    }
    const output = profileSummary(profile)
    const [self, total] = output.split('Top 15 by total time (self + descendants)')
    expect(output).toContain('Sampled time: 10.00 ms (6 samples)')
    expect(self).toMatch(/child\s+app.ts:20\s+5.00\s+50.00%/)
    expect(self).toMatch(/parent\s+app.ts:10\s+1.00\s+10.00%/)
    expect(total).toMatch(/parent\s+app.ts:10\s+3.00\s+30.00%/)
    expect(total).toMatch(/\(root\)\s+\(native\):0\s+10.00\s+100.00%/)
    expect(output).toContain('(idle): 1.00 ms (10.00%)')
    expect(output).toContain('(program): 1.00 ms (10.00%)')
    expect(output).toContain('(garbage collector): 2.00 ms (20.00%)')
  })

  it('handles an empty profile', () => {
    expect(profileSummary({ nodes: [], samples: [], timeDeltas: [] })).toContain('(idle): 0.00 ms (0.00%)')
  })
})

describe('stalls summary', () => {
  it('parses loop samples, counts, nearest-rank percentiles, and labels', () => {
    const output = stallsSummary([
      '2026-10-22T07:30:00.000Z loop max=312ms mean=75ms inflight=git.status:1200ms,session.events:30ms pushes=meta:1200,event:40 running=33 load=4.1 rss=1200MB wsbuf=0KB',
      '2026-10-22T07:30:01.000Z loop max=150ms mean=25ms inflight=- pushes=meta:1000,event:2040 running=1 load=1.0 rss=400MB',
      '2026-10-22T07:30:02.000Z slow-request git.status 100ms inflight=-',
      '2026-10-22T07:30:03.000Z slow-request git.status 300ms inflight=-',
      '2026-10-22T07:30:04.000Z slow-request session.events 200ms inflight=-',
      '2026-10-22T07:30:05.000Z timed mirrorSession 70ms inflight=-',
      '2026-10-22T07:30:06.000Z timed mirrorSession 90ms inflight=-',
      '2026-10-22T07:30:07.000Z [renderer] timed ignored 120ms',
      'unrelated line'
    ].join('\n'))
    expect(output).toMatch(/2\s+50.00\s+312/)
    expect(output).toMatch(/git.status\s+2\s+100\s+300\s+300/)
    expect(output).toMatch(/session.events\s+1\s+200\s+200\s+200/)
    expect(output.indexOf('git.status')).toBeLessThan(output.indexOf('session.events'))
    expect(output).toMatch(/meta\s+1100.00\s+1\s+1200/)
    expect(output).toMatch(/event\s+1040.00\s+1\s+2040/)
    expect(output).toMatch(/max\s+p90\n2\s+2/)
    expect(output).toMatch(/mirrorSession\s+2/)
    expect(output).not.toContain('ignored')
  })

  it('handles an empty log', () => {
    const output = stallsSummary('')
    expect(output).toMatch(/0\s+0.00\s+0/)
    expect(output).not.toMatch(/NaN|Infinity/)
  })
})

describe('send spans summary (--sends)', () => {
  it('gaps per handle kind, the warm share, and the cache miss rate after a 5 to 60 minute gap', () => {
    const output = sendsSummary([
      '2026-11-01T10:00:00.000Z send session=a accepted=0 prepared=5 handle=20(cold) delivered=25 init=1400 first-message=1400 model=3000(miss 88k) first-content=4000 inflight=- running=3',
      '2026-11-01T10:00:30.000Z send session=b accepted=0 prepared=5 handle=10(warm) delivered=40 init=100 first-message=100 model=900(hit) first-content=1600',
      '2026-11-01T10:20:00.000Z send session=a accepted=0 prepared=2 handle=3(live) delivered=4 init=- first-message=300 model=500(hit) first-content=800',
      '2026-11-01T10:50:00.000Z send session=b accepted=0 prepared=2 handle=3(live) delivered=4 init=- first-message=300 model=2000(miss 120k) first-content=2600',
      '2026-11-01T10:51:00.000Z send session=c accepted=0 prepared=2 handle=- delivered=- init=- first-message=- model=- first-content=-',
      'unrelated line'
    ].join('\n'))
    const lines = output.split('\n')
    // Kinds in order live, warm, cold, then the rest.
    expect(lines.findIndex((l) => l.startsWith('live'))).toBeLessThan(lines.findIndex((l) => l.startsWith('warm')))
    expect(lines.find((l) => l.startsWith('cold'))).toMatch(/^cold\s+1\s+20\s+20\s+5\s+5\s+1375\s+1375\s+1600\s+1600\s+1000\s+1000\s+4000\s+4000$/)
    // A live send has no init: the model gap runs from delivered.
    expect(lines.find((l) => l.startsWith('live'))).toMatch(/^live\s+2\s+3\s+3\s+1\s+1\s+-\s+-\s+496\s+1996/)
    expect(lines.find((l) => l.startsWith('none'))).toMatch(/^none\s+1(\s+-)+$/)
    expect(output).toMatch(/warm\s+cold\s+warm share\n1\s+1\s+50%/)
    // Four model notes, two misses; two sends after a 5-60 minute gap, one a miss.
    expect(output).toMatch(/4\s+50%\s+2\s+50%/)
  })
})
