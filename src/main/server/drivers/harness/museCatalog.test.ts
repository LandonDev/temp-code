import { describe, expect, it } from 'vitest'
import fixtureJson from '../fixtures/muse/model-list.json'
import type { ModelListResult } from '@muse-code/sdk/dist/src/msp'

const fixture = fixtureJson as unknown as ModelListResult
import { museLabel, museModels, toModelInfo } from './museCatalog'

const entry = (over: Record<string, unknown> = {}) => ({
  modelId: 'muse-spark-1.3',
  displayLabel: 'Muse Spark 1.3',
  contextLimit: 1_048_576,
  outputLimit: null,
  cost: null,
  description: null,
  isActive: true,
  isDefault: false,
  profileId: null,
  providerId: 'meta',
  releaseDate: null,
  defaultReasoningEffort: 'high' as const,
  reasoningEffortVariants: [{ tier: 'none' as const }, { tier: 'minimal' as const }, { tier: 'low' as const }, { tier: 'high' as const }, { tier: 'ultra' as const }],
  ...over
})

describe('muse catalog', () => {
  it('maps a catalog entry onto the shared ladder, none and minimal dropped', () => {
    expect(toModelInfo(entry({ variants: undefined }))).toEqual({
      id: 'muse-spark-1.3',
      label: 'Muse Spark 1.3',
      reasoning: ['low', 'high', 'ultra'],
      defaultReasoning: 'high',
      context: 1_048_576
    })
  })

  it('reads the variants ladder over the described tiers and drops a default off the ladder', () => {
    const info = toModelInfo(entry({ reasoningEffortVariants: [{ tier: 'xhigh' as const }], variants: ['low', 'medium'], defaultReasoningEffort: 'xhigh', contextLimit: null }))
    expect(info).toEqual({ id: 'muse-spark-1.3', label: 'Muse Spark 1.3', reasoning: ['low', 'medium'] })
    expect(toModelInfo(entry({ reasoningEffortVariants: [{ tier: 'high' as const }], variants: undefined })).reasoning).toEqual(['high'])
  })

  it('keeps every row (isActive is the current pick) and takes the default from isDefault', () => {
    const list = museModels({
      models: [entry({ modelId: 'muse-old', isActive: false }), entry(), entry({ modelId: 'muse-wonder-full-1.0', displayLabel: 'Muse Wonder Full', isDefault: true })]
    })
    expect(list.models.map((m) => m.id)).toEqual(['muse-old', 'muse-spark-1.3', 'muse-wonder-full-1.0'])
    expect(list.defaultModel).toBe('muse-wonder-full-1.0')
    expect(museModels({ models: [] })).toEqual({ models: [], defaultModel: '' })
  })

  it('reads the recorded model/list of 1.4.14 (the spike of 2026-11-04)', () => {
    const list = museModels(fixture)
    expect(list.defaultModel).toBe('muse-wonder-1.0')
    expect(list.models.map((m) => [m.id, m.label])).toEqual([
      ['muse-wonder-1.0', 'Muse Wonder 1.0'],
      ['muse-wonder-full-1.0', 'Muse Wonder Full 1.0'],
      ['muse-spark-1.3', 'Muse Spark 1.3'],
      ['muse-spark-1.2', 'Muse Spark 1.2']
    ])
    expect(list.models[3]).toMatchObject({ reasoning: ['low', 'medium', 'high', 'xhigh'], defaultReasoning: 'xhigh' })
    expect(list.models[0]).toMatchObject({ reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'max', context: 1_007_997 })
    expect(museLabel('muse-spark-1.3')).toBe('Muse Spark 1.3')
  })
})
