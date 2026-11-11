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
 * The bridge's `tools/list` JSON, descriptions and schemas: the four tools and computer_result.
 * Kept under 15,000 with open/confirm (§23) and the web-content words (§25).
 */
export const TOOLS_LIST_MAX = 15_000

// ── the tools ───────────────────────────────────────────────────────────

/** The four, and computer_result, which only the bridge lists (heldCalls.ts). */
type ToolKey = 'computer_apps' | 'computer_observe' | 'computer_act' | 'computer_batch' | 'computer_result'

const ACTION_LIST =
  'left_click, right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, screenshot, zoom, cursor_position, set_value, perform, select_text, paste'

const ANTHROPIC: Record<ToolKey, string> = {
  computer_apps:
    "Lists the Mac's running apps, the active one first: name, bundle id, each window's title and each browser window's tabs, minimized or on another Space. launch starts an installed app in the background; open opens files, folders or web pages in it, never programs. An app that comes forward anyway is sent back, and the result says so. Opening into an app that holds the person's documents can change them: prefer a file you made over File › New there. Use it to find the app or window; the other tools launch by name.",
  computer_observe:
    'Reads one window of an app as text: its accessibility tree, one element a line, each with an [index], its role, name, value, state and any actions beyond a click ("actions: show menu"). Start here, then act by [index]. The first read of an app in this thread is the whole tree; later reads are a diff against your last one: "-" removed, "~" changed, "+ in [n]:" added, or "no changes". It waits for the window to settle, so never sleep first. An act\'s result is your next read; read again only when it says something is missing. When the header says "thin tree" a picture of the window comes too: aim with coordinates in its pixels. Title-bar buttons are elements: click close or minimize by [index]; a whole read with no close line means the window cannot close. "minimized" on the window line means it is in the Dock. menus: true lists each menu on one line; to run an item you know, use menu.',
  computer_act:
    'Does one action in an app window, waits for the window to settle, and returns the step\'s line and the window as a diff: that is your next read. A step that opens a menu or a window returns it: pick from it in the same batch with named. The actions are the computer tool\'s, with its parameters: left_click, right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, type, key, hold_key, wait, screenshot, zoom, cursor_position. Four more work on an element: set_value replaces its value, perform runs an action word it lists or one its role does by default, select_text selects text in it, paste puts in text, markdown or HTML and gives back the clipboard. Name a target by element, by named: "Team" (its name in the tree), or a menu-bar item by menu: "File > Save…", which needs no read of the menu bar. Use coordinate on a thin tree. Prefer set_value to clicking and typing. type and paste with no element go to the focused element of your latest read. key takes xdotool names: Return, Tab, Escape, super+c. The step line names the tier it ran on and whether the window changed; "no change seen" means try another way. In the background a shortcut runs its menu item, a click presses the element under it and text goes straight into the field; the step line names that way, and a disabled menu item waits for the Mac to be free. For several steps, use computer_batch. Set confirm for an act the person approves first, of a kind confirm.kind lists.',
  computer_batch:
    'Does up to 20 actions in order in one app window, waits once, and returns a line per step and one read of the window: the fast way to work. Batch every step your read lets you foresee: click a field, type, click Save. Each step takes {steps}, with action one of {actions}. A step can target what an earlier step opens, by named. After a step that names a field or opens one, type and key go to it; otherwise the batch stops there and says where the focus is. Keys after a step that changed nothing do not run. The batch stops at the first failure and the steps after it say Not executed. End the batch before a step that needs confirm and send that step alone. You are done when the returned tree shows the result, not when the actions ran.',
  computer_result:
    'Gets the result of a computer call that answered "Held", by its id, waiting up to 20 s, or says it is still held. cancel: true cancels it; a held call never runs unless you ask for its result.'
}

const CUA: Record<ToolKey, string> = {
  computer_apps:
    "Lists the Mac's running apps and their windows, the active app first: names, bundle ids, window titles and each browser window's tabs, minimized or on another Space. launch opens an installed app in the background; open hands it files, folders or web pages, never programs. If the app comes forward anyway, the person's app is put back and the result says so. Opening into an app holding the person's documents can change them: prefer a file you made over File › New there. Use it to find the app or window.",
  computer_observe:
    'This is getAXState: one window\'s accessibility tree as text, an [index] on each element with its role, name, value, state and any actions beyond a click ("actions: show menu"). Call it first, then act on elements by [index]. The first read of an app in this thread is the whole tree; later reads diff your last one ("-" removed, "~" changed, "+ in [n]:" added, or "no changes"). It waits for the window to settle: do not sleep first. An act\'s result is your next read; read again only when it says something is missing. When the header says "thin tree" a picture of the window comes too: then use coordinates in its pixels. Title-bar buttons are elements: click(index) close or minimize; a whole read with no close line means the window cannot close. "minimized" on the window line: it is in the Dock. menus: true lists each menu on one line; to run an item you know, use menu.',
  computer_act:
    'Runs one action, waits for the window to settle, and returns its line and a diff: your next read. A step that opens a menu or a window returns it: pick from it in the same batch with named. left_click with element is click(index); set_value is setValue and replaces an element\'s value; perform is performSecondaryAction and takes an action name the element lists or one its role does by default; select_text is selectText; type is typeText; key is pressKey, xdotool syntax (Return, Tab, Escape, super+c); paste is paste, text, markdown or HTML with the clipboard restored. Other pointer and screen actions: right_click, middle_click, double_click, triple_click, left_click_drag, mouse_move, left_mouse_down, left_mouse_up, scroll, hold_key, wait, screenshot, zoom, cursor_position. Name a target by element, by named: "Team" (its name in the tree), or a menu-bar item by menu: "File > Save…", which needs no read of the menu bar. Use coordinate on a thin tree. Prefer setValue to typeText. type and paste with no element go to the focused element of your latest read. The step line names its tier and whether the window changed; "no change seen" means try another way. In the background pressKey runs the combo\'s menu item, click presses the element under it and text goes straight in; a disabled item waits for a free Mac. For several steps, use computer_batch. Set confirm for acts the person must approve, using a confirm.kind.',
  computer_batch:
    'This is one cua_repl script: up to 20 actions run in order in one app window, then it waits once and returns a line per step and the window\'s state. Each step takes {steps}, with action one of {actions}. Batch every step your read lets you foresee: click a field, type, click Save. A step can target what an earlier step opens, by named. After a step that names a field or opens one, type and key go to it; otherwise the batch stops there and says where the focus is. Keys after a step that changed nothing do not run. The batch stops at the first failure; the steps after it say Not executed. End the batch before a step that needs confirm and send that step alone. An action tried is not a task done: keep going until the returned state shows the result, or name what blocks you.',
  computer_result:
    'Waits up to 20 s for the result of a computer call that answered "Held", named by its id, or says it is still held. With cancel: true it cancels the call instead; a held call never runs unless you ask for its result.'
}

const WEB_OBSERVE = "In a browser, window may name a tab: a background tab is selected first and the result says so. \"page not drawn\" means the window is covered and the browser has not drawn that tab: perform raise on its window draws it when the Mac is free. \"… N more below\" under a list or table in a page: observe with element set to its [index] reads its rows, up to a few thousand; past that the read says it was cut, and you read on from a later row."
const WEB_ACT = "In a web page, set_value on a pop up picks the item of that name, and a value that did not take fails the step. key takes element to focus first; in a browser, text and keys with no element never go into its address bar."

const STEPS_AS: Record<ToolShape, string> = {
  act: "computer_act's fields",
  'per-verb': 'the fields of its own computer_<action> tool'
}

/** One tool's description in a word shape; computer_batch says where its steps' fields are described, since its step items carry none but action's (§27.12). */
export function toolDescription(shape: WordsShape, tools: ToolShape, name: ToolKey): string {
  const text = (shape === 'cua' ? CUA : ANTHROPIC)[name]
  const web = name === 'computer_observe'
    ? WEB_OBSERVE
    : name === 'computer_act'
      ? shape === 'cua' ? WEB_ACT.replace('set_value', 'set_value (setValue)').replace('key takes', 'key (pressKey) takes') : WEB_ACT
      : ''
  return name === 'computer_batch' ? text.replace('{actions}', ACTION_LIST).replace('{steps}', STEPS_AS[tools]) : text + (web ? ` ${web}` : '')
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
  | 'result.id'
  | 'result.cancel'
  | ActionParam

const ANTHROPIC_FIELDS: Record<FieldKey, string> = {
  app: 'App name or bundle id from computer_apps. An installed app starts in the background if it is not running.',
  window: "Part of the window's title, or a tab's title in a browser (that tab is selected first). Left out: the window you used last in this app, else its main window.",
  screenshot: 'Attach a window picture. Left out: a picture comes only with a thin tree.',
  full: 'The whole tree, not a diff against your last read.',
  'observe.element': "One element's full subtree with uncut values, such as a long document.",
  menus: 'Include the menu bar.',
  launch: 'Start this app in the background before listing.',
  open: 'Absolute paths, file or http(s) URLs to open in the launch app. Never programs.',
  'apps.confirm': "As computer_act's confirm: set when an item sends, uploads or shares the person's data.",
  'apps.confirm.kind': "As on computer_act's confirm.",
  actions: 'Ordered steps, each with action and its parameters.',
  action: 'Action name from the tool description.',
  element: 'The [index] from your latest read. key and hold_key: the element to focus first.',
  coordinate: "[x, y] in screenshot pixels from the window's top left. Prefer element when the tree has one.",
  start_element: 'Drag start: an [index] from your latest read.',
  start_coordinate: "Drag start: [x, y] in screenshot pixels.",
  text: 'type, paste, select_text: text. key, hold_key: key or combo (Return, super+c). Clicks, drag, scroll: modifiers (shift, ctrl, alt, super).',
  region: "zoom: [x0, y0, x1, y1] in the screenshot's pixels.",
  scroll_direction: 'up, down, left or right.',
  scroll_amount: 'Wheel clicks; five is about a page.',
  repeat: 'key: how many times to press it.',
  duration:
    'Seconds. wait: max time for the window to settle; ends sooner if settled. hold_key: key hold time. Clicks: button hold time.',
  value: 'set_value: the new value, which replaces the old.',
  name: 'perform: an action word the element lists after "actions:", or one its role does by default: expand, collapse, increment, decrement, raise (a window, from the Dock too).',
  range: 'select_text: [start, end] in UTF-16 units, instead of text.',
  prefix: 'select_text: the text right before the match, to pick one of several.',
  suffix: 'select_text: the text right after the match, to pick one of several.',
  place: 'select_text: select (the default), or before or after to put the caret there.',
  format: 'paste: text (the default), markdown or html.',
  named: 'An element by its name in the tree, for one this call opens or one you have not read. Instead of element or coordinate.',
  menu: 'A menu-bar item by its path, File > Save…; picks it with no menu open. left_click, or perform with name pick.',
  confirm: "Ask for the person's OK before this act. The app acts only on Allow. Leave out otherwise.",
  'batch.confirm':
    "Ask for the person's OK before this batch. One card covers it; it runs only on Allow.",
  'confirm.kind':
    "delete, send, pay, subscribe, account, access, install, captcha, security, medical: always. Other kinds: unless the person asked for the act.",
  'confirm.what': 'What happens and to whom, in one line: "Reply to Ana accepting Friday\'s lunch".',
  'result.id': 'The id the "Held" answer named, such as c4.',
  'result.cancel': 'Cancel the held call instead of waiting for it.'
}

const CUA_FIELDS: Record<FieldKey, string> = {
  ...ANTHROPIC_FIELDS,
  full: 'disableDiffing: full tree, without a diff.',
  element: 'The [index] from your latest read; left_click is click(index). key and hold_key: the element to focus first.',
  text: 'type (typeText), paste, select_text: text. key (pressKey), hold_key: keys. Clicks, drag, scroll: modifiers.',
  scroll_amount: 'Wheel clicks, five to a page.',
  value: 'set_value (setValue): replaces the value.',
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
  key: "Presses a key or combo in xdotool names: text (Return, Tab, Escape, super+c); repeat to press it again. element focuses it first. In the background it runs the app's menu item for the combo.",
  hold_key: 'Holds a key or combo (text) for duration seconds. element focuses it first.',
  wait: 'Waits up to duration seconds for the window to settle, and ends sooner when it does.',
  set_value: "Replaces an element's value: element and value. Faster than a click and typing. On a pop up it picks the item by name.",
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
