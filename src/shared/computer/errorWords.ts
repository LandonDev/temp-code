/**
 * What a model reads when the service refuses a step or a call
 * (docs/computer-protocol.md "The model's words"): one sentence per
 * `ComputerErrorKind`, worded by the host from the error's data and the
 * call's own words, each ending in the next move. The service's `message`
 * stays the fallback, where the data cannot tell the cause, and the trace's
 * text.
 */
import type { ComputerAction, ComputerError, ComputerErrorKind, ErrorReason } from './protocol'
import { noReadForTextLine } from './hostErrors'
import { openItemName } from './words'

/** What the model asked for: its `app` and `window` strings and the step that failed. */
export interface ErrorContext {
  app?: string
  window?: string
  action?: ComputerAction
  /** computer_apps: the items the call opens; one names itself in the line */
  open?: string[]
  /** the error is one step's, not the request's */
  step?: boolean
}

/** A line, or null for the service's own `message`. */
type Words = (e: ComputerError, ctx: ErrorContext) => string | null

export const ERROR_LINE_MAX = 200

/** A menu item's title path, `File › Close`, then `tail`: each title at most 40 characters, the line at most ERROR_LINE_MAX. */
const menuLine = (path: readonly string[], tail: string): string => {
  const whole = path.map((t) => (t.length > 40 ? `${t.slice(0, 39)}…` : t)).join(' › ')
  const room = ERROR_LINE_MAX - tail.length
  return `${whole.length > room ? `${whole.slice(0, Math.max(1, room - 1))}…` : whole}${tail}`
}

/** The app as a line names it, cut so a long name leaves the line room. */
const quoteApp = (app: string | undefined): string => (!app ? 'the app' : app.length > 40 ? `${app.slice(0, 39)}…` : app)

const index = (e: ComputerError, ctx: ErrorContext): string => {
  const i = e.element ?? ctx.action?.element
  return i === undefined ? 'that element' : `[${i}]`
}

const quote = (s: string, max = 40): string => JSON.stringify([...s].length > max ? [...s].slice(0, max).join('') + '…' : s)

/** As many of `items` as fit `room` characters, then `…` (counted) when some were left out. */
function fitList(items: string[], room: number): string {
  let out = ''
  for (const [i, item] of items.entries()) {
    const next = out ? `${out}, ${item}` : item
    const more = i < items.length - 1 ? ', …'.length : 0
    if (next.length + more > room) return out ? `${out}, …` : '…'
    out = next
  }
  return out
}

const SESSION_WHY: Partial<Record<ErrorReason, string>> = {
  locked: 'the screen is locked',
  'secure-input': 'secure input is on (a password field has the keyboard)',
  'activation-refused': 'the app would not come to the front',
  'in-use': 'another app holds it'
}

/** An element's line, cut to fit a sentence. */
const cutLine = (line: string): string => (line.length > 60 ? `${line.slice(0, 59)}…` : line)

/** The one item a refusal is about by name, when the call named one; else a plain noun. */
const oneItem = (ctx: ErrorContext): string | null => (ctx.open?.length === 1 ? openItemName(ctx.open[0]) : null)

const OPEN_REFUSED: Words = (e, ctx) => {
  const item = oneItem(ctx)
  switch (e.reason) {
    case 'scheme':
      return 'only http, https and file items open; give a web page, a file or a folder'
    case 'executable':
      return `${item ?? 'an item'} is a program; open only opens documents, folders and web pages`
    case 'missing':
      return `${item && ctx.open ? `no file at ${quote(ctx.open[0], 80)}` : 'an item is not'} on the Mac; check the path`
    case 'app':
      return "that app is one computer use may not touch; open the items in another app"
    default:
      return 'open refused an item; give documents, folders or web pages'
  }
}

const NOT_READY: Words = () => 'the computer service is not ready; try the call again'

export const COMPUTER_ERROR_WORDS: Readonly<Record<ComputerErrorKind, Words>> = {
  not_initialized: NOT_READY,
  protocol_mismatch: NOT_READY,
  unknown_session: NOT_READY,
  already_running: () => 'another computer service is still stopping; try the call again in a few seconds',
  permission_missing: (e) =>
    e.which === 'screenRecording'
      ? 'TempCode lacks the Screen Recording permission; the person turns it on under System Settings → Privacy & Security → Screen & System Audio Recording'
      : 'TempCode lacks the Accessibility permission; the person turns it on under System Settings → Privacy & Security → Accessibility',
  app_not_found: (e, ctx) => {
    const head = `no app matches ${ctx.app ? quote(ctx.app) : 'that name'}`
    if (!e.candidates?.length) return `${head}; computer_apps lists them all`
    const tail = ' (computer_apps lists them all)'
    const lead = `${head}; close names: `
    return `${lead}${fitList(e.candidates, ERROR_LINE_MAX - lead.length - tail.length)}${tail}`
  },
  window_not_found: (e, ctx) => {
    // the target closed or its app quit (§22.6): the service names which, "<App> has no window open." or "<App> quit."
    if (e.reason === 'gone') return null
    // a step's: blind keys or text in a window other than the one the thread last read (§27.6)
    if (ctx.step) return noReadForTextLine(quoteApp(ctx.app), ctx.window ?? e.candidates?.[0])
    const head = `no window of ${ctx.app ?? 'the app'} matches ${ctx.window ? quote(ctx.window) : 'that title'}`
    if (!e.candidates?.length) return `${head}; computer_apps lists its windows`
    const lead = `${head}; its windows: `
    return `${lead}${fitList(e.candidates.map((t) => quote(t, 30)), ERROR_LINE_MAX - lead.length)}`
  },
  window_minimized: () => "the window is minimized, so it can't be read or used; pick another window or ask the person to restore it",
  stale_element: (e, ctx) =>
    e.reason === 'service-restarted'
      ? 'the computer service restarted, so every index is stale; read the window again'
      : `${index(e, ctx)} is gone from the window; read it again and use the new index`,
  no_such_element: (e, ctx) => `${index(e, ctx)} was never in this window's tree; read it again`,
  action_unsupported: (e, ctx) => {
    // a shortcut whose menu item is disabled with the app in front (§24.2)
    if (e.menu?.length) return menuLine(e.menu, ' is disabled now; try another way')
    if (!e.available) return null
    const what = ctx.action?.action === 'perform' && ctx.action.name ? quote(ctx.action.name) : ctx.action?.action ?? 'that action'
    const lead = `${index(e, ctx)} can't do ${what}; `
    return e.available.length ? `${lead}it lists: ${fitList(e.available, ERROR_LINE_MAX - lead.length - 10)}` : `${lead}it lists no actions`
  },
  needs_tier: (e, ctx) =>
    e.menu?.length
      ? menuLine(e.menu, ` is disabled while ${quoteApp(ctx.app)} is in the background; it runs when the Mac is free`)
      : !e.needed || e.needed === 'session'
      ? "this needs the session tier (the real pointer and keyboard); see the step's tier line"
      : `this needs the ${e.needed} tier, which this step may not use now; see the step's tier line`,
  out_of_bounds: (e) => {
    const at = e.coordinate ? `${e.coordinate[0]},${e.coordinate[1]}` : 'that point'
    const space = e.space ? `the window's ${e.space.width}×${e.space.height} picture` : "the window's picture"
    return `${at} is outside ${space}; aim inside it or take a new screenshot`
  },
  invalid_key: (_e, ctx) =>
    `${ctx.action?.text ? `no key named ${quote(ctx.action.text)}` : 'no such key'}; use xdotool names such as Return, Tab, Escape, super+c`,
  interrupted: () => 'the person used the Mac, so this step stopped; carry on in the background or try later',
  app_busy: () => 'another thread is acting in this app; try again in a moment',
  cancelled: () => 'cancelled before it finished',
  clipboard_busy: () => 'the clipboard was busy; try again',
  capture_failed: () => 'the window could not be captured; read the tree instead, or try the screenshot again',
  timeout: (_e, ctx) => `${ctx.app ?? 'the app'} did not answer within 2 s and may be hung; try again, or work in another window`,
  text_not_found: (e, ctx) => {
    const a = ctx.action
    const i = e.element ?? a?.element
    const text = a?.text ? quote(a.text) : 'that text'
    const near = a?.prefix !== undefined || a?.suffix !== undefined ? ' with that prefix or suffix' : ''
    return `no ${text}${near} in ${index(e, ctx)}; read its text with computer_observe element ${i ?? '<index>'}`
  },
  key_window_unavailable: () => "the window isn't its app's key window, so keys and paste can't reach it; use set_value, or type with element",
  open_refused: OPEN_REFUSED,
  value_not_taken: (e, ctx) => {
    const reads = e.value === undefined ? 'did not take the value' : `still reads ${quote(e.value)}`
    return `${index(e, ctx)} ${reads}; nothing after it ran. On a pop up, click it and perform pick on the item; on a field, type with element`
  },
  focus_moved: (e) => {
    const i = e.focused?.index ?? e.element
    const at = e.focused ? `[${e.focused.index}] ${cutLine(e.focused.line)}` : i !== undefined ? `[${i}]` : 'another element'
    switch (e.reason) {
      case 'browser-field':
        return `the keys would go to ${at}, not the page; name the element they are for`
      case 'unplanned':
        return `${at} has the focus, which no step of this batch aimed at; name the element the text is for`
      case 'secure':
        return `${at} can only be typed into by its element, so the person can be asked; send the step again with ${i !== undefined ? `element ${i}` : 'its element'}`
      default:
        return `the focus moved to ${at} since your read; name the element the keys are for`
    }
  },
  named_target: (e, ctx) => {
    const path = ctx.action?.menu
    const what = quote(ctx.action?.named ?? path ?? '')
    if (e.reason !== 'several' || !e.elementCandidates?.length)
      return path
        ? `the menu bar has no item ${what}; read it with menus: true and use an element`
        : `nothing named ${ctx.action?.named ? what : 'that'} in the window or what this call opened; read the window and use an element`
    const lead = `several elements are named ${what}; use element: `
    return `${lead}${fitList(e.elementCandidates.map((c) => `[${c.index}] ${cutLine(c.line)}`), ERROR_LINE_MAX - lead.length)}`
  },
  tab_in_use: (_e, ctx) =>
    `the person has ${quoteApp(ctx.app)}'s window in front on another tab, so a read won't switch it; switch tabs with an act, which waits for the Mac to be free`,
  session_unavailable: (e) =>
    `the session tier can't run now${e.reason && SESSION_WHY[e.reason] ? `: ${SESSION_WHY[e.reason]}` : ''}; stay in the background tiers`
}

/** The line a model reads for a service error: the host's words, else the service's own message. */
export function errorLine(e: ComputerError, ctx: ErrorContext = {}): string {
  const words = (COMPUTER_ERROR_WORDS as Partial<Record<string, Words>>)[e.kind]
  return words?.(e, ctx) ?? e.message
}
