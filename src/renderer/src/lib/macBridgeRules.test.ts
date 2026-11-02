import { describe, expect, it, vi } from 'vitest'
import { registry } from './connection/registry'
import type { EnvLink } from './connection/link'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import type { MacBridgeRule } from '@server/shared/contract-macbridge-rules'
import { startMacBridgeRules, ruleText, runRememberOptions } from './macBridgeRules'

const run = (extra: Partial<MacBridgeRequest> = {}): MacBridgeRequest => ({
  id: 'mb_1',
  environmentId: 'env_box',
  hostName: 'box',
  sessionId: 't1',
  threadTitle: 't',
  kind: 'run',
  method: 'mac.run',
  argv: ['make'],
  cwd: '/Users/me/app',
  createdAt: 0,
  expiresAt: 1,
  status: 'pending',
  ...extra
})

describe('runRememberOptions', () => {
  it('exact first, then what the request offers, thread, and ask every time', () => {
    expect(
      runRememberOptions(run({ folder: '/Users/me/app', program: 'make' })).map((o) => o.value)
    ).toEqual(['exact', 'folder', 'program', 'thread', 'ask'])
    expect(runRememberOptions(run()).map((o) => o.value)).toEqual(['exact', 'thread', 'ask'])
  })
  it('nothing for an always-ask command', () => {
    expect(runRememberOptions(run({ alwaysAsk: 'sudo' }))).toEqual([])
  })
})

describe('ruleText', () => {
  const rule = (r: Partial<MacBridgeRule>): MacBridgeRule => ({
    id: 'r',
    environmentId: 'env_box',
    hostName: 'box',
    sessionId: 't1',
    threadTitle: 't',
    kind: 'thread',
    createdAt: 0,
    uses: 0,
    ...r
  })
  it('names each kind', () => {
    expect(ruleText(rule({ kind: 'folder', folder: '/a' }))).toEqual({
      what: 'Commands in',
      detail: '/a'
    })
    expect(ruleText(rule({ kind: 'program', program: 'make' })).detail).toBe('make')
    expect(ruleText(rule({ kind: 'exact', argv: ['a', 'b c'], cwd: '/x' })).detail).toBe(
      "a 'b c' in /x"
    )
    expect(ruleText(rule({ kind: 'read-folder', folder: '/r' })).what).toBe('Reads in')
  })
})

describe('existing links', () => {
  it('attaches each of two open links once when installed', async () => {
    const links = ['env_box', 'env_other'].map((environmentId) => ({
      environmentId,
      connected: true,
      onPush: vi.fn(() => () => {}),
      onOpen: vi.fn(() => () => {}),
      request: vi.fn(async () => ({ resources: [] }))
    }))
    vi.spyOn(registry, 'links').mockReturnValue(links as unknown as EnvLink[])
    vi.spyOn(registry, 'onLink').mockImplementation((listener) => {
      for (const link of links) listener(link as unknown as EnvLink, 'added')
      return () => {}
    })
    try {
      startMacBridgeRules()
      startMacBridgeRules()
      await Promise.resolve()
      for (const link of links) {
        expect(link.onPush).toHaveBeenCalledTimes(1)
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})
