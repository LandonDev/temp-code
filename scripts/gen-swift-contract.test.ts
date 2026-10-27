import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { METHOD_CAPABILITY } from '../src/shared/capabilities'
import * as W from '../src/shared/wireSchemas'
import { SUBSET, generate, jsonSchemas, method, pascal, type } from './gen-swift-contract'

// The generator's rules, pinned on the generated text: the box cannot build
// Swift, so the names a sibling codes against are proven here.

const files = generate()
const pushNames = W.RemotePushSchema.options.map((o) => o.shape.push.value)

const camel = (text: string): string => {
  const p = pascal(text)
  return p[0].toLowerCase() + p.slice(1)
}

describe('named types', () => {
  it('emits BuildFacts once and every build field reads it', () => {
    expect(files['Types.swift'].match(/public struct BuildFacts\b/g)).toHaveLength(1)
    expect(files['ServerPush.swift']).toContain('public let build: BuildFacts?')
    expect(files['Types.swift']).toContain('public let build: BuildFacts?')
    expect(files['Types.swift']).not.toMatch(/public struct Build\b/)
  })
  it('emits NoticeKind as an enum with an unknown case, and the notice row reads it', () => {
    const enums = files['Enums.swift']
    const start = enums.indexOf('public enum NoticeKind')
    expect(start).toBeGreaterThan(-1)
    const body = enums.slice(start, enums.indexOf('\n}\n', start))
    for (const c of ['case review', 'case gate', 'case batch', 'case accountGone', 'case unknown(String)'])
      expect(body).toContain(c)
    expect(files['AgentEvent.swift']).toContain('public let kind: NoticeKind')
  })
  it('keeps the FailureKind fallback as unrecognized and every other enum as unknown', () => {
    const enums = files['Enums.swift']
    const failure = enums.slice(enums.indexOf('public enum FailureKind'), enums.indexOf('public enum Failure', enums.indexOf('public enum FailureKind') + 1))
    expect(failure).toContain('case unknown\n')
    expect(failure).toContain('case unrecognized(String)')
    const status = enums.slice(enums.indexOf('public enum SessionStatus'), enums.indexOf('public enum PermissionPolicy'))
    expect(status).toContain('case unknown(String)')
    expect(status).not.toContain('unrecognized')
  })
})

describe('the subset', () => {
  it('refuses a local-only method', () => {
    const subset = [...SUBSET, method('host.publish', z.null())]
    expect(() => jsonSchemas(subset)).toThrow('host.publish is local-only (capabilities.ts); a phone can never call it')
    expect(() => jsonSchemas()).not.toThrow()
  })
  it('names a capability a client key can hold for every method', () => {
    for (const entry of SUBSET) {
      if (entry.kind !== 'method') continue
      const cap = METHOD_CAPABILITY[entry.method as keyof typeof METHOD_CAPABILITY]
      expect(cap, entry.method).toBeDefined()
      expect(cap, entry.method).not.toBe('local')
    }
  })
  it('gives every remote push a case and keeps the unknown default', () => {
    const swift = files['ServerPush.swift']
    for (const name of pushNames) expect(swift).toContain(`case ${camel(name)}(${pascal(name)}Push)`)
    expect(swift).toContain('default: self = .unknown(try JSONValue(from: decoder))')
    expect(pushNames).toEqual(expect.arrayContaining(['notes', 'batch', 'resources', 'boot-resume', 'accounts', 'host.devices', 'host-log', 'macBridge.held']))
  })
  it('is deterministic and writes exactly six files', () => {
    expect(generate()).toEqual(files)
    expect(Object.keys(files).sort()).toEqual(['AgentEvent.swift', 'Contract.swift', 'Enums.swift', 'Methods.swift', 'ServerPush.swift', 'Types.swift'])
  })
  it('emits a nullable method output as an optional typealias', () => {
    const methods = files['Methods.swift']
    expect(methods).toContain('public typealias Output = ProjectPlanState?')
    expect(methods).toContain('public typealias Output = MilestoneLink?')
    expect(methods).toContain('public typealias Output = [HostDevicesHost]')
    const subset = [type('Thing', z.object({ a: z.string() })), method('session.rename', z.object({ a: z.string() }).nullable())]
    expect(() => generate(subset)).not.toThrow()
  })
  it('never aliases a type to itself', () => {
    for (const [file, text] of Object.entries(files))
      for (const [, a, b] of text.matchAll(/typealias (\w+) = ([\w.]+)$/gm)) expect(`${file}: ${a}`).not.toBe(`${file}: ${b}`)
    // queue.add answers a tagged union: it is declared as the Output, with no alias
    const queueAdd = files['Methods.swift'].split('public enum QueueAdd: ContractMethod')[1].split('public enum QueueRemove')[0]
    expect(queueAdd).toContain('public enum Output: Codable, Hashable, Sendable')
    expect(queueAdd).not.toContain('typealias Output')
  })
  it('names a wrapped anonymous output Value, never Output', () => {
    const union = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a'), x: z.string() }), z.object({ kind: z.literal('b') })])
    const of = (out: z.ZodType) => generate([method('session.rename', out)])['Methods.swift']
    expect(of(union)).toContain('public enum Output: Codable')
    expect(of(union)).not.toMatch(/typealias Output/)
    expect(of(union.nullable())).toContain('public enum Value: Codable')
    expect(of(union.nullable())).toContain('public typealias Output = Value?')
    expect(of(z.array(union))).toContain('public typealias Output = [Value]')
    expect(of(z.enum(['x', 'y']).nullable())).toContain('public typealias Output = Value?')
  })
  it('names the method types siblings code against', () => {
    const methods = files['Methods.swift']
    for (const name of [
      'BatchGet', 'SessionNotesGet', 'ProjectPlanGet', 'ReviewGet', 'ResourcesList', 'SessionChanges', 'HostDevicesHosts',
      'HostDeployStatus', 'HostLog', 'MacBridgeThreadGet', 'AccountsList', 'NotesSearch', 'PlanImplement', 'PlansGet',
      'SessionSetMaster', 'SessionStart', 'SessionBatch'
    ])
      expect(methods).toContain(`public enum ${name}: ContractMethod`)
    // a method type that shadows a top-level name reaches it qualified
    expect(methods).toContain('public typealias Output = TempCodeContract.SessionChanges')
  })
  it('names the batch and device structs with their nested shapes', () => {
    const types = files['Types.swift']
    for (const name of ['BatchStepSpec', 'BatchStep', 'BatchRules', 'BatchState', 'BatchAdoptResult', 'ThreadResource', 'HostDevicesReport', 'AccountsSnapshot', 'ReviewFinding'])
      expect(types).toContain(`public struct ${name}: Codable`)
    expect(types).toContain('public let blocked: Blocked?')
    expect(types).toContain('public let progress: Progress?')
    expect(types).toContain('public let providers: Providers')
    expect(types).toContain('case confirmed')
    expect(types).not.toContain('cONFIRMED')
  })
})
