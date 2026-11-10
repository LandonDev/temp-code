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
  { name: 'Finder', pid: 400, bundleId: 'com.apple.finder', windows: [] }
]
const brief = ({ pid, bundleId, name }) => ({ pid, bundleId, name })
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
  const window = ref.id !== undefined ? app.windows.find((w) => w.id === ref.id) : ref.title !== undefined ?
    app.windows.find((w) => w.title === ref.title) ?? app.windows.find((w) => w.title.includes(ref.title)) : app.windows[0]
  if (!window) throw failure('window_not_found', 'Choose a window from this app.', { candidates: app.windows.map((w) => w.title) })
  const named = params.element !== undefined ? [params.element] : params.action ? elements(params.action) : (params.actions ?? []).flatMap(elements)
  if (named.length && params.epoch !== epoch) throw failure('stale_element', 'Read the app again after the service restart.', { element: named[0], reason: 'service-restarted' })
  let perApp = states.get(params.session)
  if (!perApp) states.set(params.session, perApp = new Map())
  let state = perApp.get(app.pid)
  if (!state) perApp.set(app.pid, state = { seq: 0, dirty: false, maxIndex: 0, gotFirst: false })
  return { app, window, state, session: params.session }
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
  const kind = options.element !== undefined ? 'subtree' : options.mode === 'full' || !state.gotFirst ? 'full' : state.dirty ? 'diff' : 'unchanged'
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
  const lines = text.split('\n')
  const result = {
    epoch, session: ctx.session, app: brief(ctx.app), window: { id: ctx.window.id, title: ctx.window.title, frame },
    kind, seq: state.seq, ...(kind === 'diff' ? { base } : {}), text, space,
    stats: { elements: lines.filter((line) => line.includes('[')).length, lines: lines.length - 1, bytes: Buffer.byteLength(text), omitted: 0, thin: ctx.app.name === 'Thin', partial: false, readMs: 5 },
    waited
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
function step(ctx, action, tiers, index, pasteQuietMs, ignored) {
  const fail = (error) => ({ index, action: action.action, status: 'failed', error })
  for (const element of elements(action)) {
    if (element > ctx.state.maxIndex) return fail(failure('no_such_element', 'Read the app before using this element.', { element }))
  }
  const verb = action.action
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
function actionResult(ctx, params, method, wasCancelled = false) {
  const actions = method === 'action.run' ? [params.action] : params.actions
  let stopped = false
  const steps = actions.map((action, index) => {
    if (stopped) return { index, action: action.action, status: 'not-run' }
    const result = wasCancelled ? { index, action: action.action, status: 'failed', error: cancelled() } : step(ctx, action, params.tiers, index, params.pasteQuietMs, params.ignored)
    stopped = result.status === 'failed'
    return result
  })
  const result = method === 'action.run' ? { step: steps[0] } : { steps, waited: wasCancelled ? { waitedMs: 0, settled: false, busy: false, reason: 'cancelled' } : waited }
  // Closey's close button closes the target: the observation reads the next window whole, or says none is left
  const closed = ctx.app.name === 'Closey' && steps.some((s, i) => s.status === 'ok' && actions[i].action === 'left_click' && s.element?.line === 'button "close"')
  if (closed) ctx.app.windows = ctx.app.windows.filter((w) => w.id !== ctx.window.id)
  if (wasCancelled) result.observationError = cancelled()
  else if (closed && !ctx.app.windows.length) result.observationError = failure('window_not_found', 'Closey has no window open.', { reason: 'gone' })
  else if (closed) result.observation = observation({ ...ctx, window: ctx.app.windows[0] }, { ...params.observe, mode: 'full' }, 'action')
  else if (params.observe?.mode !== 'none') result.observation = observation(ctx, params.observe, 'action')
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
      reply(id, { ...initial, protocol: 1, epoch, permissions })
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
      .map((app) => ({ ...brief(app), active: app.name === 'TextEdit', hidden: app.name === 'Finder', ...(params.windows ? { windows: app.windows } : {}) })) })
    case 'apps.launch': {
      const app = resolveApp({ app: params.app })
      if (!app) return refuse(id, missingApp())
      const launched = app.name === 'Preview' && !previewRunning
      if (app.name === 'Preview') previewRunning = true
      return reply(id, { pid: app.pid, launched })
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
