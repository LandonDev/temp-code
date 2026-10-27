import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventRow, SessionMeta } from '@shared/events'
import type { ThreadResource } from '@shared/contract-resources'
import { openDb } from './db'
import { OfflineError, ThreadResources } from './threadResources'
import { devInstanceDirAllowed, removeResource, type ResourceRunner, type RunResult } from './threadResourcesRemove'

const HOME = '/Users/landon'
const ME = 'env_me0000000000000000000'
const MAC = 'env_mac000000000000000000'
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr = 'fatal: no', code = 128): RunResult => ({ exitCode: code, stdout: '', stderr })

const session = (id: string, parentId: string | null = null, permission: SessionMeta['permission'] = 'auto'): SessionMeta =>
  ({ id, parentId, title: `t ${id}`, cwd: `${HOME}/IdeaProjects/temp-code`, permission, archived: false }) as unknown as SessionMeta

/** A scripted host: answers each argv by the first matching rule, records every run. */
function host(rules: [RegExp, RunResult | ((argv: string[]) => RunResult)][]) {
  const runs: { argv: string[]; cwd: string }[] = []
  const run: ResourceRunner = async (argv, cwd) => {
    runs.push({ argv, cwd })
    const line = argv.join(' ')
    for (const [re, r] of rules) if (re.test(line)) return typeof r === 'function' ? r(argv) : r
    return ok()
  }
  return { run, runs, lines: () => runs.map((r) => r.argv.join(' ')) }
}

describe('ThreadResources ledger', () => {
  let db: ReturnType<typeof openDb>
  let sessions: Map<string, SessionMeta>
  let runOn: ReturnType<typeof vi.fn<(env: string, thread: SessionMeta, argv: string[], cwd: string) => Promise<RunResult>>>
  let ledger: ThreadResources
  let changes: { sessionId: string; resources: ThreadResource[] }[]
  let now: number
  beforeEach(() => {
    db = openDb(':memory:')
    sessions = new Map([
      ['root', session('root')],
      ['child', session('child', 'root')],
      ['grandchild', session('grandchild', 'child')],
      ['other', session('other', null, 'edits')]
    ])
    runOn = vi.fn(async () => ok())
    now = 1_000
    changes = []
    ledger = new ThreadResources({ db, environmentId: ME, sessions: { get: (id) => sessions.get(id) ?? null }, runOn, homeOf: () => HOME, now: () => now++, log: () => {} })
    ledger.onChange((sessionId, resources) => changes.push({ sessionId, resources }))
  })
  afterEach(() => db.close())

  const toolCall = (sessionId: string, callId: string, name: string, input: unknown) =>
    ledger.observeEvent({ sessionId, seq: 1, ts: 1, event: { type: 'tool-call', callId, name, input } })
  const toolResult = (sessionId: string, callId: string, output: string) =>
    ledger.observeEvent({ sessionId, seq: 2, ts: 2, event: { type: 'tool-result' as const, callId, output } as EventRow['event'] })

  it('records a Bash worktree under the top-level thread on this host and pushes the change', () => {
    toolCall('grandchild', 'c1', 'Bash', { command: 'git worktree add .claude/worktrees/x -b x', description: 'wt' })
    toolResult('grandchild', 'c1', "Preparing worktree (new branch 'x')\nHEAD is now at 1234 m")
    const rows = ledger.list('root')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sessionId: 'root', environmentId: ME, kind: 'worktree', identifier: `${HOME}/IdeaProjects/temp-code/.claude/worktrees/x`, label: 'x', branch: 'x', removedAt: null })
    expect(ledger.list('grandchild')).toEqual([])
    expect(changes.at(-1)).toMatchObject({ sessionId: 'root', resources: [{ id: rows[0].id }] })
  })
  it('pairs a result with its call by callId, keeps only shell-like calls, and ignores partials and failures', () => {
    toolCall('root', 'p', 'Bash', { command: 'git worktree add ../a -b a' })
    ledger.observeEvent({ sessionId: 'root', seq: 1, ts: 1, event: { type: 'tool-call', callId: 'p', name: 'Bash', input: { command: 'git worktree ad' }, partial: true } })
    toolCall('root', 'r', 'Read', { file_path: '/x' })
    toolResult('root', 'r', 'contents')
    toolResult('root', 'p', "fatal: 'a' is already checked out")
    toolResult('root', 'unknown', "Preparing worktree (new branch 'z')")
    expect(ledger.list('root')).toEqual([])
  })
  it('records the harness worktree tool and stamps its removal', () => {
    toolCall('root', 'e', 'EnterWorktree', { name: 'feat' })
    toolResult('root', 'e', `Created worktree at ${HOME}/IdeaProjects/temp-code/.claude/worktrees/feat on branch feat`)
    expect(ledger.list('root')[0]).toMatchObject({ kind: 'worktree', label: 'feat', branch: 'feat' })
    toolCall('root', 'x', 'ExitWorktree', { action: 'remove' })
    toolResult('root', 'x', `Removed worktree ${HOME}/IdeaProjects/temp-code/.claude/worktrees/feat`)
    expect(ledger.list('root')).toEqual([])
    expect(ledger.list('root', true)[0]).toMatchObject({ removedAt: expect.any(Number), note: 'removed by the thread' })
  })
  it('records a bridged mac.run on the Mac, with the Mac home for ~, and a job once its reads prove the creation', () => {
    ledger.observeMacRun('child', MAC, { argv: ['git', 'worktree', 'add', '~/IdeaProjects/tc-ios/home', '-b', 'ios/home'], cwd: '~/IdeaProjects/temp-code' }, { exitCode: 0, signal: null, stdout: '', stderr: "Preparing worktree (new branch 'ios/home')", truncated: false, timedOut: false, durationMs: 1 }, '/Users/mac')
    expect(ledger.list('root')[0]).toMatchObject({ environmentId: MAC, identifier: '/Users/mac/IdeaProjects/tc-ios/home', branch: 'ios/home' })
    ledger.observeJobStart('child', MAC, 'j1', { command: 'xcrun simctl create tc-home "iPhone 16"' }, '/Users/mac')
    ledger.observeJobRead('j1', { output: 'Creating…\n', running: true, exitCode: null })
    expect(ledger.listAll({ kind: 'simulator' })).toEqual([])
    ledger.observeJobRead('j1', { output: '6F6E2E2E-1C7B-4C1D-9C9E-0D0E0F101112\n', running: true, exitCode: null })
    ledger.observeJobRead('j1', { output: '', running: false, exitCode: 0 })
    const sims = ledger.listAll({ kind: 'simulator', environmentId: MAC })
    expect(sims).toHaveLength(1)
    expect(sims[0]).toMatchObject({ sessionId: 'root', identifier: '6F6E2E2E-1C7B-4C1D-9C9E-0D0E0F101112', label: 'tc-home' })
    // A failed mac.run records nothing.
    ledger.observeMacRun('root', MAC, { command: 'git worktree add ../b -b b' }, { exitCode: 128, signal: null, stdout: '', stderr: "Preparing worktree (new branch 'b')\nfatal: x", truncated: false, timedOut: false, durationMs: 1 }, '/Users/mac')
    expect(ledger.list('root')).toHaveLength(2)
  })
  it('keeps one live row per resource on a host (the first owner), and lets a re-creation after removal be a new row', () => {
    const made = { created: [{ kind: 'worktree' as const, identifier: '/w', label: 'w', branch: 'w' }], removed: [] }
    expect(ledger.record('root', ME, made)).toHaveLength(1)
    expect(ledger.record('other', ME, made)).toHaveLength(0)
    expect(ledger.record('other', MAC, made)).toHaveLength(1)
    ledger.record('root', ME, { created: [], removed: [{ kind: 'worktree', identifier: '/w' }] })
    expect(ledger.list('root')).toEqual([])
    expect(ledger.record('other', ME, made)).toHaveLength(1)
    expect(ledger.summary('other')).toEqual({ total: 2, byHost: { [ME]: 1, [MAC]: 1 } })
  })
  it("a port row keeps what its process is, and a row from before reads null", () => {
    ledger.record('root', ME, { created: [{ kind: 'port', identifier: '5173', label: 'http://localhost:5173', branch: null, pid: 9, callId: 'c', what: 'Vite dev server' }], removed: [] })
    ledger.record('root', ME, { created: [{ kind: 'port', identifier: '5174', label: 'http://localhost:5174', branch: null, pid: 10, callId: 'd' }], removed: [] })
    expect(ledger.live(ME, 'port', '5173')).toMatchObject({ what: 'Vite dev server', pid: 9, callId: 'c' })
    expect(ledger.live(ME, 'port', '5174')?.what).toBeNull()
    // A worktree carries no port facts.
    ledger.record('root', ME, { created: [{ kind: 'worktree', identifier: '/w', label: 'w', branch: 'w' }], removed: [] })
    expect(ledger.live(ME, 'worktree', '/w')).not.toHaveProperty('what')
  })
  it('a simctl delete by name stamps the row recorded by UDID', () => {
    ledger.record('root', MAC, { created: [{ kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-x', branch: null }], removed: [] })
    ledger.record('root', MAC, { created: [], removed: [{ kind: 'simulator', identifier: 'tc-x' }] })
    expect(ledger.list('root')).toEqual([])
  })

  describe('removal', () => {
    it('runs on the owning host as the thread, stamps the row and answers the outcome', async () => {
      ledger.record('child', MAC, { created: [{ kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-x', branch: null }], removed: [] })
      const [row] = ledger.list('root')
      const results = await ledger.remove('child')
      expect(results).toEqual([{ id: row.id, outcome: 'removed', note: null }])
      expect(runOn).toHaveBeenCalledWith(MAC, sessions.get('root'), ['xcrun', 'simctl', 'shutdown', 'ABCDEF00-0000-4000-8000-000000000000'], '/')
      expect(runOn).toHaveBeenCalledWith(MAC, sessions.get('root'), ['xcrun', 'simctl', 'delete', 'ABCDEF00-0000-4000-8000-000000000000'], '/')
      expect(ledger.list('root')).toEqual([])
      expect(ledger.get(row.id)).toMatchObject({ removedAt: expect.any(Number), removeRequestedAt: expect.any(Number) })
    })
    it('removes only the named ids, and only the thread\'s own rows', async () => {
      ledger.record('root', ME, { created: [{ kind: 'worktree', identifier: '/a', label: 'a', branch: null }, { kind: 'worktree', identifier: '/b', label: 'b', branch: null }], removed: [] })
      ledger.record('other', ME, { created: [{ kind: 'worktree', identifier: '/c', label: 'c', branch: null }], removed: [] })
      const b = ledger.list('root').find((r) => r.identifier === '/b')!
      const c = ledger.list('other')[0]
      runOn.mockImplementation(async (_e, _t, argv) => (argv[0] === 'git' && argv.includes('--git-common-dir') ? ok('/repo/.git\n') : ok()))
      const results = await ledger.remove('root', [b.id, c.id])
      expect(results.map((r) => r.id)).toEqual([b.id])
      expect(ledger.list('root').map((r) => r.identifier)).toEqual(['/a'])
      expect(ledger.list('other')).toHaveLength(1)
    })
    it('an offline host leaves the row waiting with the request stamped, and a link-up retries it', async () => {
      ledger.record('root', MAC, { created: [{ kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-x', branch: null }], removed: [] })
      runOn.mockRejectedValue(new OfflineError(MAC))
      const [result] = await ledger.remove('root')
      expect(result).toMatchObject({ outcome: 'waiting', note: 'host offline, waiting for its link' })
      const [row] = ledger.list('root')
      expect(row).toMatchObject({ removeRequestedAt: expect.any(Number), removedAt: null, note: 'host offline, waiting for its link' })
      expect(ledger.waitingOn(MAC)).toHaveLength(1)
      expect(ledger.waitingOn(ME)).toEqual([])
      await ledger.linkUp(ME)
      expect(ledger.list('root')).toHaveLength(1)
      runOn.mockImplementation(async () => ok())
      await ledger.linkUp(MAC)
      expect(ledger.list('root')).toEqual([])
      expect(ledger.get(row.id)).toMatchObject({ removedAt: expect.any(Number) })
    })
    it('a host that refused leaves the row live with no request pending and the reason as its note', async () => {
      ledger.record('root', MAC, { created: [{ kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc-x', branch: null }], removed: [] })
      runOn.mockRejectedValue(new Error('denied at the Mac'))
      const [result] = await ledger.remove('root')
      expect(result).toMatchObject({ outcome: 'failed', note: 'denied at the Mac' })
      expect(ledger.list('root')[0]).toMatchObject({ removeRequestedAt: null, note: 'denied at the Mac' })
      expect(ledger.waitingOn(MAC)).toEqual([])
    })
    it('a row whose thread is gone cannot run as it', async () => {
      ledger.record('root', ME, { created: [{ kind: 'worktree', identifier: '/a', label: 'a', branch: null }], removed: [] })
      sessions.delete('root')
      const [result] = await ledger.remove('root')
      expect(result).toMatchObject({ outcome: 'failed', note: 'its thread is gone; remove by hand' })
      expect(runOn).not.toHaveBeenCalled()
    })
  })
})

describe('removeResource rules', () => {
  const wt = (branch: string | null): ThreadResource => ({ id: 'r', sessionId: 's', environmentId: ME, kind: 'worktree', identifier: '/repo/.claude/worktrees/feat', label: 'feat', branch, createdAt: 1, removeRequestedAt: null, removedAt: null, note: null })
  const COMMON: [RegExp, RunResult] = [/--git-common-dir/, ok('/repo/.git\n')]

  it('removes the worktree from the main tree and deletes a branch with nothing ahead of its upstream', async () => {
    const h = host([COMMON, [/rev-list --count feat@\{upstream\}\.\.feat/, ok('0\n')]])
    expect(await removeResource(wt('feat'), h.run)).toEqual({ note: 'branch feat deleted' })
    expect(h.lines()).toEqual([
      'git -C /repo/.claude/worktrees/feat rev-parse --path-format=absolute --git-common-dir',
      'git worktree remove --force /repo/.claude/worktrees/feat',
      'git rev-parse --verify --quiet refs/heads/feat',
      'git rev-list --count feat@{upstream}..feat',
      'git branch -D feat'
    ])
    expect(h.runs[1].cwd).toBe('/repo')
  })
  it('keeps a branch with commits ahead of its upstream and says so', async () => {
    const h = host([COMMON, [/rev-list --count feat@\{upstream\}\.\.feat/, ok('2\n')]])
    expect(await removeResource(wt('feat'), h.run)).toEqual({ note: 'branch feat kept: 2 commits ahead of its upstream' })
    expect(h.lines()).not.toContain('git branch -D feat')
  })
  it('with no upstream, counts what no remote has', async () => {
    const h = host([COMMON, [/feat@\{upstream\}/, fail('fatal: no upstream configured for branch')], [/--not --remotes/, ok('1\n')]])
    expect(await removeResource(wt('feat'), h.run)).toEqual({ note: 'branch feat kept: 1 commit on no remote' })
    const h2 = host([COMMON, [/feat@\{upstream\}/, fail('fatal: no upstream')], [/--not --remotes/, ok('0\n')]])
    expect(await removeResource(wt('feat'), h2.run)).toEqual({ note: 'branch feat deleted' })
  })
  it('deletes no branch when the command created none, and notes one already gone', async () => {
    const h = host([COMMON])
    expect(await removeResource(wt(null), h.run)).toEqual({ note: null })
    expect(h.lines().some((l) => l.includes('branch -D'))).toBe(false)
    const h2 = host([COMMON, [/rev-parse --verify/, fail('', 1)]])
    expect(await removeResource(wt('feat'), h2.run)).toEqual({ note: 'branch feat was already gone' })
  })
  it('a worktree already gone is a removal with a note; a path that is not a worktree fails', async () => {
    const gone = host([[/--git-common-dir/, fail('fatal: not a git repository')], [/^test -e/, fail('', 1)]])
    expect(await removeResource(wt('feat'), gone.run)).toEqual({ note: 'was already gone' })
    expect(gone.lines()).toHaveLength(2)
    const notRepo = host([[/--git-common-dir/, fail('fatal: not a git repository')], [/^test -e/, ok()]])
    await expect(removeResource(wt('feat'), notRepo.run)).rejects.toThrow('not a git worktree: fatal: not a git repository')
    const refused = host([COMMON, [/worktree remove/, fail("fatal: '/x' is a main working tree")]])
    await expect(removeResource(wt('feat'), refused.run)).rejects.toThrow("git worktree remove: fatal: '/x' is a main working tree")
  })
  it('a simulator: shutdown (its failure is nothing), then delete; an invalid device is already gone', async () => {
    const sim: ThreadResource = { ...wt(null), kind: 'simulator', identifier: 'ABCDEF00-0000-4000-8000-000000000000', label: 'tc' }
    const h = host([[/shutdown/, fail('Unable to shutdown device in current state: Shutdown', 149)]])
    expect(await removeResource(sim, h.run)).toEqual({ note: null })
    expect(h.lines()).toEqual(['xcrun simctl shutdown ABCDEF00-0000-4000-8000-000000000000', 'xcrun simctl delete ABCDEF00-0000-4000-8000-000000000000'])
    const gone = host([[/delete/, fail('Invalid device: ABCDEF00-0000-4000-8000-000000000000', 164)]])
    expect(await removeResource(sim, gone.run)).toEqual({ note: 'was already gone' })
    const bad = host([[/delete/, fail('An error was encountered', 1)]])
    await expect(removeResource(sim, bad.run)).rejects.toThrow('simctl delete: An error was encountered')
  })
  it('a dev instance: rm -rf of its own dir, never the installed app\'s or a shallow path', async () => {
    const dev: ThreadResource = { ...wt(null), kind: 'devInstance', identifier: '/Users/landon/Library/Application Support/temp-code-dev2', label: 'temp-code-dev2' }
    const h = host([])
    expect(await removeResource(dev, h.run)).toEqual({ note: null })
    expect(h.lines()).toEqual(['test -e /Users/landon/Library/Application Support/temp-code-dev2', 'rm -rf -- /Users/landon/Library/Application Support/temp-code-dev2'])
    const gone = host([[/^test -e/, fail('', 1)]])
    expect(await removeResource(dev, gone.run)).toEqual({ note: 'was already gone' })
    await expect(removeResource({ ...dev, identifier: '/Users/landon/Library/Application Support/TempCode' }, h.run)).rejects.toThrow('refused')
    await expect(removeResource({ ...dev, identifier: '/Users/landon' }, h.run)).rejects.toThrow('refused')
    expect(devInstanceDirAllowed('relative/dir')).toBe(false)
    expect(devInstanceDirAllowed('/tmp/tc/temp-code')).toBe(false)
    expect(devInstanceDirAllowed('/tmp/tc/temp-code-dev')).toBe(true)
  })
})
