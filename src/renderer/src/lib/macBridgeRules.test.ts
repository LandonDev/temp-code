import { describe, expect, it } from 'vitest'
import type { MacBridgeRequest } from '@server/shared/contract-macbridge'
import type { MacBridgeRule } from '@server/shared/contract-macbridge-rules'
import { chipMenuItems } from '../chrome/ThreadHeader'
import type { StripChip } from '../chrome/ThreadHeaderStrip'
import { ruleText, runRememberOptions } from './macBridgeRules'

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
      "a 'b c'  (in /x)"
    )
    expect(ruleText(rule({ kind: 'read-folder', folder: '/r' })).what).toBe('Reads in')
  })
})

describe('chipMenuItems: Mac approvals', () => {
  const chip = {
    id: 't1',
    status: 'idle',
    thread: { id: 't1', title: 't' }
  } as unknown as StripChip
  const ids = (macPeer: string | null) =>
    chipMenuItems(chip, {
      state: { sessionId: 't1', macPeer, inherited: false, online: true, registered: [] }
    }).map((i) => (i.kind === 'item' ? i.id : '-'))
  it('only with the bridge on', () => {
    expect(ids('env_mac')).toContain('mac-bridge-rules')
    expect(ids(null)).not.toContain('mac-bridge-rules')
  })
})
