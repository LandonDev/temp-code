import { describe, expect, it } from 'vitest'
import { commandPathProbe, loginShell } from './loginShell'

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
