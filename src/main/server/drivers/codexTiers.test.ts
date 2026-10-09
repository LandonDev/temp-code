import { describe, expect, it } from 'vitest'
import { CATALOG } from '@shared/catalog'
import { applySpeedTiers, readTierCache, tiersFromModelList } from './codexTiers'

const LIST = {
  data: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority' }] },
    { id: 'odd', model: 'odd' }
  ]
}

describe('codex speed tiers', () => {
  it('reads each listed model\'s tier ids; a model without tiers lists none', () => {
    expect(tiersFromModelList(LIST)).toEqual({
      'gpt-6-astra': ['priority', 'ultrafast'],
      'gpt-5.6-sol': ['priority'],
      odd: []
    })
    expect(tiersFromModelList(null)).toEqual({})
    expect(tiersFromModelList({ data: 'nope' })).toEqual({})
  })

  it('stamps only the rows the CLI listed; unlisted rows stay unknown, stale stamps clear', () => {
    const astra = CATALOG.codex.models.find((m) => m.id === 'gpt-6-astra')!
    const sol = CATALOG.codex.models.find((m) => m.id === 'gpt-6.1-sol')!
    applySpeedTiers({ 'gpt-6-astra': ['priority', 'ultrafast'], 'gpt-6.1-sol': ['priority'] })
    expect(astra.speedTiers).toEqual(['priority', 'ultrafast'])
    expect(sol.speedTiers).toEqual(['priority'])
    applySpeedTiers({ 'gpt-6-astra': ['priority'] })
    expect(astra.speedTiers).toEqual(['priority'])
    expect(sol.speedTiers).toBeUndefined()
    applySpeedTiers({})
    expect(astra.speedTiers).toBeUndefined()
  })

  it('a missing or broken cache reads as empty', () => {
    expect(readTierCache({ getSetting: () => null, setSetting: () => {} })).toEqual({ last: null, accounts: {} })
    expect(readTierCache({ getSetting: () => '{nope', setSetting: () => {} })).toEqual({ last: null, accounts: {} })
    expect(
      readTierCache({ getSetting: () => JSON.stringify({ last: 'a@b', accounts: { 'a@b': { x: ['ultrafast'] } } }), setSetting: () => {} })
    ).toEqual({ last: 'a@b', accounts: { 'a@b': { x: ['ultrafast'] } } })
  })
})
