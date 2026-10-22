import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { failedGateStep, gateLine, typecheckErrorCount } from '@shared/gate'
import { gateCommand, gateEnv, parseGateStub, runGateStep, tailOf } from './gateRun'

describe('gateRun', () => {
  it('names each step\'s command', () => {
    expect(gateCommand({ step: 'typecheck' })).toEqual(['run', 'typecheck'])
    expect(gateCommand({ step: 'gate', since: 'abc' })).toEqual(['scripts/gate.ts', '--tier', 'commit', '--since', 'abc'])
    expect(gateCommand({ step: 'release', notes: 'n', push: true })).toEqual(['scripts/release.ts', 'n', '--push'])
    expect(gateCommand({ step: 'release', notes: 'n' })).toEqual(['scripts/release.ts', 'n'])
    expect(gateCommand({ step: 'release', notes: 'n' })).toEqual(['scripts/release.ts', 'n'])
  })

  it('a stub rule decides the run by step and branch, lines reach the listener, nothing spawns', async () => {
    const stub = JSON.stringify([
      { step: 'typecheck', branch: 'b', ok: false, log: 'src/a.ts(1,1): error TS2322: no\nFound 1 error.' },
      { step: 'gate', ok: true, log: '✓ typecheck 1s\n✓ vitest 2s\n✓ build 3s' }
    ])
    const lines: string[] = []
    const red = await runGateStep({ cwd: '/nowhere', step: 'typecheck', branch: 'b', stub, onLine: (l) => lines.push(l) })
    expect(red.ok).toBe(false)
    expect(red.log).toContain('error TS2322')
    expect(lines).toHaveLength(2)
    const green = await runGateStep({ cwd: '/nowhere', step: 'typecheck', branch: 'a', stub })
    expect(green.ok).toBe(true)
    const gate = await runGateStep({ cwd: '/nowhere', step: 'gate', branch: 'master', stub })
    expect(gate.ok).toBe(true)
    expect(gate.log.split('\n').at(-1)).toBe('✓ build 3s')
  })

  it("the child's env drops the hook's GIT_* and puts bun's directory ahead of a PATH without it", () => {
    const home = mkdtempSync(join(tmpdir(), 'tc-gate-env-'))
    const bin = join(home, '.bun', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\n')
    chmodSync(join(bin, 'bun'), 0o755)
    const env = gateEnv({ HOME: home, PATH: '/usr/bin', GIT_DIR: '/x/.git', GIT_INDEX_FILE: '/x/index', KEEP: '1' })
    expect(env.PATH).toBe(`${bin}:/usr/bin`)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.KEEP).toBe('1')
    // Already on the PATH: left where it is.
    expect(gateEnv({ HOME: home, PATH: `/usr/bin:${bin}` }).PATH).toBe(`/usr/bin:${bin}`)
  })

  it('a bad stub is ignored', () => {
    expect(parseGateStub('nope')).toBeNull()
    expect(parseGateStub(null)).toBeNull()
    expect(parseGateStub('[{"step":"gate","ok":true},{"x":1}]')).toEqual([{ step: 'gate', ok: true }])
  })

  it('keeps the tail', () => {
    expect(tailOf('a\n\nb\nc', 2)).toBe('b\nc')
  })
})

describe('gate lines', () => {
  it('counts typecheck errors and names the failed gate step', () => {
    expect(typecheckErrorCount('x\nFound 3 errors in 2 files.')).toBe(3)
    expect(typecheckErrorCount('a.ts(1,1): error TS1 x\nb.ts(2,2): error TS2 y')).toBe(2)
    expect(typecheckErrorCount('clean')).toBe(0)
    expect(failedGateStep('✓ typecheck 2s passed\n✗ vitest 40s failed')).toBe('vitest')
    expect(failedGateStep('✓ typecheck 2s')).toBeNull()
  })
  it('reads as one line', () => {
    expect(gateLine({ step: 'typecheck', branch: 'b', ok: false, log: 'Found 3 errors.', at: 1 })).toBe('Typecheck failed on b · 3 errors')
    expect(gateLine({ step: 'typecheck', branch: 'b', ok: true, log: '', at: 1 })).toBe('Typecheck passed on b')
    expect(gateLine({ step: 'gate', branch: 'master', ok: false, log: '✗ vitest 1s failed', at: 1 })).toBe('Gate failed on master · at vitest')
    expect(gateLine({ step: 'release', branch: 'master', ok: false, log: '', at: 1 })).toBe('Release failed on master')
  })
})
