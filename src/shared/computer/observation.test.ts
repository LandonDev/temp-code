import { describe, expect, it } from 'vitest'
import {
  ACTION_WORDS,
  KeyComboError,
  ObservationParseError,
  ROLE_DEFAULTS,
  ROLE_WORDS,
  STATE_WORDS,
  SUBROLE_NAMES,
  TITLE_BAR_CORNER,
  TITLE_BAR_SUBROLES,
  actionWord,
  axWords,
  cutName,
  cutValue,
  formatElementLine,
  formatKeyCombo,
  formatObservation,
  hasRoleDefault,
  listedActions,
  parseElementLine,
  parseKeyCombo,
  parseModifiers,
  parseObservation,
  roleTag,
  sortStates
} from './observation'

const header = 'app "TextEdit" · window "Untitled" · 1280×1072'
const parses = (text: string): boolean => {
  try {
    parseObservation(text)
    return true
  } catch {
    return false
  }
}
const lineOf = (text: string): number | null => {
  try {
    parseObservation(text)
    return null
  } catch (e) {
    return (e as ObservationParseError).line
  }
}

describe('element lines', () => {
  const lines = [
    '[3] text area = "Hello from the probe\\nSecond line" focused caret 0 actions: show menu',
    '  [21] checkbox "bold" unchecked',
    '    [25] button "text color" = "Clear" actions: show color panel',
    '[42] input "Save As:" = "Untitled" focused selection 0..8',
    '[1] window "Untitled" @0,0 1280×1072',
    '[45] menu "Format" @-12,40 200×300',
    '- [20] group "Formatting" (and 16 inside)',
    '~ [3] text area = "x" caret 33',
    '[7] row selected',
    '[9] input "Name" required invalid read-only',
    '[5] ruler marker',
    '~ [1] window "Notes" minimized'
  ]
  it('format back to the same text', () => {
    for (const line of lines) expect(formatElementLine(parseElementLine(line))).toBe(line)
  })

  it('read the role, name, value, states, caret, actions and frame', () => {
    expect(parseElementLine(lines[0])).toEqual({
      depth: 0,
      index: 3,
      role: 'text area',
      value: 'Hello from the probe\nSecond line',
      states: ['focused'],
      caret: 0,
      actions: ['show menu']
    })
    expect(parseElementLine(lines[2])).toMatchObject({ depth: 2, role: 'button', name: 'text color', actions: ['show color panel'] })
    expect(parseElementLine(lines[4]).frame).toEqual({ x: 0, y: 0, w: 1280, h: 1072 })
    expect(parseElementLine(lines[6])).toMatchObject({ marker: '-', inside: 16 })
    expect(parseElementLine(lines[10])).toMatchObject({ role: 'ruler marker', states: [] })
  })

  it('refuse states out of order, a padded action and text the grammar does not know', () => {
    expect(() => parseElementLine('[1] checkbox checked focused')).toThrow(/out of order/)
    expect(() => parseElementLine('[1] button actions: show menu, ')).toThrow()
    expect(() => parseElementLine('[1] button "a" nonsense')).toThrow()
    expect(() => parseElementLine('[0] button')).toThrow()
    expect(() => parseElementLine('[1] button "a\\/b"')).toThrow(/canonical/)
    expect(() => parseElementLine('[1] button (and 3 inside)')).toThrow(/removed line/)
  })
})

describe('observations', () => {
  it('parse a full tree, a range, summaries and the truncated line', () => {
    const text = [
      `${header} · focused [3]`,
      'other windows: "Notes.rtf" minimized',
      '[1] window "Untitled"',
      '  [2] scroll area',
      '    [3] text area = "a" focused caret 1',
      '    [4]–[9] 6 × ruler marker',
      '    … 12 more below, 3 above',
      '  (outline "Project": items not exposed to accessibility; see the screenshot)',
      '(truncated: 40 elements left out; observe with element: 2 to see one part whole)'
    ].join('\n')
    const p = parseObservation(text)
    expect(p.header).toMatchObject({ app: 'TextEdit', width: 1280, height: 1072, focused: 3, change: null })
    expect(p.others).toEqual([{ title: 'Notes.rtf', where: 'minimized' }])
    expect(p.lines.map((l) => l.type)).toEqual(['element', 'element', 'element', 'range', 'more', 'stub', 'truncated'])
    expect(formatObservation(p)).toBe(text)
  })

  it('read every header word in its place', () => {
    const p = parseObservation(`${header} · focused [4] · still loading · changes since your last read · thin tree, see the screenshot`)
    expect(p.header).toMatchObject({ focused: 4, loading: true, change: 'diff', thin: true })
    expect(parses(`${header} · thin tree, see the screenshot · still loading`)).toBe(false)
  })

  it('hold a tree to its shape', () => {
    expect(lineOf(`${header}\n  [1] window`)).toBe(2)
    expect(lineOf(`${header}\n[1] window\n    [2] button`)).toBe(3)
    expect(lineOf(`${header}\n[1] window\n  [1] button`)).toBe(3)
    expect(lineOf(`${header}\n[1] window\n  [2]–[4] 3 × marker\n  [3] button`)).toBe(4)
    expect(lineOf(`${header}\n[1] window\n(truncated: 1 elements left out; observe with element: 1 to see one part whole)\n[2] button`)).toBe(4)
    expect(lineOf(`${header}\n[1] window\n\n[2] button`)).toBe(3)
    expect(lineOf(`${header}\n[1] window \n`)).toBe(2)
    expect(lineOf(`${header}\n[1]–[3] 2 × marker`)).toBe(2)
  })

  it('keep marked lines and added groups to a diff, and a diff to them', () => {
    const diff = `${header} · changes since your last read`
    expect(parses(`${diff}\n- [2] button "a"\n~ [3] checkbox "b" checked\n+ in [1]:\n  [4] sheet "Save"\n+ at top:\n  [5] menu`)).toBe(true)
    expect(lineOf(`${header}\n- [2] button`)).toBe(2)
    expect(lineOf(`${diff}\n[2] button`)).toBe(2)
    expect(lineOf(`${diff}\n+ in [1]:\n[4] sheet`)).toBe(3)
    expect(lineOf(`${diff}\n~ [2]–[4] 3 × marker`)).toBe(2)
    expect(lineOf(`${header} · no changes\n[1] window`)).toBe(2)
  })

  it("take a changed container's new summary lines under its ~ line, and a changed truncated line last", () => {
    const diff = `${header} · changes since your last read`
    const text = `${diff}\n~ [18] list "Past orders"\n  … 50 more below, 7 above\n(truncated: 12 elements left out; observe with element: 18 to see one part whole)`
    expect(formatObservation(parseObservation(text))).toBe(text)
    expect(lineOf(`${diff}\n~ [18] list\n    … 50 more below`)).toBe(3)
    expect(lineOf(`${diff}\n- [18] list\n  … 50 more below`)).toBe(3)
    expect(lineOf(`${diff}\n~ [18] list\n  [19] button`)).toBe(3)
  })
})

describe('cutting names and values', () => {
  it('cuts by Unicode scalars and says how much a value lost', () => {
    expect(cutName('a'.repeat(100))).toBe('a'.repeat(100))
    expect(cutName('a'.repeat(101))).toBe(`${'a'.repeat(100)}…`)
    expect(cutValue('🙂'.repeat(170))).toBe(`${'🙂'.repeat(160)}…(+10 chars)`)
  })
})

describe('roles, states and actions', () => {
  it('maps roles and subroles, and splits an unknown AX name into words', () => {
    expect(roleTag('AXTextField', 'AXSecureTextField')).toBe('password')
    expect(roleTag('AXTextField', 'AXSomethingElse')).toBe('input')
    expect(roleTag('AXCheckBox', 'AXSwitch')).toBe('switch')
    expect(roleTag('AXRadioButton', 'AXTabButton')).toBe('tab')
    expect(roleTag('AXRulerMarker')).toBe('ruler marker')
    expect(axWords('AXURLField')).toBe('url field')
    for (const word of ROLE_WORDS) expect(STATE_WORDS as readonly string[]).not.toContain(word)
  })

  it('words AX actions, names custom ones by their Name: part and drops the hover ones', () => {
    expect(actionWord('AXShowMenu')).toBe('show menu')
    expect(actionWord('AXScrollDownByPage')).toBe('scroll down')
    expect(actionWord('Name:Show color panel\nTarget:0x0\nSelector:(null)')).toBe('show color panel')
    expect(actionWord('Name:\nTarget:0x0')).toBeNull()
    expect(actionWord('AXShowAlternateUI')).toBeNull()
    expect(actionWord('AXSomethingNew')).toBe('something new')
    expect(Object.values(ACTION_WORDS)).toContain('press')
  })

  it('lists only what a role does not take by default', () => {
    expect(listedActions('pop up', ['press', 'show menu'])).toEqual([])
    expect(listedActions('button', ['press', 'show menu', 'show menu'])).toEqual(['show menu'])
    expect(listedActions('cell', ['open'])).toEqual(['open'])
    expect(ROLE_DEFAULTS['scroll area']).toHaveLength(4)
    expect(hasRoleDefault('input')).toBe(true)
    expect(hasRoleDefault('group')).toBe(false)
  })

  it('sorts states into the printed order', () => {
    expect(sortStates(['read-only', 'focused', 'checked', 'focused'])).toEqual(['focused', 'checked', 'read-only'])
  })

  it('prints minimized last on a window line (§22.4)', () => {
    expect(STATE_WORDS.at(-1)).toBe('minimized')
    expect(sortStates(['minimized', 'focused'])).toEqual(['focused', 'minimized'])
    expect(parseElementLine('[1] window "Notes" minimized')).toMatchObject({ role: 'window', name: 'Notes', states: ['minimized'] })
    expect(() => parseElementLine('[1] window "Notes" minimized focused')).toThrow(/out of order/)
  })

  it('orders the title-bar buttons by subrole, each one named (§22.1)', () => {
    expect(TITLE_BAR_SUBROLES).toEqual(['AXCloseButton', 'AXMinimizeButton', 'AXFullScreenButton', 'AXZoomButton'])
    for (const subrole of TITLE_BAR_SUBROLES) expect(SUBROLE_NAMES[subrole]).toBeTruthy()
    expect(TITLE_BAR_CORNER).toEqual({ w: 96, h: 32 })
  })
})

describe('key combos', () => {
  it("parses Anthropic's examples", () => {
    expect(parseKeyCombo('ctrl+s')).toEqual({ modifiers: ['ctrl'], key: 's' })
    expect(parseKeyCombo('super+shift+t')).toEqual({ modifiers: ['super', 'shift'], key: 't' })
    expect(parseKeyCombo('alt+Tab')).toEqual({ modifiers: ['alt'], key: 'Tab' })
    expect(parseKeyCombo('Return')).toEqual({ modifiers: [], key: 'Return' })
    expect(parseKeyCombo('super+Return')).toEqual({ modifiers: ['super'], key: 'Return' })
    expect(parseKeyCombo('Page_Down')).toEqual({ modifiers: [], key: 'Page_Down' })
    expect(parseKeyCombo('F12')).toEqual({ modifiers: [], key: 'F12' })
    expect(parseKeyCombo('BackSpace')).toEqual({ modifiers: [], key: 'BackSpace' })
  })

  it('takes the aliases, any case, a plus key and a lone modifier', () => {
    expect(parseKeyCombo('cmd+opt+escape')).toEqual({ modifiers: ['super', 'alt'], key: 'Escape' })
    expect(parseKeyCombo('Command+Option+Control+a')).toEqual({ modifiers: ['super', 'alt', 'ctrl'], key: 'a' })
    expect(parseKeyCombo('ENTER')).toEqual({ modifiers: [], key: 'Return' })
    expect(parseKeyCombo('pageup')).toEqual({ modifiers: [], key: 'Page_Up' })
    expect(parseKeyCombo('super++')).toEqual({ modifiers: ['super'], key: '+' })
    expect(parseKeyCombo('+')).toEqual({ modifiers: [], key: '+' })
    expect(parseKeyCombo('shift')).toEqual({ modifiers: [], key: 'shift' })
    expect(parseKeyCombo('ctrl+shift')).toEqual({ modifiers: ['ctrl'], key: 'shift' })
    expect(formatKeyCombo(parseKeyCombo('cmd+shift+t'))).toBe('shift+super+t')
  })

  it('refuses an empty part, an unknown name, a repeated modifier and a non-modifier before the key', () => {
    for (const bad of ['', 'ctrl+', '+a', 'ctrl++a', 'foo', 'F21', 'shift+shift', 'shift+shift+a', 'a+b'])
      expect(() => parseKeyCombo(bad), bad).toThrow(KeyComboError)
  })

  it('parses the modifiers a click holds', () => {
    expect(parseModifiers('shift')).toEqual(['shift'])
    expect(parseModifiers('cmd+alt')).toEqual(['super', 'alt'])
    expect(() => parseModifiers('shift+a')).toThrow(KeyComboError)
  })
})
