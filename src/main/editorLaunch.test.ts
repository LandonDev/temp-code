import { describe, expect, it } from 'vitest'
import {
  EDITOR_SETTING_KEY,
  EditorLauncher,
  chooseEditor,
  editorArgs,
  editorChoice,
  isSwiftUnderIos,
  type EditorId,
  type EditorLaunchDeps
} from './editorLaunch'

const ALL = { idea: true, code: true, xed: true }

function harness(options: { setting?: string | null; installed?: Partial<Record<EditorId, boolean>> } = {}) {
  const settings = new Map<string, string>()
  if (options.setting) settings.set(EDITOR_SETTING_KEY, options.setting)
  const installed = { ...ALL, ...options.installed }
  const spawned: { command: string; args: string[] }[] = []
  const resolved: EditorId[] = []
  const deps: EditorLaunchDeps = {
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => {
      if (value === null) settings.delete(key)
      else settings.set(key, value)
    },
    resolve: async (editor) => {
      resolved.push(editor)
      return installed[editor] ? `/bin/${editor}` : null
    },
    spawn: async (command, args) => {
      spawned.push({ command, args })
    }
  }
  return { launcher: new EditorLauncher(deps), spawned, resolved, settings }
}

describe('editorArgs', () => {
  it('shapes the arguments per editor, with and without a line', () => {
    expect(editorArgs('idea', { path: '/p/a.ts', line: 12 })).toEqual(['--line', '12', '/p/a.ts'])
    expect(editorArgs('idea', { path: '/p/a.ts', line: 12, column: 4 })).toEqual(['--line', '12', '--column', '4', '/p/a.ts'])
    expect(editorArgs('idea', { path: '/p/a.ts' })).toEqual(['/p/a.ts'])
    expect(editorArgs('code', { path: '/p/a.ts', line: 12 })).toEqual(['-g', '/p/a.ts:12'])
    expect(editorArgs('code', { path: '/p/a.ts', line: 12, column: 4 })).toEqual(['-g', '/p/a.ts:12:4'])
    expect(editorArgs('code', { path: '/p/a.ts' })).toEqual(['-g', '/p/a.ts'])
    expect(editorArgs('xed', { path: '/p/A.swift', line: 7 })).toEqual(['-l', '7', '/p/A.swift'])
    expect(editorArgs('xed', { path: '/p/A.swift' })).toEqual(['/p/A.swift'])
  })
  it('ignores a column without a line and a non-positive line', () => {
    expect(editorArgs('idea', { path: '/p/a.ts', column: 4 })).toEqual(['/p/a.ts'])
    expect(editorArgs('code', { path: '/p/a.ts', line: 0 })).toEqual(['-g', '/p/a.ts'])
  })
})

describe('chooseEditor', () => {
  it('honours the configured editor when installed and falls back in order', () => {
    expect(chooseEditor('code', ALL, '/p/a.ts')).toBe('code')
    expect(chooseEditor('auto', ALL, '/p/a.ts')).toBe('idea')
    expect(chooseEditor('auto', { idea: false, code: true, xed: true }, '/p/a.ts')).toBe('code')
    expect(chooseEditor('idea', { idea: false, code: false, xed: true }, '/p/a.ts')).toBe('xed')
    expect(chooseEditor('auto', { idea: false, code: false, xed: false }, '/p/a.ts')).toBeNull()
  })
  it('prefers Xcode for Swift under ios/ when Xcode is configured or IDEA is absent', () => {
    const swift = '/Users/me/IdeaProjects/temp-code/ios/TempCode/Sources/App.swift'
    expect(isSwiftUnderIos(swift)).toBe(true)
    expect(isSwiftUnderIos('/p/ios/README.md')).toBe(false)
    expect(isSwiftUnderIos('/p/Sources/App.swift')).toBe(false)
    expect(chooseEditor('xed', ALL, swift)).toBe('xed')
    expect(chooseEditor('auto', { idea: false, code: true, xed: true }, swift)).toBe('xed')
    expect(chooseEditor('code', { idea: false, code: true, xed: true }, swift)).toBe('xed')
    // IDEA installed and chosen (or auto): the Swift file stays with IDEA.
    expect(chooseEditor('auto', ALL, swift)).toBe('idea')
    expect(chooseEditor('code', ALL, swift)).toBe('code')
    // Xcode wanted but missing: the ordinary rule applies.
    expect(chooseEditor('xed', { idea: false, code: true, xed: false }, swift)).toBe('code')
  })
})

describe('EditorLauncher', () => {
  it('reads and writes the setting, auto when unset or unknown', () => {
    const { launcher, settings } = harness()
    expect(launcher.choice()).toBe('auto')
    launcher.setChoice('code')
    expect(settings.get(EDITOR_SETTING_KEY)).toBe('code')
    expect(launcher.choice()).toBe('code')
    launcher.setChoice('auto')
    expect(settings.has(EDITOR_SETTING_KEY)).toBe(false)
    expect(editorChoice('vim')).toBe('auto')
  })
  it('spawns the configured launcher with the editor argument shape', async () => {
    const { launcher, spawned } = harness({ setting: 'code' })
    await expect(launcher.open({ path: '/p/a.ts', line: 3 })).resolves.toEqual({ editor: 'code' })
    expect(spawned).toEqual([{ command: '/bin/code', args: ['-g', '/p/a.ts:3'] }])
  })
  it('resolves each launcher once and reports what is installed', async () => {
    const { launcher, resolved } = harness({ installed: { code: false } })
    const config = await launcher.config()
    expect(config).toEqual({ editor: 'auto', installed: { idea: true, code: false, xed: true }, effective: 'idea' })
    await launcher.open({ path: '/p/a.ts' })
    expect(resolved).toEqual(['idea', 'code', 'xed'])
    launcher.refresh()
    await launcher.installed()
    expect(resolved).toHaveLength(6)
  })
  it('rejects when nothing is installed', async () => {
    const { launcher, spawned } = harness({ installed: { idea: false, code: false, xed: false } })
    await expect(launcher.open({ path: '/p/a.ts' })).rejects.toThrow(/No editor found/)
    expect(spawned).toEqual([])
  })
})
