import { describe, expect, it } from 'vitest'
import {
  CROSS_HOST_PEER_METHODS,
  CROSS_HOST_REPORT_METHODS,
  CrossHostLandingSchema,
  CrossHostRequestSchemas,
  THREAD_ARGS_SCHEMAS,
  decodeAgentId,
  encodeAgentId,
  isCrossHostPeerMethod,
  isRemoteAgentId
} from './contract-crosshost'

const MAC = `env_${'m'.repeat(22)}`

describe('agent ids across hosts', () => {
  it('encodes <environmentId>:<sessionId> and decodes it back', () => {
    const id = encodeAgentId(MAC, 'abc123_-XYZ')
    expect(id).toBe(`${MAC}:abc123_-XYZ`)
    expect(decodeAgentId(id)).toEqual({ environmentId: MAC, sessionId: 'abc123_-XYZ' })
    expect(isRemoteAgentId(id)).toBe(true)
  })
  it('a local id (no colon) decodes to null', () => {
    expect(decodeAgentId('abc123XYZ_-9')).toBeNull()
    expect(isRemoteAgentId('abc123XYZ_-9')).toBe(false)
  })
  it('refuses an id whose host part is not an environment id or whose session part is empty', () => {
    expect(() => decodeAgentId('mac:abc')).toThrow('not an agent id')
    expect(() => decodeAgentId(`${MAC}:`)).toThrow('not an agent id')
    expect(() => decodeAgentId(`${MAC}:a/b`)).toThrow('not an agent id')
    expect(isRemoteAgentId('mac:abc')).toBe(false)
  })
})

describe('the thread.* peer methods', () => {
  it('names every method once and nothing of the Mac bridge', () => {
    expect(new Set(CROSS_HOST_PEER_METHODS).size).toBe(CROSS_HOST_PEER_METHODS.length)
    for (const m of CROSS_HOST_PEER_METHODS) expect(m.startsWith('thread.')).toBe(true)
    expect(isCrossHostPeerMethod('thread.wait')).toBe(true)
    expect(isCrossHostPeerMethod('thread.archive')).toBe(true)
    expect(isCrossHostPeerMethod('mac.run')).toBe(false)
  })
  it('every peer method is also a request on a listener, with the same args schema and a caller', () => {
    const requests = new Map(CrossHostRequestSchemas.map((s) => [s.shape.method.value, s]))
    for (const m of CROSS_HOST_PEER_METHODS) {
      const schema = requests.get(m)
      expect(schema, m).toBeDefined()
      const params = schema!.shape.params as unknown as { shape: Record<string, unknown> }
      expect(Object.keys(params.shape).sort()).toEqual(['args', 'caller'])
      expect(params.shape.args).toBe(THREAD_ARGS_SCHEMAS[m])
    }
    for (const m of CROSS_HOST_REPORT_METHODS) expect(requests.has(m), m).toBe(true)
  })
  it('a landing names its phase, and the sha only on landed', () => {
    const base = { from: MAC, sessionId: 's1', masterId: 'm1', branch: 'b', target: 'master', subjects: ['one'] }
    expect(CrossHostLandingSchema.parse({ ...base, phase: 'ask' }).phase).toBe('ask')
    expect(CrossHostLandingSchema.parse({ ...base, phase: 'landed', sha: 'abc' }).sha).toBe('abc')
    expect(() => CrossHostLandingSchema.parse({ ...base, phase: 'merged' })).toThrow()
  })
})
