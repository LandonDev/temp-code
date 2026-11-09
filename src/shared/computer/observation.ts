/**
 * The observation grammar (docs/computer-protocol.md §4): what the model
 * reads of a window. The AX reader in tc-computer writes it; this module is
 * its tables (roles, states, action words, role defaults, keys), a formatter
 * and a strict parser, so the tests hold every fixture to the grammar and
 * `formatObservation(parseObservation(text)) === text`.
 *
 * Names and values are JSON strings as `JSON.stringify` writes them: `"`,
 * `\`, `\b \f \n \r \t` escaped, other controls and lone surrogates as
 * lower-case `\u00xx`, nothing else (never `\/`, never non-ASCII). Lengths
 * count Unicode scalars.
 */
import { OBSERVATION_TEXT } from './protocol'

// ── roles ───────────────────────────────────────────────────────────────

/** AX role, or `role:subrole`, → the word an element line prints. A subrole entry wins. */
export const ROLE_TAGS: Readonly<Record<string, string>> = {
  AXWindow: 'window',
  'AXWindow:AXDialog': 'dialog',
  'AXWindow:AXSystemDialog': 'dialog',
  AXSheet: 'sheet',
  AXButton: 'button',
  AXPopUpButton: 'pop up',
  AXMenuButton: 'menu button',
  AXCheckBox: 'checkbox',
  'AXCheckBox:AXSwitch': 'switch',
  'AXCheckBox:AXToggle': 'switch',
  AXRadioButton: 'radio',
  'AXRadioButton:AXTabButton': 'tab',
  AXTabGroup: 'tabs',
  AXTextField: 'input',
  'AXTextField:AXSearchField': 'search',
  'AXTextField:AXSecureTextField': 'password',
  AXTextArea: 'text area',
  AXComboBox: 'combo box',
  AXStaticText: 'text',
  AXLink: 'link',
  AXImage: 'image',
  AXHeading: 'heading',
  AXToolbar: 'toolbar',
  AXMenuBar: 'menu bar',
  AXMenu: 'menu',
  AXMenuItem: 'menu item',
  AXMenuBarItem: 'menu item',
  AXList: 'list',
  AXOutline: 'outline',
  AXTable: 'table',
  AXRow: 'row',
  AXCell: 'cell',
  AXColumn: 'column',
  AXScrollArea: 'scroll area',
  AXSlider: 'slider',
  AXIncrementor: 'stepper',
  AXStepper: 'stepper',
  AXProgressIndicator: 'progress',
  AXBusyIndicator: 'busy',
  AXSplitGroup: 'split',
  AXWebArea: 'web area',
  AXDisclosureTriangle: 'disclosure',
  AXDateField: 'date',
  AXColorWell: 'color well',
  AXLevelIndicator: 'level',
  AXGroup: 'group'
}

/** Every word ROLE_TAGS prints. */
export const ROLE_WORDS: ReadonlySet<string> = new Set(Object.values(ROLE_TAGS))

/** `AXRulerMarker` → `ruler marker`: an AX name without `AX`, split into lower-case words. */
export function axWords(name: string): string {
  return name
    .replace(/^AX/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

/** The word for an element's role. */
export function roleTag(role: string, subrole?: string | null): string {
  if (subrole && ROLE_TAGS[`${role}:${subrole}`]) return ROLE_TAGS[`${role}:${subrole}`]
  return ROLE_TAGS[role] ?? axWords(role)
}

/** The window buttons carry no title or description; their subrole names them. */
export const SUBROLE_NAMES: Readonly<Record<string, string>> = {
  AXCloseButton: 'close',
  AXMinimizeButton: 'minimize',
  AXFullScreenButton: 'full screen',
  AXZoomButton: 'zoom'
}

/** Kept with no name, value, action or state: they give the tree its shape. */
export const STRUCTURAL_ROLES: ReadonlySet<string> = new Set([
  'window',
  'sheet',
  'dialog',
  'menu',
  'list',
  'outline',
  'table',
  'scroll area',
  'web area'
])

// ── states ──────────────────────────────────────────────────────────────

/** In the order a line prints them. */
export const STATE_WORDS = [
  'focused',
  'selected',
  'disabled',
  'checked',
  'unchecked',
  'mixed',
  'expanded',
  'collapsed',
  'required',
  'invalid',
  'modal',
  'read-only'
] as const
export type StateWord = (typeof STATE_WORDS)[number]
const STATE_SET: ReadonlySet<string> = new Set(STATE_WORDS)

/** States in the order a line prints them. */
export function sortStates(states: readonly StateWord[]): StateWord[] {
  return [...new Set(states)].sort((a, b) => STATE_WORDS.indexOf(a) - STATE_WORDS.indexOf(b))
}

/** Checkbox, switch and radio always print one of checked, unchecked, mixed. */
export const TOGGLE_ROLES: ReadonlySet<string> = new Set(['checkbox', 'switch', 'radio'])

// ── actions ─────────────────────────────────────────────────────────────

export const ACTION_WORDS: Readonly<Record<string, string>> = {
  AXPress: 'press',
  AXShowMenu: 'show menu',
  AXOpen: 'open',
  AXConfirm: 'confirm',
  AXCancel: 'cancel',
  AXDelete: 'delete',
  AXIncrement: 'increment',
  AXDecrement: 'decrement',
  AXRaise: 'raise',
  AXPick: 'pick',
  AXZoomWindow: 'zoom window',
  AXScrollToVisible: 'scroll to visible',
  AXScrollUpByPage: 'scroll up',
  AXScrollDownByPage: 'scroll down',
  AXScrollLeftByPage: 'scroll left',
  AXScrollRightByPage: 'scroll right'
}

/** Hover affordances on every Finder row: never listed. */
export const DROPPED_ACTIONS: ReadonlySet<string> = new Set(['AXShowAlternateUI', 'AXShowDefaultUI'])

/**
 * The word for a raw CopyActionNames entry, or null when it is never listed.
 * A custom action comes as `Name:<name>\nTarget:…\nSelector:…` (TextEdit's
 * colour buttons); its word is the `Name:` part, lower-cased.
 */
export function actionWord(raw: string): string | null {
  if (DROPPED_ACTIONS.has(raw)) return null
  if (ACTION_WORDS[raw]) return ACTION_WORDS[raw]
  if (raw.startsWith('Name:')) {
    const name = raw.slice(5).split('\n')[0].trim().toLowerCase().replace(/,\s*/g, ' ')
    return name || null
  }
  if (raw.startsWith('AX')) return axWords(raw) || null
  return raw.trim().toLowerCase().replace(/,\s*/g, ' ') || null
}

/** What every element of a role takes without listing it (§4.1 "Role defaults"). */
export const ROLE_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  button: ['press'],
  link: ['press'],
  'menu item': ['press'],
  checkbox: ['press'],
  switch: ['press'],
  radio: ['press'],
  tab: ['press'],
  // expand and collapse set AXExpanded (a row's AXDisclosing) where it is settable; the line's state says which applies
  disclosure: ['press', 'expand', 'collapse'],
  'pop up': ['press', 'show menu'],
  'menu button': ['press', 'show menu'],
  'combo box': ['show menu'],
  row: ['press', 'expand', 'collapse'],
  cell: ['press'],
  slider: ['increment', 'decrement'],
  stepper: ['increment', 'decrement'],
  'scroll area': ['scroll up', 'scroll down', 'scroll left', 'scroll right'],
  window: ['raise']
}

/** Roles that take typing and `set_value` by default (unless `read-only`). */
export const TYPING_ROLES: ReadonlySet<string> = new Set(['input', 'search', 'password', 'text area', 'date', 'combo box'])

/** Whether an element of this role can be acted on without listing anything. */
export function hasRoleDefault(role: string): boolean {
  return (ROLE_DEFAULTS[role]?.length ?? 0) > 0 || TYPING_ROLES.has(role)
}

/** The action words a line lists: the element's, less its role's defaults, deduplicated, in order. */
export function listedActions(role: string, words: readonly string[]): string[] {
  const defaults = new Set(ROLE_DEFAULTS[role] ?? [])
  return [...new Set(words)].filter((w) => !defaults.has(w))
}

// ── keys (§5.1) ─────────────────────────────────────────────────────────

export const MODIFIERS = ['shift', 'ctrl', 'alt', 'super'] as const
export type Modifier = (typeof MODIFIERS)[number]

/** Lower-cased name → modifier. On the Mac `super` is Command and `alt` is Option. */
export const MODIFIER_NAMES: Readonly<Record<string, Modifier>> = {
  shift: 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  super: 'super',
  cmd: 'super',
  command: 'super'
}

const NAMED_KEYS = [
  'Return',
  'Tab',
  'Escape',
  'BackSpace',
  'Delete',
  'space',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'Page_Up',
  'Page_Down',
  'minus',
  'plus',
  'equal',
  'comma',
  'period',
  'slash',
  'backslash',
  'semicolon',
  'apostrophe',
  'grave',
  'bracketleft',
  'bracketright',
  ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`)
]

/** Lower-cased X11 keysym name or alias → the canonical name. A modifier is a key too (`hold_key shift`). */
export const KEY_NAMES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(NAMED_KEYS.map((k) => [k.toLowerCase(), k])),
  enter: 'Return',
  kp_enter: 'Return',
  esc: 'Escape',
  del: 'Delete',
  pageup: 'Page_Up',
  prior: 'Page_Up',
  pagedown: 'Page_Down',
  next: 'Page_Down',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  spacebar: 'space',
  ...Object.fromEntries(Object.entries(MODIFIER_NAMES)),
  shift_l: 'shift',
  shift_r: 'shift',
  control_l: 'ctrl',
  control_r: 'ctrl',
  alt_l: 'alt',
  alt_r: 'alt',
  super_l: 'super',
  super_r: 'super',
  meta_l: 'super',
  meta_r: 'super'
}

export interface KeyCombo {
  modifiers: Modifier[]
  /** a canonical KEY_NAMES value, a modifier, or a single character as written */
  key: string
}

export class KeyComboError extends Error {}

/** `ctrl+s`, `super+shift+t`, `alt+Tab`, `Return`, `super++`: names case-insensitive, `+`-joined. */
export function parseKeyCombo(text: string): KeyCombo {
  if (text === '') throw new KeyComboError('a key is needed')
  let rest = text
  let key: string | null = null
  if (text === '+') return { modifiers: [], key: '+' }
  if (text.endsWith('++')) {
    key = '+'
    rest = text.slice(0, -2)
  }
  const parts = rest.split('+')
  if (parts.some((p) => p === '')) throw new KeyComboError(`"${text}" has an empty part`)
  if (key === null) key = keyName(parts.pop()!)
  const modifiers = parseModifierParts(parts, text)
  if ((MODIFIERS as readonly string[]).includes(key) && modifiers.includes(key as Modifier))
    throw new KeyComboError(`"${text}" names ${key} twice`)
  return { modifiers, key }
}

/** The modifiers a click, drag or scroll holds: `shift`, `ctrl+alt`, `cmd`. */
export function parseModifiers(text: string): Modifier[] {
  const parts = text.split('+')
  if (parts.some((p) => p === '')) throw new KeyComboError(`"${text}" has an empty part`)
  return parseModifierParts(parts, text)
}

function parseModifierParts(parts: string[], text: string): Modifier[] {
  const out: Modifier[] = []
  for (const part of parts) {
    const m = MODIFIER_NAMES[part.toLowerCase()]
    if (!m) throw new KeyComboError(`"${part}" in "${text}" is not a modifier`)
    if (out.includes(m)) throw new KeyComboError(`"${text}" names ${m} twice`)
    out.push(m)
  }
  return out
}

function keyName(part: string): string {
  if ([...part].length === 1) return part === ' ' ? 'space' : part
  const named = KEY_NAMES[part.toLowerCase()]
  if (!named) throw new KeyComboError(`"${part}" is not a key`)
  return named
}

/** The canonical text of a combo: modifiers in MODIFIERS order, then the key. */
export function formatKeyCombo(combo: KeyCombo): string {
  const mods = [...combo.modifiers].sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b))
  return [...mods, combo.key].join('+')
}

// ── lines ───────────────────────────────────────────────────────────────

export const HEADER_SEPARATOR = ' · '
export const HEADER_WORDS = {
  loading: 'still loading',
  diff: 'changes since your last read',
  unchanged: 'no changes',
  thin: 'thin tree, see the screenshot'
} as const
export const OTHER_WINDOWS_PREFIX = 'other windows: '
export const STUB_SUFFIX = ': items not exposed to accessibility; see the screenshot)'

export interface ObservationHeader {
  app: string
  window: string
  /** the coordinate space, pixels */
  width: number
  height: number
  focused?: number
  loading: boolean
  change: 'diff' | 'unchanged' | null
  thin: boolean
}

export interface OtherWindow {
  title: string
  where?: 'minimized' | 'other Space'
}

/** Integer pixels in the session's coordinate space. */
export interface LineFrame {
  x: number
  y: number
  w: number
  h: number
}

export interface ElementLine {
  depth: number
  marker?: '-' | '~'
  index: number
  role: string
  /** as printed: already cut */
  name?: string
  /** as printed: already cut */
  value?: string
  states: StateWord[]
  caret?: number
  selection?: [number, number]
  actions: string[]
  frame?: LineFrame
  /** a removed subtree: how many elements went with it */
  inside?: number
}

export interface RangeLine {
  depth: number
  marker?: '-'
  first: number
  last: number
  role: string
}

export type ObservationLine =
  | ({ type: 'element' } & ElementLine)
  | ({ type: 'range' } & RangeLine)
  | { type: 'more'; depth: number; below?: number; above?: number }
  | { type: 'stub'; depth: number; role: string; name?: string }
  | { type: 'truncated'; omitted: number; element: number }
  | { type: 'added'; parent: number | null }

export interface ParsedObservation {
  header: ObservationHeader
  others: OtherWindow[]
  lines: ObservationLine[]
}

export class ObservationParseError extends Error {
  constructor(
    readonly line: number,
    reason: string
  ) {
    super(`line ${line}: ${reason}`)
  }
}

/** A name as a line prints it: at most 100 Unicode scalars, then `…`. */
export function cutName(name: string): string {
  const s = [...name]
  return s.length > OBSERVATION_TEXT.nameMaxChars ? s.slice(0, OBSERVATION_TEXT.nameMaxChars).join('') + '…' : name
}

/** A value as a line prints it: at most 160 Unicode scalars, then `…(+<n> chars)`. */
export function cutValue(value: string): string {
  const s = [...value]
  const max = OBSERVATION_TEXT.valueMaxChars
  return s.length > max ? `${s.slice(0, max).join('')}…(+${s.length - max} chars)` : value
}

const quote = (s: string): string => JSON.stringify(s)
const indent = (depth: number): string => ' '.repeat(depth * OBSERVATION_TEXT.indentSpaces)

export function formatHeader(h: ObservationHeader): string {
  const parts = [`app ${quote(h.app)}`, `window ${quote(h.window)}`, `${h.width}×${h.height}`]
  if (h.focused !== undefined) parts.push(`focused [${h.focused}]`)
  if (h.loading) parts.push(HEADER_WORDS.loading)
  if (h.change) parts.push(HEADER_WORDS[h.change])
  if (h.thin) parts.push(HEADER_WORDS.thin)
  return parts.join(HEADER_SEPARATOR)
}

export function formatOthers(others: readonly OtherWindow[]): string {
  return OTHER_WINDOWS_PREFIX + others.map((w) => quote(w.title) + (w.where ? ` ${w.where}` : '')).join(', ')
}

export function formatElementLine(e: ElementLine): string {
  let s = (e.marker ? `${e.marker} ` : indent(e.depth)) + `[${e.index}] ${e.role}`
  if (e.name !== undefined) s += ` ${quote(e.name)}`
  if (e.value !== undefined) s += ` = ${quote(e.value)}`
  for (const state of e.states) s += ` ${state}`
  if (e.caret !== undefined) s += ` caret ${e.caret}`
  else if (e.selection) s += ` selection ${e.selection[0]}..${e.selection[1]}`
  if (e.actions.length) s += ` actions: ${e.actions.join(', ')}`
  if (e.frame) s += ` @${e.frame.x},${e.frame.y} ${e.frame.w}×${e.frame.h}`
  if (e.inside !== undefined) s += ` (and ${e.inside} inside)`
  return s
}

export function formatRangeLine(r: RangeLine): string {
  return (r.marker ? `${r.marker} ` : indent(r.depth)) + `[${r.first}]–[${r.last}] ${r.last - r.first + 1} × ${r.role}`
}

export function formatLine(line: ObservationLine): string {
  switch (line.type) {
    case 'element':
      return formatElementLine(line)
    case 'range':
      return formatRangeLine(line)
    case 'more': {
      const counts =
        line.below !== undefined && line.above !== undefined
          ? `${line.below} more below, ${line.above} above`
          : line.below !== undefined
            ? `${line.below} more below`
            : `${line.above} more above`
      return `${indent(line.depth)}… ${counts}`
    }
    case 'stub':
      return `${indent(line.depth)}(${line.role}${line.name !== undefined ? ` ${quote(line.name)}` : ''}${STUB_SUFFIX}`
    case 'truncated':
      return `(truncated: ${line.omitted} elements left out; observe with element: ${line.element} to see one part whole)`
    case 'added':
      return line.parent === null ? '+ at top:' : `+ in [${line.parent}]:`
  }
}

export function formatObservation(o: ParsedObservation): string {
  return [formatHeader(o.header), ...(o.others.length ? [formatOthers(o.others)] : []), ...o.lines.map(formatLine)].join('\n')
}

// ── the parser ──────────────────────────────────────────────────────────

/** Whether a role word starts at `at`: a lower-case word that is not reserved for what follows a role. */
function roleWordAt(text: string, at: number): boolean {
  const m = /^([a-z][a-z0-9-]*)(:?)/.exec(text.slice(at))
  if (!m) return false
  const w = m[1]
  return !(STATE_SET.has(w) || w === 'caret' || w === 'selection' || (w === 'actions' && m[2] === ':'))
}

/** A cursor over one line; every read either advances or throws. */
class Cursor {
  pos = 0
  constructor(
    readonly text: string,
    readonly line: number
  ) {}
  get done(): boolean {
    return this.pos >= this.text.length
  }
  fail(reason: string): never {
    throw new ObservationParseError(this.line, `${reason} at column ${this.pos + 1}`)
  }
  peek(s: string): boolean {
    return this.text.startsWith(s, this.pos)
  }
  take(s: string): boolean {
    if (!this.peek(s)) return false
    this.pos += s.length
    return true
  }
  expect(s: string): void {
    if (!this.take(s)) this.fail(`expected ${JSON.stringify(s)}`)
  }
  int(): number {
    const m = /^(?:0|-?[1-9]\d*)/.exec(this.text.slice(this.pos))
    if (!m) this.fail('expected a number')
    this.pos += m[0].length
    return Number(m[0])
  }
  /** A JSON string written the way JSON.stringify writes it. */
  string(): string {
    if (this.text[this.pos] !== '"') this.fail('expected a quoted string')
    let i = this.pos + 1
    while (i < this.text.length && this.text[i] !== '"') i += this.text[i] === '\\' ? 2 : 1
    if (i >= this.text.length) this.fail('unterminated string')
    const raw = this.text.slice(this.pos, i + 1)
    let value: string
    try {
      value = JSON.parse(raw) as string
    } catch {
      this.fail('bad string escape')
    }
    if (quote(value) !== raw) this.fail('string not written the canonical way')
    this.pos = i + 1
    return value
  }
  /** One or more lower-case words, stopping before a state word, `caret`, `selection`, `actions:`, a quote or `=`. */
  role(): string {
    const words: string[] = []
    for (;;) {
      const m = /^[a-z][a-z0-9-]*/.exec(this.text.slice(this.pos))
      if (!m) break
      words.push(m[0])
      this.pos += m[0].length
      if (this.text[this.pos] !== ' ' || !roleWordAt(this.text, this.pos + 1)) break
      this.pos += 1
    }
    if (!words.length) this.fail('expected a role')
    return words.join(' ')
  }
  /** A quoted string after one space, when one follows. */
  optionalString(): string | undefined {
    if (!this.peek(' "')) return undefined
    this.pos += 1
    return this.string()
  }
}

/** Depth from a run of spaces: two per level, at most OBSERVATION_TEXT.maxDepth. */
function depthOf(text: string, line: number): { depth: number; rest: string } {
  const spaces = /^ */.exec(text)![0].length
  if (spaces % OBSERVATION_TEXT.indentSpaces) throw new ObservationParseError(line, 'indent is not a whole number of levels')
  const depth = spaces / OBSERVATION_TEXT.indentSpaces
  if (depth > OBSERVATION_TEXT.maxDepth) throw new ObservationParseError(line, `deeper than ${OBSERVATION_TEXT.maxDepth} levels`)
  return { depth, rest: text.slice(spaces) }
}

/** An element or range line's body: `[<i>] …` or `[<a>]–[<b>] <n> × <role>`. */
function parseBody(body: string, depth: number, line: number): ({ type: 'element' } & ElementLine) | ({ type: 'range' } & RangeLine) {
  const range = /^\[([1-9]\d*)\]–\[([1-9]\d*)\] ([1-9]\d*) × (.+)$/.exec(body)
  if (range) {
    const [first, last, count] = [Number(range[1]), Number(range[2]), Number(range[3])]
    if (last <= first) throw new ObservationParseError(line, 'a range ends after it starts')
    if (count !== last - first + 1) throw new ObservationParseError(line, `a range of [${first}]–[${last}] holds ${last - first + 1}, not ${count}`)
    const c = new Cursor(range[4], line)
    const role = c.role()
    if (!c.done) c.fail('unexpected text after the role')
    return { type: 'range', depth, first, last, role }
  }
  let rest = body
  let inside: number | undefined
  const insideMatch = / \(and ([1-9]\d*) inside\)$/.exec(rest)
  if (insideMatch) {
    inside = Number(insideMatch[1])
    rest = rest.slice(0, insideMatch.index)
  }
  let frame: LineFrame | undefined
  const geo = / @(0|-?[1-9]\d*),(0|-?[1-9]\d*) (0|[1-9]\d*)×(0|[1-9]\d*)$/.exec(rest)
  if (geo) {
    frame = { x: Number(geo[1]), y: Number(geo[2]), w: Number(geo[3]), h: Number(geo[4]) }
    rest = rest.slice(0, geo.index)
  }
  const c = new Cursor(rest, line)
  c.expect('[')
  const index = c.int()
  if (index < 1) c.fail('an index is positive')
  c.expect('] ')
  const e: { type: 'element' } & ElementLine = { type: 'element', depth, index, role: c.role(), states: [], actions: [] }
  const name = c.optionalString()
  if (name !== undefined) e.name = name
  if (c.take(' = ')) e.value = c.string()
  while (!c.done) {
    const m = /^ ([a-z-]+)/.exec(c.text.slice(c.pos))
    if (!m || !STATE_SET.has(m[1])) break
    const state = m[1] as StateWord
    const last = e.states[e.states.length - 1]
    if (last && STATE_WORDS.indexOf(state) <= STATE_WORDS.indexOf(last)) c.fail(`state "${state}" out of order`)
    e.states.push(state)
    c.pos += m[0].length
  }
  if (c.take(' caret ')) e.caret = c.int()
  else if (c.take(' selection ')) {
    const a = c.int()
    c.expect('..')
    const b = c.int()
    if (b < a) c.fail('a selection ends after it starts')
    e.selection = [a, b]
  }
  if (c.take(' actions: ')) {
    e.actions = c.text.slice(c.pos).split(', ')
    if (e.actions.some((w) => !/^\S(.*\S)?$/.test(w))) c.fail('an empty or padded action word')
    c.pos = c.text.length
  }
  if (!c.done) c.fail('unexpected text')
  if (frame) e.frame = frame
  if (inside !== undefined) e.inside = inside
  return e
}

/** One element line, with its indent or its diff marker. */
export function parseElementLine(text: string, line = 1): ElementLine {
  const parsed = parseLineAt(text, line)
  if (parsed.type !== 'element') throw new ObservationParseError(line, 'not an element line')
  const { type: _type, ...element } = parsed
  return element
}

function parseLineAt(text: string, line: number): ObservationLine {
  if (text.startsWith('- ')) return { ...parseBody(text.slice(2), 0, line), marker: '-' }
  if (text.startsWith('~ ')) {
    const body = parseBody(text.slice(2), 0, line)
    if (body.type !== 'element') throw new ObservationParseError(line, 'a changed line names one element')
    if (body.inside !== undefined) throw new ObservationParseError(line, '"(and n inside)" belongs to a removed line')
    return { ...body, marker: '~' }
  }
  const added = /^\+ (?:in \[([1-9]\d*)\]|at top):$/.exec(text)
  if (added) return { type: 'added', parent: added[1] === undefined ? null : Number(added[1]) }
  const truncated = /^\(truncated: ([1-9]\d*) elements left out; observe with element: ([1-9]\d*) to see one part whole\)$/.exec(text)
  if (truncated) return { type: 'truncated', omitted: Number(truncated[1]), element: Number(truncated[2]) }
  const { depth, rest } = depthOf(text, line)
  const more = /^… ([1-9]\d*) more (below|above)(?:, ([1-9]\d*) above)?$/.exec(rest)
  if (more) {
    if (more[3] !== undefined && more[2] !== 'below') throw new ObservationParseError(line, 'write "N more below, M above"')
    return more[2] === 'below'
      ? { type: 'more', depth, below: Number(more[1]), ...(more[3] !== undefined ? { above: Number(more[3]) } : {}) }
      : { type: 'more', depth, above: Number(more[1]) }
  }
  if (rest.startsWith('(') && rest.endsWith(STUB_SUFFIX)) {
    const c = new Cursor(rest.slice(1, -STUB_SUFFIX.length), line)
    const role = c.role()
    const name = c.optionalString()
    if (!c.done) c.fail('unexpected text in a stub line')
    return name === undefined ? { type: 'stub', depth, role } : { type: 'stub', depth, role, name }
  }
  if (rest.startsWith('[')) {
    const body = parseBody(rest, depth, line)
    if (body.type === 'element' && body.inside !== undefined)
      throw new ObservationParseError(line, '"(and n inside)" belongs to a removed line')
    return body
  }
  throw new ObservationParseError(line, 'not a line of the observation grammar')
}

function parseHeader(text: string): ObservationHeader {
  const c = new Cursor(text, 1)
  c.expect('app ')
  const app = c.string()
  c.expect(`${HEADER_SEPARATOR}window `)
  const window = c.string()
  c.expect(HEADER_SEPARATOR)
  const width = c.int()
  c.expect('×')
  const height = c.int()
  if (width < 1 || height < 1) c.fail('the space is at least 1×1')
  const h: ObservationHeader = { app, window, width, height, loading: false, change: null, thin: false }
  if (c.take(`${HEADER_SEPARATOR}focused [`)) {
    h.focused = c.int()
    c.expect(']')
  }
  if (c.take(HEADER_SEPARATOR + HEADER_WORDS.loading)) h.loading = true
  if (c.take(HEADER_SEPARATOR + HEADER_WORDS.diff)) h.change = 'diff'
  else if (c.take(HEADER_SEPARATOR + HEADER_WORDS.unchanged)) h.change = 'unchanged'
  if (c.take(HEADER_SEPARATOR + HEADER_WORDS.thin)) h.thin = true
  if (!c.done) c.fail('unexpected text in the header')
  return h
}

function parseOthers(text: string): OtherWindow[] {
  const c = new Cursor(text, 2)
  c.expect(OTHER_WINDOWS_PREFIX)
  const out: OtherWindow[] = []
  do {
    const w: OtherWindow = { title: c.string() }
    if (c.take(' minimized')) w.where = 'minimized'
    else if (c.take(' other Space')) w.where = 'other Space'
    out.push(w)
  } while (c.take(', '))
  if (!c.done) c.fail('unexpected text in the other windows')
  return out
}

/**
 * The observation text as lines, held to the grammar: a full or subtree
 * observation is a tree (depth grows one level at a time, an index at most
 * once, the `(truncated …)` line last); a diff is marker lines and added
 * groups; `unchanged` is the header alone. Anything else throws with its
 * line number.
 */
export function parseObservation(text: string): ParsedObservation {
  const rows = text.split('\n')
  rows.forEach((row, i) => {
    if (row === '') throw new ObservationParseError(i + 1, 'an empty line')
    if (row !== row.trimEnd()) throw new ObservationParseError(i + 1, 'trailing spaces')
  })
  const header = parseHeader(rows[0])
  let at = 1
  let others: OtherWindow[] = []
  if (rows[1]?.startsWith(OTHER_WINDOWS_PREFIX)) {
    others = parseOthers(rows[1])
    at = 2
  }
  if (header.change === 'unchanged' && rows.length > 1)
    throw new ObservationParseError(2, 'an unchanged observation is its header alone')
  const lines: ObservationLine[] = []
  const seen = new Set<number>()
  const claim = (from: number, to: number, line: number): void => {
    for (let i = from; i <= to; i++) {
      if (seen.has(i)) throw new ObservationParseError(line, `[${i}] appears twice`)
      seen.add(i)
    }
  }
  const diff = header.change === 'diff'
  let prevDepth = -1
  let inAdded = false
  for (let r = at; r < rows.length; r++) {
    const n = r + 1
    const line = parseLineAt(rows[r], n)
    if (lines.some((l) => l.type === 'truncated')) throw new ObservationParseError(n, 'the truncated line comes last')
    const marked = (line.type === 'element' || line.type === 'range') && line.marker !== undefined
    if (line.type === 'added') {
      if (!diff) throw new ObservationParseError(n, 'an added group outside a diff')
      inAdded = true
      prevDepth = 0
    } else if (marked) {
      if (!diff) throw new ObservationParseError(n, 'a marked line outside a diff')
      inAdded = false
    } else if (line.type === 'truncated') {
      // depth 0, last
    } else {
      const depth = line.depth
      if (diff) {
        if (!inAdded) throw new ObservationParseError(n, 'a diff line needs a marker or an added group')
        if (depth < 1) throw new ObservationParseError(n, 'an added line is indented under its group')
      } else if (prevDepth === -1 && depth !== 0) throw new ObservationParseError(n, 'the tree starts at depth 0')
      if (depth > prevDepth + 1) throw new ObservationParseError(n, 'indent grows one level at a time')
      prevDepth = depth
    }
    if (line.type === 'element') claim(line.index, line.index, n)
    if (line.type === 'range') claim(line.first, line.last, n)
    lines.push(line)
  }
  return { header, others, lines }
}
