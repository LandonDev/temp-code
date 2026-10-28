import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { commandPathProbe, loginShell, withToolPath } from './loginShell'

describe('loginShell', () => {
  it('prefers $SHELL and falls back by platform', () => {
    expect(loginShell({ SHELL: '/usr/bin/fish' }, 'linux')).toBe('/usr/bin/fish')
    expect(loginShell({}, 'darwin')).toBe('/bin/zsh')
    expect(loginShell({}, 'linux')).toBe('/bin/bash')
  })
  it('probes a command path without shell functions in the way', () => {
    expect(commandPathProbe('codex', '/bin/zsh')).toBe('whence -p codex')
    expect(commandPathProbe('codex', '/bin/bash')).toBe('type -P codex')
    expect(commandPathProbe('codex', '/usr/bin/fish')).toBe('command -v codex')
  })
})

describe('withToolPath', () => {
  const run = (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string =>
    execFileSync('/bin/sh', ['-c', withToolPath(command, platform)], { env, encoding: 'utf8' })

  it('puts the macOS tool dirs first, in order, when PATH lacks them', () => {
    expect(run('echo "$PATH"', 'darwin', { HOME: '/h', PATH: '/usr/bin:/bin' }).trim()).toBe(
      '/h/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    )
  })

  it('puts the Linux tool dirs first elsewhere', () => {
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: '/usr/bin:/bin' }).trim()).toBe('/h/.bun/bin:/h/.local/bin:/usr/bin:/bin')
  })

  it('repeats no dir the PATH already has, so a full PATH is unchanged', () => {
    const path = '/h/.bun/bin:/h/.local/bin:/usr/bin'
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: path }).trim()).toBe(path)
    expect(run('echo "$PATH"', 'linux', { HOME: '/h', PATH: '/usr/bin:/h/.local/bin' }).trim()).toBe('/h/.bun/bin:/usr/bin:/h/.local/bin')
  })

  it('leaves the command and its arguments alone', () => {
    const out = execFileSync('/bin/sh', ['-c', withToolPath('printf "%s|" "$@"', 'linux'), 'sh', 'a b', 'c'], {
      env: { HOME: '/h', PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(out).toBe('a b|c|')
  })
})
