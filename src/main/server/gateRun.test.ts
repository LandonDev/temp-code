import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { failedGateStep, gateFailureDetail, gateLine, gateReason, isErrorLine, typecheckErrorCount } from '@shared/gate'
import { gateCommand, gateEnv, nodeBinary, parseGateStub, runGateStep, tailOf } from './gateRun'

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
    // bun first, then node's directory when the PATH has none (the installed
    // app's PATH); a node already under /usr/bin (the box) is left where it is.
    const node = nodeBinary({ PATH: '/usr/bin' })
    const nodeDir = node ? dirname(node) : ''
    expect(env.PATH).toBe(nodeDir && nodeDir !== '/usr/bin' ? `${bin}:${nodeDir}:/usr/bin` : `${bin}:/usr/bin`)
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.KEEP).toBe('1')
    // Already on the PATH: left where it is.
    const already = ['/usr/bin', nodeDir, bin].filter(Boolean).join(':')
    expect(gateEnv({ HOME: home, PATH: already }).PATH).toBe(already)
  })

  it('keeps the first error line past the tail, from a stub and from a child', async () => {
    const early = 'src/early.ts(1,1): error TS2322: early'
    const log = [early, ...Array.from({ length: 300 }, (_, i) => `line ${i}`)].join('\n')
    const stub = JSON.stringify([{ step: 'typecheck', ok: false, log }])
    const red = await runGateStep({ cwd: '/nowhere', step: 'typecheck', branch: 'b', stub })
    expect(red.log).not.toContain(early)
    expect(red.firstError).toBe(early)
    // A child that prints the same: the runner keeps the line while it streams.
    const home = mkdtempSync(join(tmpdir(), 'tc-gate-first-'))
    const bin = join(home, '.bun', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho '${early}'\ni=0\nwhile [ $i -lt 300 ]; do echo "line $i"; i=$((i+1)); done\nexit 1\n`)
    chmodSync(join(bin, 'bun'), 0o755)
    const child = await runGateStep({ cwd: home, step: 'typecheck', branch: 'b', env: { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') } })
    expect(child.ok).toBe(false)
    expect(child.log).not.toContain(early)
    expect(child.firstError).toBe(early)
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
  it('says why a gate failed: the step, else the last line of the log', () => {
    expect(gateReason('✓ typecheck 2s passed\n✗ vitest 40s failed\n')).toBe('at vitest')
    expect(gateReason('$ bun scripts/gate.ts\nerror: Module not found "scripts/gate.ts"\n\n')).toBe('error: Module not found "scripts/gate.ts"')
    expect(gateReason('\x1b[31m  fatal: not a git repository  \x1b[0m')).toBe('fatal: not a git repository')
    expect(gateReason('  \n')).toBeNull()
  })
  it('gateFailureDetail: the failing step and its first error line, by precedence, never a duration', () => {
    const gateLog = [
      'gate: commit tier, 3 steps: typecheck, vitest, build',
      '✓ typecheck 12s passed',
      '✗ vitest 40s failed',
      '--- vitest (last lines) ---',
      ' ❯ src/x.test.ts (3 tests | 1 failed) 40ms',
      ' FAIL  src/x.test.ts > suite > name',
      'AssertionError: expected 1 to be 2',
      '--- end vitest ---',
      'gate failed: vitest in 1m 12s'
    ].join('\n')
    // The step's printed tail wins over the runner's first error line.
    expect(gateFailureDetail('gate', gateLog, 'src/early.ts(1,1): error TS1 early')).toBe('vitest: FAIL  src/x.test.ts > suite > name')
    // No printed tail: the log's first error line; the gate's own ✗ line is never it.
    expect(gateFailureDetail('gate', '✗ vitest 40s failed\nFAIL x.test.ts', null)).toBe('vitest: FAIL x.test.ts')
    // The step from the final line, the error from the runner.
    expect(gateFailureDetail('gate', 'gate failed: build in 2m', 'error: Module not found "x"')).toBe('build: error: Module not found "x"')
    // Nothing named: the kind and the last line.
    expect(gateFailureDetail('gate', 'something odd\n', null)).toBe('gate: something odd')
    expect(gateFailureDetail('typecheck', 'x\nFound 2 errors.', 'src/a.ts(1,1): error TS2322: no')).toBe('typecheck: src/a.ts(1,1): error TS2322: no')
    expect(gateFailureDetail('release', '\x1b[31mfatal: not a git repository\x1b[0m', null)).toBe('release: fatal: not a git repository')
    expect(gateFailureDetail('release', '', null)).toBe('release failed')
    const long = gateFailureDetail('typecheck', '', 'e'.repeat(400))
    expect(long.length).toBe('typecheck: '.length + 160)
    expect(long.endsWith('…')).toBe(true)
    expect(isErrorLine('✗ vitest 40s failed')).toBe(false)
    expect(isErrorLine('AssertionError: x')).toBe(true)
    expect(isErrorLine('  × suite > name 12ms')).toBe(true)
    expect(isErrorLine('✓ typecheck 2s passed')).toBe(false)
  })
  it('reads as one line', () => {
    expect(gateLine({ step: 'typecheck', branch: 'b', ok: false, log: 'Found 3 errors.', at: 1 })).toBe('Typecheck failed on b · 3 errors')
    expect(gateLine({ step: 'typecheck', branch: 'b', ok: true, log: '', at: 1 })).toBe('Typecheck passed on b')
    expect(gateLine({ step: 'gate', branch: 'master', ok: false, log: '✗ vitest 1s failed', at: 1 })).toBe('Gate failed on master · at vitest')
    expect(gateLine({ step: 'release', branch: 'master', ok: false, log: '', at: 1 })).toBe('Release failed on master')
  })
})
