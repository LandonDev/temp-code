import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STEPS, TIER_PATHS, formatReport, gateDir, matchPath, parseArgs, readStoredHash, runSteps, selectSteps, shouldSkipTypecheck, storeHash, tiersForPaths, typecheckHash, type Step, macOnlySkips, judgeReport, spawnStep, stepArgs } from './gate'

describe('the step list', () => {
  it('has unique names, a tier and a lane on every step, and the hook-facing steps in the commit tier', () => {
    const names = STEPS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const s of STEPS) {
      expect(['commit', 'publish']).toContain(s.tier)
      expect(s.lane).toBeTruthy()
    }
    const commit = STEPS.filter((s) => s.tier === 'commit').map((s) => s.name)
    expect(commit).toEqual(expect.arrayContaining(['typecheck', 'vitest', 'build', 'bundle-size']))
    // The bundle-size check reads out/, so it follows the build in the build lane.
    const build = STEPS.find((s) => s.name === 'build')!
    const size = STEPS.find((s) => s.name === 'bundle-size')!
    expect(size.lane).toBe(build.lane)
    expect(STEPS.indexOf(size)).toBeGreaterThan(STEPS.indexOf(build))
    const publish = STEPS.filter((s) => s.tier === 'publish').map((s) => s.name)
    expect(publish).toEqual(expect.arrayContaining(['e2e-remote-fence', 'hub', 'ios', 'ios-client']))
    expect(STEPS.filter((s) => s.hashSkip).map((s) => s.name)).toEqual(['typecheck'])
  })

  it('selects by tier, honours --only and --skip, and refuses an unknown name', () => {
    expect(selectSteps({ tiers: new Set(['commit']) }).map((s) => s.name)).toEqual(['typecheck', 'vitest', 'build', 'bundle-size'])
    expect(selectSteps({ tiers: new Set(['commit', 'publish']) }).length).toBe(STEPS.length)
    expect(selectSteps({ tiers: new Set(['commit']), only: ['vitest'] }).map((s) => s.name)).toEqual(['vitest'])
    expect(selectSteps({ tiers: new Set(['commit']), skip: ['vitest'] }).map((s) => s.name)).toEqual(['typecheck', 'build', 'bundle-size'])
    expect(() => selectSteps({ tiers: new Set(['commit']), only: ['nope'] })).toThrow(/no gate step named nope/)
  })

  it('parses the CLI', () => {
    expect(parseArgs([])).toMatchObject({ tiers: new Set(['commit']), full: false, verbose: false })
    expect(parseArgs(['--tier', 'all', '--since', 'release-3', '--full', '-v', '--skip', 'vitest,build'])).toMatchObject({
      tiers: new Set(['commit', 'publish']),
      since: 'release-3',
      full: true,
      verbose: true,
      skip: ['vitest', 'build']
    })
    expect(parseArgs(['--tier=publish']).tiers).toEqual(new Set(['publish']))
    expect(() => parseArgs(['--tier', 'weekly'])).toThrow(/--tier must be/)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/)
  })
})

describe('the Mac-only steps', () => {
  it('skips hub, ios and ios-client off macOS with a note, and nothing on it', () => {
    expect([...macOnlySkips(STEPS, 'linux').keys()]).toEqual(['hub', 'ios', 'ios-client'])
    expect(macOnlySkips(STEPS, 'linux').get('ios')).toBe('needs the Mac; release:publish runs it there')
    expect(macOnlySkips(STEPS, 'darwin').size).toBe(0)
    expect(STEPS.filter((s) => s.mac).every((s) => s.tier === 'publish')).toBe(true)
  })
})

describe('tier selection by path', () => {
  it('matches globs across segments and within one', () => {
    expect(matchPath('ios/**', 'ios/TempCode/Sources/A.swift')).toBe(true)
    expect(matchPath('ios/**', 'ios/Package.swift')).toBe(true)
    expect(matchPath('ios/**', 'bios/x')).toBe(false)
    expect(matchPath('src/shared/contract*.ts', 'src/shared/contract-crosshost.ts')).toBe(true)
    expect(matchPath('src/shared/contract*.ts', 'src/shared/contracts/a.ts')).toBe(false)
    expect(matchPath('**/*.json', 'package.json')).toBe(true)
    expect(matchPath('**/*.json', 'a/b/c.json')).toBe(true)
    expect(matchPath('**/*.json', 'a/b/c.jsonl')).toBe(false)
  })

  it('pulls the publish tier in for the paths it guards and nothing else', () => {
    const guarded = [
      'ios/TempCodeContract/Sources/TempCodeContract/Generated/Wire.swift',
      'scripts/gen-swift-contract.ts',
      'src/shared/wireSchemas.ts',
      'src/main/server/remote/fence.ts',
      'infra/hub/src/index.ts'
    ]
    for (const path of guarded) {
      expect(tiersForPaths([path]).get('publish'), path).toEqual([path])
    }
    for (const path of ['src/main/index.ts', 'src/renderer/src/App.tsx', 'docs/box.md', 'package.json', 'scripts/release.ts']) {
      expect(tiersForPaths([path]).size, path).toBe(0)
    }
    const mixed = tiersForPaths(['CLAUDE.md', 'ios/a.swift', 'infra/hub/wrangler.toml'])
    expect(mixed.get('publish')).toEqual(['ios/a.swift', 'infra/hub/wrangler.toml'])
  })

  it('every rule names a tier the steps have', () => {
    const tiers = new Set(STEPS.map((s) => s.tier))
    for (const r of TIER_PATHS) expect(tiers.has(r.tier), r.pattern).toBe(true)
  })
})

describe('the typecheck hash skip', () => {
  it('skips only when not forced and the stored hash equals the tree hash', () => {
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: 'a' })).toBe(true)
    expect(shouldSkipTypecheck({ full: true, hash: 'a', stored: 'a' })).toBe(false)
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: 'b' })).toBe(false)
    expect(shouldSkipTypecheck({ full: false, hash: 'a', stored: undefined })).toBe(false)
  })

  it('changes with a committed, a modified, an untracked and a deleted .ts or .json file, and not with a .md', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x' } })
    try {
      git('init', '-q')
      mkdirSync(join(repo, 'src'))
      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, 'tsconfig.json'), '{}\n')
      writeFileSync(join(repo, 'README.md'), 'hi\n')
      git('add', '.')
      git('commit', '-qm', 'one')
      const clean = typecheckHash(repo)
      expect(typecheckHash(repo)).toBe(clean)

      writeFileSync(join(repo, 'README.md'), 'changed\n')
      expect(typecheckHash(repo)).toBe(clean)

      writeFileSync(join(repo, 'src/a.ts'), 'export const a = 2\n')
      const modified = typecheckHash(repo)
      expect(modified).not.toBe(clean)
      git('add', '.')
      git('commit', '-qm', 'two')
      expect(typecheckHash(repo)).toBe(modified)

      writeFileSync(join(repo, 'src/b.tsx'), 'export const b = 1\n')
      const untracked = typecheckHash(repo)
      expect(untracked).not.toBe(modified)
      rmSync(join(repo, 'src/b.tsx'))
      expect(typecheckHash(repo)).toBe(modified)

      rmSync(join(repo, 'tsconfig.json'))
      expect(typecheckHash(repo)).not.toBe(modified)

      const dir = gateDir(repo)
      expect(dir).toBe(join(repo, '.git', 'temp-code-gate'))
      expect(readStoredHash(dir)).toBeUndefined()
      storeHash(dir, modified)
      expect(readStoredHash(dir)).toBe(modified)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('the parallel runner', () => {
  const step = (name: string, lane: string, tier: 'commit' | 'publish' = 'commit'): Step => ({
    name,
    tier,
    lane,
    cmd: 'true',
    args: [],
    why: name
  })

  it('runs lanes at once and a lane in order', async () => {
    const steps = [step('a1', 'a'), step('a2', 'a'), step('b1', 'b')]
    const started: string[] = []
    const order: string[] = []
    let release!: () => void
    const gateA1 = new Promise<void>((r) => (release = r))
    const report = await runSteps(steps, async (s) => {
      started.push(s.name)
      if (s.name === 'a1') await gateA1
      order.push(s.name)
      // b1 finishing lets a1 go: a1 can only finish after b1 if the lanes ran at once.
      if (s.name === 'b1') release()
      return { exitCode: 0, tail: '' }
    })
    // b1 ran while a1 waited; a2 waited for a1.
    expect(started.slice(0, 2).sort()).toEqual(['a1', 'b1'])
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'))
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1'))
    expect(report.ok).toBe(true)
    expect(report.results.map((r) => [r.name, r.outcome])).toEqual([
      ['a1', 'passed'],
      ['a2', 'passed'],
      ['b1', 'passed']
    ])
  })

  it('reports the failed step with its exit code and tail, stops the running ones and never starts the rest', async () => {
    const steps = [step('tsc', 'tsc'), step('vitest', 'vitest'), step('build', 'build'), step('size', 'build')]
    const finished: string[] = []
    const report = await runSteps(
      steps,
      (s, signal) =>
        new Promise((resolve) => {
          if (s.name === 'vitest') {
            setTimeout(() => resolve({ exitCode: 1, tail: 'FAIL src/x.test.ts > boom' }), 10)
            return
          }
          if (s.name === 'tsc') {
            resolve({ exitCode: 0, tail: '' })
            return
          }
          // build runs until aborted, like a real child killed with SIGTERM.
          signal.addEventListener('abort', () => resolve({ exitCode: null, tail: 'killed' }), { once: true })
        }),
      { onFinish: (r) => finished.push(`${r.name}:${r.outcome}`) }
    )
    expect(report.ok).toBe(false)
    const by = Object.fromEntries(report.results.map((r) => [r.name, r]))
    expect(by.tsc.outcome).toBe('passed')
    expect(by.vitest).toMatchObject({ outcome: 'failed', exitCode: 1, tail: 'FAIL src/x.test.ts > boom' })
    expect(by.build.outcome).toBe('stopped')
    expect(by.size.outcome).toBe('not run')
    expect(finished).toContain('vitest:failed')
    const text = formatReport(report)
    expect(text).toContain('✗ vitest')
    expect(text).toContain('exit 1')
    expect(text).toContain('FAIL src/x.test.ts > boom')
    expect(text).toContain('■ build')
    expect(text).toContain('· size')
    expect(text).toMatch(/gate failed: vitest/)
  })

  it('treats a thrown spawn error as a failure of that step', async () => {
    const report = await runSteps([step('x', 'x')], async () => {
      throw new Error('spawn ENOENT')
    })
    expect(report.results[0]).toMatchObject({ outcome: 'failed', exitCode: null, tail: 'spawn ENOENT' })
  })

  it('reports a skipped step without running it and keeps the gate green', async () => {
    const ran: string[] = []
    const report = await runSteps(
      [step('typecheck', 'tsc'), step('vitest', 'vitest')],
      async (s) => {
        ran.push(s.name)
        return { exitCode: 0, tail: '' }
      },
      {},
      new Map([['typecheck', 'no change']])
    )
    expect(ran).toEqual(['vitest'])
    expect(report.ok).toBe(true)
    expect(report.results[0]).toMatchObject({ name: 'typecheck', outcome: 'skipped', note: 'no change' })
    expect(formatReport(report)).toContain('– typecheck')
  })
})

describe('the vitest step and its JSON report', () => {
  const report = (over: Record<string, unknown>) => ({ numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, testResults: [], ...over })

  it('the vitest step writes the JSON report beside its log, after the default reporter', () => {
    const vitest = STEPS.find((s) => s.name === 'vitest')!
    expect(vitest.json).toBe(true)
    expect(stepArgs(vitest, '/g/logs')).toEqual({
      args: ['vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile=/g/logs/vitest.json'],
      jsonFile: '/g/logs/vitest.json'
    })
    expect(stepArgs(STEPS.find((s) => s.name === 'typecheck')!, '/g/logs')).toEqual({ args: ['run', 'typecheck'], jsonFile: null })
  })

  it('a green exit is itself, report or not', () => {
    expect(judgeReport(0, 'ok', null)).toEqual({ exitCode: 0, tail: 'ok' })
    expect(judgeReport(0, 'ok', report({ success: false }))).toEqual({ exitCode: 0, tail: 'ok' })
  })

  it('a reporter that died after a green run passes the step on the report, and the tail says so', () => {
    const r = judgeReport(1, '', report({ success: true }))
    expect(r.exitCode).toBe(0)
    expect(r.tail).toBe('vitest exited 1 after the tests ran; its JSON report says all 3 passed, so the step passes')
    expect(judgeReport(null, 'RUN v3', report({ success: true })).tail).toBe('RUN v3\nvitest exited by signal after the tests ran; its JSON report says all 3 passed, so the step passes')
  })

  it("a run whose reporter printed its summary keeps its exit: the JSON report does not count an unhandled error", () => {
    const summary = 'Test Files  530 passed (530)\n      Tests  4966 passed (4966)\n     Errors  1 error'
    expect(judgeReport(1, summary, report({ success: true }))).toEqual({ exitCode: 1, tail: summary })
    // The summary seen earlier in the output, evicted from the kept tail by later lines: the exit still stands.
    expect(judgeReport(1, 'shutdown line', report({ success: true }), true)).toEqual({ exitCode: 1, tail: 'shutdown line' })
    expect(judgeReport(1, 'shutdown line', report({ success: true }), false).exitCode).toBe(0)
  })

  it('spawnStep reads the summary off whole lines: one split across two chunks still keeps the exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-spawn-'))
    try {
      // A vitest stand-in: a green JSON report, the summary written in two chunks, an unhandled error, exit 1.
      const script = [
        "const out = process.argv.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length)",
        "require('fs').writeFileSync(out, JSON.stringify({ success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] }))",
        "process.stdout.write(' Test ')",
        "setTimeout(() => process.stdout.write('Files  1 passed (1)\\n     Errors  1 error\\n', () => process.exit(1)), 80)"
      ].join('\n')
      // `--` ends node's own option parsing: the reporter flags the step appends reach the script.
      const step: Step = { name: 'vitest', tier: 'commit', cmd: process.execPath, args: ['-e', script, '--'], lane: 'vitest', why: '', json: true }
      const run = spawnStep({ repo: dir, logDir: join(dir, 'logs'), verbose: false })
      const { exitCode, tail } = await run(step, new AbortController().signal)
      expect(exitCode).toBe(1)
      expect(tail).toContain('Errors  1 error')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a red report names its failures when the output printed nothing, and keeps the output when it did', () => {
    const red = report({
      success: false,
      numFailedTests: 1,
      testResults: [{ name: 'src/x.test.ts', assertionResults: [{ fullName: 'x > boom', status: 'failed' }, { fullName: 'x > fine', status: 'passed' }] }]
    })
    expect(judgeReport(1, '', red)).toEqual({ exitCode: 1, tail: 'vitest printed nothing; its JSON report lists 1 failed\nFAIL src/x.test.ts > x > boom' })
    expect(judgeReport(1, 'FAIL x > boom\n(details)', red)).toEqual({ exitCode: 1, tail: 'FAIL x > boom\n(details)' })
  })

  it('no report and no output names the workers that never started; output without a report stands', () => {
    expect(judgeReport(1, '  \n', null)).toEqual({
      exitCode: 1,
      tail: 'vitest printed nothing and wrote no report: its workers never started (the host at its pids cap, or the pool could not spawn)'
    })
    expect(judgeReport(null, '', null).exitCode).toBe(1)
    expect(judgeReport(2, 'Error: Channel closed', null)).toEqual({ exitCode: 2, tail: 'Error: Channel closed' })
  })
})
