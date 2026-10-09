import { describe, expect, it } from 'vitest'
import { CATALOG, resolveModel } from './catalog'

describe('resolveModel', () => {
  it('an empty id is the provider default; a known id stays; another provider\'s id routes there', () => {
    expect(resolveModel('claude', '')).toEqual({ provider: 'claude', model: CATALOG.claude.defaultModel })
    expect(CATALOG.claude.defaultModel).toBe('claude-fable-5-1')
    expect(resolveModel('claude', 'claude-opus-5-5')).toEqual({ provider: 'claude', model: 'claude-opus-5-5' })
    expect(resolveModel('claude', 'gpt-6-astra')).toEqual({ provider: 'codex', model: 'gpt-6-astra' })
  })
  it('a bare display slug maps to the catalog id; a real or foreign id passes through untouched', () => {
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
