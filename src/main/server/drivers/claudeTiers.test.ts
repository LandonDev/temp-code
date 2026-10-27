import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from '@shared/catalog'
import {
  applyClaudeTiers,
  claudeFastFor,
  forgetClaudeTiers,
  noteClaudeInit,
  readClaudeTierCache,
  startClaudeTiers,
  tiersFromSupportedModels
} from './claudeTiers'

const opus = () => CATALOG.claude.models.find((m) => m.id === 'claude-opus-5-5')!
const fable = () => CATALOG.claude.models.find((m) => m.id === 'claude-fable-5-1')!

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getSetting: (k: string) => data.get(k) ?? null,
    setSetting: (k: string, v: string | null) => void (v === null ? data.delete(k) : data.set(k, v))
  }
}

afterEach(() => applyClaudeTiers({}))

describe('claude speed tiers', () => {
  it('reads the fast-mode rows by their canonical id, without a [1m] suffix', () => {
    expect(
      tiersFromSupportedModels([
        { value: 'opus', resolvedModel: 'claude-opus-5-5[1m]', supportsFastMode: true },
        { value: 'claude-fable-5-1', supportsFastMode: true },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportsFastMode: false },
        { value: 'haiku' }
      ])
    ).toEqual({ 'claude-opus-5-5': ['fast'], 'claude-fable-5-1': ['fast'] })
    expect(tiersFromSupportedModels([])).toEqual({})
  })

  it('stamps only the listed rows; the rest lose any stale stamp', () => {
    applyClaudeTiers({ 'claude-opus-5-5': ['fast'], 'claude-fable-5-1': ['fast'] })
    expect(opus().speedTiers).toEqual(['fast'])
    applyClaudeTiers({ 'claude-opus-5-5': ['fast'] })
    expect(fable().speedTiers).toBeUndefined()
    applyClaudeTiers({})
    expect(opus().speedTiers).toBeUndefined()
  })

  it('asks for fast mode only when the thread wants it and the model lists it', () => {
    applyClaudeTiers({ 'claude-opus-5-5': ['fast'] })
    expect(claudeFastFor({ fast: true }, 'claude-opus-5-5')).toBe(true)
    expect(claudeFastFor({ fast: false }, 'claude-opus-5-5')).toBe(false)
    expect(claudeFastFor({ fast: true }, 'claude-fable-5-1')).toBe(false)
    expect(claudeFastFor({ fast: true }, 'nope')).toBe(false)
  })

  it('a broken cache reads as nothing', () => {
    expect(readClaudeTierCache(memoryStore())).toBeNull()
    expect(readClaudeTierCache(memoryStore({ 'claude.speedTiers': '{nope' }))).toBeNull()
    expect(readClaudeTierCache(memoryStore({ 'claude.speedTiers': '[1]' }))).toBeNull()
  })

  it('round trip: boot applies the cache, the first init asks once and stores the answer, refresh asks again', async () => {
    const store = memoryStore({ 'claude.speedTiers': JSON.stringify({ 'claude-fable-5-1': ['fast'] }) })
    startClaudeTiers(store)
    expect(fable().speedTiers).toEqual(['fast'])
    const supportedModels = vi.fn(async () => [{ value: 'opus', resolvedModel: 'claude-opus-5-5', supportsFastMode: true }])
    noteClaudeInit({ supportedModels })
    noteClaudeInit({ supportedModels })
    await vi.waitFor(() => expect(opus().speedTiers).toEqual(['fast']))
    expect(supportedModels).toHaveBeenCalledTimes(1)
    expect(fable().speedTiers).toBeUndefined()
    expect(JSON.parse(store.data.get('claude.speedTiers')!)).toEqual({ 'claude-opus-5-5': ['fast'] })
    forgetClaudeTiers()
    noteClaudeInit({ supportedModels })
    expect(supportedModels).toHaveBeenCalledTimes(2)
  })
})
