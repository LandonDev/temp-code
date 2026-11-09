import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  stopOnSignals,
  argvFromPs,
  carriesNonce,
  disabledSkillPaths,
  hasSkillSet,
  isLoopbackTarget,
  listingVerdict,
  skillListing
} from './skillsDriversProof'

describe('skills driver request evidence', () => {
  it('never treats a user prompt as the skill listing', () => {
    const b = {
      messages: [{ role: 'user', content: 'tc-e2e-probe' }],
      input: [{ role: 'user', content: 'tc-e2e-probe' }]
    }
    for (const provider of ['claude', 'codex', 'muse'] as const)
      expect(listingVerdict(skillListing(b, provider)).probe).toBe(false)
  })
  it('checks Claude tool listings and rejects prefixed names and home skills', () => {
    const listing = skillListing(
      { tools: [{ name: 'Skill', description: 'tc-e2e-probe: use this probe' }] },
      'claude'
    )
    expect(listingVerdict(listing)).toEqual({ probe: true, bare: true, homeAbsent: true })
    expect(listingVerdict('plugin:tc-e2e-probe tc-home-only')).toEqual({
      probe: true,
      bare: false,
      homeAbsent: false
    })
  })
  it('checks Responses developer instructions and skill bodies', () => {
    const b = {
      instructions: 'tc-e2e-probe',
      input: [
        { role: 'developer', content: 'tc-home-only' },
        { role: 'tool', content: 'N2-unique' }
      ]
    }
    expect(listingVerdict(skillListing(b, 'codex'))).toEqual({
      probe: true,
      bare: true,
      homeAbsent: false
    })
    expect(carriesNonce(b, 'N2-unique')).toBe(true)
    expect(carriesNonce(b, 'N3-unique')).toBe(false)
  })
})

describe('live app-server argv evidence', () => {
  const config =
    'skills.config=[{path="/tmp/home with spaces/.codex/skills/probe/SKILL.md",enabled=false},{path="/tmp/home/.agents/skills/quote\\\"/SKILL.md",enabled=false}]'
  it('parses every disabled path from a real config pair', () => {
    expect(disabledSkillPaths(['codex', '-c', config, 'app-server'])).toEqual([
      '/tmp/home with spaces/.codex/skills/probe/SKILL.md',
      '/tmp/home/.agents/skills/quote"/SKILL.md'
    ])
    expect(disabledSkillPaths(['--config', config])).toHaveLength(2)
  })
  it('does not count paths in text or enabled entries', () => {
    expect(
      disabledSkillPaths([
        'codex',
        config,
        '-c',
        'skills.config=[{path="/a",enabled=true}]',
        'app-server'
      ])
    ).toEqual([])
  })
  it('recovers the config pair from macOS ps output', () => {
    expect(
      disabledSkillPaths(
        argvFromPs(`/bin/codex -c ${config} app-server TEMP_CODE_USER_DATA=/tmp/data`)
      )
    ).toHaveLength(2)
  })
})

it('accepts only loopback origins and rejects lookalikes and bad URLs', () => {
  for (const origin of ['http://127.0.0.1:123', 'https://localhost:9', 'http://[::1]:12'])
    expect(isLoopbackTarget(origin)).toBe(true)
  for (const origin of ['https://127.0.0.1.evil.test', 'https://api.anthropic.com', 'bad'])
    expect(isLoopbackTarget(origin)).toBe(false)
})

it('rejects a skill set on any harness status environment', () => {
  expect(hasSkillSet({ environments: [{ sets: null }, { sets: { rules: 1 } }] })).toBe(false)
  expect(hasSkillSet({ environments: [{ sets: { rules: 1 } }, { sets: { skills: 1 } }] })).toBe(
    true
  )
})

it('reads the skill list appended to Claude environment text, excluding the prompt', () => {
  const b = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Use tc-e2e-probe' }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '# Environment\nThe following skills are available for use with the Skill tool:\n\n- tc-e2e-probe: Probe.'
          }
        ]
      }
    ]
  }
  expect(listingVerdict(skillListing(b, 'claude'))).toEqual({
    probe: true,
    bare: true,
    homeAbsent: true
  })
})

it('resolves only the probe file advertised by the live Codex listing', async () => {
  const { advertisedSkillFile } = await import('./skillsDriversProof')
  expect(
    advertisedSkillFile({
      input: [
        {
          role: 'developer',
          content: [
            {
              text: '- `r1` = `/tmp/generation/skills`\n- tc-e2e-probe: Probe. (file: r1/tc-e2e-probe/SKILL.md)'
            }
          ]
        }
      ]
    })
  ).toBe('/tmp/generation/skills/tc-e2e-probe/SKILL.md')
  expect(
    advertisedSkillFile({
      input: [{ role: 'user', content: [{ text: '(file: /fake/tc-e2e-probe/SKILL.md)' }] }]
    })
  ).toBeNull()
})

it('keeps the accepted Muse home discovery gap visible with every listed id', async () => {
  const { museHomeGap } = await import('./skillsDriversProof')
  const gap = museHomeGap(
    {
      input: [
        {
          role: 'developer',
          content:
            '<skill id="tc-home-only" path="$HOME/.agents/skills/tc-home-only/SKILL.md"></skill><skill id="tc-late-home" path="$CODEX_HOME/skills/tc-late-home/SKILL.md" origin-family=".codex"></skill><skill id="tc-e2e-probe" path="$CONFIG_DIR/skills/tc-e2e-probe/SKILL.md"></skill>'
        }
      ]
    },
    '/tmp/home'
  )
  expect(gap.fail).toBe(false)
  expect(gap.ids).toEqual(['tc-home-only', 'tc-late-home'])
  expect(gap.message).toBe(
    'KNOWN GAP  muse: lists home skills of other harnesses (tc-home-only, tc-late-home); a host fix is pending'
  )
})

it('fails when the accepted Muse gap closes, without counting user text or the store probe', async () => {
  const { museHomeGap } = await import('./skillsDriversProof')
  const gap = museHomeGap(
    {
      input: [
        {
          role: 'developer',
          content:
            '<skill id="tc-e2e-probe" path="$CONFIG_DIR/skills/tc-e2e-probe/SKILL.md"></skill>'
        },
        {
          role: 'user',
          content:
            '<skill id="tc-home-only" path="$HOME/.agents/skills/tc-home-only/SKILL.md"></skill>'
        }
      ]
    },
    '/tmp/home'
  )
  expect(gap.fail).toBe(true)
  expect(gap.message).toBe(
    'KNOWN GAP CLOSED  muse no longer lists home skills: make this check strict'
  )
})

it('exempts only the exact Chromium dictionary host from its network service', async () => {
  const { isHousekeepingConnect } = await import('./skillsDriversProof')
  const chromium = [
    '/proc/self/exe',
    '--type=utility',
    '--utility-sub-type=network.mojom.NetworkService'
  ]
  expect(isHousekeepingConnect('redirector.gvt1.com:443', chromium)).toBe(true)
  expect(isHousekeepingConnect('redirector.gvt1.com:443', ['codex', 'app-server'])).toBe(false)
  for (const host of [
    'api.anthropic.com',
    'chatgpt.com',
    'api.openai.com',
    'api.meta.ai',
    'auth.meta.com',
    'claude.ai',
    'auth.openai.com',
    'redirector.gvt1.com.evil.test',
    'redirector.gvt1.com@chatgpt.com'
  ])
    expect(isHousekeepingConnect(`${host}:443`, chromium)).toBe(false)
  expect(isHousekeepingConnect('redirector.gvt1.com:80', chromium)).toBe(false)
})

describe('the rig under two stop signals', () => {
  it("keeps handling the wrapper's forwarded SIGTERM after the group's, and exits once its one cleanup settles", async () => {
    const events = new EventEmitter()
    let release!: () => void
    const cleaning = new Promise<void>((r) => (release = r))
    let cleanups = 0
    let cleaned: Promise<void> | undefined
    const cleanup = (): Promise<void> => (cleaned ??= (cleanups++, cleaning))
    const exits: number[] = []
    stopOnSignals(events, cleanup, (code) => exits.push(code))
    events.emit('SIGTERM')
    // The forwarded one arrives mid-cleanup: still handled, so no default termination.
    expect(events.listenerCount('SIGTERM')).toBe(1)
    events.emit('SIGTERM')
    expect(cleanups).toBe(1)
    expect(exits).toEqual([])
    release()
    await cleaning
    await Promise.resolve()
    expect(exits[0]).toBe(130)
  })
})
