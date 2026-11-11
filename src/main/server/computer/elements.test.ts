import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ElementBook } from './elements'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures/observations', name), 'utf8').replace(/\n$/, '')

describe('ElementBook', () => {
  it('reads a full observation, range lines included', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    expect(book.brief(37)).toEqual({ index: 37, line: 'button "close"' })
    expect(book.brief(3)?.line).toBe('text area = "Hello from the probe\\nSecond line" focused caret 0 actions: show menu')
    expect(book.brief(12)?.line).toBe('ruler marker')
    expect(book.size).toBe(40)
  })

  it('a diff removes subtrees, replaces changed lines and adds groups', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    book.apply(fixture('diff.txt'), 'diff')
    for (const gone of [20, 21, 30, 36, 5, 19]) expect(book.has(gone)).toBe(false)
    expect(book.brief(3)?.line).toBe('text area = "Hello from the probe\\nSecond line!" caret 33 actions: show menu')
    expect(book.brief(44)).toEqual({ index: 44, line: 'button "Save"' })
    expect(book.brief(47)?.line).toBe('menu item "Italic" disabled')
    expect(book.has(37)).toBe(true)
  })

  it('a removed parent added by a diff takes its new children with it', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    book.apply(fixture('diff.txt'), 'diff')
    book.apply('app "TextEdit" · window "Untitled" · 1280×1072 · changes since your last read\n- [41] sheet "Save As" (and 3 inside)', 'diff')
    for (const gone of [41, 42, 43, 44]) expect(book.has(gone)).toBe(false)
    expect(book.has(45)).toBe(true)
  })

  it('unchanged keeps the book, and a subtree updates its values', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    book.apply(fixture('unchanged.txt'), 'unchanged')
    expect(book.size).toBe(40)
    book.apply('app "TextEdit" · window "Untitled" · 1280×1072\n[3] text area = "Whole text" focused caret 4', 'subtree')
    expect(book.brief(3)?.line).toBe('text area = "Whole text" focused caret 4')
    expect(book.size).toBe(40)
  })

  it('a text off the grammar empties the book', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    book.apply('not an observation', 'full')
    expect(book.size).toBe(0)
    expect(book.brief(14)).toBeNull()
  })
})

describe('the focused index', () => {
  it('takes the latest header, including diffs, unchanged and subtree reads, and clears missing focus', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    expect(book.focused).toBe(3)
    for (const kind of ['diff', 'unchanged', 'subtree'] as const) {
      book.apply('app "App" · window "W" · 1×1 · focused [9]\n[9] input "Field"', kind)
      expect(book.focused).toBe(9)
      book.apply('app "App" · window "W" · 1×1\n[9] input "Field"', kind)
      expect(book.focused).toBeNull()
    }
    book.clear()
    expect(book.focused).toBeNull()
  })
})
