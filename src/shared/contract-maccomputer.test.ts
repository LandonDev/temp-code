import { describe, expect, it } from 'vitest'
import { MAC_APPROVAL_WAIT_MS, heldLine, type MacBridgeHeld } from './contract-macbridge'
import {
  COMPUTER_HOLD_MAX_MS,
  COMPUTER_SESSION_WAIT_MS,
  ComputerPeerAnswerSchema,
  ComputerPeerProgressSchema,
  MacComputerCallArgsSchema,
  MacComputerEndArgsSchema,
  bridgedDeadlineMs,
  computerCallBudgetMs,
  isMacComputerPeerMethod,
  macComputerKey,
  parseMacComputerKey
} from './contract-maccomputer'
import type { ComputerToolCall } from './computer/tools'

const ENV = 'env_abcdefghijklmnopqrstuv'
const row = { threadId: 't1', since: 1, lastCallAt: 2, apps: [{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', window: 'Untitled' }], running: null, tier: null }
const observe: ComputerToolCall = { tool: 'computer_observe', args: { app: 'TextEdit' }, threadId: 't1', permission: 'safe' }

describe('the bridge payloads', () => {
  it('takes a call with its turn and root, and refuses one without', () => {
    expect(MacComputerCallArgsSchema.safeParse({ call: observe, turn: 'b:1', rootId: 'r' }).success).toBe(true)
    expect(MacComputerCallArgsSchema.safeParse({ call: observe, turn: '', rootId: 'r' }).success).toBe(false)
    expect(MacComputerCallArgsSchema.safeParse({ call: { ...observe, tool: 'computer_fly' }, turn: 'b:1', rootId: 'r' }).success).toBe(false)
    expect(MacComputerCallArgsSchema.safeParse({ call: { ...observe, permission: 'yolo' }, turn: 'b:1', rootId: 'r' }).success).toBe(false)
  })

  it('ends a session for one of three reasons', () => {
    for (const reason of ['settled', 'stopped', 'ended']) expect(MacComputerEndArgsSchema.safeParse({ reason }).success).toBe(true)
    expect(MacComputerEndArgsSchema.safeParse({ reason: 'bored' }).success).toBe(false)
  })

  it('reads an answer with its steps, body, pictures and row', () => {
    const answer = {
      steps: ['1. left_click [4] · ax · changed'],
      body: 'TextEdit "Untitled"',
      isError: false,
      images: [{ label: 'observation', data: 'aGk=', mimeType: 'image/jpeg', width: 10, height: 20 }],
      row
    }
    expect(ComputerPeerAnswerSchema.parse(answer)).toEqual(answer)
    expect(ComputerPeerAnswerSchema.parse({ ...answer, body: null, away: true, row: null }).away).toBe(true)
    expect(ComputerPeerAnswerSchema.safeParse({ ...answer, away: false }).success).toBe(false)
    expect(ComputerPeerAnswerSchema.safeParse({ ...answer, images: [{ label: 'x', data: '', mimeType: 'image/png', width: 0, height: 1 }] }).success).toBe(false)
    expect(ComputerPeerAnswerSchema.safeParse({ steps: [], body: null, isError: false, images: [] }).success).toBe(false)
  })

  it('reads a progress row, the mirror fields included', () => {
    const mirrored = { ...row, macPeer: ENV, macName: 'Mac', asking: { line: 'Click button "Save"?' } }
    expect(ComputerPeerProgressSchema.parse({ row: mirrored }).row.asking?.line).toBe('Click button "Save"?')
    expect(ComputerPeerProgressSchema.safeParse({ row: { threadId: 't1' } }).success).toBe(false)
  })

  it('names its peer methods', () => {
    expect(isMacComputerPeerMethod('mac.computer')).toBe(true)
    expect(isMacComputerPeerMethod('mac.computerEnd')).toBe(true)
    expect(isMacComputerPeerMethod('mac.run')).toBe(false)
  })
})

describe('the session key', () => {
  it('round-trips a box and a thread', () => {
    const key = macComputerKey(ENV, 'abc:def')
    expect(key).toBe(`${ENV}:abc:def`)
    expect(parseMacComputerKey(key)).toEqual({ envId: ENV, threadId: 'abc:def' })
  })

  it('refuses a key whose host is not an environment id', () => {
    expect(parseMacComputerKey('box:thread')).toBeNull()
    expect(parseMacComputerKey('thread')).toBeNull()
    expect(parseMacComputerKey(`${ENV}:`)).toBeNull()
  })
})

describe('deadlines', () => {
  it('gives a call 60 s plus its durations, at most 600 s', () => {
    expect(computerCallBudgetMs(observe)).toBe(60_000)
    const wait: ComputerToolCall = { tool: 'computer_act', args: { app: 'TextEdit', action: 'wait', duration: 300 }, threadId: 't1', permission: 'auto' }
    expect(computerCallBudgetMs(wait)).toBe(360_000)
    const waits: ComputerToolCall = {
      tool: 'computer_batch',
      args: { app: 'TextEdit', actions: [1, 2, 3].map(() => ({ action: 'wait' as const, duration: 300 })) },
      threadId: 't1',
      permission: 'auto'
    }
    expect(computerCallBudgetMs(waits)).toBe(600_000)
  })

  it('leaves room for the card, the line, the scheduler and the reply', () => {
    expect(bridgedDeadlineMs(observe)).toBe(MAC_APPROVAL_WAIT_MS + COMPUTER_HOLD_MAX_MS + COMPUTER_SESSION_WAIT_MS + 60_000 + 30_000)
  })
})

describe('the held line', () => {
  it('names the computer cap', () => {
    const held: MacBridgeHeld = { reason: 'computer', position: 1, load: 1, limit: 16, cores: 8, maxRunning: 4, running: 2, computer: 2, maxComputer: 2 }
    expect(heldLine(held)).toBe('Waiting for the Mac, 2 of 2 computer sessions, 1st in line')
  })
})
