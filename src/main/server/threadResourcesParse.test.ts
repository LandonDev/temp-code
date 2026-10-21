import { describe, expect, it } from 'vitest'
import {
  detectCommand,
  detectHarnessWorktree,
  expand,
  parseWorktreeAdd,
  shellOf,
  simpleCommands,
  worktreePreparedLine
} from './threadResourcesParse'

const HOME = '/Users/landon'
const CWD = '/Users/landon/IdeaProjects/temp-code'
const run = (command: string, output = '', exitCode?: number | null) =>
  detectCommand({ command, cwd: CWD, home: HOME, output, ...(exitCode !== undefined ? { exitCode } : {}) })
const NEW_BRANCH = "Preparing worktree (new branch 'ios/home')\nHEAD is now at 9a08124 Merge\n"

describe('simpleCommands', () => {
  it('splits on && ; || | and newlines, honours quotes, drops assignments and env, tracks cd', () => {
    const out = simpleCommands(
      `FOO=1 env -u ELECTRON_RUN_AS_NODE BAR="a b" git status && cd ~/IdeaProjects; ls "x y" | wc -l || echo 'a;b'\ncd sub && pwd`,
      CWD,
      HOME
    )
    expect(out.map((s) => s.words)).toEqual([['git', 'status'], ['ls', 'x y'], ['wc', '-l'], ['echo', 'a;b'], ['pwd']])
    expect(out.map((s) => s.cwd)).toEqual([CWD, `${HOME}/IdeaProjects`, `${HOME}/IdeaProjects`, `${HOME}/IdeaProjects`, `${HOME}/IdeaProjects/sub`])
    expect(out[0].raw).toEqual(['FOO=1', 'env', '-u', 'ELECTRON_RUN_AS_NODE', 'BAR=a b', 'git', 'status'])
  })
  it('keeps $(…) and subshells as opaque text and reads a bare cd as home', () => {
    const out = simpleCommands(`git worktree add ../x $(git rev-parse HEAD) && (cd /tmp && ls) ; cd && pwd`, CWD, HOME)
    expect(out[0].words).toEqual(['git', 'worktree', 'add', '../x', '$(git', 'rev-parse', 'HEAD)'])
    expect(out.at(-1)).toEqual({ words: ['pwd'], raw: ['pwd'], cwd: HOME })
  })
})

describe('expand', () => {
  it('reads ~, $HOME, ${HOME} and relative paths against the cwd', () => {
    expect(expand('~/a', CWD, HOME)).toBe(`${HOME}/a`)
    expect(expand('$HOME/b', CWD, HOME)).toBe(`${HOME}/b`)
    expect(expand('${HOME}/c', CWD, HOME)).toBe(`${HOME}/c`)
    expect(expand('../d', CWD, HOME)).toBe(`${HOME}/IdeaProjects/d`)
    expect(expand('/abs//e/', CWD, HOME)).toBe('/abs/e')
  })
})

describe('parseWorktreeAdd', () => {
  it('reads the path, -b/-B, --detach, --orphan, a commit-ish, -- and git -C', () => {
    expect(parseWorktreeAdd(['git', 'worktree', 'add', '-b', 'feat', '../feat', 'origin/master'], CWD, HOME)).toEqual({
      path: `${HOME}/IdeaProjects/feat`,
      branchFlag: 'feat',
      commitish: 'origin/master',
      detach: false,
      orphan: null
    })
    expect(parseWorktreeAdd(['git', 'worktree', 'add', '--detach', '/tmp/wt'], CWD, HOME)?.detach).toBe(true)
    expect(parseWorktreeAdd(['git', 'worktree', 'add', '--orphan=solo', '/tmp/wt'], CWD, HOME)?.orphan).toBe('solo')
    expect(parseWorktreeAdd(['git', 'worktree', 'add', '--lock', '--reason', 'why', '--', '-odd'], CWD, HOME)?.path).toBe(`${CWD}/-odd`)
    expect(parseWorktreeAdd(['git', '-C', '/repo', '-c', 'x=y', 'worktree', 'add', 'wt'], CWD, HOME)?.path).toBe('/repo/wt')
    expect(parseWorktreeAdd(['git', 'worktree', 'list'], CWD, HOME)).toBeNull()
    expect(parseWorktreeAdd(['git', 'worktree', 'add'], CWD, HOME)).toBeNull()
  })
})

describe('worktreePreparedLine', () => {
  it('reads the four shapes git prints', () => {
    expect(worktreePreparedLine(NEW_BRANCH)).toEqual({ kind: 'new', branch: 'ios/home' })
    expect(worktreePreparedLine("Preparing worktree (checking out 'main')")).toEqual({ kind: 'existing', branch: 'main' })
    expect(worktreePreparedLine("Preparing worktree (resetting branch 'x'; was at abc)")).toEqual({ kind: 'existing', branch: 'x' })
    expect(worktreePreparedLine('Preparing worktree (detached HEAD 9a08124)')).toEqual({ kind: 'detached', branch: null })
    expect(worktreePreparedLine('nothing')).toBeNull()
  })
})

describe('detectCommand: git worktree add', () => {
  it('records a new worktree with the branch git says it made', () => {
    expect(run('git worktree add ~/IdeaProjects/tc-ios/home -b ios/home', NEW_BRANCH)).toEqual({
      created: [{ kind: 'worktree', identifier: `${HOME}/IdeaProjects/tc-ios/home`, label: 'ios/home', branch: 'ios/home' }],
      removed: []
    })
  })
  it('records an existing branch checked out with no branch to delete', () => {
    const out = run('git worktree add ../wt main', "Preparing worktree (checking out 'main')")
    expect(out.created).toEqual([{ kind: 'worktree', identifier: `${HOME}/IdeaProjects/wt`, label: 'wt', branch: null }])
  })
  it('records a detached worktree with no branch', () => {
    const out = run('git worktree add --detach /tmp/wt HEAD~2', 'Preparing worktree (detached HEAD 1234abc)')
    expect(out.created[0]).toMatchObject({ identifier: '/tmp/wt', branch: null })
  })
  it('records nothing from a tool result without the Preparing line (the worktree is not known to exist)', () => {
    expect(run('git worktree add ../wt -b x', '')).toEqual({ created: [], removed: [] })
  })
  it('records nothing when git failed', () => {
    expect(run('git worktree add ../wt -b x', "fatal: 'x' is already checked out at '/a'")).toEqual({ created: [], removed: [] })
    expect(run('git worktree add ../wt -b x', NEW_BRANCH, 128)).toEqual({ created: [], removed: [] })
    expect(run('git worktree add ../wt -b x', NEW_BRANCH, null)).toEqual({ created: [], removed: [] })
  })
  it('with a known clean exit and an old git without the line, infers the branch from the flags', () => {
    expect(run('git worktree add ../wt -b feat', '', 0).created[0]).toMatchObject({ branch: 'feat', label: 'feat' })
    expect(run('git worktree add ../wt', '', 0).created[0]).toMatchObject({ branch: 'wt' })
    expect(run('git worktree add ../wt main', '', 0).created[0]).toMatchObject({ branch: null })
    expect(run('git worktree add -B reset ../wt', '', 0).created[0]).toMatchObject({ branch: 'reset' })
  })
  it('follows cd and git -C and takes argv as given', () => {
    const out = run('cd ~/IdeaProjects/temp-code && git worktree add .claude/worktrees/x -b x', "Preparing worktree (new branch 'x')")
    expect(out.created[0].identifier).toBe(`${CWD}/.claude/worktrees/x`)
    const argv = detectCommand({ argv: ['git', '-C', '/repo', 'worktree', 'add', 'wt'], cwd: '/elsewhere', home: HOME, output: NEW_BRANCH, exitCode: 0 })
    expect(argv.created[0]).toMatchObject({ identifier: '/repo/wt', branch: 'ios/home' })
  })
  it('sees a worktree remove', () => {
    expect(run('git worktree remove --force ../wt', '', 0).removed).toEqual([{ kind: 'worktree', identifier: `${HOME}/IdeaProjects/wt` }])
    expect(run('git worktree remove ../wt', 'fatal: not a working tree').removed).toEqual([])
  })
})

describe('detectCommand: simctl', () => {
  const UDID = '6F6E2E2E-1C7B-4C1D-9C9E-0D0E0F101112'
  it('records a created simulator by the UDID it printed', () => {
    expect(run('xcrun simctl create "tc-ios-home" "iPhone 16" com.apple.CoreSimulator.SimRuntime.iOS-18-2', `${UDID.toLowerCase()}\n`)).toEqual({
      created: [{ kind: 'simulator', identifier: UDID, label: 'tc-ios-home', branch: null }],
      removed: []
    })
    expect(run('xcrun --sdk iphonesimulator simctl create x "iPhone 16"', UDID, 0).created).toHaveLength(1)
    expect(run('simctl create x "iPhone 16"', UDID).created).toHaveLength(1)
  })
  it('records nothing without a UDID or on failure', () => {
    expect(run('xcrun simctl create x "iPhone 99"', 'Invalid device type: iPhone 99').created).toEqual([])
    expect(run('xcrun simctl create x "iPhone 16"', '', 0).created).toEqual([])
    expect(run('xcrun simctl create x "iPhone 16"', UDID, 1).created).toEqual([])
  })
  it('records nothing for a boot and sees a delete', () => {
    expect(run(`xcrun simctl boot ${UDID}`, '')).toEqual({ created: [], removed: [] })
    expect(run(`xcrun simctl boot ${UDID} && xcrun simctl create y "iPhone 16"`, UDID).created).toHaveLength(1)
    expect(run(`xcrun simctl delete ${UDID}`, '', 0).removed).toEqual([{ kind: 'simulator', identifier: UDID }])
    expect(run('xcrun simctl delete unavailable', '', 0).removed).toEqual([{ kind: 'simulator', identifier: 'unavailable' }])
  })
})

describe('detectCommand: dev instance', () => {
  it('records the userData dir of an isolated dev launch, never dev:prod or a launch without one', () => {
    const cmd = `env -u ELECTRON_RUN_AS_NODE TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev2" TEMP_CODE_DEBUG_PORT=9226 bun run dev`
    expect(run(cmd, 'vite v5 dev server running').created).toEqual([
      { kind: 'devInstance', identifier: `${HOME}/Library/Application Support/temp-code-dev2`, label: 'temp-code-dev2', branch: null }
    ])
    expect(run('bun run dev:prod', '').created).toEqual([])
    expect(run('bun run dev', '').created).toEqual([])
    expect(run('TEMP_CODE_USER_DATA=/tmp/x bun run build', '').created).toEqual([])
    expect(run('TEMP_CODE_USER_DATA=/tmp/x bun run dev', 'error: a dev build needs TEMP_CODE_USER_DATA', 1).created).toEqual([])
  })
})

describe('detectHarnessWorktree', () => {
  it('reads the path and branch EnterWorktree made, and the name when no branch is printed', () => {
    const out = detectHarnessWorktree('EnterWorktree', { name: 'ios-home' }, 'Created worktree at /Users/landon/IdeaProjects/temp-code/.claude/worktrees/ios-home on branch ios-home')
    expect(out.created).toEqual([{ kind: 'worktree', identifier: `${CWD}/.claude/worktrees/ios-home`, label: 'ios-home', branch: 'ios-home' }])
    const bare = detectHarnessWorktree('EnterWorktree', { name: 'x' }, `Switched to ${CWD}/.claude/worktrees/x`)
    expect(bare.created[0]).toMatchObject({ label: 'x', branch: null })
  })
  it('records nothing from a refusal or when no path is named', () => {
    expect(detectHarnessWorktree('EnterWorktree', { name: 'x' }, 'Error: already in a worktree session').created).toEqual([])
    expect(detectHarnessWorktree('EnterWorktree', { name: 'x' }, 'ok').created).toEqual([])
  })
  it('sees ExitWorktree remove, not keep', () => {
    expect(detectHarnessWorktree('ExitWorktree', { action: 'remove' }, `Removed worktree ${CWD}/.claude/worktrees/x and its branch`).removed).toEqual([
      { kind: 'worktree', identifier: `${CWD}/.claude/worktrees/x` }
    ])
    expect(detectHarnessWorktree('ExitWorktree', { action: 'keep' }, `Left worktree ${CWD}/.claude/worktrees/x in place`).removed).toEqual([])
    expect(detectHarnessWorktree('ExitWorktree', { action: 'remove' }, 'Error: the worktree has uncommitted changes').removed).toEqual([])
  })
})

describe('shellOf', () => {
  it('reads Claude Bash, codex shell argv, a wrapped bash -lc, and a cwd under any of its names', () => {
    expect(shellOf({ command: 'ls', description: 'x' })).toEqual({ command: 'ls' })
    expect(shellOf({ command: ['git', 'status'], workdir: '/w' })).toEqual({ argv: ['git', 'status'], cwd: '/w' })
    expect(shellOf({ command: ['/bin/zsh', '-lc', 'git status && ls'], cwd: '/c' })).toEqual({ command: 'git status && ls', cwd: '/c' })
    expect(shellOf({ file_path: '/x' })).toBeNull()
    expect(shellOf(null)).toBeNull()
  })
})
