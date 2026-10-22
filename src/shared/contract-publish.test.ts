import { describe, expect, it } from 'vitest'
import type { MacPeerMethod } from './contract-macjobs'
import type { MacBridgePush } from './contract-macbridge'
import {
  PUBLISH_PEER_METHODS,
  PublishStartParamsSchema,
  PublishStopParamsSchema,
  isPublishPeerMethod
} from './contract-publish'

const caller = { environmentId: 'box', sessionId: 'thread' }
const args = { sha: 'a'.repeat(40), branch: 'master', version: '1.0.277', notes: 'Ship the fixes' }

describe('publish contract', () => {
  it('accepts both peer methods and their params in the Mac peer contract', () => {
    const methods: readonly MacPeerMethod[] = PUBLISH_PEER_METHODS
    expect(methods).toEqual(['publish.start', 'publish.stop'])
    for (const method of methods) expect(isPublishPeerMethod(method)).toBe(true)
    expect(isPublishPeerMethod('host.publish')).toBe(false)
    expect(PublishStartParamsSchema.parse({ caller, args })).toEqual({ caller, args })
    expect(PublishStopParamsSchema.parse({ caller, args: {} })).toEqual({ caller, args: {} })
    const push: MacBridgePush = {
      push: 'peer.call',
      method: 'publish.start',
      callId: 'c',
      deadlineMs: 1000,
      params: { caller, args }
    }
    expect(push.method).toBe('publish.start')
  })

  it.each([
    { ...args, sha: 'abc' },
    { ...args, sha: 'g'.repeat(40) },
    { ...args, version: '2.0.1' },
    { ...args, version: '1.0.N' },
    { ...args, branch: '' }
  ])('refuses malformed release args: %j', (bad) => {
    expect(PublishStartParamsSchema.safeParse({ caller, args: bad }).success).toBe(false)
  })

  it('requires a caller and args on both methods, with no stop args', () => {
    for (const schema of [PublishStartParamsSchema, PublishStopParamsSchema]) {
      expect(schema.safeParse({ args: {} }).success).toBe(false)
      expect(schema.safeParse({ caller }).success).toBe(false)
      expect(schema.safeParse({ caller: { ...caller, sessionId: '' }, args: {} }).success).toBe(
        false
      )
    }
    expect(PublishStopParamsSchema.safeParse({ caller, args: { sha: args.sha } }).success).toBe(
      false
    )
  })
})
