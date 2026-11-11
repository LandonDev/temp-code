import { describe, expect, it } from 'vitest'
import { etimeSeconds, otherProofIn } from './lib/proofOrder'

const bench = [
  '   80     1    05:10 bun run script:e2e-computer-bench -- --gate',
  '   90    80    05:10 /bin/sh -c esbuild scripts/e2e-computer-bench.ts --bundle && node scripts/.out/e2e-computer-bench.mjs --gate',
  '  100    90    05:09 node scripts/.out/e2e-computer-bench.mjs --gate',
  '  150     1    00:01 pgrep -f scripts/.out/e2e-computer.mjs',
  '  160     1 02:00:00 /usr/bin/vim notes.md'
]
const ps = (...more: string[]): string => [...bench, ...more].join('\n')

describe('otherProofIn', () => {
  it('finds an older proof, never this run, its own wrappers or a pgrep naming the pattern', () => {
    expect(otherProofIn(ps(), 100)).toBeNull()
    expect(otherProofIn(ps('  200     1    12:00 node scripts/.out/e2e-computer.mjs'), 100)).toBe('scripts/.out/e2e-computer.mjs')
    expect(otherProofIn(ps('  300     1 1-02:00:00 bash scripts/mac/ax-reader-proof.sh tempcode-dev'), 100)).toBe('ax-reader-proof')
    for (const p of ['e2e-computer-schedule', 'e2e-computer-preview', 'e2e-computer-ui'])
      expect(otherProofIn(ps(`  400     1    09:00 node scripts/.out/${p}.mjs`), 100)).toBe(p)
  })

  it('a younger proof waits for an older one, never both: each proof is judged by its wrapper', () => {
    // the comparison started 2 s after the bench, but its wrappers predate the bench's node runner
    const both = ps(
      '  600     1    05:08 bun run script:compare-computer-words',
      '  605   600    05:08 /bin/sh -c esbuild scripts/compare-computer-words.ts --bundle && node scripts/.out/compare-computer-words.mjs',
      '  610   605    05:05 node scripts/.out/compare-computer-words.mjs'
    )
    expect(otherProofIn(both, 100)).toBeNull()
    expect(otherProofIn(both, 610)).toBe('e2e-computer-bench')
    // started in the same second: the lower pid goes first
    const tie = ps('   70     1    05:10 bun run script:compare-computer-words', '   71    70    05:09 node scripts/.out/compare-computer-words.mjs')
    expect(otherProofIn(tie, 100)).toBe('compare-computer-words')
    expect(otherProofIn(tie, 71)).toBeNull()
  })

  it('reads ps elapsed times', () => {
    expect(etimeSeconds('05:09')).toBe(309)
    expect(etimeSeconds('02:00:00')).toBe(7200)
    expect(etimeSeconds('1-02:00:00')).toBe(93_600)
  })

  it('judges bun run → shell → proof-bun.ts → script by the package wrapper, including pid ties', () => {
    const launched = (wrapper: number, runner: number, age: string, runnerAge: string, name: string): string[] => [
      `${wrapper} 1 ${age} bun run script:${name} -- --gate`,
      `${wrapper + 1} ${wrapper} ${age} /bin/sh -c bun scripts/proof-bun.ts scripts/${name}.ts --gate`,
      `${wrapper + 2} ${wrapper + 1} ${age} bun scripts/proof-bun.ts scripts/${name}.ts --gate`,
      `${runner} ${wrapper + 2} ${runnerAge} /opt/homebrew/bin/bun scripts/${name}.ts --gate`
    ]
    const older = launched(80, 100, '05:10', '05:01', 'e2e-computer-bench')
    const younger = launched(200, 220, '05:08', '05:05', 'compare-computer-words')
    const both = [...older, ...younger].join('\n')
    // Its script started later, but the bench's package wrapper owns the older turn.
    for (const pid of [80, 81, 82, 100]) expect(otherProofIn(both, pid)).toBeNull()
    for (const pid of [200, 201, 202, 220]) expect(otherProofIn(both, pid)).toBe('e2e-computer-bench')

    const tied = [...older, ...launched(70, 220, '05:10', '05:00', 'compare-computer-words')].join('\n')
    expect(otherProofIn(tied, 100)).toBe('compare-computer-words')
    expect(otherProofIn(tied, 220)).toBeNull()
  })
})
