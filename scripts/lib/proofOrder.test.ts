import { describe, expect, it } from 'vitest'
import { COMPUTER_PROOFS, etimeSeconds, otherProofIn } from './proofOrder'

/** One `ps -Ao pid=,ppid=,etime=,command=` line. */
const row = (pid: number, ppid: number, etime: string, command: string): string => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${etime.padStart(11)} ${command}`

const bridge = (wrapper: number, runner: number, etime: string, half?: number): string[] => [
  row(wrapper, 1, etime, 'bun run script:e2e-computer-bridge -- --gate'),
  row(runner, wrapper, etime, '/opt/homebrew/bin/bun scripts/e2e-computer-bridge.ts --gate'),
  ...(half ? [row(half, runner, '00:05', '/opt/homebrew/bin/bun scripts/e2e-computer-bridge.ts --box-half --pair local')] : [])
]
const tcComputer = (wrapper: number, runner: number, etime: string): string[] => [
  row(wrapper, 1, etime, 'bun run script:e2e-tc-computer -- --gate'),
  row(runner, wrapper, etime, '/opt/homebrew/bin/bun scripts/e2e-tc-computer.ts --gate')
]

describe('proofOrder', () => {
  it('lists the bridge proof', () => {
    expect(COMPUTER_PROOFS).toContain('e2e-computer-bridge')
    expect(COMPUTER_PROOFS).toContain('e2e-person-guard')
  })

  it('reads ps elapsed times', () => {
    expect(etimeSeconds('05')).toBe(5)
    expect(etimeSeconds('01:05')).toBe(65)
    expect(etimeSeconds('02:01:05')).toBe(7265)
    expect(etimeSeconds('1-00:00:01')).toBe(86_401)
  })

  it('a newer bridge waits for an older e2e-tc-computer, and the older never waits on it', () => {
    const ps = [...tcComputer(100, 101, '03:00'), ...bridge(200, 201, '00:30')].join('\n')
    expect(otherProofIn(ps, 201)).toBe('e2e-tc-computer')
    expect(otherProofIn(ps, 101)).toBeNull()
  })

  it('a newer e2e-tc-computer waits for an older bridge, and the older never waits on it', () => {
    const ps = [...bridge(100, 101, '03:00', 102), ...tcComputer(200, 201, '00:30')].join('\n')
    expect(otherProofIn(ps, 201)).toBe('e2e-computer-bridge')
    expect(otherProofIn(ps, 101)).toBeNull()
    expect(otherProofIn(ps, 102)).toBeNull()
  })

  it("counts the local box half under its own bridge's wrapper, never as a second proof", () => {
    const ps = bridge(100, 101, '03:00', 102).join('\n')
    expect(otherProofIn(ps, 101)).toBeNull()
    expect(otherProofIn(ps, 102)).toBeNull()
  })

  it('breaks an age tie by pid', () => {
    const ps = [...tcComputer(100, 101, '01:00'), ...bridge(200, 201, '01:00')].join('\n')
    expect(otherProofIn(ps, 201)).toBe('e2e-tc-computer')
    expect(otherProofIn(ps, 101)).toBeNull()
  })

  it('never counts a pgrep or ps naming a proof', () => {
    const ps = [row(50, 1, '09:00', 'pgrep -f e2e-computer-bridge'), ...tcComputer(100, 101, '00:10')].join('\n')
    expect(otherProofIn(ps, 101)).toBeNull()
  })

  it('ignores a shell mentioning a finished proof when its only child is sleep', () => {
    const ps = [
      row(50, 1, '17:00', '/bin/bash -lc bun scripts/e2e-tc-computer.ts --gate; sleep 3600'),
      row(51, 50, '00:20', 'sleep 3600'),
      ...bridge(200, 201, '00:10')
    ].join('\n')
    expect(otherProofIn(ps, 201)).toBeNull()
  })

  it('still waits for an older actual runner under a shell, through an intermediate process', () => {
    const ps = [
      row(50, 1, '17:00', '/bin/bash -lc bun scripts/e2e-tc-computer.ts --gate; sleep 3600'),
      row(51, 50, '02:00', '/usr/bin/env helper'),
      row(52, 51, '02:00', 'bun scripts/e2e-tc-computer.ts --gate'),
      ...bridge(200, 201, '01:00')
    ].join('\n')
    expect(otherProofIn(ps, 201)).toBe('e2e-tc-computer')
    expect(otherProofIn(ps, 52)).toBeNull()
  })

  it('does not backdate a new runner to an old shell and let it jump ahead of a live proof', () => {
    const ps = [
      row(50, 1, '17:00', '/bin/bash -lc bun scripts/e2e-tc-computer.ts --gate; sleep 3600'),
      row(51, 50, '00:20', '/usr/bin/env helper'),
      row(52, 51, '00:20', 'bun scripts/e2e-tc-computer.ts --gate'),
      ...bridge(200, 201, '01:00')
    ].join('\n')
    expect(otherProofIn(ps, 201)).toBeNull()
    expect(otherProofIn(ps, 52)).toBe('e2e-computer-bridge')
  })

  it('still waits for a genuine benchmark after ignoring an old shell mention', () => {
    const ps = [
      row(50, 1, '17:00', '/bin/bash -c echo e2e-tc-computer; sleep 3600'),
      row(51, 50, '00:20', 'sleep 3600'),
      row(60, 1, '13:00', '/opt/homebrew/bin/bun --preload ./scripts/lib/electron-stub.ts scripts/e2e-computer-bench.ts --set field'),
      ...bridge(200, 201, '00:10')
    ].join('\n')
    expect(otherProofIn(ps, 201)).toBe('e2e-computer-bench')
  })

  it('still counts a shell running a proof script by path', () => {
    const ps = [row(50, 1, '01:00', '/bin/sh scripts/mac/input-proof.sh --active'), ...bridge(200, 201, '00:10')].join('\n')
    expect(otherProofIn(ps, 201)).toBe('input-proof')
  })

  it('lets the next proof sweep orphaned scratch processes instead of waiting forever behind them', () => {
    const leftovers = [
      row(50, 1, '01:30:00', '/private/tmp/tc-computer-proof/TC Probe.app/Contents/MacOS/TC Probe'),
      row(51, 1, '01:30:00', '/tmp/tc-computer-proof/computer-proof-probe screen')
    ]
    expect(otherProofIn([...leftovers, ...bridge(200, 201, '00:10')].join('\n'), 201)).toBeNull()
    // An older live runner still keeps its turn, even while it owns a scratch child.
    expect(otherProofIn([...leftovers, ...tcComputer(100, 101, '01:00'), ...bridge(200, 201, '00:10')].join('\n'), 201)).toBe('e2e-tc-computer')
  })
})
