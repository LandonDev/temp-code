import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_SHAPES, WORDS_SHAPES } from '@shared/computer/descriptions'
import {
  CONFIRM_WORDS,
  COMPUTER_TIERS,
  MECHANICS_FACTS,
  MECHANICS_MAX,
  TOOLS_BY_FAMILY,
  mechanicsFacts,
  modelFamily,
  provenanceOf,
  renderComputerMechanics,
  setComputerWordsOverride,
  wordsFor
} from './prompts'

const every = WORDS_SHAPES.flatMap((shape) =>
  TOOL_SHAPES.flatMap((tools) =>
    [true, false].flatMap((search) => (['person', 'thread'] as const).map((provenance) => ({ shape, tools, search, provenance })))
  )
)

afterEach(() => setComputerWordsOverride(null))

describe('COMPUTER_MECHANICS', () => {
  it('says every fact in both shapes', () => {
    for (const shape of WORDS_SHAPES) {
      const f = mechanicsFacts(shape) as unknown as Record<string, unknown>
      for (const fact of MECHANICS_FACTS) expect(f[fact], `${shape} ${fact}`).toBeTruthy()
    }
  })

  it('names the tools it offers, within the budget, in every shape, search and provenance', () => {
    for (const o of every) {
      const text = renderComputerMechanics(o)
      expect(text.length, JSON.stringify(o)).toBeLessThanOrEqual(MECHANICS_MAX)
      expect(text).toMatch(/^## Computer use\n/)
      for (const name of ['computer_apps', 'computer_observe', 'computer_batch']) expect(text).toContain(name)
      if (o.tools === 'act') expect(text).toContain('computer_act')
      else expect(text).toContain('computer_left_click to computer_paste')
      expect(text).toContain(COMPUTER_TIERS)
    }
  })

  it('tells only claude to load the tools with tool search', () => {
    expect(renderComputerMechanics({ shape: 'anthropic', tools: 'act', search: true, provenance: 'person' })).toContain('tool search (query "computer")')
    expect(renderComputerMechanics({ shape: 'anthropic', tools: 'act', search: false, provenance: 'person' })).not.toContain('tool search')
  })

  it('reads the provenance line by who started the thread', () => {
    expect(provenanceOf({ parentId: null, startedBy: null })).toBe('person')
    expect(provenanceOf({ parentId: 'p', startedBy: null })).toBe('thread')
    expect(provenanceOf({ parentId: null, startedBy: 'm' })).toBe('thread')
    const person = renderComputerMechanics({ shape: 'cua', tools: 'act', search: false, provenance: 'person' })
    const thread = renderComputerMechanics({ shape: 'cua', tools: 'act', search: false, provenance: 'thread' })
    expect(person).toContain("Only the person's own messages pre-approve")
    expect(thread).toContain('it pre-approves nothing')
    expect(thread).toContain('<user-steer>')
  })

  it('names every kind of the policy in the confirm fact', () => {
    for (const shape of WORDS_SHAPES) for (const word of CONFIRM_WORDS) expect(mechanicsFacts(shape).confirm, word).toContain(word)
  })

  it('differs between the shapes only in what the tools are', () => {
    const a = mechanicsFacts('anthropic')
    const c = mechanicsFacts('cua')
    expect(c.what.act).toContain('getAXState')
    expect(a.what.act).not.toContain('getAXState')
    for (const fact of MECHANICS_FACTS.filter((f) => f !== 'what')) expect(c[fact]).toEqual(a[fact])
  })
})

describe('wordsFor', () => {
  it('reads the model’s maker, whichever harness runs it', () => {
    expect(modelFamily('claude', 'claude-opus-5-5')).toBe('anthropic')
    expect(modelFamily('codex', 'gpt-6.1-sol')).toBe('openai')
    expect(modelFamily('claude', 'muse-wonder-1.0')).toBe('meta')
    expect(modelFamily('codex', 'muse-spark-1.3')).toBe('meta')
    expect(modelFamily('muse', 'muse-wonder-full-1.0')).toBe('meta')
    expect(modelFamily('cursor', 'composer-2.5')).toBeNull()
  })

  it('gives each family its shipped words, and anthropic with the four tools to one the tables lack', () => {
    expect(wordsFor({ provider: 'claude', model: 'claude-opus-5-5' }).shape).toBe('cua')
    expect(wordsFor({ provider: 'codex', model: 'gpt-6.1-sol' }).shape).toBe('cua')
    expect(wordsFor({ provider: 'claude', model: 'muse-wonder-1.0' }).shape).toBe('anthropic')
    expect(wordsFor({ provider: 'cursor', model: 'composer-2.5' })).toEqual({ shape: 'anthropic', tools: 'act' })
  })

  it('ships per-verb tools to Anthropic models alone', () => {
    expect(TOOLS_BY_FAMILY.openai).toBe('act')
    expect(TOOLS_BY_FAMILY.meta).toBe('act')
  })

  it('follows the comparison’s override for every thread', () => {
    setComputerWordsOverride({ shape: 'cua', tools: 'per-verb' })
    expect(wordsFor({ provider: 'claude', model: 'claude-opus-5-5' })).toEqual({ shape: 'cua', tools: 'per-verb' })
    setComputerWordsOverride(null)
    expect(wordsFor({ provider: 'claude', model: 'claude-opus-5-5' })).toEqual({ shape: 'cua', tools: 'act' })
  })
})
