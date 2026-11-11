import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from './contract'
import { ComputerAppVerdictSchema, ComputerSettingsPatchSchema, ComputerSettingsSchema } from './contract-computer'

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
    expect(ComputerSettingsSchema.safeParse({ sessionIdleMs: 120_000, apps: [app] }).success).toBe(true)
    expect(ComputerAppVerdictSchema.safeParse({ ...app, classes: { click: 'screen' } }).success).toBe(false)
  })
})
