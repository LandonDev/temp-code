import { randomInt } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// The fake shares fixture text with the wire tests, but needs only Node to run.
const fixture = (path) => readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8')
const texts = Object.fromEntries(['full', 'diff', 'unchanged', 'thin'].map((kind) => [kind, fixture(`observations/${kind}.txt`).trimEnd()]))
const initial = JSON.parse(fixture('wire/initialize.response.json')).result
const streamJpeg = JSON.parse(fixture('wire/notify-capture-frame.json')).params.data
const startedAt = Date.now()
const epoch = 'e-' + Array.from({ length: 8 }, () => randomInt(36).toString(36)).join('')
const frame = { x: 100, y: 100, w: 800, h: 670 }
const space = { width: 1280, height: 1072, scale: 1.6 }
const waited = { waitedMs: 12, settled: true, busy: false, reason: 'quiet' }
const clicks = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']
// A complete one-pixel grayscale JPEG; shot metadata models the target window.
const jpeg = Buffer.from('/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAJgABAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwA//9k=', 'base64')
const windowInfo = (id, title = 'Untitled', minimized = false) => ({
  id, title, frame, main: !minimized, focused: !minimized, minimized, onScreen: !minimized, space: 'current'
})
const apps = [
  { name: 'TextEdit', pid: 16800, bundleId: 'com.apple.TextEdit', windows: [windowInfo(1581), windowInfo(1582, 'Notes.rtf', true)] },
  ...['Thin', 'KeyWin', 'Sessiony', 'Stubborn', 'Slow', 'Crashy', 'NoAX', 'NoShot', 'Touchy', 'Menuey', 'Hitty'].map((name, i) => ({
    name, pid: 16801 + i, bundleId: `dev.fake.${name.toLowerCase()}`, windows: [windowInfo((16801 + i) * 10)]
  })),
  // Closey: a click on button "close" closes the window it targets (§22.6)
  { name: 'Closey', pid: 16900, bundleId: 'dev.fake.closey', windows: [windowInfo(169000, 'Closey Doc'), windowInfo(169001, 'Closey Plain')] },
  { name: 'Preview', pid: 17000, bundleId: 'com.apple.Preview', windows: [windowInfo(170000, 'Preview')] },
  { name: 'Webby', pid: 17100, bundleId: 'dev.fake.webby', windows: [{ ...windowInfo(171000, 'Web front - Webby'), tabs: [{ title: 'Web front', selected: true }, { title: 'Web report', selected: false }] }] },
  // §26: Fronty's File › Save runs only in front, Committy's rename reaches the disk only when committed in front,
  // Panely saves through its panel, Menuy leaves a menu open
  ...['Fronty', 'Committy', 'Panely', 'Menuy'].map((name, i) => ({
    name, pid: 17200 + i, bundleId: `dev.fake.${name.toLowerCase()}`, windows: [windowInfo((17200 + i) * 10, `${name} Doc`)]
  })),
  { name: 'Finder', pid: 400, bundleId: 'com.apple.finder', windows: [] },
  // §27's scenarios: each reads its own small tree (FEWER below)
  ...['Menuful', 'Newdoc', 'Renamey', 'Blindy', 'Unplanned', 'Secret', 'Splitty'].map((name, i) => ({
    name, pid: 16820 + i, bundleId: `dev.fake.${name.toLowerCase()}`,
    windows: name === 'Renamey' ? [windowInfo(168220, 'Untitled'), windowInfo(168221, 'Other')] : [windowInfo((16820 + i) * 10, name)]
  }))
]
const brief = ({ pid, bundleId, name }) => ({ pid, bundleId, name })
// §27 (fewer calls). Each scenario app's tree as element lines, its focused element first; `named` resolves by these names.
//   Menuful: a click on [5] opens the Sort menu, whose block closes the read; "Team" names two buttons.
//   Newdoc: super+n opens a window with its text area [8] focused, and the call follows it; super+w closes it.
//   Renamey: the first type into "Untitled" autosaves it as "Draft.txt"; the old title still matches (§27.6).
//   Blindy: a click on [5] changes nothing, so the keys after it do not run (§27.8).
//   Unplanned: Tab walks onto the existing field [6]; text after it is refused (§27.7).
//   Secret: [12] is a password field the read never lists; by name or by focus it is refused secure (§27.7a).
//   Splitty: [5] changes nothing, Return focuses the rename field [8], "Search" is [7]; FAKE_FOCUS_DRIFT=1 moves the
//   focus to [9] before every request that carries a prior. In front only (§26): super+s saves nothing (effect none),
//   super+o opens a window with [8] focused.
const FEWER = {
  Menuful: { focused: 3, lines: { 3: 'text area = ""', 5: 'menu button "Sort"', 6: 'button "Team"', 7: 'button "Team"' } },
  Newdoc: { focused: 3, lines: { 3: 'text area = ""', 4: 'button "New"', 8: 'text area "Body" = ""' } },
  Renamey: { focused: 3, lines: { 3: 'text area = ""' } },
  Blindy: { focused: 3, lines: { 3: 'text area = ""', 5: 'button "Refresh"' } },
  Unplanned: { focused: 3, lines: { 3: 'list "Items"', 6: 'text field "Name"' } },
  Secret: { focused: 11, lines: { 11: 'text field "User"', 13: 'button "Sign In"' }, hidden: { 12: 'password "Password"' } },
  Splitty: { focused: 3, lines: { 3: 'list "Files"', 5: 'button "Refresh"', 7: 'text field "Search"', 8: 'text field "Rename"', 9: 'text field "Other"' } }
}
const MENU = { 50: 'menu "Sort"', 51: 'menu item "Name"', 52: 'menu item "Date"', 53: 'menu item "Team"' }
const NAV_KEY = /^(shift\+)?(Tab|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|Prior|Next)$/i
const KEY_TEXT = ['type', 'paste', 'key', 'hold_key']
const NO_INPUT = ['screenshot', 'zoom', 'cursor_position', 'wait']
const isPassword = (line) => line?.startsWith('password')
const fewerLine = (ctx, i) => (ctx.state.menu ? MENU[i] : undefined) ?? FEWER[ctx.app.name].lines[i] ?? FEWER[ctx.app.name].hidden?.[i]
function fewerText(ctx) {
  const app = FEWER[ctx.app.name]
  const focused = ctx.state.focused ?? app.focused
  const body = Object.entries(app.lines).map(([i, line]) => `  [${i}] ${line}${Number(i) === focused ? ' focused' : ''}`)
  const block = ctx.state.menu ? [`+ menu opened by step ${ctx.state.menu.by}: [50] menu "Sort"`, ...[51, 52, 53].map((i) => `  [${i}] ${MENU[i]}`)] : []
  return [`app ${JSON.stringify(ctx.app.name)} · window ${JSON.stringify(ctx.window.title)} · 1280×1072 · focused [${focused}]`, `[1] window ${JSON.stringify(ctx.window.title)}`, ...body, ...block].join('\n')
}
// the titles each session's calls have answered for a window, by window id (§27.6)
const keptTitles = new Map()
const sessions = new Set()
const states = new Map()
const shots = new Map()
const pending = new Map()
// replies held for the closing wait: a cancel answers them at once with what ran
const delayed = new Map()
const permissions = { accessibility: true, screenRecording: process.env.FAKE_SCREEN_RECORDING !== '0' }
const streams = new Map()
const lastClicks = new Map()
let escapeUntil = 0
let escapeTimer
function stopStream(id) {
  const stream = streams.get(id)
  if (stream) { clearInterval(stream.timer); clearTimeout(stream.endTimer) }
  streams.delete(id)
}
function clickNote(stream, at) {
  notify('capture/click', { stream: stream.id, at: at.map((v, i) => Math.round(v * (i ? stream.height / space.height : stream.width / space.width))), width: stream.width, height: stream.height })
}
function recordClick(ctx, action) {
  const at = action.coordinate ?? [640, 536]
  const key = `${ctx.session}:${ctx.window.id}`
  lastClicks.set(key, { at, answeredAt: Date.now() })
  for (const stream of streams.values()) if (stream.key === key) clickNote(stream, at)
}
// The pasteboard as clipboard.state reports it: the watch began a minute before the fake (so only a copy
// counts), FAKE_CLIPBOARD_COPY_AT_MS puts one foreign copy that many ms after the fake started, and
// FAKE_CLIPBOARD_COPY_EVERY_MS keeps making one at that period from the start.
const watchingSince = startedAt - 60_000
const copyAt = process.env.FAKE_CLIPBOARD_COPY_AT_MS === undefined ? null : startedAt + Number(process.env.FAKE_CLIPBOARD_COPY_AT_MS)
const copyEvery = Number(process.env.FAKE_CLIPBOARD_COPY_EVERY_MS ?? 0)
function foreignChangeAt() {
  const now = Date.now()
  const every = copyEvery > 0 ? startedAt + Math.floor((now - startedAt) / copyEvery) * copyEvery : null
  const at = [copyAt, every].filter((t) => t !== null && t <= now)
  return at.length ? Math.max(...at) : null
}
const recentCopy = (quietMs) => quietMs !== undefined && Date.now() - Math.max(foreignChangeAt() ?? 0, watchingSince) < quietMs
// What a session step left in front, which input.restoreSession puts back.
let restorable = null
let initialized = false
let dataDir
let previewRunning = false
let answered = 0
let exiting = false

process.stderr.write('fake tc-computer up\n')
const out = (value, done) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n', done)
function reply(id, value, error = false, exitCode) {
  if (exiting) return
  answered++
  const code = Number(process.env.FAKE_EXIT_75_AFTER) === answered ? 75 : exitCode
  if (code !== undefined) exiting = true
  out({ id, [error ? 'error' : 'result']: value }, code === undefined ? undefined : () => process.exit(code))
}
const notify = (method, params) => out({ method, params })
const failure = (kind, message, fields = {}) => ({ kind, message, ...fields })
const refuse = (id, data) => reply(id, { code: -32000, message: data.message, data }, true)
const missingApp = () => failure('app_not_found', 'Choose a known app.', { candidates: apps.slice(0, 5).map((app) => app.name) })
const shotFailure = () => failure('permission_missing', 'Allow screen recording to take a screenshot.', { which: 'screenRecording' })
const cancelled = () => failure('cancelled', 'The request was cancelled.')
const elements = (action) => [action.element, action.start_element].filter((i) => i !== undefined)
function resolveApp(ref) {
  return apps.find((app) => ref.pid !== undefined ? app.pid === ref.pid :
    [app.name, app.bundleId].some((name) => name.toLowerCase() === ref.app?.toLowerCase()))
}
function target(params) {
  if (!sessions.has(params.session)) throw failure('unknown_session', 'Open the session before using it.')
  const app = resolveApp(params.app)
  if (!app || app.name === 'Finder' || (app.name === 'Preview' && !previewRunning && !params.launch)) throw missingApp()
  if (app.name === 'Preview') previewRunning = true
  if (app.name === 'NoAX') throw failure('permission_missing', 'Allow accessibility to read this app.', { which: 'accessibility' })
  const ref = params.window ?? {}
  let selectedTab
  let matchedTab
  const tabWindow = (exact) => app.windows.find((w) => {
    const tab = w.tabs?.find((t) => exact ? t.title === ref.title : t.title.includes(ref.title))
    if (tab) matchedTab = tab
    return !!tab
  })
  let kept = keptTitles.get(params.session)
  if (!kept) keptTitles.set(params.session, kept = new Map())
  // a title a live window once answered to, when no live title or tab matched and no other live window shared it
  const keptWindow = () => {
    const once = app.windows.filter((w) => kept.get(w.id)?.has(ref.title))
    return once.length === 1 ? once[0] : undefined
  }
  const window = ref.id !== undefined ? app.windows.find((w) => w.id === ref.id) : ref.title !== undefined ?
    app.windows.find((w) => w.title === ref.title) ?? tabWindow(true) ?? app.windows.find((w) => w.title.includes(ref.title)) ?? tabWindow(false) ?? keptWindow() : app.windows[0]
  if (!window) throw failure('window_not_found', 'Choose a window from this app.', { candidates: app.windows.map((w) => w.title) })
  if (!kept.has(window.id)) kept.set(window.id, new Set())
  kept.get(window.id).add(window.title)
  const named = params.element !== undefined ? [params.element] : params.action ? elements(params.action) : (params.actions ?? []).flatMap(elements)
  if (params.expectFocus !== undefined) named.push(params.expectFocus)
  if (named.length && params.epoch !== epoch) throw failure('stale_element', 'Read the app again after the service restart.', { element: named[0], reason: 'service-restarted' })
  if (matchedTab && !matchedTab.selected) {
    if (process.env.FAKE_WEB_ACTIVE === '1' && params.tabs !== 'any') throw failure('tab_in_use', 'The person is on another tab.')
    for (const tab of window.tabs) tab.selected = tab === matchedTab
    selectedTab = matchedTab.title
    window.title = selectedTab + ' - Webby'
    window.pageReads = 0
  }
  let perApp = states.get(params.session)
  if (!perApp) states.set(params.session, perApp = new Map())
  let state = perApp.get(app.pid)
  if (!state) perApp.set(app.pid, state = { seq: 0, dirty: false, maxIndex: 0, gotFirst: false })
  return { app, window, state, selectedTab, session: params.session }
}
function shot(ctx, action) {
  if (ctx.app.name === 'NoShot' || !permissions.screenRecording) throw shotFailure()
  const dir = join(dataDir, 'shots', ctx.session)
  mkdirSync(dir, { recursive: true })
  if (!shots.has(ctx.session)) {
    const highest = readdirSync(dir).reduce((max, name) => Math.max(max, Number(/^(\d+)-.*\.jpg$/.exec(name)?.[1] ?? 0)), 0)
    shots.set(ctx.session, highest)
  }
  const count = shots.get(ctx.session) + 1
  shots.set(ctx.session, count)
  const path = join(dir, `${String(count).padStart(4, '0')}-${action}.jpg`)
  const files = process.env.FAKE_SHOT_FILES?.split(',').filter(Boolean)
  const source = files?.length ? files[Math.min(count - 1, files.length - 1)] : process.env.FAKE_SHOT_FILE
  const bytes = source ? readFileSync(source) : jpeg
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  writeFileSync(path, bytes)
  return { path, format: png ? 'png' : 'jpeg', ...space, ...(png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}), bytes: bytes.length, window: { id: ctx.window.id, frame }, blank: false, capturedAt: Date.now() }
}
function rewrite(text, ctx) {
  return text.replace(/^app "[^"]*" · window "[^"]*"/, `app ${JSON.stringify(ctx.app.name)} · window ${JSON.stringify(ctx.window.title)}`)
    .replace(/^(\[1\] window )"[^"]*"/m, (_, prefix) => prefix + JSON.stringify(ctx.window.title))
}
function observation(ctx, options = {}, action = 'observe') {
  const { state } = ctx
  const base = state.seq
  let kind = options.element !== undefined ? 'subtree' : options.mode === 'full' || !state.gotFirst ? 'full' : state.dirty ? 'diff' : 'unchanged'
  let text
  if (kind === 'subtree') {
    const line = options.element === 3 ? texts.full.split('\n').find((line) => line.trimStart().startsWith('[3] ')).trim() : `[${options.element}] group "Part"`
    text = texts.full.split('\n')[0] + '\n' + line
  } else {
    state.seq++
    state.gotFirst = true
    state.dirty = false
    if (kind === 'full') state.maxIndex = 40
    if (kind === 'diff') state.maxIndex = 47
    text = texts[ctx.app.name === 'Thin' ? 'thin' : kind]
  }
  text = rewrite(text, ctx)
  // FAKE_PASSWORD=1: the focused text area is a password field
  if (process.env.FAKE_PASSWORD === '1') text = text.replace('[3] text area', '[3] password "Password"')
  let page
  if (ctx.app.name === 'Webby') {
    const tab = ctx.window.tabs.find((t) => t.selected).title
    const pageState = process.env.FAKE_WEB_NOT_DRAWN === '1' ? 'not-drawn' : tab === 'Web report' && !ctx.window.pageReads ? 'loading' : 'loaded'
    ctx.window.pageReads = (ctx.window.pageReads ?? 0) + 1
    page = { tab, state: pageState }
    kind = 'full'
    state.maxIndex = 40
    state.focused ??= 3
    text = `app "Webby" · window ${JSON.stringify(ctx.window.title)} · 1280×1072 · focused [${state.focused}]` +
      (pageState === 'loading' ? ' · still loading' : pageState === 'not-drawn' ? ' · page not drawn' : '') +
      `\n[1] window ${JSON.stringify(ctx.window.title)}\n  [3] input "Name" = ""\n  [4] input "Blocked value" = "Original"\n  [9] input "Address and search bar"\n  [19] pop up "Plan" = ${JSON.stringify(state.plan ?? 'Choose a plan')}\n  [20] table "Report"`
  }
  if (FEWER[ctx.app.name]) {
    kind = 'full'
    state.maxIndex = 60
    text = fewerText(ctx)
  }
  const lines = text.split('\n')
  const result = {
    epoch, session: ctx.session, app: brief(ctx.app), window: { id: ctx.window.id, title: ctx.window.title, frame },
    kind, seq: state.seq, ...(kind === 'diff' ? { base } : {}), text, space,
    stats: { elements: lines.filter((line) => line.includes('[')).length, lines: lines.length - 1, bytes: Buffer.byteLength(text), omitted: 0, thin: ctx.app.name === 'Thin', partial: false, readMs: 5 },
    waited,
    ...(page ? { page } : {}),
    ...(ctx.selectedTab !== undefined ? { selectedTab: ctx.selectedTab } : {})
  }
  if (options.screenshot === 'always' || (options.screenshot !== 'never' && result.stats.thin)) {
    try { result.shot = shot(ctx, action) } catch (error) { result.shotError = error }
  }
  return result
}
function sessionChange(app) {
  restorable = app
  const now = Date.now()
  return {
    frontmost: { before: brief(apps[0]), after: brief(app) }, pointer: { before: [10, 10], after: [20, 20] }, restorable: true,
    armedAt: now - 5, idleAtArmMs: 130_000, lastInputAt: now
  }
}
function elementLine(index, ctx) {
  if (FEWER[ctx.app.name]) return fewerLine(ctx, index) ?? 'group "Part"'
  if (ctx.app.name === 'Webby') return ({ 1: `window ${JSON.stringify(ctx.window.title)}`, 3: 'input "Name"', 4: 'input "Blocked value"', 9: 'input "Address and search bar"', 19: 'pop up "Plan"', 20: 'table "Report"' })[index] ?? 'group "Part"'
  // Changed and new lines in the diff take precedence after a diff was returned.
  const sources = ctx.state.maxIndex === 47 ? [texts.diff, texts.full] : [texts.full]
  for (const source of sources) {
    const match = rewrite(source, ctx).split('\n').map((line) => /^(?:~ )?\s*\[(\d+)\] (.+)$/.exec(line)).find((match) => Number(match?.[1]) === index)
    if (match) return match[2]
  }
  return 'group "Part"'
}
// Hitty's coordinate clicks pressed through the hit route: the first two change nothing (§24.3)
let hits = 0
// what the host said it speaks at initialize (§26, decision 14); FAKE_NO_FEATURES=1 plays an older service
let hostFeatures = new Set()
const speaks = (feature) => process.env.FAKE_NO_FEATURES !== '1' && hostFeatures.has(feature)
// a front hold, shared by a batch's run of front steps until 2,000 ms (§26.2)
const FRONT_STEP_MS = 700
let hold = null
function frontHold() {
  const now = Date.now()
  if (!hold || hold.heldMs + FRONT_STEP_MS > 2_000) hold = { heldMs: 0, armedAt: now }
  hold.heldMs += FRONT_STEP_MS
  return { heldMs: hold.heldMs, activateMs: 80, restoreMs: 40, restored: 'restored', person: brief(apps[0]), armedAt: hold.armedAt, idleAtArmMs: 2_000, lastInputAt: now }
}
/** The four §26 apps; null when the step is not theirs. */
function activeStep(ctx, action, tiers, result, fail) {
  const verb = action.action
  const front = tiers.includes('front') && speaks('front')
  const combo = (action.text ?? '').toLowerCase()
  if (ctx.app.name === 'Fronty' && verb === 'key' && combo === 'super+s') {
    if (!front) return fail(failure('needs_tier', 'File › Save is disabled while Fronty is in the background.', { needed: speaks('front') ? 'front' : 'session', menu: ['File', 'Save'] }))
    ctx.state.dirty = true
    return { ...result, tier: 'front', effect: 'changed', input: { via: 'menu', on: 'File › Save' }, front: frontHold(), ...(speaks('commit') ? { disk: { saved: '~/run/Total.txt', edited: { before: true, after: false } } } : {}) }
  }
  if (ctx.app.name === 'Committy' && (verb === 'set_value' || (verb === 'key' && combo === 'return'))) {
    ctx.state.dirty = true
    // a commit step in a background app skips process and runs once in front (§26, decision 12)
    if (verb === 'key' && front) return { ...result, tier: 'front', effect: 'changed', front: frontHold(), disk: { renamed: [{ from: '~/run/a.txt', to: '~/run/b.txt' }] } }
    const tier = verb === 'set_value' ? 'ax' : 'process'
    if (!tiers.includes(tier)) return fail(failure('needs_tier', 'Allow the tier this action needs.', { needed: tier }))
    if (!speaks('commit')) return { ...result, tier, effect: 'changed' }
    return { ...result, tier, effect: 'uncommitted', disk: { edited: { before: false, after: false }, hint: 'commit it with key Return in the field' } }
  }
  if (ctx.app.name === 'Committy' && verb === 'type') {
    ctx.state.dirty = true
    // TextEdit's autosave: the app wrote the file by itself during the step
    return { ...result, tier: 'ax', effect: 'changed', input: { via: 'ax-insert' }, ...(speaks('commit') ? { disk: { saved: '~/Library/Autosave/Committy Doc.txt', unexpected: true } } : {}) }
  }
  if (verb === 'save_as') {
    if (!speaks('save_as')) return fail(failure('action_unsupported', 'This service has no save_as.'))
    const path = action.path ?? ''
    if (path.endsWith('/exists.txt') && !action.replace) return fail(failure('file_exists', `${path} exists; pass replace to overwrite it.`))
    if (path.endsWith('/nothing.txt')) return fail(failure('not_committed', `${ctx.app.name} closed the save panel and no file appeared.`))
    // the folder's Go to Folder confirms only in front (§26.7, E4')
    if (!front) return fail(failure('needs_tier', 'The save panel changes folders only with the app in front.', { needed: 'front' }))
    ctx.state.dirty = true
    return { ...result, tier: 'front', effect: 'changed', input: { via: 'panel', on: path }, front: frontHold(), disk: { saved: path } }
  }
  if (ctx.app.name === 'Menuy' && verb === 'perform' && action.name === 'show menu') {
    ctx.state.dirty = true
    if (action.element === 4) ctx.menusLeftOpen = ['Action']
    return { ...result, tier: 'ax', effect: 'changed' }
  }
  return null
}
function step(ctx, action, tiers, index, pasteQuietMs, ignored) {
  const fail = (error) => ({ index, action: action.action, status: 'failed', error })
  for (const element of elements(action)) {
    if (element > ctx.state.maxIndex) return fail(failure('no_such_element', 'Read the app before using this element.', { element }))
  }
  const verb = action.action
  // only the scenario apps resolve a name (§27.9)
  if (action.named !== undefined && !FEWER[ctx.app.name]) return fail(failure('named_target', 'Nothing has that name.', { reason: 'no-match' }))
  // keys or text with no target in a window other than the one the host last read (§27.6), unless the call opened it
  if (['type', 'paste', 'key', 'hold_key'].includes(verb) && action.element === undefined && action.named === undefined && ctx.params?.textWindowId !== undefined &&
    ctx.window.id !== ctx.params.textWindowId && !ctx.opened?.has(ctx.window.id) && !(ctx.params.prior?.windows ?? []).includes(ctx.window.id))
    return fail(failure('window_not_found', `Read the window "${ctx.window.title}" before typing into it.`, { candidates: [ctx.window.title] }))
  const result = { index, action: verb, status: 'ok', tier: null, effect: 'none' }
  const element = action.element ?? action.start_element
  if (element !== undefined) result.element = { index: element, line: elementLine(element, ctx) }
  if (['screenshot', 'zoom', 'cursor_position', 'wait'].includes(verb)) {
    if (verb === 'screenshot' || verb === 'zoom') {
      try { result.shot = shot(ctx, verb) } catch (error) { return fail(error) }
    }
    if (verb === 'cursor_position') result.text = 'X=0, Y=0'
    if (verb === 'wait') result.waited = waited
    return result
  }
  const active = activeStep(ctx, action, tiers, result, fail)
  if (active) return active
  // Webby (§25): a native pick, read-back failure, page scroll, and focus leaving the page.
  if (ctx.app.name === 'Webby') {
    if (['key', 'hold_key', 'type', 'paste'].includes(verb)) {
      const focused = process.env.FAKE_WEB_FOCUS_MOVED === '1' ? 9 : ctx.state.focused ?? 3
      if (action.element === undefined && focused === 9 && !(verb === 'key' && action.text === 'super+l'))
        return fail(failure('focus_moved', 'Focus left the page.', { element: 9, focused: { index: 9, line: 'input "Address and search bar"' }, reason: 'browser-field' }))
      if (action.element !== undefined) ctx.state.focused = action.element
      if (action.text === 'super+l') ctx.state.focused = 9
    }
    if (verb === 'set_value' && element === 4)
      return fail(failure('value_not_taken', 'AXValue did not take.', { element: 4, value: 'Original' }))
    if (verb === 'set_value' && element === 19) {
      ctx.state.plan = action.value
      ctx.state.dirty = true
      return { ...result, element: { index: 19, line: 'pop up "Plan"' }, tier: 'ax', effect: 'changed', input: { via: 'pick', on: action.value } }
    }
    if (verb === 'scroll') return { ...result, tier: 'ax', effect: 'changed', input: { via: 'scroll-into-view' } }
  }
  // Menuey (§24.2): ⌘⇧P runs its menu item at ax; ⌘W's item is disabled while the app is in the background
  if (ctx.app.name === 'Menuey' && verb === 'key') {
    const combo = (action.text ?? '').toLowerCase()
    if (combo === 'super+shift+p' && tiers.includes('ax')) {
      ctx.state.dirty = true
      return { ...result, tier: 'ax', effect: 'changed', input: { via: 'menu', on: 'Probe › Ping App' } }
    }
    if (combo === 'super+w' && !tiers.includes('session')) {
      return fail(failure('needs_tier', 'File › Close is disabled while Menuey is in the background.', { needed: 'session', menu: ['File', 'Close'] }))
    }
  }
  // Hitty (§24.1, §24.3, §24.5): a plain coordinate click presses the button under it, a scroll moves the bar;
  // a route the call names as ignored runs after the event tiers, or not at all with skip
  if (ctx.app.name === 'Hitty' && verb === 'left_click' && action.element === undefined && !action.text) {
    const named = (ignored?.via ?? []).includes('hit')
    const events = tiers.filter((t) => t === 'process' || t === 'session')
    if (tiers.includes('ax') && !(named && (ignored?.skip || events.length))) {
      hits++
      ctx.state.dirty = true
      recordClick(ctx, action)
      return { ...result, tier: 'ax', effect: hits <= 2 ? 'none' : 'changed', input: { via: 'hit', on: 'button "Save"' } }
    }
    if (!events.length) return fail(failure('needs_tier', 'Allow the tier this action needs.', { needed: 'process' }))
  }
  if (ctx.app.name === 'Hitty' && verb === 'scroll' && tiers.includes('ax')) {
    ctx.state.dirty = true
    return { ...result, tier: 'ax', effect: 'changed', input: { via: 'scroll-bar' } }
  }
  let supported = ['process', 'session']
  if (['set_value', 'perform', 'select_text'].includes(verb)) supported = ['ax']
  if (verb === 'type' || (['left_click', 'right_click', 'double_click'].includes(verb) && action.element !== undefined)) supported = ['ax', 'process', 'session']
  if (ctx.app.name === 'Sessiony' && (['hold_key', 'left_mouse_down', 'left_mouse_up'].includes(verb) || (verb === 'perform' && action.name === 'raise'))) supported = ['session']
  if (ctx.app.name === 'Touchy') supported = ['session']
  if (ctx.app.name === 'Stubborn' && clicks.includes(verb)) supported = ['process', 'session']
  if (ctx.app.name === 'KeyWin' && ['key', 'hold_key', 'paste'].includes(verb) && !tiers.includes('process')) supported = ['session']
  // KeyWin's text takes no AX insert while keys may go: its type goes by keys, and fails the key window check
  if (ctx.app.name === 'KeyWin' && verb === 'type' && tiers.includes('process')) supported = ['process', 'session']
  const tier = tiers.find((tier) => supported.includes(tier))
  if (!tier) return fail(failure('needs_tier', 'Allow the tier this action needs.', { needed: supported[0] }))
  if (ctx.app.name === 'KeyWin' && tier === 'process' && ['type', 'key', 'paste'].includes(verb)) {
    return fail(failure('key_window_unavailable', 'Choose the target key window before sending input.', { keyWindow: { id: 99, title: 'Other' } }))
  }
  // the person touches the Mac during every session step of Touchy: the step stops, the change says what it did
  if (ctx.app.name === 'Touchy' && tier === 'session') {
    ctx.touched = true
    return fail(failure('interrupted', 'The person took over the Mac during this step.', { by: 'person', session: sessionChange(ctx.app) }))
  }
  if (recentCopy(pasteQuietMs) && (verb === 'paste' || (verb === 'type' && (action.text ?? '').length >= 2000))) {
    return fail(failure('clipboard_busy', 'The person copied something just now.', { reason: 'recent-copy' }))
  }
  result.tier = tier
  result.effect = ctx.app.name === 'Thin' ? 'unknown' : ctx.app.name === 'Stubborn' && clicks.includes(verb) && tier === 'process' ? 'none' : 'changed'
  if (verb === 'type') result.input = { via: tier === 'ax' ? 'ax-insert' : 'keys' }
  if (verb === 'paste') result.input = { via: 'paste', clipboard: 'restored' }
  if (tier === 'session') result.session = sessionChange(ctx.app)
  if (clicks.includes(verb) || ['left_mouse_down', 'perform'].includes(verb)) recordClick(ctx, action)
  ctx.state.dirty = true
  return result
}
/**
 * One step of a scenario app (§27): the stop rule, `named`, the live focus and the password field, then the step as
 * any app runs it, then what it did to the focus, the menu and the windows. `call` is what the request's earlier steps
 * (and its prior) did.
 */
function fewerStep(ctx, action, params, index, call) {
  const verb = action.action
  const fail = (error) => ({ index, action: verb, status: 'failed', error })
  const blind = KEY_TEXT.includes(verb) && action.element === undefined && action.named === undefined
  if (blind && call.lastEffect === 'none') return { index, action: verb, status: 'not-run', stopped: { afterStep: Math.max(call.lastInput, 0), reason: 'no-change' } }
  let resolved
  if (action.named !== undefined) {
    const lines = { ...(ctx.state.menu ? MENU : {}), ...FEWER[ctx.app.name].lines, ...FEWER[ctx.app.name].hidden }
    // a line's quoted name, exact before case-blind
    const nameOf = (line) => { const m = /"((?:[^"\\]|\\.)*)"/.exec(line); return m ? JSON.parse(`"${m[1]}"`) : null }
    const entries = Object.entries(lines)
    const exact = entries.filter(([, line]) => nameOf(line) === action.named)
    const matches = exact.length ? exact : entries.filter(([, line]) => nameOf(line)?.toLowerCase() === action.named.toLowerCase())
    // what this call made appear first: an open menu's items
    const menuFirst = ctx.state.menu ? matches.filter(([i]) => MENU[i]) : []
    const pool = menuFirst.length ? menuFirst : matches
    if (!pool.length) return fail(failure('named_target', 'Nothing has that name.', { reason: 'no-match' }))
    if (pool.length > 1) return fail(failure('named_target', 'Several elements have that name.', { reason: 'several', elementCandidates: pool.map(([i, line]) => ({ index: Number(i), line })) }))
    resolved = Number(pool[0][0])
  }
  const focused = ctx.state.focused ?? FEWER[ctx.app.name].focused
  const secure = (i) => failure('focus_moved', 'A password field takes text by its element alone.', { element: i, focused: { index: i, line: fewerLine(ctx, i) }, reason: 'secure' })
  if (resolved !== undefined && ['type', 'paste', 'set_value'].includes(verb) && isPassword(fewerLine(ctx, resolved))) return fail(secure(resolved))
  if (blind && call.sentInput) {
    if (['type', 'paste'].includes(verb) && isPassword(fewerLine(ctx, focused))) return fail(secure(focused))
    if (!call.targeted.has(focused) && call.focusTo !== focused)
      return fail(failure('focus_moved', 'No step of this call aimed at the focused element.', { element: focused, focused: { index: focused, line: fewerLine(ctx, focused) }, reason: 'unplanned' }))
  }
  const run = resolved !== undefined ? { ...action, named: undefined, element: resolved } : action
  const combo = verb === 'key' ? (action.text ?? '').toLowerCase() : ''
  if (ctx.app.name === 'Splitty' && (combo === 'super+s' || combo === 'super+o')) {
    const item = combo === 'super+s' ? 'Save' : 'Open…'
    if (!(params.tiers.includes('front') && speaks('front')))
      return fail(failure('needs_tier', `File › ${item} is disabled while Splitty is in the background.`, { needed: 'front', menu: ['File', item] }))
    const result = { index, action: verb, status: 'ok', tier: 'front', effect: combo === 'super+s' ? 'none' : 'changed', input: { via: 'menu', on: `File › ${item}` }, front: frontHold() }
    if (combo === 'super+o') {
      const id = ctx.app.windows.at(-1).id + 1
      const opened = windowInfo(id, 'Opened')
      ctx.app.windows.push(opened)
      ctx.window = opened
      ctx.opened.add(id)
      result.opened = { id, title: opened.title }
      ctx.state.focused = 8
      if (focused !== 8) result.focusTo = 8
    }
    return result
  }
  const result = step(ctx, run, params.tiers, index, params.pasteQuietMs, params.ignored)
  if (result.status !== 'ok') return result
  if (resolved !== undefined) result.resolved = resolved
  const app = ctx.app.name
  const target = run.element
  if (['Blindy', 'Splitty'].includes(app) && verb === 'left_click' && target === 5) result.effect = 'none'
  if (app === 'Menuful' && verb === 'left_click' && target === 5) ctx.state.menu = { by: index + 1 }
  else if (app === 'Menuful' && MENU[target]) ctx.state.menu = undefined
  if (app === 'Newdoc' && verb === 'key' && action.text === 'super+n') {
    const id = ctx.app.windows.at(-1).id + 1
    const opened = windowInfo(id, `Untitled ${ctx.app.windows.length + 1}`)
    for (const w of ctx.app.windows) w.focused = false
    ctx.app.windows.push(opened)
    ctx.window = opened
    ctx.opened.add(id)
    result.opened = { id, title: opened.title }
    ctx.state.focused = 8
  }
  // super+w closes a window the app opened; the focus goes back to the first window's text area
  if (app === 'Newdoc' && verb === 'key' && action.text === 'super+w' && ctx.window.id !== ctx.app.windows[0].id) {
    ctx.app.windows = ctx.app.windows.filter((w) => w.id !== ctx.window.id)
    ctx.window = ctx.app.windows[0]
    ctx.state.focused = 3
  }
  if (app === 'Renamey' && verb === 'type' && ctx.window.title === 'Untitled') ctx.window.title = 'Draft.txt'
  if (verb === 'left_click' && /^(text field|password)/.test(fewerLine(ctx, target) ?? '')) ctx.state.focused = target
  if (app === 'Unplanned' && verb === 'key' && action.text === 'Tab') ctx.state.focused = 6
  if (app === 'Splitty' && verb === 'key' && action.text === 'Return') ctx.state.focused = 8
  const now = ctx.state.focused ?? FEWER[app].focused
  if (now !== focused && !(verb === 'key' && NAV_KEY.test(action.text ?? ''))) result.focusTo = now
  return result
}
function actionResult(ctx, params, method, wasCancelled = false) {
  const actions = method === 'action.run' ? [params.action] : params.actions
  ctx.params = params
  ctx.opened = new Set()
  const fewer = FEWER[ctx.app.name]
  if (fewer && process.env.FAKE_FOCUS_DRIFT === '1' && ctx.app.name === 'Splitty' && params.prior) ctx.state.focused = 9
  const call = { lastEffect: params.prior?.effect, lastInput: -1, sentInput: params.prior !== undefined, targeted: new Set(params.prior?.targeted ?? []), focusTo: params.prior?.focusTo }
  let stopped = false
  let halted
  hold = null
  ctx.menusLeftOpen = undefined
  const steps = actions.map((action, index) => {
    if (halted) return { index, action: action.action, status: 'not-run', stopped: halted }
    if (stopped) return { index, action: action.action, status: 'not-run' }
    const result = wasCancelled ? { index, action: action.action, status: 'failed', error: cancelled() } :
      fewer ? fewerStep(ctx, action, params, index, call) : step(ctx, action, params.tiers, index, params.pasteQuietMs, params.ignored)
    stopped = result.status === 'failed'
    if (result.status === 'not-run') halted = result.stopped
    if (result.status === 'ok' && !NO_INPUT.includes(action.action)) {
      call.lastEffect = result.effect
      call.lastInput = index
      call.sentInput = true
      call.focusTo = result.focusTo
      for (const i of [action.element, action.start_element, result.resolved]) if (i !== undefined) call.targeted.add(i)
    }
    return result
  })
  const result = method === 'action.run' ? { step: steps[0] } : { steps, waited: wasCancelled ? { waitedMs: 0, settled: false, busy: false, reason: 'cancelled' } : waited }
  // Closey's close button closes the target: the observation reads the next window whole, or says none is left
  const closed = ctx.app.name === 'Closey' && steps.some((s, i) => s.status === 'ok' && actions[i].action === 'left_click' && s.element?.line === 'button "close"')
  if (closed) ctx.app.windows = ctx.app.windows.filter((w) => w.id !== ctx.window.id)
  if (ctx.menusLeftOpen) result.menusLeftOpen = ctx.menusLeftOpen
  if (wasCancelled) result.observationError = cancelled()
  else if (closed && !ctx.app.windows.length) result.observationError = failure('window_not_found', 'Closey has no window open.', { reason: 'gone' })
  else if (closed) result.observation = observation({ ...ctx, window: ctx.app.windows[0] }, { ...params.observe, mode: 'full' }, 'action')
  else if (params.observe?.mode !== 'none' && ctx.app.name === 'Secret' && process.env.FAKE_SECRET_NO_OBS === '1') result.observationError = failure('timeout', 'Secret did not answer.')
  // a window the call opened is read whole (§27.5)
  else if (params.observe?.mode !== 'none') result.observation = observation(ctx, ctx.opened.size ? { ...params.observe, mode: 'full' } : params.observe, 'action')
  return result
}
function handle({ id, method, params = {} }) {
  if (method === '$/cancel' && id === undefined) {
    const held = delayed.get(params.id)
    if (held) {
      delayed.delete(params.id)
      clearTimeout(held.timer)
      reply(params.id, held.result)
      return
    }
    const request = pending.get(params.id)
    if (request) {
      pending.delete(params.id)
      if (request.method === 'state.get') refuse(params.id, cancelled())
      else reply(params.id, actionResult(request.ctx, request.params, request.method, true))
    }
    return
  }
  if (method === 'capture.stream.ack' && id === undefined) {
    const stream = streams.get(params.stream)
    if (stream) for (const seq of stream.unacked) if (seq <= params.seq) stream.unacked.delete(seq)
    return
  }
  if (id === undefined) return
  if (!initialized && method !== 'initialize') return refuse(id, failure('not_initialized', 'Initialize the service before using it.'))
  switch (method) {
    case 'initialize': {
      initialized = true
      dataDir = params.dataDir
      hostFeatures = new Set(params.features ?? [])
      const features = process.env.FAKE_NO_FEATURES === '1' ? [] : ['front', 'commit', 'save_as'].filter((f) => hostFeatures.has(f))
      reply(id, { ...initial, protocol: 1, epoch, permissions, ...(features.length ? { features } : {}) })
      if (exiting) return
      if (process.env.FAKE_GARBAGE === '1') process.stdout.write('this is not json\n')
      if (process.env.FAKE_UNKNOWN_NOTIFY === '1') notify('future/thing', {})
      if (process.env.FAKE_LOG_NOTIFY === '1') notify('log', { level: 'info', message: 'fake log line' })
      if (process.env.FAKE_PERMISSIONS_CHANGE_MS !== undefined) setTimeout(() => {
        permissions.screenRecording = !permissions.screenRecording
        notify('permissions/changed', permissions)
      }, Number(process.env.FAKE_PERMISSIONS_CHANGE_MS)).unref()
      return
    }
    case 'shutdown': return reply(id, {}, false, 0)
    case 'permissions.get': if (process.env.FAKE_NO_PONG === '1') return; return reply(id, permissions)
    case 'permissions.request': return reply(id, permissions)
    case 'apps.list': return reply(id, { apps: apps.filter((app) => app.name !== 'Preview' || previewRunning)
      .sort((a, b) => a.name === 'TextEdit' ? -1 : b.name === 'TextEdit' ? 1 : a.name.localeCompare(b.name))
      .map((app) => ({ ...brief(app), active: app.name === 'Webby' ? process.env.FAKE_WEB_ACTIVE === '1' : app.name === 'TextEdit', hidden: app.name === 'Finder', ...(params.windows ? { windows: app.windows } : {}) })) })
    case 'apps.launch': {
      // §23.2: the items and the app are checked before anything opens
      const open = params.open ?? []
      if (open.some((item) => item.endsWith('.command')))
        return refuse(id, failure('open_refused', 'That item is a program; open only opens documents, folders and web pages.', { reason: 'executable' }))
      if (open.some((item) => item.includes('/missing/')))
        return refuse(id, failure('open_refused', 'No file at that path.', { reason: 'missing' }))
      // FAKE_LAUNCH_REFUSE_APP=1 stands for a path to TempCode.app, which only the service can resolve
      if (process.env.FAKE_LAUNCH_REFUSE_APP === '1') return refuse(id, failure('open_refused', 'That app may not be opened into.', { reason: 'app' }))
      const app = resolveApp({ app: params.app })
      if (!app) return refuse(id, missingApp())
      if (app.bundleId && (params.refuse ?? []).includes(app.bundleId))
        return refuse(id, failure('open_refused', 'That app may not be opened into.', { reason: 'app' }))
      const launched = app.name === 'Preview' && !previewRunning
      if (app.name === 'Preview') previewRunning = true
      // FAKE_LAUNCH_STEAL=1: the app came forward and the guard put the person's back
      const front = process.env.FAKE_LAUNCH_STEAL === '1' ? { front: { raised: true, restored: process.env.FAKE_LAUNCH_RESTORED ?? 'restored', ms: 120 } } : {}
      const window = open.length ? { window: { id: 9001, title: open[0].split('/').pop() } } : {}
      const others = open.length && process.env.FAKE_LAUNCH_OTHERS === '1' ? { others: [{ id: 9000, title: 'Untitled — iCloud' }] } : {}
      reply(id, { pid: app.pid, launched, ...front, ...window, ...others })
      // FAKE_LATE_STEAL_MS: a steal after the result, told as apps/frontRestored naming the call's session
      if (process.env.FAKE_LATE_STEAL_MS)
        setTimeout(() => notify('apps/frontRestored', { ...(params.session ? { session: params.session } : {}), pid: app.pid, name: app.name, front: { raised: true, restored: 'restored', ms: 90 }, afterMs: 12_000 }), Number(process.env.FAKE_LATE_STEAL_MS))
      return
    }
    case 'session.open': sessions.add(params.session); return reply(id, {})
    case 'session.close': for (const key of lastClicks.keys()) if (key.startsWith(params.session + ':')) lastClicks.delete(key); for (const stream of streams.values()) if (stream.session === params.session) stopStream(stream.id); sessions.delete(params.session); states.delete(params.session); shots.delete(params.session); return reply(id, {})
    case 'capture.stream.stop': stopStream(params.stream); return reply(id, {})
    case 'escape.watch': {
      if (process.env.FAKE_ESCAPE_UNSUPPORTED === '1') return reply(id, { code: -32601, message: 'The method is unknown.' }, true)
      escapeUntil = params.on ? Date.now() + (params.leaseMs ?? 30000) : 0
      clearTimeout(escapeTimer)
      if (params.on && process.env.FAKE_ESCAPE_PRESS_MS) escapeTimer = setTimeout(() => {
        if (Date.now() < escapeUntil) notify('escape/pressed', { at: Date.now() })
      }, Number(process.env.FAKE_ESCAPE_PRESS_MS))
      return reply(id, {})
    }
    case 'input.restoreSession': {
      const answer = restorable ? { frontmost: 'restored', pointer: 'restored', held: brief(restorable) } : { frontmost: 'nothing', pointer: 'nothing', held: null }
      restorable = null
      const hold = Number(process.env.FAKE_RESTORE_MS ?? 0)
      if (hold > 0) setTimeout(() => reply(id, answer), hold)
      else reply(id, answer)
      return
    }
    case 'clipboard.state': return reply(id, { changeCount: 1, foreignChangeAt: foreignChangeAt(), watchingSince })
    case 'state.get': case 'action.run': case 'action.batch': case 'capture.screenshot': case 'capture.stream.start': case 'input.probe': {
      const ctx = target(params)
      if (ctx.app.name === 'Slow' && ['state.get', 'action.run', 'action.batch'].includes(method)) {
        pending.set(id, { ctx, params, method })
        return
      }
      if (ctx.app.name === 'Crashy' && method.startsWith('action.')) {
        process.stderr.write('fake crash\n', () => process.exit(1))
        return
      }
      if (method === 'state.get') return reply(id, observation(ctx, params))
      if (method.startsWith('action.')) {
        const result = actionResult(ctx, params, method)
        // FAKE_ACT_STEAL=1: the app came forward during the call (§23.4), unless a step raises it by design
        const raises = (params.actions ?? [params.action]).some((a) => a.action === 'perform' && a.name === 'raise')
        if (process.env.FAKE_ACT_STEAL === '1' && !raises) result.front = { raised: true, restored: 'restored', ms: 60 }
        // the service says the person took over the moment its watch trips, before the call's closing wait
        if (ctx.touched) notify('session/interrupted', { session: ctx.session, by: 'person', at: Date.now() })
        const steps = result.steps ?? [result.step]
        const session = steps.some((step) => step.tier === 'session' || step.error?.session)
        const wait = Number(process.env.FAKE_CLOSING_WAIT_MS ?? 0)
        if (session && wait > 0) delayed.set(id, { result, timer: setTimeout(() => (delayed.delete(id), reply(id, result)), wait) })
        else reply(id, result)
        return
      }
      if (method === 'capture.screenshot') return reply(id, shot(ctx, 'screenshot'))
      if (method === 'capture.stream.start') {
        if (!permissions.screenRecording || ctx.app.name === 'NoShot') return refuse(id, shotFailure())
        if (ctx.window.minimized) return refuse(id, failure('window_minimized', 'Restore the window before previewing it.'))
        stopStream(params.stream)
        const width = params.maxEdge ?? 960
        const height = Math.round(width * space.height / space.width)
        const stream = { id: params.stream, session: params.session, key: `${params.session}:${ctx.window.id}`, width, height, seq: 0, unacked: new Set() }
        streams.set(stream.id, stream)
        stream.timer = setInterval(() => {
          if (stream.unacked.size >= 2 || process.env.FAKE_NO_FRAMES === '1') return
          const seq = ++stream.seq
          stream.unacked.add(seq)
          notify('capture/frame', { stream: stream.id, seq, ts: Date.now(), width, height, format: 'jpeg', data: streamJpeg })
        }, 1000 / (params.fps ?? 4))
        if (process.env.FAKE_STREAM_END_MS) stream.endTimer = setTimeout(() => {
          stopStream(stream.id)
          notify('capture/streamEnded', { stream: stream.id, reason: process.env.FAKE_STREAM_END_REASON ?? 'window-closed' })
        }, Number(process.env.FAKE_STREAM_END_MS))
        reply(id, { stream: stream.id, width, height })
        const click = lastClicks.get(stream.key)
        if (click && Date.now() - click.answeredAt <= 2000) clickNote(stream, click.at)
        return
      }
      return reply(id, { pid: ctx.app.pid, bundleId: ctx.app.bundleId, keyWindow: ctx.app.name === 'KeyWin' ? 'other' : 'target',
        results: (params.classes ?? ['scroll', 'key', 'click']).map((kind) => ({ class: kind, outcome: ctx.app.name === 'Thin' ? 'untested' : ctx.app.name === 'Stubborn' && kind === 'click' ? 'ignored' : 'honoured',
          ...(ctx.app.name === 'Thin' ? { reason: 'thin tree' } : {}), restored: true, ms: 5 })) })
    }
    default: return reply(id, { code: -32601, message: 'The method is unknown.' }, true)
  }
}
const rl = createInterface({ input: process.stdin })
rl.on('close', () => { if (!exiting) process.stdout.write('', () => process.exit(0)) })
rl.on('line', (line) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, line + '\n')
  if (exiting) return
  let request
  try { request = JSON.parse(line) } catch { reply(null, { code: -32700, message: 'Send a JSON frame.' }, true); return }
  try { handle(request) } catch (error) {
    if (error?.kind) refuse(request.id, error)
    else reply(request.id, { code: -32603, message: 'The fake service could not handle the request.' }, true)
  }
})
