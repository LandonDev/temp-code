import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEY_NAMES, MODIFIER_NAMES, MODIFIERS, formatKeyCombo, parseKeyCombo } from '../../../shared/computer/observation'

// The key-combo vectors both parsers are held to: this file holds observation.ts,
// native/tc-computer/Tests/InputTests/KeyComboTests.swift holds KeyCombo.swift.

type Vector = { input: string; ok: true; modifiers: string[]; key: string; text: string } | { input: string; ok: false }
const { vectors } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'keys', 'combos.json'), 'utf8')) as { vectors: Vector[] }

describe('the key-combo vectors', () => {
  it('match parseKeyCombo, modifiers in print order', () => {
    for (const v of vectors) {
      if (!v.ok) {
        expect(() => parseKeyCombo(v.input), JSON.stringify(v.input)).toThrow()
        continue
      }
      const c = parseKeyCombo(v.input)
      expect([...c.modifiers].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b)), v.input).toEqual(v.modifiers)
      expect(c.key, v.input).toBe(v.key)
      expect(formatKeyCombo(c), v.input).toBe(v.text)
    }
  })

  it('cover every key name and modifier alias, and refusals', () => {
    const inputs = new Set(vectors.map((v) => v.input.toLowerCase()))
    for (const name of [...Object.keys(KEY_NAMES), ...Object.keys(MODIFIER_NAMES)]) expect(inputs.has(name), name).toBe(true)
    expect(vectors.filter((v) => !v.ok).length).toBeGreaterThanOrEqual(10)
    expect(vectors.some((v) => v.ok && v.key === '+')).toBe(true)
  })
})
