import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STEPS, TIER_PATHS, formatReport, gateDir, matchPath, parseArgs, readStoredHash, runSteps, selectSteps, shouldSkipTypecheck, storeHash, tiersForPaths, typecheckHash, type Step, macOnlySkips, judgeReport, spawnStep, stepArgs, atPublishSkips, fmtCap, SOAK_CAP_MS, BUILD_WAIT_MS, proofCap, STORE_MEASURED_MS, STORE_CAP_MS, COMPUTER_MEASURED_MS, COMPUTER_CAP_MS, buildBarrier, gate } from './gate'
import { BENCH_TIMING } from './lib/computerBench'

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
    expect(publish).toEqual(expect.arrayContaining(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'e2e-remote-fence', 'e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench']))
    // The soaks read out/ too: in the build lane after the build and its size check, so they never race them,
    // one scene after the other, each failing on its CPU bound (no report-only flag).
    const soak = STEPS.find((s) => s.name === 'renderer-soak')!
    const chat = STEPS.find((s) => s.name === 'renderer-soak-chat')!
    const typing = STEPS.find((s) => s.name === 'renderer-soak-typing')!
    expect(soak).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate'] })
    expect(chat).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'chat'] })
    expect(STEPS.indexOf(soak)).toBeGreaterThan(STEPS.indexOf(size))
    expect(STEPS.indexOf(chat)).toBeGreaterThan(STEPS.indexOf(soak))
    // The typing scene last in the lane, on its own rule (no CPU bound to report).
    expect(typing).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'typing'] })
    expect(STEPS.indexOf(typing)).toBeGreaterThan(STEPS.indexOf(chat))
    // The scroll scene after it, the same lane.
    const scroll = STEPS.find((s) => s.name === 'renderer-soak-scroll')!
    expect(scroll).toMatchObject({ tier: 'publish', lane: build.lane, mac: true, cmd: 'bun', args: ['scripts/measure-renderer-soak.ts', '--gate', '--scene', 'scroll'] })
    expect(STEPS.indexOf(scroll)).toBeGreaterThan(STEPS.indexOf(typing))
    expect(STEPS.filter((s) => s.hashSkip).map((s) => s.name)).toEqual(['typecheck'])
  })

  it('selects by tier, honours --only and --skip, and refuses an unknown name', () => {
    expect(selectSteps({ tiers: new Set(['commit']) }).map((s) => s.name)).toEqual(['typecheck', 'vitest', 'build', 'bundle-size'])
    expect(selectSteps({ tiers: new Set(['publish']) }).map((s) => s.name)).toEqual(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'e2e-remote-fence', 'e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench'])
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
  it('skips the renderer soak, hub, ios and ios-client off macOS with a note, and nothing on it', () => {
    expect([...macOnlySkips(STEPS, 'linux').keys()]).toEqual(['renderer-soak', 'renderer-soak-chat', 'renderer-soak-typing', 'renderer-soak-scroll', 'hub', 'ios', 'ios-client', 'computer-swift', 'e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview', 'computer-bench'])
    expect(macOnlySkips(STEPS, 'linux').get('ios')).toBe('needs the Mac; release:publish runs it there')
    expect(macOnlySkips(STEPS, 'darwin').size).toBe(0)
    expect(STEPS.filter((s) => s.mac).every((s) => s.tier === 'publish')).toBe(true)
  })
})

describe('the computer bench row and the caps', () => {
  const bench = STEPS.find((s) => s.name === 'computer-bench')!

  it('is a publish step on the Mac in its own lane, with a cap, never pulled into a commit hook', () => {
    expect(bench).toMatchObject({ tier: 'publish', mac: true, lane: 'computer', onlyAtPublish: true, cmd: 'bun', args: ['run', 'script:e2e-computer-bench', '--', '--gate'] })
    // Last in its lane, after the Mac's TC Probe proofs.
    expect(STEPS.filter((s) => s.lane === 'computer').at(-1)).toBe(bench)
    expect(bench.capMs).toBe(15 * 60_000)
    // The script's own deadline leaves it a minute inside the cap to report and clean up.
    expect(BENCH_TIMING.budgetMs).toBeLessThan(bench.capMs!)
  })

  it('gives every soak row its cap', () => {
    const soaks = STEPS.filter((s) => s.name.startsWith('renderer-soak'))
    expect(soaks).toHaveLength(4)
    for (const s of soaks) expect(s.capMs, s.name).toBe(SOAK_CAP_MS)
    expect(SOAK_CAP_MS).toBe(12 * 60_000)
  })

  it('skips an onlyAtPublish step when changed paths alone pulled its tier, and keeps it when the tier was asked for', async () => {
    expect([...atPublishSkips(STEPS, new Set(['publish']))]).toEqual([['computer-bench', 'runs at publish']])
    expect(atPublishSkips(STEPS, new Set()).size).toBe(0)
    const publish = selectSteps({ tiers: new Set(['publish']) })
    const ran: string[] = []
    const report = await runSteps(
      publish.filter((s) => s.name === 'computer-bench' || s.name === 'e2e-remote-fence'),
      async (s) => {
        ran.push(s.name)
        return { exitCode: 0, tail: '' }
      },
      {},
      atPublishSkips(publish, new Set(['publish']))
    )
    expect(ran).toEqual(['e2e-remote-fence'])
    expect(report.ok).toBe(true)
    expect(formatReport(report)).toMatch(/– computer-bench\s+skipped {2}runs at publish/)
  })

  it('says a cap in minutes, seconds or milliseconds', () => {
    expect(fmtCap(15 * 60_000)).toBe('15m')
    expect(fmtCap(90_000)).toBe('90s')
    expect(fmtCap(300)).toBe('300ms')
  })

  it('kills a step past its cap and fails it with the cap’s line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-cap-'))
    try {
      const sleeper: Step = { name: 'sleeper', tier: 'publish', cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], lane: 'x', why: '', capMs: 300 }
      const quick: Step = { name: 'quick', tier: 'publish', cmd: process.execPath, args: ['-e', ''], lane: 'y', why: '', capMs: 60_000 }
      const t0 = Date.now()
      const report = await runSteps([sleeper, quick], spawnStep({ repo: dir, logDir: join(dir, 'logs'), verbose: false }))
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(report.ok).toBe(false)
      const by = Object.fromEntries(report.results.map((r) => [r.name, r]))
      expect(by.sleeper).toMatchObject({ outcome: 'failed', note: 'passed its 300ms cap' })
      expect(by.quick.outcome).toBe('passed')
      expect(formatReport(report)).toMatch(/✗ sleeper .* failed {2}passed its 300ms cap/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the store and computer proofs', () => {
  const STORE = ['e2e-addons', 'e2e-addon-grants', 'e2e-skills-store', 'e2e-skills-drivers']
  const MAC = ['e2e-tc-computer', 'e2e-computer-bridge', 'e2e-computer-preview']
  const at = (name: string): number => STEPS.findIndex((s) => s.name === name)

  it('runs each as a publish row through its script entry with --gate, under a cap', () => {
    for (const name of [...STORE, ...MAC]) {
      const s = STEPS.find((x) => x.name === name)!
      expect(s, name).toMatchObject({ tier: 'publish', cmd: 'bun', args: ['run', `script:${name}`, '--', '--gate'] })
      expect(s.capMs, name).toBeGreaterThan(BUILD_WAIT_MS)
      expect(s.capMs! % 60_000, name).toBe(0)
      expect(s.onlyAtPublish, name).toBeUndefined()
    }
  })

  it('puts the store proofs one after the other in one lane, right after the fence, on both hosts', () => {
    const fence = STEPS.find((s) => s.name === 'e2e-remote-fence')!
    const lane = STEPS.filter((s) => s.lane === fence.lane).map((s) => s.name)
    expect(lane).toEqual(['e2e-remote-fence', ...STORE])
    for (const name of STORE) expect(STEPS[at(name)].mac, name).toBeUndefined()
    expect(STORE.map(at)).toEqual(STORE.map((_, i) => at('e2e-remote-fence') + 1 + i))
  })

  it("puts the Mac's TC Probe proofs before the bench in the computer lane", () => {
    expect(STEPS.filter((s) => s.lane === 'computer').map((s) => s.name)).toEqual([...MAC, 'computer-bench'])
    for (const name of MAC) expect(STEPS[at(name)].mac, name).toBe(true)
  })

  it('caps a proof at the build wait plus three times its measured time, rounded up to the minute', () => {
    expect(proofCap(133_000)).toBe(BUILD_WAIT_MS + 7 * 60_000)
    expect(proofCap(60_000)).toBe(BUILD_WAIT_MS + 3 * 60_000)
    for (const [name, ms] of Object.entries(STORE_MEASURED_MS)) expect(STORE_CAP_MS[name as keyof typeof STORE_CAP_MS]).toBe(proofCap(ms))
    for (const [name, ms] of Object.entries(COMPUTER_MEASURED_MS)) expect(COMPUTER_CAP_MS[name as keyof typeof COMPUTER_CAP_MS]).toBe(proofCap(ms))
  })
})

describe('the build barrier', () => {
  // gate() prints its status and report; the tests read its results instead.
  beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('holds only a run that selects the build, after bundle-size when it runs', () => {
    expect(buildBarrier(selectSteps({ tiers: new Set(['publish']) }), '/g')).toBeNull()
    expect(buildBarrier(selectSteps({ tiers: new Set(['commit', 'publish']) }), '/g')).toEqual({ file: '/g/build.done', after: 'bundle-size' })
    expect(buildBarrier(selectSteps({ tiers: new Set(['commit']), skip: ['bundle-size'] }), '/g')).toEqual({ file: '/g/build.done', after: 'build' })
  })

  it("removes last run's build.done, names it to every step and touches it once the size check passes", async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-barrier-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const dir = gateDir(repo)
      mkdirSync(dir, { recursive: true })
      // Last run's file: a proof that read it would start before this run's build.
      writeFileSync(join(dir, 'build.done'), 'stale\n')
      const seen = join(repo, 'seen.txt')
      const node = (body: string): string[] => ['-e', body]
      const steps: Step[] = [
        // The build checks the stale file is gone before it "builds".
        { name: 'build', tier: 'commit', lane: 'build', why: '', cmd: process.execPath, args: node("if (require('fs').existsSync(process.env.TEMP_CODE_SOAK_BUILD_DONE)) process.exit(3); setTimeout(() => {}, 300)") },
        { name: 'bundle-size', tier: 'commit', lane: 'build', why: '', cmd: process.execPath, args: node("if (require('fs').existsSync(process.env.TEMP_CODE_SOAK_BUILD_DONE)) process.exit(4)") },
        // A proof in another lane: it starts at once, waits for the file, and records what it saw.
        {
          name: 'proof',
          tier: 'publish',
          lane: 'e2e',
          why: '',
          cmd: process.execPath,
          args: node(
            `const fs = require('fs'); const f = process.env.TEMP_CODE_SOAK_BUILD_DONE; const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); fs.writeFileSync(${JSON.stringify(seen)}, f) } }, 20)`
          )
        }
      ]
      const report = await gate({ repo, tiers: new Set(['commit', 'publish']), full: false, verbose: false, steps })
      expect(report.results.map((r) => [r.name, r.outcome])).toEqual([
        ['build', 'passed'],
        ['bundle-size', 'passed'],
        ['proof', 'passed']
      ])
      expect(readFileSync(seen, 'utf8')).toBe(join(dir, 'build.done'))
      expect(existsSync(join(dir, 'build.done'))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('leaves a run without the build on the caller’s variable', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tc-gate-nobarrier-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      const seen = join(repo, 'seen.txt')
      const step: Step = { name: 'proof', tier: 'publish', lane: 'e2e', why: '', cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(seen)}, process.env.TEMP_CODE_SOAK_BUILD_DONE ?? 'unset')`] }
      const before = process.env.TEMP_CODE_SOAK_BUILD_DONE
      process.env.TEMP_CODE_SOAK_BUILD_DONE = '/stage/build.done'
      try {
        await gate({ repo, tiers: new Set(['publish']), full: false, verbose: false, steps: [step] })
      } finally {
        if (before === undefined) delete process.env.TEMP_CODE_SOAK_BUILD_DONE
        else process.env.TEMP_CODE_SOAK_BUILD_DONE = before
      }
      expect(readFileSync(seen, 'utf8')).toBe('/stage/build.done')
      expect(existsSync(join(gateDir(repo), 'build.done'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('tier selection by path', () => {
  it('pulls the publish tier in for the add-on, skills and computer host code and their proofs', () => {
    for (const path of [
      'src/main/server/addons/addonHost.ts',
      'src/main/server/skills/materialize.ts',
      'src/main/server/computer/sessions.ts',
      'src/main/server/addonStore.ts',
      'src/main/server/skillStore.ts',
      'src/main/server/skillFiles.ts',
      'src/main/server/storeRpc.ts',
      'src/main/server/museConfigDirs.ts',
      'src/shared/addons.ts',
      'src/shared/skills.ts',
      'src/shared/addonGrant.ts',
      'src/shared/addonGrantWords.ts',
      'src/main/addonHostProcess.ts',
      'src/main/addonHostSpawn.ts',
      'scripts/app-mcp-bridge.mjs',
      'scripts/e2e-addons.ts',
      'scripts/e2e-addon-grants.ts',
      'scripts/e2e-skills-store.ts',
      'scripts/e2e-skills-drivers.ts',
      'scripts/e2e-computer-bridge.ts',
      'scripts/e2e-computer.ts',
      'scripts/e2e-tc-computer.ts',
      'scripts/lib/gateBuild.ts',
      'scripts/lib/tcComputerBuild.ts',
      'scripts/lib/proofOrder.ts'
    ]) {
      expect(tiersForPaths([path]).get('publish'), path).toEqual([path])
    }
    // The drivers stay out: nearly every commit touches them.
    for (const path of ['src/main/server/drivers/claude.ts', 'src/main/server/drivers/codex.ts']) expect(tiersForPaths([path]).size, path).toBe(0)
  })

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
      'infra/hub/src/index.ts',
      'native/tc-computer/Sources/ComputerProtocol/Generated/Types.swift',
      'src/shared/computer/protocol.ts',
      'scripts/gen-swift-computer.ts'
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
