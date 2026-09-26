import { describe, expect, it } from 'vitest'
import { CATALOG, resolveModel } from './catalog'

describe('resolveModel', () => {
  it('an empty id is the provider default; a known id stays; another provider\'s id routes there', () => {
    expect(resolveModel('claude', '')).toEqual({ provider: 'claude', model: CATALOG.claude.defaultModel })
    expect(CATALOG.claude.defaultModel).toBe('claude-fable-5-1')
    expect(resolveModel('claude', 'claude-opus-5-5')).toEqual({ provider: 'claude', model: 'claude-opus-5-5' })
    expect(resolveModel('claude', 'gpt-6-astra')).toEqual({ provider: 'codex', model: 'gpt-6-astra' })
  })
  it('an id the catalog does not list is kept, never swapped for the default', () => {
    expect(resolveModel('claude', 'claude-opus-9')).toEqual({ provider: 'claude', model: 'claude-opus-9' })
  })
})
