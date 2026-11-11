import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import {
  COMPUTER_STEP_KINDS,
  COMPUTER_STEP_STATES,
  ComputerAppVerdictSchema,
  ComputerHistoryCallSchema,
  ComputerHistoryStepSchema,
  ComputerSettingsPatchSchema,
  ComputerSettingsSchema,
  HISTORY_PICTURE_NONE,
  HISTORY_READ_MAX_KEYS
} from './contract-computer'

const req = (method: string, params: unknown) => ClientRequestSchema.safeParse({ id: '1', method, params })

describe('Settings → Computer use wire', () => {
  it('takes the threshold inside the scheduler bounds, and nothing at all', () => {
    expect(ComputerSettingsPatchSchema.safeParse({ sessionIdleMs: 5_000 }).success).toBe(true)
    expect(ComputerSettingsPatchSchema.safeParse({ sessionIdleMs: 3_600_000 }).success).toBe(true)
    expect(ComputerSettingsPatchSchema.safeParse({}).success).toBe(true)
    expect(req('computer.settings.set', { sessionIdleMs: 120_000 }).success).toBe(true)
  })

  it('refuses a threshold under 5 s, over an hour or not whole', () => {
    expect(req('computer.settings.set', { sessionIdleMs: 4_999 }).success).toBe(false)
    expect(req('computer.settings.set', { sessionIdleMs: 3_600_001 }).success).toBe(false)
    expect(req('computer.settings.set', { sessionIdleMs: 60_000.5 }).success).toBe(false)
  })

  it('forgets one app by bundle id or every app with null, never an empty id', () => {
    expect(req('computer.verdicts.forget', { bundleId: 'com.apple.TextEdit' }).success).toBe(true)
    expect(req('computer.verdicts.forget', { bundleId: null }).success).toBe(true)
    expect(req('computer.verdicts.forget', { bundleId: '' }).success).toBe(false)
    expect(req('computer.verdicts.forget', {}).success).toBe(false)
  })

  it('parses the reads with no params', () => {
    for (const m of ['computer.settings.get', 'computer.permissions', 'computer.service.retry']) expect(req(m, {}).success).toBe(true)
  })

  it('carries an app with no name and only the classes it learned', () => {
    const app = { bundleId: 'com.apple.TextEdit', name: null, classes: { click: 'session' }, updatedAt: 1 }
    expect(ComputerAppVerdictSchema.parse(app)).toEqual(app)
    expect(ComputerSettingsSchema.safeParse({ sessionIdleMs: 120_000, activeApp: 'brief', keepPictures: true, apps: [app] }).success).toBe(true)
    expect(ComputerSettingsSchema.safeParse({ sessionIdleMs: 120_000, activeApp: 'ask', keepPictures: true, apps: [] }).success).toBe(false)
    // the pictures switch is part of what the page reads
    expect(ComputerSettingsSchema.safeParse({ sessionIdleMs: 120_000, activeApp: 'brief', apps: [] }).success).toBe(false)
    expect(ComputerAppVerdictSchema.safeParse({ ...app, classes: { click: 'screen' } }).success).toBe(false)
  })

  it('the pictures switch is a boolean on the patch, alone or with the rest', () => {
    expect(req('computer.settings.set', { keepPictures: false }).success).toBe(true)
    expect(req('computer.settings.set', { keepPictures: true, sessionIdleMs: 120_000 }).success).toBe(true)
    expect(req('computer.settings.set', { keepPictures: 'off' }).success).toBe(false)
  })
})

describe("the thread's computer history on the wire", () => {
  it('a read names 1 to 64 keys, and pages one key by a call number', () => {
    expect(req('computer.history.read', { keys: ['t1'] }).success).toBe(true)
    expect(req('computer.history.read', { keys: ['t1', 'mac:env_1:t2'] }).success).toBe(true)
    expect(req('computer.history.read', { keys: Array.from({ length: HISTORY_READ_MAX_KEYS }, (_, i) => `t${i}`) }).success).toBe(true)
    expect(req('computer.history.read', { keys: ['t1'], before: 201 }).success).toBe(true)
    expect(req('computer.history.read', { keys: [] }).success).toBe(false)
    expect(req('computer.history.read', { keys: Array.from({ length: HISTORY_READ_MAX_KEYS + 1 }, (_, i) => `t${i}`) }).success).toBe(false)
    expect(req('computer.history.read', { keys: [''] }).success).toBe(false)
    expect(req('computer.history.read', {}).success).toBe(false)
    // a page is one key's
    expect(req('computer.history.read', { keys: ['t1', 't2'], before: 201 }).success).toBe(false)
    expect(req('computer.history.read', { keys: ['t1'], before: 0 }).success).toBe(false)
    expect(req('computer.history.read', { keys: ['t1'], before: 1.5 }).success).toBe(false)
  })

  it('a step names a key and a call, and no path', () => {
    expect(req('computer.history.step', { key: 't1', n: 3 }).success).toBe(true)
    expect(req('computer.history.step', { key: '', n: 3 }).success).toBe(false)
    expect(req('computer.history.step', { key: 't1', n: 0 }).success).toBe(false)
    expect(req('computer.history.step', { key: 't1' }).success).toBe(false)
  })

  it('a step and a call parse as the journal folds them', () => {
    const step = { kind: 'click', verb: 'Clicked', object: 'Save', inApp: 'Save in TextEdit', state: 'ok', tier: 'ax', target: 'a button in the "Save As" sheet', facts: ['nothing changed'], element: 44 }
    expect(ComputerHistoryStepSchema.parse(step)).toEqual(step)
    // a planned step has no state yet
    expect(ComputerHistoryStepSchema.safeParse({ kind: 'read', verb: 'Reading', object: '', inApp: 'TextEdit' }).success).toBe(true)
    expect(ComputerHistoryStepSchema.safeParse({ ...step, kind: 'poke' }).success).toBe(false)
    expect(ComputerHistoryStepSchema.safeParse({ ...step, state: 'done' }).success).toBe(false)
    expect([...COMPUTER_STEP_KINDS]).toEqual(['click', 'type', 'key', 'scroll', 'read', 'look', 'wait', 'app'])
    expect([...COMPUTER_STEP_STATES]).toEqual(['ok', 'failed', 'not-run', 'stopped'])
    const call = { n: 1, turn: 1, at: 10, endedAt: 20, state: 'done', app: 'TextEdit', window: 'Untitled', steps: [step], read: 'Read 3 changes', text: true, picture: { width: 960, height: 804, at: 21 }, rev: 3 }
    expect(ComputerHistoryCallSchema.parse(call)).toEqual(call)
    for (const none of HISTORY_PICTURE_NONE) expect(ComputerHistoryCallSchema.safeParse({ ...call, picture: { none } }).success, none).toBe(true)
    expect(ComputerHistoryCallSchema.safeParse({ ...call, picture: { none: 'lost' } }).success).toBe(false)
    expect(ComputerHistoryCallSchema.safeParse({ ...call, state: 'stopped' }).success).toBe(false)
    expect(ComputerHistoryCallSchema.safeParse({ ...call, rev: 0 }).success).toBe(false)
    const running = { n: 2, turn: 1, at: 30, state: 'running', app: '', window: null, steps: [], plan: ['click button "To"', 'press super+Return'], text: false, rev: 1 }
    expect(ComputerHistoryCallSchema.parse(running)).toEqual(running)
  })
})
