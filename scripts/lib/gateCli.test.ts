import { describe, expect, it, vi } from 'vitest'
import { withToolPath } from '../../src/main/server/loginShell'
import {
  claudeJudgeFailure,
  composeGatePath,
  resolveGateCli,
  shellWord,
  type CliLookup
} from './gateCli'

const lookup = (changes: Partial<CliLookup> = {}): CliLookup => ({
  home: '/real/home',
  env: { HOME: '/different/home', PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
  platform: 'linux',
  probe: () => '',
  executable: () => false,
  ...changes
})

describe('gate CLI resolution under a sparse caller PATH', () => {
  it.each([
    ['/bin/bash', 'type -P claude'],
    ['/bin/zsh', 'whence -p claude'],
    ['/bin/sh', 'command -v claude']
  ])('uses %s with the real HOME and the app tool prelude', (shell, command) => {
    const probe = vi.fn(() => 'profile greeting\n/real/tool bin/claude\n')
    const env = { HOME: '/temporary/home', PATH: '/bin', SHELL: shell }
    expect(
      resolveGateCli(
        'claude',
        lookup({ env, probe, executable: (p) => p === '/real/tool bin/claude' })
      )
    ).toBe('/real/tool bin/claude')
    expect(probe).toHaveBeenCalledWith(shell, ['-lc', withToolPath(command, 'linux')], {
      ...env,
      HOME: '/real/home'
    })
    expect(env.HOME).toBe('/temporary/home')
  })

  it('falls back to caller PATH when the login probe fails', () => {
    expect(
      resolveGateCli(
        'codex',
        lookup({
          probe: () => {
            throw new Error('shell failed')
          },
          executable: (p) => p === '/usr/bin/codex'
        })
      )
    ).toBe('/usr/bin/codex')
  })

  it('finds npm-global Codex as the app does when the login profile omits it', () => {
    expect(
      resolveGateCli(
        'codex',
        lookup({ executable: (p) => p === '/real/home/.npm-global/bin/codex' })
      )
    ).toBe('/real/home/.npm-global/bin/codex')
  })

  it('prefers the login-shell binary to a different caller PATH binary', () => {
    expect(
      resolveGateCli(
        'muse',
        lookup({
          probe: () => '/real/home/.local/bin/muse',
          executable: (p) => ['/real/home/.local/bin/muse', '/usr/bin/muse'].includes(p)
        })
      )
    ).toBe('/real/home/.local/bin/muse')
  })

  it('fails the explicit Claude override without trying other sources', () => {
    const probe = vi.fn(() => '/usr/bin/codex')
    const config = lookup({
      env: { TC_SD_GATE_CLAUDE_BIN: '/missing/claude', PATH: '/usr/bin' },
      probe,
      executable: (p) => p === '/usr/bin/codex'
    })
    expect(resolveGateCli('claude', config)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    expect(resolveGateCli('codex', config)).toBe('/usr/bin/codex')
  })

  it('accepts an executable absolute override and rejects a relative one', () => {
    expect(
      resolveGateCli(
        'claude',
        lookup({ env: { TC_SD_GATE_CLAUDE_BIN: '/custom/claude' }, executable: () => true })
      )
    ).toBe('/custom/claude')
    expect(
      resolveGateCli(
        'claude',
        lookup({ env: { TC_SD_GATE_CLAUDE_BIN: 'claude' }, executable: () => true })
      )
    ).toBeNull()
  })

  it('returns missing without accepting a shell function or working-directory search', () => {
    expect(
      resolveGateCli(
        'claude',
        lookup({ env: { PATH: ':/bin' }, probe: () => 'claude', executable: (p) => p === 'claude' })
      )
    ).toBeNull()
  })
})

it('puts wrappers and all found CLI dirs before the caller PATH, once each', () => {
  expect(
    composeGatePath(
      ['/real/local/claude', '/real/npm/codex', '/real/local/muse', null],
      '/bin:/real/local::/usr/bin:/bin',
      '/rig/bin'
    )
  ).toBe('/rig/bin:/real/local:/real/npm:/bin:/usr/bin')
  expect(shellWord("/rig/bin:/tools with spaces:/literal/$(touch no):/it's/bin")).toBe(
    "'/rig/bin:/tools with spaces:/literal/$(touch no):/it'\\''s/bin'"
  )
})

it('requires Claude to judge even when both optional legs judged', () => {
  expect(claudeJudgeFailure([], 'binary missing')).toBe(
    'the Claude leg did not judge: binary missing'
  )
  expect(claudeJudgeFailure(['codex', 'muse'], 'unresolvable override')).toBe(
    'the Claude leg did not judge: unresolvable override'
  )
  expect(claudeJudgeFailure(['claude'], 'optional binaries missing')).toBeNull()
})
