/**
 * The Mac proof of the computer preview's host side (plan .temp-code/plan-uYrrhDzuBc9f.md §13): the real
 * tc-computer under the in-process host pieces index.ts wires (`ComputerService`, `ComputerSessions`
 * with TC Probe pinned by pid, `ComputerPreviews`, `SessionHolds`), and a fake viewer where a socket
 * would be. TC Probe (scripts/mac/computer-probe-app.swift) runs in the background with `--tick`, so
 * its window changes ten times a second and the capture stream, which sends only on a change, keeps
 * sending.
 *
 *  1. one `computer_observe` makes TC Probe the thread's preview target
 *  2. a preview at maxEdge 512, each frame acked as drawn: 4 ± 1 fps over 5 s; stopped, the service
 *     hears `capture.stream.stop` and the frames end
 *  3. an `ax` click on Ping brings `computer-click`, whose point mapped back to the session space lies
 *     in the button's frame from a geometry read; a second click that changes nothing (the label
 *     already "pong", TC Probe's tick paused by SIGUSR1, the stream still) brings one too, and no
 *     frame comes from the service after it
 *  4. `escape.watch { on: true, leaseMs: 1000 }` answers `{}`, the service holds an enabled event tap
 *     (CGGetEventTapList) and the trace has the frames; unrenewed it ends within ~2 s; `on: false` ends
 *     a fresh one at once; `SessionHolds` over a fake banner shows Esc once the watch answered and
 *     hides, the tap gone, after its linger
 *  5. the person's frontmost app and pointer are where they were (inconclusive, not failed, if they
 *     used the Mac meanwhile)
 *
 * Escape itself is never pressed. The person's leave for this proof drops the idle gate; a locked or
 * dark screen, read before each launch and every second, stops it (inconclusive) and cleans up.
 * Nothing stays but report.json and trace.log under /tmp/tc-preview-proof.
 *
 * Run on the Mac: bun run script:e2e-computer-preview (esbuild → node, as script:e2e-computer).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComputerClickPush, ComputerFramePush, ComputerPreviewPush } from '../src/shared/contract-computer'
import { parseObservation } from '../src/shared/computer/observation'
import type { ComputerMethod, Tier } from '../src/shared/computer/protocol'
import { ComputerService } from '../src/main/server/computer/service'
import { ComputerSessions } from '../src/main/server/computer/sessions'
import { ComputerPreviews, type Viewer } from '../src/main/server/computer/preview'
import { SessionHolds, HOLD_LINGER_MS } from '../src/main/server/computer/hold'
import { setSessionTierGate, REFUSE_SESSION_TIER } from '../src/main/server/computer/tierGate'
import { buildTcComputer } from './lib/tcComputerBuild'
import { waitForGateBuild } from './lib/gateBuild'
import { computerProofMode, computerProofPolicy, requireGateNative, waitForComputerProof } from './lib/computerProofGate'
import { repoRoot } from './lib/repoRoot'
import { buildProbeApp, cleanupProbeApp, launchTickingProbe, PROBE_APP_NAME, MAC_EXTRA_SOURCE, ScreenLost, ScreenWatch, type ProbeAppBuild } from './lib/tcProbeApp'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

const GATE = computerProofMode(process.argv).gate
if (GATE) process.env.TC_PROOF_UNGATED = '1'
const ROOT = repoRoot()
if (GATE) await waitForGateBuild({ tree: ROOT, log: console.log })
await waitForComputerProof(console.log)
const WORK = '/tmp/tc-preview-proof'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(WORK, 'computer-proof-probe')
const TAPS = join(WORK, 'tap-counter')
const APP = PROBE_APP_NAME
const THREAD = 'proof-preview'
const watch = new ScreenWatch()
const sleep = (ms: number): Promise<void> => watch.nap(ms)

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
writeFileSync(TRACE, '')
process.env.TEMP_CODE_COMPUTER_BIN = BIN

type Outcome = 'passed' | 'failed' | 'inconclusive' | 'skipped'
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  gate: 'off by the person\'s leave: no idle wait; a locked or dark screen stops the run',
  checks: [] as { name: string; outcome: Outcome; detail?: string }[],
  frames: { count: 0, seconds: 0, fps: 0, size: '' },
  clicks: [] as { at: number[]; width: number; height: number; session: number[]; button: string }[],
  tiers: [] as { method: string; tier: Tier }[],
  requests: [] as string[],
  bounce: null as string | null,
  cleanup: [] as string[]
}
const skipCheck = (name: string, detail: string): void => {
  report.checks.push({ name, outcome: 'skipped', detail })
  console.log(`SKIP  ${name}: ${detail}`)
}
const check = (name: string, ok: boolean | 'inconclusive', detail = ''): void => {
  const outcome: Outcome = ok === 'inconclusive' ? 'inconclusive' : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, ...(detail ? { detail } : {}) })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'VOID'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const saveReport = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))

const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, command.split(' '), { encoding: 'utf8', timeout: 10_000 })) as T
const frontmost = (): { pid: number; bundleId: string | null } => probe('frontmost')
const pointer = (): { x: number; y: number } => probe('pointer')
const idleSeconds = (): number => probe<{ seconds: number }>('idle').seconds

let probeBuild: ProbeAppBuild | null = null
let probePid = 0
let service: ComputerService | null = null
let previews: ComputerPreviews | null = null
let holds: SessionHolds | null = null

async function cleanup(): Promise<void> {
  report.cleanup.push(...cleanupProbeApp(probeBuild, probePid))
  probePid = 0
  probeBuild = null
  holds?.close()
  await previews?.close().catch(() => undefined)
  await service?.request('escape.watch', { on: false }).catch(() => undefined)
  await service?.close().catch(() => undefined)
  saveReport()
  for (const name of readdirSync(WORK)) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}

async function run(): Promise<void> {
  if (GATE) requireGateNative(ROOT)
  const build = buildTcComputer({ root: ROOT, require: true })
  console.log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  writeFileSync(`${TAPS}.swift`, MAC_EXTRA_SOURCE)
  execFileSync('xcrun', ['swiftc', '-O', '-o', TAPS, `${TAPS}.swift`], { stdio: 'pipe' })
  for (const binary of [PROBE, TAPS]) execFileSync('codesign', ['-s', '-', '--force', binary], { stdio: 'pipe' })
  const taps = (pid: number): { taps: number; enabled: number } => JSON.parse(execFileSync(TAPS, ['taps', String(pid)], { encoding: 'utf8' })) as { taps: number; enabled: number }
  const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
  if (!grants.accessibility) throw new Error('Accessibility is off for the session holder (TempCode.app from Publish); enable its Accessibility grant')
  if (!GATE && !grants.screenRecording) throw new Error('the hand-run preview needs Screen Recording; it asks for no grant')
  const policy = computerProofPolicy(GATE, grants)
  report.gate = GATE ? 'unattended: TC Probe only; no Escape watch or idle wait' : report.gate
  watch.start(PROBE)

  const start = Date.now()
  const app0 = frontmost()
  const p0 = pointer()

  probeBuild = buildProbeApp(ROOT, WORK, 'dev.landon.tempcode.computer-preview-probe')
  watch.check()
  const launched = await launchTickingProbe(probeBuild, GATE ? () => ({ ...frontmost(), bundleId: null }) : frontmost)
  probePid = launched.pid
  report.bounce = launched.bounced

  const settings = new Map<string, string>(policy.settings)
  service = new ComputerService({
    dataDir: join(WORK, 'data'),
    env: { ...process.env, TEMP_CODE_COMPUTER_TRACE: '1' },
    trace: true,
    bin: () => BIN,
    log: (line) => appendFileSync(TRACE, `${new Date().toISOString()} ${line}\n`)
  })
  const svc = service
  const sourceFrames: number[] = []
  svc.onNotification((n) => void (n.method === 'capture/frame' && sourceFrames.push(Date.now())))
  const request = svc.request.bind(svc)
  svc.request = (async (method: ComputerMethod, params: never, opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
    policy.assertRequest(method, params)
    report.requests.push(method)
    const result = await request(method, params, opts)
    const steps = method === 'action.run' ? [(result as { step: { status: string; tier?: Tier | null } }).step] : []
    for (const s of steps) if (s.status === 'ok' && s.tier) report.tiers.push({ method, tier: s.tier })
    return result
  }) as typeof svc.request
  setSessionTierGate(REFUSE_SESSION_TIER)
  const sessions = new ComputerSessions({
    service: svc,
    registry: { get: () => null, requestApproval: async () => true, awayOn: () => false },
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    dataDir: join(WORK, 'data'),
    landing: (id) => join(WORK, 'landing', id),
    resolveApp: (q) => (q.toLowerCase() === APP.toLowerCase() ? { pid: probePid } : null),
    log: (line) => appendFileSync(TRACE, `${line}\n`)
  })
  previews = new ComputerPreviews({ service: svc, sessions, log: (line) => appendFileSync(TRACE, `[preview] ${line}\n`) })
  const banner: { show: boolean[]; hide: number } = { show: [], hide: 0 }
  holds = new SessionHolds({
    service: svc,
    sessions,
    banner: () => ({ show: ({ esc }) => void banner.show.push(esc), hide: () => void banner.hide++ }),
    log: (line) => appendFileSync(TRACE, `[hold] ${line}\n`)
  })
  const ctx = { threadId: THREAD, permission: () => 'auto' as const }

  // the window lists a moment after the app starts
  for (const until = Date.now() + 15_000; ; ) {
    const { apps } = await svc.request('apps.list', { windows: true })
    if (apps.some((a) => a.pid === probePid && (a.windows ?? []).some((w) => w.title === APP))) break
    if (Date.now() > until) throw new Error("TC Probe's window did not show in apps.list within 15 s")
    await sleep(250)
  }

  // ── 1. the target ─────────────────────────────────────────────────────
  console.log('\n[1] one computer_observe makes TC Probe the target')
  let retargets = 0
  sessions.onTarget((id) => id === THREAD && retargets++)
  const obs = await sessions.run(ctx, 'computer_observe', policy.observeArgs({ app: APP, window: APP }))
  const target = sessions.previewTarget(THREAD)
  check('the observe answered', !obs.isError, (obs.body ?? '').split('\n')[0])
  check('TC Probe is the thread\'s preview target', !!target && target.app.pid === probePid && target.window.title === APP && retargets === 1, JSON.stringify(target))

  if (policy.pictures) {
  // ── 2. frames ─────────────────────────────────────────────────────────
  console.log('\n[2] a preview at maxEdge 512, every frame acked')
  const connection = {}
  const got: { frames: { at: number; push: ComputerFramePush }[]; clicks: { at: number; push: ComputerClickPush }[]; states: ComputerPreviewPush[] } = { frames: [], clicks: [], states: [] }
  const viewer: Viewer = {
    connection,
    send: (frame) => {
      if (frame.push === 'computer-frame') {
        got.frames.push({ at: Date.now(), push: frame })
        setImmediate(() => previews!.ack(connection, frame.preview, frame.seq))
      } else if (frame.push === 'computer-click') got.clicks.push({ at: Date.now(), push: frame })
      else got.states.push(frame)
    }
  }
  const answer = await previews.start(viewer, { threadId: THREAD, maxEdge: 512 })
  check('the start answered TC Probe\'s window with a size', answer.app === APP && answer.window === APP && answer.width > 0 && answer.height > 0 && Math.max(answer.width, answer.height) <= 512, `${answer.app} "${answer.window}" ${answer.width}×${answer.height}`)
  for (const until = Date.now() + 5_000; !got.frames.length && Date.now() < until; ) await sleep(50)
  const from = Date.now()
  const first = got.frames.length
  await sleep(5_000)
  const counted = got.frames.length - first
  const seconds = (Date.now() - from) / 1000
  const fps = counted / seconds
  const last = got.frames.at(-1)?.push
  report.frames = { count: counted, seconds, fps: Math.round(fps * 100) / 100, size: last ? `${last.width}×${last.height}` : '' }
  check('frames at 4 ± 1 fps over 5 s', fps >= 3 && fps <= 5, `${counted} frames in ${seconds.toFixed(2)} s = ${fps.toFixed(2)} fps`)
  check('each frame a JPEG within maxEdge', !!last && Math.max(last.width, last.height) <= 512 && Buffer.from(last.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8', last ? `${last.width}×${last.height}, ${Math.round((last.data.length * 3) / 4 / 1024)} KiB` : 'none')

  // ── 3. clicks ─────────────────────────────────────────────────────────
  console.log('\n[3] an ax click on Ping brings computer-click inside the button')
  const geoSession = 'proof-geometry'
  await svc.request('session.open', { session: geoSession })
  const geo = await svc.request('state.get', { session: geoSession, app: { pid: probePid }, window: { title: APP }, mode: 'full', geometry: true, screenshot: 'never' })
  const parsedGeo = parseObservation(geo.text)
  const header = /· (\d+)×(\d+)/.exec(geo.text.split('\n')[0] ?? '')
  const space = header ? { w: Number(header[1]), h: Number(header[2]) } : null
  const pingLine = parsedGeo.lines.find((l) => l.type === 'element' && l.role === 'button' && /Ping/.test(l.name ?? ''))
  const pingFrame = pingLine && pingLine.type === 'element' ? pingLine.frame : undefined
  check('the geometry read names Ping with a frame', !!space && !!pingFrame, `space ${space?.w}×${space?.h}, Ping ${JSON.stringify(pingFrame)}`)
  const threadObs = parseObservation((await sessions.run(ctx, 'computer_observe', policy.observeArgs({ app: APP, window: APP, full: true }))).body ?? '')
  const ping = threadObs.lines.find((l) => l.type === 'element' && l.role === 'button' && /Ping/.test(l.name ?? ''))
  if (!ping || ping.type !== 'element') throw new Error("the thread's read shows no Ping button")

  const clickOnce = async (label: string): Promise<void> => {
    const before = got.clicks.length
    const tiersBefore = report.tiers.length
    const sent = Date.now()
    const out = await sessions.run(ctx, 'computer_act', policy.observeArgs({ app: APP, window: APP, action: 'left_click', element: ping.index }))
    const tier = report.tiers.slice(tiersBefore).map((t) => t.tier).join(',')
    for (const until = Date.now() + 3_000; got.clicks.length === before && Date.now() < until; ) await sleep(25)
    const click = got.clicks[before]
    check(`${label}: the click ran at the ax tier`, !out.isError && tier === 'ax', `${out.steps.join(' | ')} (tier ${tier || 'none'})`)
    if (!click) return check(`${label}: computer-click arrived`, false, 'none within 3 s')
    const { at, width, height } = click.push
    const session = space ? [(at[0] * space.w) / width, (at[1] * space.h) / height] : [NaN, NaN]
    const f = pingFrame
    const inside = !!f && session[0] >= f.x - 1 && session[0] <= f.x + f.w + 1 && session[1] >= f.y - 1 && session[1] <= f.y + f.h + 1
    report.clicks.push({ at, width, height, session: session.map((n) => Math.round(n * 10) / 10), button: f ? `@${f.x},${f.y} ${f.w}×${f.h}` : '' })
    check(`${label}: computer-click arrived (${click.at - sent} ms) and lies in Ping's frame`, inside, `at ${at.join(',')} of ${width}×${height} → session ${session.map((n) => n.toFixed(1)).join(',')}; Ping @${f?.x},${f?.y} ${f?.w}×${f?.h}`)
  }
  await clickOnce('first click')
  const label = (await svc.request('state.get', { session: geoSession, app: { pid: probePid }, window: { title: APP }, mode: 'full', screenshot: 'never' })).text
  check('the label reads pong', label.includes('"pong"'))
  // A click that changes nothing (pong stays pong) on a still window, TC Probe's tick paused, so the
  // stream has nothing to send: the click must still come, with no frame after it.
  process.kill(probePid, 'SIGUSR1')
  let still = false
  for (const until = Date.now() + 6_000; !still && Date.now() < until; await sleep(100)) still = Date.now() - (sourceFrames.at(-1) ?? 0) >= 1_200
  const clickedAt = Date.now()
  await clickOnce('second click, nothing changes')
  await sleep(1_500)
  const after = sourceFrames.filter((t) => t >= clickedAt).length
  check('no frame came from the service after it', still && after === 0 ? true : 'inconclusive', still ? `${after} frames in the 1.5 s after the click` : 'the window never went still')
  process.kill(probePid, 'SIGUSR1')

  // ── stop ──────────────────────────────────────────────────────────────
  const stopsBefore = report.requests.filter((m) => m === 'capture.stream.stop').length
  await previews.stop(connection, answer.preview)
  const stopsAfter = report.requests.filter((m) => m === 'capture.stream.stop').length
  const atStop = got.frames.length
  await sleep(1_500)
  check('stopped: capture.stream.stop went to the service', stopsAfter > stopsBefore, `${stopsAfter - stopsBefore} stop`)
  check('stopped: no frame after', got.frames.length === atStop, `${got.frames.length - atStop} after`)
  check('no ended push while the session lived', !got.states.some((s) => s.state === 'ended'), got.states.map((s) => `${s.state}${s.reason ? ` ${s.reason}` : ''}`).join(', '))

  } else {
    skipCheck('preview frames and click picture coordinates', 'Screen Recording is off')
    const read = await sessions.run(ctx, 'computer_observe', policy.observeArgs({ app: APP, window: APP, full: true }))
    const ping = parseObservation(read.body ?? '').lines.find((l) => l.type === 'element' && l.role === 'button' && /Ping/.test(l.name ?? ''))
    if (!ping || ping.type !== 'element') throw new Error('TC Probe has no Ping button')
    const before = report.tiers.length
    const clicked = await sessions.run(ctx, 'computer_act', policy.observeArgs({ app: APP, window: APP, action: 'left_click', element: ping.index }))
    check('Ping ran at ax without a picture', !clicked.isError && report.tiers.slice(before).some((t) => t.tier === 'ax'))
    const label = await sessions.run(ctx, 'computer_observe', policy.observeArgs({ app: APP, window: APP, full: true }))
    check('the label reads pong', (label.body ?? '').includes('\"pong\"'))
  }

  if (policy.escapeWatch) {
  // ── 4. the escape watch ───────────────────────────────────────────────
  console.log('\n[4] escape.watch: the lease, off, and the hold')
  const servicePid = svc.state().pid ?? 0
  const traceSize = (): number => readFileSync(TRACE).length
  const traceSince = (from: number): string => readFileSync(TRACE).subarray(from).toString('utf8')
  let mark = traceSize()
  const watched = await svc.request('escape.watch', { on: true, leaseMs: 1_000 })
  const onAt = Date.now()
  const tapsOn = taps(servicePid)
  check('escape.watch { on: true, leaseMs: 1000 } answered {}', JSON.stringify(watched) === '{}', JSON.stringify(watched))
  check('the service holds one enabled event tap', tapsOn.taps === 1 && tapsOn.enabled === 1, JSON.stringify(tapsOn))
  const traced = traceSince(mark)
  check('the trace shows the watch going on', /→ .*"escape\.watch".*"on":true/.test(traced) && /← .*"result":\{\}/.test(traced))
  let endedAt = 0
  for (const until = Date.now() + 4_000; Date.now() < until; ) {
    if (/escape watch ended: the host stopped renewing it/.test(traceSince(mark)) && taps(servicePid).taps === 0) {
      endedAt = Date.now()
      break
    }
    await sleep(50)
  }
  check('unrenewed, it ended within ~2 s (trace line, tap gone)', endedAt > 0 && endedAt - onAt <= 2_200, endedAt ? `${endedAt - onAt} ms after on` : 'still on after 4 s')

  mark = traceSize()
  await svc.request('escape.watch', { on: true, leaseMs: 5_000 })
  const freshOn = taps(servicePid)
  const off = await svc.request('escape.watch', { on: false })
  const freshOff = taps(servicePid)
  await sleep(5_500)
  check('on: false ended a fresh one at once', freshOn.taps === 1 && freshOff.taps === 0 && JSON.stringify(off) === '{}' && !/escape watch ended/.test(traceSince(mark)), `on ${JSON.stringify(freshOn)}, off ${JSON.stringify(freshOff)}; no lease line after`)

  holds.holder({ thread: null })
  for (const until = Date.now() + 3_000; !banner.show.includes(true) && Date.now() < until; ) await sleep(25)
  const heldTaps = taps(servicePid)
  check('a hold shows the banner, then Esc once the watch answered', banner.show[0] === false && banner.show.includes(true) && heldTaps.taps === 1, `show ${JSON.stringify(banner.show)}, taps ${JSON.stringify(heldTaps)}`)
  const released = Date.now()
  holds.holder(null)
  for (const until = Date.now() + HOLD_LINGER_MS + 2_000; !banner.hide && Date.now() < until; ) await sleep(25)
  await sleep(300)
  const afterHold = taps(servicePid)
  check('released, it hides after its linger and the tap goes', banner.hide === 1 && Date.now() - released >= HOLD_LINGER_MS && afterHold.taps === 0, `hid after ${Date.now() - released} ms, taps ${JSON.stringify(afterHold)}`)

  } else skipCheck('escape.watch and SessionHolds', "takes the person's Escape: hand run")

  // ── 5. the person ─────────────────────────────────────────────────────
  const app1 = frontmost()
  const p1 = pointer()
  const same = app0.pid === app1.pid && Math.abs(p0.x - p1.x) < 0.5 && Math.abs(p0.y - p1.y) < 0.5
  const personActive = Date.now() - idleSeconds() * 1_000 > start
  check(
    "the person's frontmost app and pointer stayed put",
    same ? true : personActive ? 'inconclusive' : false,
    same ? '' : `app ${app0.pid} → ${app1.pid}, pointer ${p0.x},${p0.y} → ${p1.x},${p1.y}${personActive ? '; the person used the Mac meanwhile' : ''}`
  )
}

process.once('exit', () => {
  cleanupProbeApp(probeBuild, probePid)
  const pid = service?.state().pid
  if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  watch.stop()
  void cleanup().finally(() => process.exit(1))
})

const running = run()
try {
  await Promise.race([running, watch.lost])
} catch (e) {
  if (e instanceof ScreenLost) check('the run', 'inconclusive', e.message)
  else check('the run finished', false, ((e as Error).stack ?? String(e)).split('\n').slice(0, 4).join(' '))
}
// A lost screen ends the race at once; the run unwinds at its next nap before the cleanup, 20 s at most.
await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))])
watch.stop()
await cleanup()
const failed = report.checks.filter((c) => c.outcome === 'failed').length
const voided = report.checks.filter((c) => c.outcome === 'inconclusive').length
console.log(`\n${report.checks.length - failed - voided} passed, ${failed} failed, ${voided} inconclusive; report ${REPORT}`)
process.exit(failed ? 1 : voided ? 2 : 0)
