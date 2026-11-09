import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeAppPids, staleComputerProofPids, stopProofPids } from './computerProofProcesses'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

const bin = '/Users/me/temp-code/resources/native/tc-computer'
const probe = '/tmp/tc-computer-proof/TC Probe.app/Contents/MacOS/TC Probe'

describe('staleComputerProofPids', () => {
  it('finds every proof probe, including /private and preview copies, with no launch pid', () => {
    expect(staleComputerProofPids(`
      10 1 ${probe}
      11 1 /private${probe} --tick
      12 1 /private/var/folders/xx/yy/T/tc-preview-proof/TC Probe.app/Contents/MacOS/TC Probe --tick
      13 1 /tmp/tc-computer-bridge/TC Probe.app/Contents/MacOS/TC Probe
    `, 99)).toEqual([10, 11, 12, 13])
  })

  it('finds orphaned proof services and lock holders with the new marker or legacy gate environment', () => {
    expect(staleComputerProofPids(`
      20 1 ${bin} serve TEMP_CODE_COMPUTER_PROOF=1
      21 1 ${bin} hold-lock session 60000 TEMP_CODE_COMPUTER_PROOF=1
      22 1 ${bin} serve TC_PROOF_UNGATED=1
      23 1 ${bin} serve HOME=/private/var/folders/xx/yy/T/tc-computer-bridge-mac-abcd/mac-home
      24 1 ${bin} serve TEMP_CODE_USER_DATA=/tmp/tc-computer-bridge-mac-abcd/mac-data
    `, 99)).toEqual([20, 21, 22, 23, 24])
  })

  it('never matches installed TempCode, an unmarked service, a helper, or a shell mentioning a proof', () => {
    expect(staleComputerProofPids(`
      30 1 /Applications/TempCode.app/Contents/Resources/native/tc-computer serve TEMP_CODE_COMPUTER_PROOF=1 TC_PROOF_UNGATED=1
      31 1 /Applications/TempCode.app/Contents/MacOS/TempCode
      32 1 /Users/me/TempCode.app/Contents/resources/native/tc-computer serve TEMP_CODE_COMPUTER_PROOF=1
      33 1 ${bin} serve
      34 1 /tmp/tc-computer-proof/computer-proof-probe screen
      35 1 /bin/sh -c ${bin} serve TEMP_CODE_COMPUTER_PROOF=1
      36 1 /usr/bin/pgrep -f ${probe}
      37 1 /tmp/tc-computer-proof/TC Probe.app/Contents/MacOS/TC Probe-other
      38 1 ${bin} permissions TEMP_CODE_COMPUTER_PROOF=1
    `, 99)).toEqual([])
  })

  it('protects another live proof, but finds this runner’s descendants through an intermediate process', () => {
    expect(staleComputerProofPids(`
      40 1 bun scripts/e2e-computer-preview.ts
      41 40 ${bin} serve TEMP_CODE_COMPUTER_PROOF=1
      42 40 ${probe}
      99 1 bun scripts/e2e-tc-computer.ts
      44 99 /usr/bin/env helper
      45 44 ${bin} serve
      46 99 ${probe}
    `, 99)).toEqual([45, 46])
  })
})

it('finds all exact spellings for a launch whose pid was never recorded', () => {
  expect(probeAppPids(`
    10 ${probe}
    11 /private${probe} --tick
    12 /tmp/other/TC Probe.app/Contents/MacOS/TC Probe
    13 /usr/bin/pgrep -f ${probe}
    14 ${probe}-other
  `, [probe, `/private${probe}`])).toEqual([10, 11])
})

it('ends each pid once, without ever signalling init or the current runner', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) throw new Error('gone')
    return true
  })
  expect(stopProofPids([0, 1, process.pid, 120, 120])).toEqual([120])
  expect(kill.mock.calls).toEqual([[120, 'SIGTERM'], [120, 0], [120, 0]])
})

it('gives a stuck process a bounded TERM grace, then kills it', () => {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.mocked(execFileSync).mockImplementation(() => { now += 100; return Buffer.from('') })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  expect(stopProofPids([120])).toEqual([120])
  expect(now).toBe(1_000)
  expect(kill).toHaveBeenNthCalledWith(1, 120, 'SIGTERM')
  expect(kill).toHaveBeenLastCalledWith(120, 'SIGKILL')
})
