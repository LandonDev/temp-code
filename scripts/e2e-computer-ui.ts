/**
 * The live pass of the computer preview through a real thread (plan .temp-code/plan-uYrrhDzuBc9f.md
 * §13): an isolated built instance (`electron-vite preview --skipBuild`, a fresh TEMP_CODE_USER_DATA
 * under /private/tmp, its own debug port, the remote listener off, the soak window so it never
 * activates, the proof statuses on) with `TEMP_CODE_COMPUTER_PIN="TC Probe=<pid>"` pinning a ticking TC
 * Probe the proof launched (scripts/mac/computer-probe-app.swift `--tick`). A claude-sonnet-5-5 thread at
 * low effort in full access reads TC Probe's window, waits, clicks Ping, takes a screenshot and waits
 * again; over CDP (bun's global WebSocket):
 *
 *  - the right panel's Activity section shows the Computer row with its words; opened, its canvas draws
 *    at least 3 frames (`[role=img][data-frames]`) and a click mark (`data-marks`)
 *  - the transcript has the screenshot row (`[data-slot="computer-shot"] img`, naturalWidth > 0)
 *  - `Page.captureScreenshot` of the pane and the row, dark and light, under /tmp/tc-preview-reports
 *  - `computer.proofHold { on: true }`: the banner window appears (a CDP target reading "TempCode is
 *    using your Mac"), is never focused, and the frontmost app never changes; `{ on: false }` hides it
 *
 * The person's leave for this proof drops the idle gate; a locked or dark screen, read before each
 * launch and every second, stops it (inconclusive). Cleanup always: the instance's process group (only
 * an instance this run started), TC Probe, the scratch dirs.
 *
 * Run on the Mac: bun run script:e2e-computer-ui   (`--skip-build` reuses out/ from an earlier build)
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Cdp, REPO, attach, prepareEnv } from './lib/packagedApp'
import { buildTcComputer } from './lib/tcComputerBuild'
import { buildProbeApp, cleanupProbeApp, launchTickingProbe, MAC_EXTRA_SOURCE, PROBE_APP_NAME, ScreenLost, ScreenWatch, type ProbeAppBuild } from './lib/tcProbeApp'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}
prepareEnv()

const WORK = '/private/tmp/tc-computer-ui'
const USER_DATA = join(WORK, 'user-data')
const WS_DIR = join(WORK, 'workspace')
const SHOTS = process.env.TC_UI_SHOTS ?? '/tmp/tc-preview-reports/ui'
const REPORT = join(SHOTS, 'report.json')
const DEBUG_PORT = Number(process.env.TC_UI_DEBUG_PORT ?? 9241)
const MODEL = process.env.TC_E2E_MODEL || 'claude-sonnet-5-5'
const APP = PROBE_APP_NAME
const PROBE = join(WORK, 'computer-proof-probe')
const EXTRA = join(WORK, 'mac-extra')
const watch = new ScreenWatch()
const sleep = (ms: number): Promise<void> => watch.nap(ms)
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Outcome = 'passed' | 'failed' | 'inconclusive'
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  model: MODEL,
  gate: "off by the person's leave: no idle wait; a locked or dark screen stops the run",
  checks: [] as { name: string; outcome: Outcome; detail?: string }[],
  row: null as string | null,
  preview: null as { frames: number; marks: number } | null,
  toolCalls: [] as string[],
  shots: [] as string[],
  banner: null as unknown,
  bounce: null as string | null,
  cleanup: [] as string[]
}
const check = (name: string, ok: boolean | 'inconclusive', detail = ''): boolean => {
  const outcome: Outcome = ok === 'inconclusive' ? 'inconclusive' : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, ...(detail ? { detail } : {}) })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'VOID'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return outcome === 'passed'
}
const log = (m: string): void => console.log(`      ${m}`)

const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, command.split(' '), { encoding: 'utf8', timeout: 10_000 })) as T
const frontmost = (): { pid: number; bundleId: string | null } => probe('frontmost')
const extra = <T>(...args: string[]): T => JSON.parse(execFileSync(EXTRA, args, { encoding: 'utf8', timeout: 10_000 })) as T
const pidsOn = (port: number): number[] => {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n')
      .map(Number)
      .filter((n) => n > 0)
  } catch {
    return []
  }
}

let probeBuild: ProbeAppBuild | null = null
let probePid = 0
let instance: ReturnType<typeof spawn> | null = null
let page: Cdp | null = null

/** A listener on the port that is this run's instance by its environment (its own user data dir), should Electron have left the group. */
const strays = (): number[] =>
  pidsOn(DEBUG_PORT).filter((pid) => {
    try {
      return execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(`TEMP_CODE_USER_DATA=${USER_DATA}`)
    } catch {
      return false
    }
  })

/** Only what this run started: the detached instance's process group (Electron is in it), never the port's owner. */
async function cleanup(): Promise<void> {
  page?.close()
  const group = instance?.pid ?? 0
  if (group) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-group, signal)
      } catch {
        /* gone */
      }
      if (signal === 'SIGTERM') await pause(1_500)
    }
    for (const pid of strays()) {
      try {
        process.kill(pid, 'SIGKILL')
        report.cleanup.push(`ended ${pid}, which had left the group`)
      } catch {
        /* gone */
      }
    }
  }
  report.cleanup.push(group ? `ended the instance's process group ${group}` : 'no instance was started')
  report.cleanup.push(...cleanupProbeApp(probeBuild, probePid))
  probePid = 0
  rmSync(WORK, { recursive: true, force: true })
  report.cleanup.push(`removed ${WORK}`)
  writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))
}

/** The page's element box, for a clipped screenshot; scrolled into view first. */
async function shot(cdp: Cdp, selector: string, name: string): Promise<string | null> {
  const box = await cdp.eval<{ x: number; y: number; width: number; height: number } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })()`)
  if (!box || box.width < 1 || box.height < 1) return null
  await sleep(300)
  const again = await cdp.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...again, scale: 1 } })) as { data: string }
  const path = join(SHOTS, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  report.shots.push(path)
  return path
}

const setTheme = (cdp: Cdp, light: boolean): Promise<unknown> =>
  cdp.eval(`(() => { const r = document.documentElement; r.classList.toggle('theme-light', ${light}); window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: ${light ? "'light'" : "'dark'"} })); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))) })()`)

async function run(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(REPO, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  writeFileSync(`${EXTRA}.swift`, MAC_EXTRA_SOURCE)
  execFileSync('xcrun', ['swiftc', '-O', '-o', EXTRA, `${EXTRA}.swift`], { stdio: 'pipe' })
  watch.start(PROBE)
  if (pidsOn(DEBUG_PORT).length) throw new Error(`port ${DEBUG_PORT} is in use; pick another with TC_UI_DEBUG_PORT`)

  if (!process.argv.includes('--skip-build')) {
    log('bun run build')
    execFileSync('bun', ['run', 'build'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] })
  }
  const tc = buildTcComputer({ root: REPO, require: true })
  log(`tc-computer: ${tc.built ? `built in ${tc.ms} ms` : tc.skipped}`)
  if (!existsSync(join(REPO, 'out/renderer/index.html'))) throw new Error('out/renderer is missing: run without --skip-build')

  probeBuild = buildProbeApp(REPO, WORK, 'dev.landon.tempcode.computer-ui-probe')
  watch.check()
  const launched = await launchTickingProbe(probeBuild, frontmost)
  probePid = launched.pid
  report.bounce = launched.bounced
  log(`TC Probe ${probePid}, ticking`)

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TEMP_CODE_USER_DATA: USER_DATA,
    TEMP_CODE_DEBUG_PORT: String(DEBUG_PORT),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_SOAK_WINDOW: '1',
    TEMP_CODE_E2E_STATUS: '1',
    TEMP_CODE_COMPUTER_PIN: `${APP}=${probePid}`,
    TEMP_CODE_COMPUTER_TRACE: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  watch.check()
  instance = spawn(join(REPO, 'node_modules/.bin/electron-vite'), ['preview', '--skipBuild'], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
  page = await attach(DEBUG_PORT, 120_000)
  const cdp = page
  for (let i = 0; i < 120 && !(await cdp.eval<boolean>('!!window.__monocode?.registry?.primary()?.connected').catch(() => false)); i++) await sleep(500)
  log('instance up and connected')
  const mainPid = pidsOn(DEBUG_PORT)[0] ?? 0
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false })
  const request = <T>(method: string, params: unknown): Promise<T> =>
    cdp.eval<T>(`window.__monocode.registry.primary().request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)

  mkdirSync(WS_DIR, { recursive: true })
  writeFileSync(join(WS_DIR, 'README.md'), '# computer preview proof\n')
  execFileSync('git', ['init', '-q', WS_DIR])
  const ws = await request<{ id: string }>('workspace.create', { path: WS_DIR, name: 'computer-ui-proof' })
  const meta = await request<{ id: string }>('session.create', {
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    permission: 'auto',
    cwd: WS_DIR,
    workspaceId: ws.id,
    threadType: 'chat',
    title: 'Computer preview proof'
  })
  const id = meta.id
  log(`thread ${id}`)
  await cdp.eval(`window.__monocode.open(${JSON.stringify(id)})`)
  await sleep(1_500)
  // The panel opens on ⌘⇧R (toggle_panel); its state is stored per thread, which says whether it took.
  const panelOpen = (): Promise<boolean> => cdp.eval<boolean>(`(() => { try { return !!JSON.parse(localStorage.getItem('monocode.rightPanel') ?? 'null')?.threads?.[${JSON.stringify(id)}]?.open } catch { return false } })()`)
  for (let i = 0; i < 3 && !(await panelOpen()); i++) {
    for (const type of ['rawKeyDown', 'keyUp'] as const)
      await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 4 | 8, key: 'R', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 15 })
    await sleep(500)
  }
  check('the right panel is open on the thread', await panelOpen())

  const where = `the window "${APP}" of the app "${APP}"`
  await request('session.send', {
    sessionId: id,
    text: [
      `Use the computer tools (find them with tool search). In ${where}, do these in order, one tool call each:`,
      `1. computer_observe to read the window.`,
      `2. computer_act with action "wait" and duration 12.`,
      `3. computer_act with action "left_click" on its Ping button (by its element number).`,
      `4. computer_act with action "screenshot".`,
      `5. computer_act with action "wait" and duration 25.`,
      `Then say "done" and stop.`
    ].join('\n')
  })

  // ── the Computer row and the preview ──────────────────────────────────
  const until = async <T>(what: string, ms: number, fn: () => Promise<T | null | false | undefined>): Promise<T | null> => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      const v = await fn().catch(() => null)
      if (v) return v
      await sleep(250)
    }
    log(`no ${what} within ${ms / 1000} s`)
    return null
  }
  const rowText = await until('Computer row', 240_000, () => cdp.eval<string | null>(`document.querySelector('[data-kind="computer"]')?.textContent ?? null`))
  report.row = rowText
  check('the Activity section shows the Computer row with its words', !!rowText && rowText.includes(APP), rowText ?? 'none')
  if (rowText) {
    await cdp.eval(`document.querySelector('[data-kind="computer"] [data-row-open]')?.click()`)
    const drawn = await until('3 frames and a mark', 60_000, () =>
      cdp.eval<{ frames: number; marks: number } | null>(`(() => { const el = document.querySelector('[role=img][data-frames]'); if (!el) return null; const f = Number(el.dataset.frames), m = Number(el.dataset.marks); return f >= 3 && m >= 1 ? { frames: f, marks: m } : null })()`)
    )
    const seen = await cdp.eval<{ frames: number; marks: number; label: string } | null>(`(() => { const el = document.querySelector('[role=img][data-frames]'); return el ? { frames: Number(el.dataset.frames), marks: Number(el.dataset.marks), label: el.getAttribute('aria-label') } : null })()`)
    report.preview = seen ? { frames: seen.frames, marks: seen.marks } : null
    check('opened, the preview draws at least 3 frames', (seen?.frames ?? 0) >= 3, seen ? `${seen.frames} frames, "${seen.label}"` : 'no preview')
    check('and a click mark', (seen?.marks ?? 0) >= 1 && !!drawn, `${seen?.marks ?? 0} marks`)
    const live = await cdp.eval<boolean>(`!!document.querySelector('[data-slot="computer-row"] [role=img]')`)
    if (live) {
      const dark = await shot(cdp, '[data-slot="computer-row"]', 'preview-pane-dark')
      await setTheme(cdp, true)
      const light = await shot(cdp, '[data-slot="computer-row"]', 'preview-pane-light')
      await setTheme(cdp, false)
      check('the pane captured dark and light', !!dark && !!light)
    } else check('the pane captured dark and light', false, 'the preview had gone before the capture')
  }

  // ── the turn ends; the screenshot row ─────────────────────────────────
  const settled = await until('settle', 300_000, () => cdp.eval<string | null>(`(() => { const s = window.__monocode.sessionStore.metaOf(${JSON.stringify(id)})?.status; return s === 'idle' || s === 'error' || s === 'done' ? s : null })()`))
  check('the turn settled', settled === 'idle' || settled === 'done', settled ?? 'still running')
  type Row = { event: { type: string; name?: string; partial?: boolean } }
  const page1 = await request<Row[] | { rows: Row[] }>('session.events', { sessionId: id, afterSeq: 0 })
  report.toolCalls = (Array.isArray(page1) ? page1 : page1.rows).flatMap((r) => (r.event.type === 'tool-call' && !r.event.partial && r.event.name ? [r.event.name] : []))
  log(`tool calls: ${report.toolCalls.join(', ')}`)
  const img = await until('loaded screenshot row', 30_000, () => cdp.eval<number | null>(`(() => { const i = document.querySelector('[data-slot="computer-shot"] img'); if (!i) return null; i.scrollIntoView({ block: 'center' }); return i.complete && i.naturalWidth > 0 ? i.naturalWidth : null })()`))
  check('the transcript has the screenshot row, its image loaded', !!img, img ? `naturalWidth ${img}` : 'none')
  if (img) {
    const dark = await shot(cdp, '[data-slot="computer-shot"]', 'screenshot-row-dark')
    await setTheme(cdp, true)
    const light = await shot(cdp, '[data-slot="computer-shot"]', 'screenshot-row-light')
    await setTheme(cdp, false)
    check('the row captured dark and light', !!dark && !!light)
  }

  // ── the banner ────────────────────────────────────────────────────────
  watch.check()
  const before = frontmost()
  const fronts = new Set<number>([before.pid])
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      try {
        fronts.add(frontmost().pid)
      } catch {
        /* a slow read */
      }
      await pause(100)
    }
  })()
  await request('computer.proofHold', { on: true })
  const bannerPage = await until('banner target', 5_000, async () => {
    const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    return list.find((t) => t.type === 'page' && t.url.startsWith('data:text/html') && t.webSocketDebuggerUrl) ?? null
  })
  let text = ''
  let focused: boolean[] = []
  let onScreen: { layer: number; x: number; y: number; w: number; h: number }[] = []
  if (bannerPage?.webSocketDebuggerUrl) {
    const banner = await Cdp.connect(bannerPage.webSocketDebuggerUrl)
    await sleep(400)
    for (let i = 0; i < 16; i++) {
      focused.push(await banner.eval<boolean>('document.hasFocus()'))
      await sleep(100)
    }
    text = await banner.eval<string>('document.body.innerText')
    onScreen = extra<{ windows: { layer: number; x: number; y: number; w: number; h: number }[] }>('windows', String(mainPid)).windows.filter((w) => w.layer > 0)
    await banner.send('Page.enable')
    const { data } = (await banner.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    const path = join(SHOTS, 'banner.png')
    writeFileSync(path, Buffer.from(data, 'base64'))
    report.shots.push(path)
    banner.close()
  }
  await request('computer.proofHold', { on: false })
  const gone = await until('banner hidden', 6_000, async () => !extra<{ windows: { layer: number; h: number }[] }>('windows', String(mainPid)).windows.some((w) => w.layer > 0 && w.h === 32))
  sampling = false
  await sampler
  report.banner = { text, focused, onScreen, fronts: [...fronts] }
  check('the banner shows "TempCode is using your Mac"', /TempCode is using your Mac/.test(text), text.replace(/\s+/g, ' ').trim())
  check('the banner is a 32px window above the others', onScreen.some((w) => w.h === 32), JSON.stringify(onScreen))
  check('the banner was never focused', focused.length > 0 && focused.every((f) => !f), `${focused.length} reads`)
  check('the frontmost app never changed', fronts.size === 1, [...fronts].join(', '))
  check('off, the banner hides', !!gone)
}

const running = run()
try {
  await Promise.race([running, watch.lost])
} catch (e) {
  if (e instanceof ScreenLost) check('the run', 'inconclusive', e.message)
  else check('the run finished', false, ((e as Error).stack ?? String(e)).split('\n').slice(0, 4).join(' '))
}
// A lost screen ends the race at once; the run unwinds at its next nap before the cleanup, 20 s at most.
await Promise.race([running.catch(() => undefined), pause(20_000)])
watch.stop()
await cleanup()
const failed = report.checks.filter((c) => c.outcome === 'failed').length
const voided = report.checks.filter((c) => c.outcome === 'inconclusive').length
console.log(`\n${report.checks.length - failed - voided} passed, ${failed} failed, ${voided} inconclusive; report ${REPORT}`)
process.exit(failed ? 1 : voided ? 2 : 0)
