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
    expect(resolveModel('claude', 'Sonnet-5')).toEqual({ provider: 'claude', model: 'claude-sonnet-5' })
    expect(resolveModel('claude', 'claude-fable-5-1')).toEqual({ provider: 'claude', model: 'claude-fable-5-1' })
    expect(resolveModel('codex', 'gpt-5.5')).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(resolveModel('claude', 'gpt-5.5')).toEqual({ provider: 'codex', model: 'gpt-5.5' })
    expect(resolveModel('claude', 'not-a-model')).toEqual({ provider: 'claude', model: 'not-a-model' })
    expect(resolveModel('codex', '5.5')).toEqual({ provider: 'codex', model: '5.5' })
  })
  it('an id the catalog does not list is kept, never swapped for the default', () => {
    expect(resolveModel('claude', 'claude-opus-9')).toEqual({ provider: 'claude', model: 'claude-opus-9' })
  })
})
