import { afterEach, describe, expect, it } from 'vitest'
import {
  CATALOG,
  compareVersions,
  isMetaModel,
  modelInfo,
  resolveModel,
  runnableHere,
  setInstalledCodexVersion,
  supportsContext1m,
  visibleCatalog
} from './catalog'

describe('resolveModel', () => {
  it('an empty id is the provider default; a known id stays; another provider\'s id routes there', () => {
    expect(resolveModel('claude', '')).toEqual({ provider: 'claude', model: CATALOG.claude.defaultModel })
    expect(CATALOG.claude.defaultModel).toBe('claude-fable-5-1')
    expect(resolveModel('claude', 'claude-opus-5-5')).toEqual({ provider: 'claude', model: 'claude-opus-5-5' })
    expect(resolveModel('claude', 'gpt-6-astra')).toEqual({ provider: 'codex', model: 'gpt-6-astra' })
  })
  it('a bare display slug maps to the catalog id; a real or foreign id passes through untouched', () => {
    expect(resolveModel('claude', 'fable-5.2')).toEqual({ provider: 'claude', model: 'claude-fable-5-2' })
    expect(resolveModel('claude', 'fable-5.1')).toEqual({ provider: 'claude', model: 'claude-fable-5-1' })
    expect(resolveModel('claude', 'opus-5.5')).toEqual({ provider: 'claude', model: 'claude-opus-5-5' })
    expect(resolveModel('claude', 'Sonnet-5.5')).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' })
    expect(resolveModel('claude', 'haiku-5.5')).toEqual({ provider: 'claude', model: 'claude-haiku-5-5' })
    expect(resolveModel('claude', 'gpt-6.1-sol')).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' })
    expect(resolveModel('codex', 'gpt-6-sol')).toEqual({ provider: 'codex', model: 'gpt-6-sol' })
    expect(resolveModel('claude', 'claude-sonnet-5')).toEqual({ provider: 'claude', model: 'claude-sonnet-5' })
    expect(resolveModel('claude', 'claude-fable-5-1')).toEqual({ provider: 'claude', model: 'claude-fable-5-1' })
    expect(resolveModel('codex', 'gpt-5.5')).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(resolveModel('claude', 'gpt-5.5')).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(resolveModel('claude', 'not-a-model')).toEqual({ provider: 'claude', model: 'not-a-model' })
    expect(resolveModel('codex', '5.5')).toEqual({ provider: 'codex', model: '5.5' })
  })
  it('an id the catalog does not list is kept, never swapped for the default', () => {
    expect(resolveModel('claude', 'claude-opus-9')).toEqual({ provider: 'claude', model: 'claude-opus-9' })
  })
  it('the codex list opens with the Sol pair; the Claude list has Sonnet 5.5 and Haiku 5.5, not Sonnet 5', () => {
    expect(CATALOG.codex.models.slice(0, 3).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra'])
    expect(CATALOG.codex.defaultModel).toBe('gpt-5.6-sol')
    const claude = CATALOG.claude.models.map((m) => m.id)
    expect(claude).toContain('claude-sonnet-5-5')
    expect(claude).toContain('claude-haiku-5-5')
    expect(claude).not.toContain('claude-sonnet-5')
  })
})

describe('Fable 5.2', () => {
  it('leads the Claude list with a 1M window and high effort, keeping 5.1 and its default', () => {
    expect(CATALOG.claude.models.slice(0, 2).map((m) => m.id)).toEqual(['claude-fable-5-2', 'claude-fable-5-1'])
    const row = modelInfo('claude', 'claude-fable-5-2')!
    expect(row.label).toBe('Fable 5.2')
    expect(row.context).toBe(1_000_000)
    expect(row.defaultReasoning).toBe('high')
    expect(row.reasoning).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(row.speedTiers).toEqual(modelInfo('claude', 'claude-fable-5-1')!.speedTiers)
    expect(supportsContext1m('claude', row.id)).toBe(true)
    expect(resolveModel('claude', row.id)).toEqual({ provider: 'claude', model: row.id })
    expect(CATALOG.claude.defaultModel).toBe('claude-fable-5-1')
    expect(modelInfo('claude', 'claude-fable-5-1')!.defaultReasoning).toBe('medium')
  })
})

describe('codex version gate', () => {
  afterEach(() => setInstalledCodexVersion(null))

  it('compares dotted versions numerically and ignores a pre-release tag', () => {
    expect(compareVersions('0.162.1', '0.153.4')).toBe(1)
    expect(compareVersions('0.153.4', '0.162.1')).toBe(-1)
    expect(compareVersions('0.162.1', '0.162.1')).toBe(0)
    expect(compareVersions('1.0.0', '0.999.9')).toBe(1)
    expect(compareVersions('0.162.1-alpha.2', '0.162.1')).toBe(0)
    expect(compareVersions('0.162', '0.162.0')).toBe(0)
  })

  it('hides the Sol rows on an old codex, shows them on 0.162.1+, and never hides when the version is unknown', () => {
    const sol = ['gpt-6.1-sol', 'gpt-6-sol']
    const ids = () => visibleCatalog().codex.models.map((m) => m.id)
    expect(ids()).toEqual(expect.arrayContaining(sol))
    expect(visibleCatalog().codex).toBe(CATALOG.codex)
    setInstalledCodexVersion('0.153.4')
    expect(ids()).not.toEqual(expect.arrayContaining(sol))
    expect(ids()).toContain('gpt-5.6-sol')
    expect(modelInfo('codex', 'gpt-6.1-sol')).toBeUndefined()
    expect(modelInfo('codex', 'gpt-5.6-sol')).toBeDefined()
    // Other providers are untouched, same objects.
    expect(visibleCatalog().claude).toBe(CATALOG.claude)
    // An unknown-to-the-catalog request stays as asked rather than being faked as served.
    expect(resolveModel('codex', 'gpt-6.1-sol')).toEqual({ provider: 'codex', model: 'gpt-6.1-sol' })
    setInstalledCodexVersion('0.162.1')
    expect(ids()).toEqual(expect.arrayContaining(sol))
    expect(modelInfo('codex', 'gpt-6-sol')?.minCodexVersion).toBe('0.162.1')
  })
})

describe('Meta rows', () => {
  afterEach(() => setInstalledCodexVersion(null))
  const META = ['muse-wonder-1.0', 'muse-spark-1.3']

  it('sit under both harnesses with a native 1M window and the vendor', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const id of META) {
        const row = modelInfo(provider, id)!
        expect(row.vendor).toBe('meta')
        expect(row.context).toBe(1_048_576)
        expect(isMetaModel(provider, id)).toBe(true)
      }
      expect(modelInfo(provider, 'muse-wonder-1.0')!.label).toBe('Muse Wonder 1.0')
      expect(modelInfo(provider, 'muse-wonder-1.0')!.defaultReasoning).toBe('high')
      expect(modelInfo(provider, 'muse-spark-1.3')!.label).toBe('Muse Spark 1.3')
      expect(modelInfo(provider, 'muse-spark-1.3')!.defaultReasoning).toBe('medium')
    }
    expect(isMetaModel('claude', 'claude-opus-5-5')).toBe(false)
    expect(isMetaModel('cursor', 'muse-wonder-1.0')).toBe(false)
  })

  it('offer minimal on the codex rows only; the claude rows keep the CLI ladder', () => {
    expect(modelInfo('codex', 'muse-wonder-1.0')!.reasoning).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(modelInfo('claude', 'muse-wonder-1.0')!.reasoning).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('never take the 1M suffix, though their window is a million tokens', () => {
    for (const id of META) {
      expect(supportsContext1m('claude', id)).toBe(false)
      expect(supportsContext1m('codex', id)).toBe(false)
    }
    expect(supportsContext1m('claude', 'claude-opus-5-5')).toBe(true)
  })

  it('resolve under the harness asked, and a harness without them goes to the first that has them', () => {
    expect(resolveModel('claude', 'muse-wonder-1.0')).toEqual({ provider: 'claude', model: 'muse-wonder-1.0' })
    expect(resolveModel('codex', 'muse-wonder-1.0')).toEqual({ provider: 'codex', model: 'muse-wonder-1.0' })
    expect(resolveModel('cursor', 'muse-wonder-1.0')).toEqual({ provider: 'claude', model: 'muse-wonder-1.0' })
  })

  it('run on any codex: they name no minimum version', () => {
    setInstalledCodexVersion('0.153.4')
    for (const id of META) expect(runnableHere('codex', modelInfo('codex', id)!)).toBe(true)
    expect(visibleCatalog().codex.models.map((m) => m.id)).toEqual(expect.arrayContaining(META))
  })
})
