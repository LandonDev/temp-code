/**
 * Every word a model reads about the computer tools (docs/computer-protocol.md
 * "The model's words"): the four tools' descriptions, one line per field and
 * one per per-verb tool, in two shapes. `anthropic` follows Anthropic's
 * computer-use phrasing; `cua` carries the same facts with cua's names
 * (`getAXState`, `setValue`, `performSecondaryAction`, `pressKey`) as glosses,
 * in our own words. Words only: tools.ts builds the described schemas and the
 * tool specs from these, so this module imports no schema.
 */
import type { ActionParam, ComputerActionName } from './protocol'
import { NO_INPUT_ACTIONS } from './protocol'

export const WORDS_SHAPES = ['anthropic', 'cua'] as const
export type WordsShape = (typeof WORDS_SHAPES)[number]
/** `act`: the four tools. `per-verb`: computer_act becomes one tool per action. */
export const TOOL_SHAPES = ['act', 'per-verb'] as const
export type ToolShape = (typeof TOOL_SHAPES)[number]

/** What tool search matches the deferred computer tools by on Claude (the SDK's `searchHint`). */
export const COMPUTER_SEARCH_HINT = 'computer use on the Mac: read app windows, click, type and scroll in them'

export const SEARCH_HINT_MAX = 120
/**
 * Claude Code 2.1.303 keeps 4,096 characters of an MCP tool's description
 * (16,384 of a deferred one); the budget sits well under both, for codex and
 * Muse, which list every tool on every turn.
 */
export const TOOL_DESCRIPTION_MAX = 1800
export const FIELD_DESCRIPTION_MAX = 200
export const PER_VERB_DESCRIPTION_MAX = 400
/**
 * The four tools' `tools/list` JSON, descriptions and schemas, as the bridge lists them.
 * 15,000 since computer_apps took `open` and its `confirm` (§23): about 800 characters in the cua shape.
 */
export const TOOLS_LIST_MAX = 15_000

// ── the four tools ──────────────────────────────────────────────────────

type ToolKey = 'computer_apps' | 'computer_observe' | 'computer_act' | 'computer_batch'

const ACTION_LIST =
  'left_click, right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, screenshot, zoom, cursor_position, set_value, perform, select_text, paste'

const ANTHROPIC: Record<ToolKey, string> = {
  computer_apps:
    "Lists the Mac's running apps, the active one first: name, bundle id, and each window's title, minimized or on another Space. launch starts an installed app in the background; open opens files, folders or web pages in it, never programs. An app that comes forward anyway is sent back, and the result says so. Opening into an app that holds the person's documents can change them: prefer a file you made over File › New there. Use this when you do not know which app or window holds the work; the other tools launch an app by name.",
  computer_observe:
    'Reads one window of an app as text: its accessibility tree, one element a line, each with an [index], its role, name, value, state and any actions beyond a click ("actions: show menu"). Start here, then act by [index]. The first read of an app in this thread is the whole tree; later reads are a diff against your last one: "-" removed, "~" changed, "+ in [n]:" added, or "no changes". It waits for the window to settle, so never sleep first, and never read again with no action between: the tools that act already return the fresh tree. full gives the whole tree again; element gives one element\'s subtree whole (a long document\'s text); screenshot attaches a picture of the window. You get one anyway when the header says "thin tree": then aim with coordinates in that picture\'s pixels. menus adds the menu bar. Title-bar buttons are elements: click close or minimize by [index]; a whole read with no close line means the window cannot close. "minimized" on the window line means it is in the Dock.',
  computer_act:
    'Does one action in an app window, waits for the window to settle, and returns the step\'s line and the window as a diff: that is your next read. The actions are the computer tool\'s, with its parameters: left_click, right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, screenshot, zoom, cursor_position. Four more work on an element: set_value replaces its value, perform runs an action word it lists or one its role does by default (expand, collapse, increment, decrement), select_text selects text in it, paste puts in text, markdown or HTML and gives back the clipboard. Aim with element, an [index] from your latest read; coordinate is [x, y] in the latest screenshot\'s pixels, for a thin tree. Prefer set_value to clicking and typing. type and paste with no element go to the focused element of your latest read. key takes xdotool names: Return, Tab, Escape, super+c. The step line names the tier it ran on and whether the window changed; "no change seen" means try another way. In the background a shortcut runs its menu item, a click presses the element under it and text goes straight into the field; the step line names that way, and a disabled menu item waits for the Mac to be free. With more than one step in view, use computer_batch. Set confirm when this act is one the person approves first: deleting, sending, paying, account or access changes and the rest of confirm\'s list.',
  computer_batch:
    'Does up to 20 actions in order in one app window, waits once, and returns a line per step and one read of the window: the fast way to work. Put in every step your latest read lets you foresee: click a field, type, press Tab, type, click Save. Each step is an object with action ({actions}) and that action\'s parameters, {steps}. An [index] must come from your latest read; an element the batch makes appear needs the next read. After another action in the same batch, type and paste name their element. The batch stops at the first failure and the steps after it say Not executed. Each step line names how the step went in. A confirm covers the whole batch, so end the batch before a step that needs one and send that step alone with its flag. You are done when the returned tree shows the result, not when the actions ran.'
}

const CUA: Record<ToolKey, string> = {
  computer_apps:
    "Lists the Mac's running apps and their windows, the active app first: names, bundle ids, window titles, minimized or on another Space. launch opens an installed app in the background; open hands it files, folders or web pages, never programs. If the app comes forward anyway, the person's app is put back and the result says so. Opening into an app holding the person's documents can change them: prefer a file you made over File › New there. Call it when you do not know which app or window holds the work.",
  computer_observe:
    'This is getAXState: one window\'s accessibility tree as text, an [index] on each element with its role, name, value, state and any actions beyond a click ("actions: show menu"). Call it first, then act on elements by [index]. Your first read of an app in this thread is the whole tree; after that you get a diff against your last read ("-" removed, "~" changed, "+ in [n]:" added, or "no changes"), and full is disableDiffing. It waits for the window to settle, so do not sleep before it, and do not call it again with no action between: the tools that act already end with the fresh state. element returns one element\'s subtree in full (a long document\'s text); screenshot adds a picture of the window, which also comes on its own when the header says "thin tree": then use coordinates in that picture\'s pixels. menus adds the menu bar. Title-bar buttons are elements: click(index) close or minimize; a whole read with no close line means the window cannot close. "minimized" on the window line: it is in the Dock.',
  computer_act:
    'Runs one action in an app window, waits for it to settle, and returns the step\'s line and the window\'s state as a diff: your next read. left_click with element is click(index); set_value is setValue and replaces an element\'s value; perform is performSecondaryAction and takes an action name the element lists or one its role does by default (expand, collapse, increment, decrement); select_text is selectText; type is typeText; key is pressKey, xdotool syntax (Return, Tab, Escape, super+c); paste is paste, text, markdown or HTML with the clipboard restored. The rest are the computer tool\'s pointer and screen actions: right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, hold_key, wait, screenshot, zoom, cursor_position. Name an element by its [index] from your latest read; coordinate is [x, y] in the latest screenshot\'s pixels, for a thin tree. Prefer setValue to a click and typeText. type and paste with no element go to the focused element of your latest read. The step line names its tier and whether the window changed; "no change seen" means try another way. In the background pressKey runs the combo\'s menu item, click presses the element under it and text goes straight in; a disabled item waits for a free Mac. When you can see more than one step ahead, use computer_batch. Set confirm when the person must approve this act first: deleting, sending, paying, account or access changes and the rest of confirm\'s list.',
  computer_batch:
    'This is one cua_repl script: the actions you can foresee and the read in one call. Up to 20 actions run in order in one app window, then it waits once and returns a line per step and the window\'s state. Each step is an object with action ({actions}) and that action\'s parameters, {steps}. Put in every step your latest read lets you foresee: click a field, type, press Tab, type, click Save. An [index] must come from your latest read; an element the batch makes appear needs the next read. After another action in the same batch, type and paste name their element. The batch stops at the first failure; the steps after it say Not executed. A confirm covers the whole batch, so end the batch before a step that needs one and send that step alone with its flag. An action tried is not a task done: keep going until the returned state shows the result, or name what blocks you.'
}

const STEPS_AS: Record<ToolShape, string> = {
  act: 'as computer_act takes them',
  'per-verb': 'as its own computer_<action> tool takes them'
}

/** One tool's description in a word shape; computer_batch says where its steps' parameters are described. */
export function toolDescription(shape: WordsShape, tools: ToolShape, name: ToolKey): string {
  const text = (shape === 'cua' ? CUA : ANTHROPIC)[name]
  return name === 'computer_batch' ? text.replace('{actions}', ACTION_LIST).replace('{steps}', STEPS_AS[tools]) : text
}

// ── the fields ──────────────────────────────────────────────────────────

/** Every field of every tool's schema; an action's own fields by their wire name. */
export type FieldKey =
  | 'app'
  | 'window'
  | 'screenshot'
  | 'full'
  | 'observe.element'
  | 'menus'
  | 'launch'
  | 'open'
  | 'apps.confirm'
  | 'apps.confirm.kind'
  | 'actions'
  | 'action'
  | 'confirm'
  | 'batch.confirm'
  | 'confirm.kind'
  | 'confirm.what'
  | ActionParam

const ANTHROPIC_FIELDS: Record<FieldKey, string> = {
  app: 'The app\'s name or bundle id, as computer_apps lists it. One that is installed but not running starts in the background.',
  window: "Part of the window's title. Left out: the window you used last in this app, else its main window.",
  screenshot: 'Attach a picture of the window to the read. Left out: a picture comes only with a thin tree.',
  full: 'The whole tree, not a diff against your last read.',
  'observe.element': "One element's subtree in full, values uncut: a long document's text.",
  menus: 'Include the menu bar.',
  launch: 'Start this app in the background before listing.',
  open: 'Absolute paths, file or http(s) URLs to open in the launch app. Never programs.',
  'apps.confirm': "As computer_act's confirm: set when an item sends, uploads or shares the person's data.",
  'apps.confirm.kind': "As on computer_act's confirm.",
  actions: 'The steps, in order, each an object with action and its parameters.',
  action: 'Which action, by its name in the tool description.',
  element: 'The [index] to act on, from your latest read.',
  coordinate: "[x, y] in the latest screenshot's pixels, from the window's top left. Use element when the tree has one.",
  start_element: 'Where a drag starts: an [index] from your latest read.',
  start_coordinate: "Where a drag starts: [x, y] in the screenshot's pixels.",
  text: 'type and paste: the text. key and hold_key: the key or combo (Return, super+c). Clicks, drag, scroll: modifiers to hold (shift, ctrl, alt, super). select_text: the text to select.',
  region: "zoom: [x0, y0, x1, y1] in the screenshot's pixels.",
  scroll_direction: 'up, down, left or right.',
  scroll_amount: 'Wheel clicks; five is about a page.',
  repeat: 'key: how many times to press it.',
  duration:
    'Seconds. wait: the longest to wait for the window to settle; it ends sooner when it does. hold_key: how long to hold. Clicks: how long to hold the button.',
  value: 'set_value: the new value, which replaces the old.',
  name: 'perform: an action word the element lists after "actions:", or one its role does by default: expand, collapse, increment, decrement, raise (a window, from the Dock too).',
  range: 'select_text: [start, end] in UTF-16 units, instead of text.',
  prefix: 'select_text: the text right before the match, to pick one of several.',
  suffix: 'select_text: the text right after the match, to pick one of several.',
  place: 'select_text: select (the default), or before or after to put the caret there.',
  format: 'paste: text (the default), markdown or html.',
  confirm: "Set when this act needs the person's OK first. The app shows a card and acts only on Allow. Leave it out for anything else.",
  'batch.confirm':
    "Set when a step of this batch needs the person's OK first. The app shows one card for the batch and runs it only on Allow.",
  'confirm.kind':
    "What the act does. delete, send, pay, subscribe, account, access, install, captcha, security and medical: always. The rest: unless the person's own words asked for this act.",
  'confirm.what': 'What happens and to whom, in one line: "Reply to Ana accepting Friday\'s lunch".'
}

const CUA_FIELDS: Record<FieldKey, string> = {
  ...ANTHROPIC_FIELDS,
  full: 'disableDiffing: the whole tree, not a diff against your last read.',
  element: 'The [index] to act on, from your latest read: left_click with element is click(index).',
  text: 'type (typeText) and paste: the text. key (pressKey) and hold_key: the key or combo (Return, super+c). Clicks, drag, scroll: modifiers to hold. select_text: the text to select.',
  scroll_amount: 'Wheel clicks, five to a page.',
  value: 'set_value (setValue): the new value, which replaces the old.',
  name: 'perform (performSecondaryAction): an action word the element lists after "actions:", or a role default: expand, collapse, increment, decrement, raise (a window, from the Dock too).'
}

export function fieldWords(shape: WordsShape): Readonly<Record<FieldKey, string>> {
  return shape === 'cua' ? CUA_FIELDS : ANTHROPIC_FIELDS
}

// ── the per-verb set ────────────────────────────────────────────────────

const PER_VERB: Record<ComputerActionName, string> = {
  screenshot: 'Takes a picture of the window, in its pixels.',
  zoom: "Takes a picture of one region of the window at full resolution: region [x0, y0, x1, y1] in the screenshot's pixels.",
  left_click: 'Clicks an element, or a point. element or coordinate; text holds modifiers; duration holds the button.',
  right_click: 'Right-clicks an element, or a point, for its menu. element or coordinate; text holds modifiers.',
  middle_click: 'Middle-clicks an element, or a point. element or coordinate; text holds modifiers.',
  double_click: 'Double-clicks an element, or a point. element or coordinate; text holds modifiers.',
  triple_click: 'Triple-clicks an element, or a point, to select a line. element or coordinate; text holds modifiers.',
  left_click_drag: 'Drags from start_element or start_coordinate to element or coordinate; text holds modifiers.',
  mouse_move: 'Moves the pointer over an element or a point, to show its hover state. element or coordinate.',
  left_mouse_down: 'Presses the mouse button where the pointer is, for a drag in steps.',
  left_mouse_up: 'Lets go of the mouse button where the pointer is.',
  cursor_position: 'Says where the pointer is, in the screenshot\'s pixels.',
  scroll: 'Scrolls: scroll_direction and scroll_amount in wheel clicks, five to a page; element or coordinate for where. In the background it moves the scroll bar.',
  type: 'Types text. element names the field; left out, the focused element of your latest read.',
  key: "Presses a key or combo in xdotool names: text (Return, Tab, Escape, super+c); repeat to press it again. In the background it runs the app's menu item for the combo.",
  hold_key: 'Holds a key or combo (text) for duration seconds.',
  wait: 'Waits up to duration seconds for the window to settle, and ends sooner when it does.',
  set_value: "Replaces an element's value: element and value. Faster than a click and typing.",
  perform: 'Runs an action on an element: element and name, a word it lists after "actions:" or a role default (expand, collapse, increment, decrement; raise on a window, out of the Dock too, when the Mac is free).',
  select_text: 'Selects text in an element: element and text or range; prefix and suffix pick one of several; place puts the caret before or after.',
  paste: 'Puts in text, markdown or HTML (format) and gives back the clipboard: text, and element or the focused one.'
}

const CUA_GLOSS: Partial<Record<ComputerActionName, string>> = {
  left_click: 'click(index)',
  type: 'typeText',
  key: 'pressKey',
  set_value: 'setValue',
  perform: 'performSecondaryAction',
  select_text: 'selectText',
  paste: 'paste'
}

export const PER_VERB_TAIL = "Returns the step's line and the window as a diff: your next read."
const CONFIRM_TAIL = "Set confirm when the person approves this act first."

/** One per-verb tool's description: what it does, its fields, cua's name in the cua shape, then the shared tail. */
export function perVerbDescription(shape: WordsShape, action: ComputerActionName): string {
  const gloss = shape === 'cua' && CUA_GLOSS[action] ? ` This is cua's ${CUA_GLOSS[action]}.` : ''
  const confirm = NO_INPUT_ACTIONS.includes(action) ? '' : ` ${CONFIRM_TAIL}`
  return `${PER_VERB[action]}${gloss} ${PER_VERB_TAIL}${confirm}`
}
