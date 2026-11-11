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

  it('path names an element\'s ancestors, the nearest first', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    expect(book.path(21)).toEqual([
      { index: 20, line: 'group "Formatting"' },
      { index: 1, line: 'window "Untitled"' }
    ])
    // a range's members hang under the range's parent
    expect(book.path(12).map((b) => b.index)).toEqual([4, 2, 1])
    // the top, and an index the book lacks, have none
    expect(book.path(1)).toEqual([])
    expect(book.path(999)).toEqual([])
    // an element a diff added keeps the parent its group named
    book.apply(fixture('diff.txt'), 'diff')
    expect(book.path(44).map((b) => b.line)).toEqual(['sheet "Save As"', 'window "Untitled"'])
    // one the service named outside a read has none until a read places it
    book.learn({ index: 70, line: 'menu item "Save"' })
    expect(book.path(70)).toEqual([])
    // a full read clears what was there
    book.apply(fixture('unchanged.txt'), 'unchanged')
    expect(book.path(44).length).toBe(2)
    book.clear()
    expect(book.path(44)).toEqual([])
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

  it('learns an element the service named outside a read, keeping its parent', () => {
    const book = new ElementBook()
    book.apply(fixture('full.txt'), 'full')
    book.learn({ index: 12, line: 'password "Password"' })
    expect(book.brief(12)).toEqual({ index: 12, line: 'password "Password"' })
    expect(book.hasRole('password')).toBe(true)
    book.learn({ index: 70, line: 'menu item "Team"' })
    expect(book.brief(70)?.line).toBe('menu item "Team"')
  })

  it('reads an opened menu after the body (§27.4) and a compact menu bar line (§27.13)', () => {
    const book = new ElementBook()
    const head = 'app "Menuful" · window "Menuful" · 1280×1072 · focused [3]\n[1] window "Menuful"\n  [3] text area = "" focused'
    book.apply(`${head}\n+ menu opened by step 1: [50] menu "Sort"\n  [51] menu item "Name"\n  [52] menu item "Date" disabled`, 'full')
    expect(book.brief(50)?.line).toBe('menu "Sort"')
    expect(book.brief(52)?.line).toBe('menu item "Date" disabled')
    expect(book.brief(3)?.line).toBe('text area = "" focused')
    book.apply(`${head}\n  [41] menu "File": New [142], Save… [157] disabled`, 'full')
    expect(book.has(50)).toBe(false)
    expect(book.brief(41)?.line).toBe('menu "File"')
    expect(book.brief(157)?.line).toBe('menu item "Save…" disabled')
  })
})
