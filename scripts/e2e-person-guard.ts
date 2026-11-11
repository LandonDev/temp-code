/**
 * Hand proof of docs/computer-protocol.md §14.9. Run with a person at an unlocked Mac:
 *   bun run script:e2e-person-guard
 * Never run in the gate or unattended. No build of tc-computer: use resources/native/tc-computer.
 * The real action.run/action.batch shell brackets callBegan/callEnded; this host restores on
 * session/interrupted (and after a normal answer). Real keys only, no synthetic typist.
 * Reports and trace stay in /tmp/tc-person-guard; scratch documents are unsaved and never opened
 * from files, so they add no Open Recent entry. Their first and last lines carry the run marker,
 * as in scripts/mac/input-proof.sh and Sources/tc-input-proof/Legs.swift.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { ComputerConnection } from '../src/main/server/computer/connection'
import { parseObservation } from '../src/shared/computer/observation'
import type { ComputerAction, ComputerNotification, SessionRestore, StepResult } from '../src/shared/computer/protocol'
import { readMacScreen } from './lib/macScreen'
import { otherProof } from './lib/proofOrder'
import { COMPUTER_PROOF_ENV, stopProofPids, sweepComputerProofProcesses } from './lib/computerProofProcesses'
import { repoRoot } from './lib/repoRoot'

if (process.platform !== 'darwin') throw new Error('This hand proof needs macOS and a person at the keys.')
if (process.argv.includes('--gate') || !process.stdin.isTTY || !process.stdout.isTTY)
  throw new Error('Run by hand in a terminal, with a person at the Mac; never in the gate.')

const ROOT = repoRoot()
const WORK = '/tmp/tc-person-guard'
const SCRATCH = join(WORK, 'work')
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(SCRATCH, 'computer-proof-probe')
const AX = join(SCRATCH, 'ax')
const MARK = `tc-person-guard-${randomUUID()}`
const HEAD = `${MARK}\n`, TAIL = `\n${MARK}`
const SESSION = 'person-guard'
const NO_WAIT = { minMs: 0, quietMs: 0, maxMs: 0, busyMaxMs: 0 }
const GAP = { minMs: 4_000, quietMs: 0, maxMs: 4_000, busyMaxMs: 4_000 }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const execAsync = promisify(execFile)
const report = {
  startedAt: new Date().toISOString(), finishedAt: '', marker: MARK,
  legs: [] as Leg[], cleanup: [] as string[], stopped: null as string | null
}
interface Snapshot { text: string; selection: [number, number]; front: number }
interface Leg {
  name: string
  checks: { name: string; passed: boolean; detail?: unknown }[]
  notices: { at: number; notification: ComputerNotification }[]
  restore?: SessionRestore
  restoreStartedAt?: number
  restoreEndedAt?: number
  firstKeyAt?: number
  keyToNoticeMs?: number
  noticeToRestoreEndMs?: number
  hidIdleAfterKeyMs?: number
  rearmed: number | null
  secureInputAtArm: boolean | null
  trace: string[]
  data: Record<string, unknown>
}
let leg: Leg | undefined
let conn: ComputerConnection | undefined
let restore: Promise<SessionRestore> | undefined
let restoreInterrupted = false
let sentinel: ChildProcess | undefined
const children: ChildProcess[] = []
const trace: string[] = []
const autosave = join(homedir(), 'Library/Containers/com.apple.TextEdit/Data/Library/Autosave Information')
const listAutosaves = (): string[] => existsSync(autosave) ? readdirSync(autosave) : []
let autosavesBefore = new Set<string>()
let savedBoard = false
let personFront = 0
let cleaning = false
let A = 0, B = 0

function check(name: string, passed: boolean, detail?: unknown): void {
  if (!leg) throw new Error('No proof leg')
  leg.checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) })
  console.log(`${passed ? 'PASS' : 'FAIL'} [${leg.name}] ${name}`)
}
async function until<T>(read: () => T | null | Promise<T | null>, what: string, ms = 12_000): Promise<T> {
  const end = Date.now() + ms
  do {
    const value = await read()
    if (value !== null) return value
    await sleep(40)
  } while (Date.now() < end)
  throw new Error(`No ${what} within ${ms} ms`)
}
const probe = <T>(...args: string[]): T => JSON.parse(execFileSync(PROBE, args, { encoding: 'utf8', timeout: 10_000 })) as T
const ax = (pid: number, command = 'read', value = '', caret = HEAD.length): Snapshot =>
  JSON.parse(execFileSync(AX, [String(pid), command, value, String(caret)], { encoding: 'utf8', timeout: 3_000 })) as Snapshot
const body = (s: Snapshot): string => {
  if (!s.text.startsWith(HEAD) || !s.text.endsWith(TAIL)) throw new Error('A scratch marker was changed; stop typing at the cue.')
  return s.text.slice(HEAD.length, -TAIL.length)
}
function save(): void {
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(WORK, 'report.md'), [
    '# Person guard hand proof', '', `${report.startedAt} → ${report.finishedAt}`,
    ...(report.stopped ? ['', `Stopped: ${report.stopped}`] : []),
    ...report.legs.flatMap(l => ['', `## ${l.name}`, '',
      ...l.checks.map(c => `- ${c.passed ? 'PASS' : 'FAIL'}: ${c.name}${c.detail === undefined ? '' : ` — ${JSON.stringify(c.detail)}`}`),
      '', `Guard: ${JSON.stringify(l.restore?.personGuard ?? null)}; rearmed: ${l.rearmed}; secure input at arm: ${l.secureInputAtArm ?? 'not recorded by trace'}.`,
      `Key → notice: ${l.keyToNoticeMs ?? 'unmeasured'} ms; notice → restore end: ${l.noticeToRestoreEndMs ?? 'unmeasured'} ms; HID idle after first key: ${l.hidIdleAfterKeyMs ?? 'unmeasured'} ms.`,
      '', `Evidence: ${JSON.stringify(l.data)}`]), '', '## Cleanup', '', ...report.cleanup.map(s => `- ${s}`), ''
  ].join('\n'))
}
async function cleanup(): Promise<void> {
  if (cleaning) return
  cleaning = true
  sentinel?.kill()
  await conn?.shutdown().catch(e => report.cleanup.push(`Service shutdown: ${String(e)}`))
  // A failed crash leg must still release the key that the dead process left down.
  const ledger = join(SCRATCH, 'data/held.json')
  if (existsSync(ledger)) {
    try {
      const entries = JSON.parse(readFileSync(ledger, 'utf8')) as unknown[]
      if (entries.length) {
        conn = await start()
        await conn.shutdown()
        report.cleanup.push('A recovery initialize released input left by the crash')
      }
    } catch (e) { report.cleanup.push(`Held-input cleanup FAILED: ${String(e)}`); process.exitCode = 1 }
  }
  stopProofPids(children.flatMap(c => c.pid ? [c.pid] : []))
  // Never clear TextEdit's whole autosave folder or recent list: only new entries with this marker.
  for (const name of listAutosaves()) {
    if (autosavesBefore.has(name)) continue
    const path = join(autosave, name)
    try {
      if (hasMarker(path)) { rmSync(path, { recursive: true, force: true }); report.cleanup.push(`Removed marked autosave ${name}`) }
    } catch (e) { report.cleanup.push(`Autosave cleanup FAILED for ${name}: ${String(e)}`); process.exitCode = 1 }
  }
  if (savedBoard) {
    try { probe('pasteboard', 'restore', join(SCRATCH, 'pasteboard.json')); report.cleanup.push('Restored the pasteboard') }
    catch (e) { report.cleanup.push(`Pasteboard restore FAILED: ${String(e)}`); process.exitCode = 1 }
  }
  if (personFront) {
    try { ax(personFront, 'activate'); report.cleanup.push('Restored the original front app') }
    catch (e) { report.cleanup.push(`Front app restore failed: ${String(e)}`) }
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  report.cleanup.push('Ended scratch processes and removed scratch data; no document was opened or saved')
  save()
}
function hasMarker(path: string): boolean {
  try { execFileSync('/usr/bin/grep', ['-r', '-l', '-F', MARK, path], { stdio: 'pipe' }); return true }
  catch (e) {
    if ((e as { status?: number }).status !== 1) throw e
    return false
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  report.stopped = signal
  void cleanup().finally(() => process.exit(1))
})

/** The connection uses the same checked stdio frames as e2e-tc-computer's private Service. */
async function start(): Promise<ComputerConnection> {
  const service = await ComputerConnection.start({
    bin: BIN, dataDir: join(SCRATCH, 'data'),
    env: { ...process.env, ...COMPUTER_PROOF_ENV, TEMP_CODE_COMPUTER_TRACE: '1' }, trace: true,
    log: line => { trace.push(line); appendFileSync(join(WORK, 'trace.log'), line + '\n') }
  })
  if (!service.init.permissions.accessibility) throw new Error('Accessibility is off for the built service')
  service.onNotification(n => {
    if (!leg) return
    leg.notices.push({ at: Date.now(), notification: n })
    if (n.method === 'session/interrupted' && n.params.session === SESSION) void restoreNow(true).catch(() => {})
    // The real host restores on Escape too. Its timestamp cuts off replay after Escape.
    if (n.method === 'escape/pressed') void restoreNow(true).catch(() => {})
  })
  await service.request('session.open', { session: SESSION })
  return service
}
function restoreNow(afterInterrupt: boolean): Promise<SessionRestore> {
  const current = leg
  if (!conn || !current) return Promise.reject(new Error('No active leg/service'))
  restoreInterrupted ||= afterInterrupt
  if (!restore) {
    const service = conn
    restore = (async () => {
      // Give a real hand time to enter a chord/click and its trailing letters in the drop
      // window. This is a test host delay, below the 2 s fail-open bound, not a timing sample.
      const delay = current.data.restoreDelayMs
      if (typeof delay === 'number') await sleep(delay)
      current.restoreStartedAt = Date.now()
      return service.request('input.restoreSession', { afterInterrupt: restoreInterrupted })
    })().then(r => {
      current.restore = r
      current.restoreEndedAt = Date.now()
      current.rearmed = r.personGuard?.rearmed ?? null
      const notice = current.notices.find(n => n.notification.method === 'session/interrupted' || n.notification.method === 'escape/pressed')
      if (notice) {
        current.noticeToRestoreEndMs = current.restoreEndedAt - notice.at
        if (current.firstKeyAt !== undefined) current.keyToNoticeMs = notice.at - current.firstKeyAt
      }
      return r
    })
  }
  return restore
}

/** Head-insert listen-only sentinel precedes the tail-appended guard; never posts input. */
async function armKeyClock(): Promise<void> {
  sentinel?.kill()
  const current = leg!
  const child = sentinel = spawn(PROBE, ['sentinel', '--allow-marks', 'tccp,tcpr'], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let ready = false
  createInterface({ input: child.stdout! }).on('line', line => {
    const event = JSON.parse(line) as { armed?: boolean; person?: boolean; type?: number; at: number }
    if (event.armed) ready = true
    if (!event.person || event.type !== 10) return // keyDown, not an autoread's pointer echo
    current.firstKeyAt = event.at
    void execAsync('ioreg', ['-c', 'IOHIDSystem']).then(({ stdout }) => {
      const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)
      if (match) current.hidIdleAfterKeyMs = Number(match[1]) / 1e6
    }).catch(() => {})
  })
  await until(() => ready ? true : null, 'the key clock', 3_000)
}
async function countdown(instruction: string): Promise<void> {
  const screen = readMacScreen(SCRATCH)
  if (!screen || screen.locked || screen.asleep) throw new Error('The screen is locked, dark or unreadable')
  console.log(`\n[${leg!.name}] After GO: ${instruction}`)
  console.log('Keep the pointer still unless this leg asks you to move it. Stop at the STOP cue.')
  for (let n = 3; n; n--) { console.log(n); await sleep(1_000) }
  console.log('GO')
}
async function prepare(b = '', caret = HEAD.length): Promise<void> {
  await conn!.request('escape.watch', { on: false })
  ax(A, 'reset', HEAD + 'Agent scratch: unchanged' + TAIL, HEAD.length + 5)
  ax(B, 'reset', HEAD + b + TAIL, caret)
  ax(B, 'activate')
  await until(() => ax(B).front === B ? true : null, 'B in front')
  restore = undefined
  restoreInterrupted = false
}
async function target(): Promise<{ session: string; app: { pid: number }; epoch: string; element: number }> {
  const obs = await conn!.request('state.get', { session: SESSION, app: { pid: A }, mode: 'full', screenshot: 'never', wait: NO_WAIT })
  const area = parseObservation(obs.text).lines.find(l => l.type === 'element' && l.role === 'text area')
  if (!area || area.type !== 'element') throw new Error('A has no AX text area')
  return { session: SESSION, app: { pid: A }, epoch: obs.epoch, element: area.index }
}
async function hold(personIdleMs: number): Promise<StepResult> {
  const { element: _element, ...t } = await target()
  const r = await conn!.request('action.run', {
    ...t, tiers: ['session'], personIdleMs, action: { action: 'hold_key', text: 'shift', duration: 8 },
    wait: NO_WAIT, observe: { mode: 'none' }
  })
  await restoreNow(leg!.notices.some(n => n.notification.method === 'session/interrupted' || n.notification.method === 'escape/pressed'))
  if (r.step.status === 'ok' || interrupted(r.step)) leg!.data.sessionArmed = true
  return r.step
}
const interrupted = (s: StepResult): boolean => s.status === 'failed' && s.error.kind === 'interrupted'
function common(beforeA: Snapshot): void {
  const a = ax(A), b = ax(B)
  check('A text stayed unchanged (AX)', a.text === beforeA.text, a)
  check('B is in front', b.front === B, b.front)
  const guard = leg!.restore?.personGuard
  check('the restore reported an active guard', guard?.mode === 'active', guard)
  check('the guard needed no rearm', guard?.rearmed === 0, guard?.rearmed)
  leg!.data.afterA = a
  leg!.data.afterB = b
}
async function runLeg(name: string, fn: () => Promise<void>): Promise<void> {
  leg = { name, checks: [], notices: [], rearmed: null, secureInputAtArm: null, trace: [], data: {} }
  report.legs.push(leg)
  const from = trace.length
  try { await fn() }
  catch (error) { check('leg completed', false, String(error)) }
  finally {
    sentinel?.kill()
    if (conn?.alive) await restoreNow(true).catch(e => check('restored after the leg', false, String(e)))
    const notice = leg.notices.find(n => n.notification.method === 'session/interrupted' || n.notification.method === 'escape/pressed')
    if (notice && leg.firstKeyAt !== undefined) leg.keyToNoticeMs = notice.at - leg.firstKeyAt
    leg.trace = trace.slice(from).filter(s => /guard|secure.?input|session.*arm/i.test(s))
    leg.data.traceStartedAt = from
    // §14.9 promises a trace when secure input is on at arm. Missing arm evidence stays unknown.
    const arm = leg.trace.find(s => /secure.?input/i.test(s) && /arm|guard/i.test(s))
    if (arm) leg.secureInputAtArm = /secure.?input[=: ]+(?:on|true|1)\b/i.test(arm)
    else if (leg.trace.some(s => /secure input on/i.test(s))) leg.secureInputAtArm = true
    else if (leg.restore?.personGuard || leg.data.sessionArmed === true) leg.secureInputAtArm = false
    save()
    leg = undefined
    restore = undefined
    restoreInterrupted = false
  }
}

// The service's app slot is held during a long action. These scratch-only AX reads must stay
// outside that slot, and use the complete AXValue rather than the observation's cut value.
const AX_SOURCE = String.raw`import AppKit
import ApplicationServices
let a = Array(CommandLine.arguments.dropFirst())
let pid = pid_t(a[0])!
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
func get(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success ? v : nil
}
func find(_ e: AXUIElement, _ depth: Int = 0) -> AXUIElement? {
    if get(e, "AXRole") as? String == "AXTextArea" { return e }
    if depth > 15 { return nil }
    for c in get(e, "AXChildren") as? [AXUIElement] ?? [] { if let t = find(c, depth + 1) { return t } }
    return nil
}
func fail(_ s: String) -> Never { FileHandle.standardError.write(Data(s.utf8)); exit(1) }
if a[1] == "activate" {
    guard NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps]) == true else { fail("activate failed") }
    print("{\"text\":\"\",\"selection\":[0,0],\"front\":\(pid)}"); exit(0)
}
guard let window = (get(app, "AXWindows") as? [AXUIElement])?.first, let text = find(window) else { fail("no scratch text area") }
if a[1] == "reset" {
    guard AXUIElementSetAttributeValue(text, "AXValue" as CFString, a[2] as CFString) == .success else { fail("set text failed") }
    var r = CFRange(location: Int(a[3])!, length: 0)
    guard let v = AXValueCreate(.cfRange, &r), AXUIElementSetAttributeValue(text, "AXSelectedTextRange" as CFString, v) == .success else { fail("set caret failed") }
    guard AXUIElementSetAttributeValue(text, "AXFocused" as CFString, kCFBooleanTrue) == .success else { fail("focus failed") }
}
var range = CFRange()
guard let raw = get(text, "AXSelectedTextRange"), CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cfRange, &range) else { fail("no caret") }
let out: [String: Any] = ["text": get(text, "AXValue") as? String ?? "", "selection": [range.location, range.length], "front": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)]
let data = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data + Data([10]))
`

try {
  // An existing proof and a second hand proof both hold our turn. Add our name locally because
  // this task may edit only this script, the schedule script and package.json.
  for (let other = otherProof(); other; other = otherProof()) {
    console.log(`Waiting for computer proof: ${other}`)
    await sleep(2_000)
  }
  mkdirSync(SCRATCH, { recursive: true })
  const screen = readMacScreen(SCRATCH)
  if (!screen || screen.locked || screen.asleep) throw new Error('Refused: screen is locked, dark or unreadable')
  if (!existsSync(BIN)) throw new Error('Build resources/native/tc-computer before this hand run')
  sweepComputerProofProcesses(line => report.cleanup.push(line))
  autosavesBefore = new Set(listAutosaves())
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  writeFileSync(join(SCRATCH, 'ax.swift'), AX_SOURCE)
  execFileSync('xcrun', ['swiftc', '-O', '-o', AX, join(SCRATCH, 'ax.swift')], { stdio: 'pipe' })
  personFront = probe<{ pid: number }>('frontmost').pid
  probe('pasteboard', 'save', join(SCRATCH, 'pasteboard.json'))
  savedBoard = true
  for (const name of ['A (agent)', 'B (person)']) {
    const child = spawn('/System/Applications/TextEdit.app/Contents/MacOS/TextEdit', [
      '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO',
      '-NSDocumentSaveNewDocumentsToCloud', 'NO', '-NSRecentDocumentsLimit', '0'
    ], { stdio: 'ignore' })
    children.push(child)
    if (!child.pid) throw new Error(`Could not launch ${name}`)
    const pid = child.pid
    await until(() => { try { return ax(pid) } catch { return null } }, `${name}'s untitled document`)
    if (!A) A = pid; else B = pid
    console.log(`${name}: TextEdit pid ${pid}`)
  }
  conn = await start()

  await runLeg('type while typing', async () => {
    await prepare()
    const a = ax(A)
    await countdown('Type "guard guard guard" steadily into B. The hold starts during word two. Finish all three words, then stop.')
    await until(() => body(ax(B)).startsWith('guard g') ? true : null, 'the second word', 20_000)
    const result = await hold(0)
    await until(() => body(ax(B)) === 'guard guard guard' ? true : null, 'three whole words', 8_000)
    console.log('STOP')
    check('the hold answered interrupted', interrupted(result), result)
    common(a)
    check('B has all three words whole', body(ax(B)) === 'guard guard guard', body(ax(B)))
    const g = leg!.restore?.personGuard
    check('every dropped press was replayed', !!g && g.dropped > 0 && g.replayed === g.dropped, g)
  })

  await runLeg('type on return', async () => {
    await prepare()
    const a = ax(A)
    await countdown('Keep still for the next 10 s. When A comes forward, type "guard" once, then stop. Do not move the pointer.')
    await sleep(10_000)
    const idleText = execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' })
    const idle = Number(/"HIDIdleTime"\s*=\s*(\d+)/.exec(idleText)?.[1] ?? 0) / 1e6
    check('ten seconds of hardware quiet before the call', idle >= 10_000, idle)
    await armKeyClock()
    const result = await hold(Math.max(10_000, Math.floor(idle)))
    await sleep(2_000)
    console.log('STOP')
    common(a)
    check('the hold answered interrupted', interrupted(result), result)
    const b = body(ax(B)), g = leg!.restore?.personGuard
    check('B has only a suffix of guard', 'guard'.endsWith(b), b)
    check('no return typing was replayed', g?.replayed === 0, g)
    check('dropped equals the letters missing from B', g?.dropped === 5 - b.length, { g, b })
    check('recorded key → notice and notice → restore end', leg!.keyToNoticeMs !== undefined && leg!.noticeToRestoreEndMs !== undefined)
    check('a dropped hardware key reset HID idle below 2 s', leg!.hidIdleAfterKeyMs !== undefined && leg!.hidIdleAfterKeyMs < 2_000, leg!.hidIdleAfterKeyMs)
  })

  await runLeg('shortcut', async () => {
    await prepare()
    const a = ax(A)
    leg!.data.restoreDelayMs = 750
    await countdown('Type "ready " in B. When A rises, type "ab", Cmd-A, "cd" within 750 ms, then stop. This leg delays restore by 750 ms.')
    await until(() => body(ax(B)) === 'ready ' ? true : null, 'ready in B', 15_000)
    const result = await hold(0)
    check('the hold answered interrupted', interrupted(result), result)
    await sleep(1_000)
    console.log('STOP')
    common(a)
    const b = ax(B)
    check('B gained ab and nothing after the shortcut', body(b) === 'ready ab', b)
    check('Cmd-A did not select B text', b.selection[1] === 0, b.selection)
  })

  await runLeg('click', async () => {
    await prepare()
    const a = ax(A)
    leg!.data.restoreDelayMs = 750
    await countdown('Type "ready " in B. When A rises, click inside A text, then type "xy" within 750 ms and stop. Restore waits 750 ms.')
    await until(() => body(ax(B)) === 'ready ' ? true : null, 'ready in B', 15_000)
    const result = await hold(0)
    check('the hold answered interrupted', interrupted(result), result)
    check('the click was dropped', (leg!.restore?.personGuard?.dropped ?? 0) >= 1)
    await sleep(1_000)
    console.log('STOP')
    common(a)
    check('A selection stayed unchanged', JSON.stringify(ax(A).selection) === JSON.stringify(a.selection), ax(A).selection)
    check('B did not gain xy', !body(ax(B)).includes('xy'), ax(B))
    check('nothing after the click was replayed', leg!.restore?.personGuard?.replayed === 0)
  })

  await runLeg('move first', async () => {
    await prepare()
    const a = ax(A)
    await countdown('When A comes forward, move the pointer. Wait for B, then type "guard" once and stop.')
    const result = await hold(10_000)
    check('pointer movement interrupted the hold', interrupted(result), result)
    await until(() => body(ax(B)) === 'guard' ? true : null, 'guard in B', 8_000)
    console.log('STOP')
    common(a)
    check('B ends with guard', body(ax(B)).endsWith('guard'), ax(B))
    check('pointer motion passed without a dropped event', leg!.restore?.personGuard?.dropped === 0)
  })

  await runLeg('held key', async () => {
    await prepare('0123456789 '.repeat(40))
    const a = ax(A), b = ax(B)
    await countdown('Hold Right Arrow in B NOW, before A rises. Keep holding until B returns, then release it at once.')
    await until(() => ax(B).selection[0] > b.selection[0] ? true : null, 'the held arrow moving B caret')
    const result = await hold(0)
    check('the held arrow interrupted the hold', interrupted(result), result)
    console.log('RELEASE Right Arrow. STOP')
    await sleep(1_000)
    const stopped = ax(B)
    await sleep(1_000)
    const later = ax(B)
    common(a)
    check('B text stayed unchanged', later.text === b.text, later)
    check('B caret moved', stopped.selection[0] > b.selection[0], { before: b.selection, stopped: stopped.selection })
    check('B caret stopped before the end (no stuck key)', stopped.selection[0] < stopped.text.length && JSON.stringify(later.selection) === JSON.stringify(stopped.selection), { stopped, later })
  })

  await runLeg('escape on', async () => {
    await prepare()
    await conn!.request('escape.watch', { on: true })
    const a = ax(A)
    leg!.data.restoreDelayMs = 750
    await countdown('Type "ready " in B. When A rises, type "ab", Escape, "cd" within 750 ms, then stop. Restore waits 750 ms.')
    await until(() => body(ax(B)) === 'ready ' ? true : null, 'ready in B', 15_000)
    await hold(0)
    await sleep(1_000)
    console.log('STOP')
    common(a)
    check('escape/pressed arrived', leg!.notices.some(n => n.notification.method === 'escape/pressed'))
    check('B gained ab and not cd', body(ax(B)) === 'ready ab', ax(B))
    await conn!.request('escape.watch', { on: false })
  })

  await runLeg('escape off', async () => {
    await prepare()
    const a = ax(A)
    await countdown('When A comes forward, press Escape ONCE, then stop. Do not type any letters.')
    const result = await hold(0)
    console.log('STOP')
    common(a)
    check('the hold answered interrupted', interrupted(result), result)
    check('Escape was dropped once and never replayed', leg!.restore?.personGuard?.dropped === 1 && leg!.restore.personGuard.replayed === 0, leg!.restore?.personGuard)
    check('escape/pressed did not arrive with watch off', !leg!.notices.some(n => n.notification.method === 'escape/pressed'))
  })

  await runLeg('closing wait', async () => {
    await prepare()
    const a = ax(A), t = await target()
    await countdown('Type "ready " in B. When A rises, wait 1 s, then type "guard" during the 4 s click wait and stop.')
    await until(() => body(ax(B)) === 'ready ' ? true : null, 'ready in B', 15_000)
    // The wire has no read action inside a batch. A separate AX read during the first
    // click's stepWait proves the read fits that gap; the batch retains one native call token.
    const { element, ...base } = t
    const actions: ComputerAction[] = [{ action: 'left_click', element }, { action: 'left_click', element }]
    const fronts: { pid: number; at: number }[] = []
    const frontwatch = spawn(PROBE, ['frontwatch', '--every', '20'], { stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(frontwatch)
    createInterface({ input: frontwatch.stdout! }).on('line', line => fronts.push(JSON.parse(line)))
    await until(() => fronts.length ? true : null, 'the front watcher', 3_000)
    try {
      const call = conn!.request('action.batch', { ...base, tiers: ['session'], personIdleMs: 0, actions, stepWait: GAP, wait: NO_WAIT, observe: { mode: 'none' } })
      const settled = call.then(value => ({ value }), error => ({ error }))
      await until(() => ax(A).front === A ? true : null, 'A raised for the first click')
      await sleep(500)
      leg!.data.axReadInGap = ax(A)
      const response = await settled
      if ('error' in response) throw response.error
      const result = response.value
      await restoreNow(true)
      await until(() => body(ax(B)) === 'ready guard' ? true : null, 'guard in B', 8_000)
      console.log('STOP')
      common(a)
      check('session/interrupted arrived for this session', leg!.notices.some(n => n.notification.method === 'session/interrupted' && n.notification.params.session === SESSION))
      check('first click used session; the second answered interrupted', result.steps[0]?.status === 'ok' && result.steps[0].tier === 'session' && !!result.steps[1] && interrupted(result.steps[1]), result.steps)
      check('B ends with guard', body(ax(B)).endsWith('guard'), ax(B))
      const firstA = fronts.findIndex(f => f.pid === A)
      const backToB = fronts.findIndex((f, i) => i > firstA && f.pid === B)
      check('A never came forward again after B returned', firstA >= 0 && backToB > firstA && !fronts.slice(backToB + 1).some(f => f.pid === A), fronts)
      leg!.data.frontChanges = fronts
      check('the first click had its 4 s wait', result.steps[0]?.status === 'ok' && (result.steps[0].waited?.waitedMs ?? 0) >= 4_000, result.steps[0])
    } finally { frontwatch.kill() }
  })

  await runLeg('crash', async () => {
    await prepare()
    const a = ax(A), t = await target()
    await countdown('Keep still while A comes forward. At the TYPE x cue, type "x" once into A, then stop.')
    const { element: _element, ...base } = t
    const call = conn!.request('action.run', { ...base, tiers: ['session'], personIdleMs: 0, action: { action: 'hold_key', text: 'shift', duration: 8 }, wait: NO_WAIT, observe: { mode: 'none' } }).catch(e => String(e))
    await until(() => ax(A).front === A ? true : null, 'A raised')
    leg!.data.sessionArmed = true
    // Save arm trace before SIGKILL, which cannot produce a restore report.
    await sleep(300)
    conn!.kill()
    const exit = await conn!.exited
    await call
    console.log('TYPE x once, then STOP. Release Shift if it seems held.')
    try {
      const expectX = a.text.slice(0, a.selection[0]) + 'x' + a.text.slice(a.selection[0] + a.selection[1])
      await until(() => ax(A).text.toLowerCase() === expectX.toLowerCase() ? true : null, 'x reaching A after the service died', 8_000)
      check('SIGKILL ended the service', exit.signal === 'SIGKILL', exit)
      check('x reached A: the tap died with the service', ax(A).text.toLowerCase() === expectX.toLowerCase(), ax(A))
    } finally {
      ax(B, 'activate')
      const oldEpoch = conn!.epoch
      conn = await start()
      // initialize clears the dead writer's ledger; read it as well as the restore reply.
      const fresh = await conn.request('input.restoreSession', {})
      leg!.data.restartInitialize = conn.init
      leg!.data.restartRestore = fresh
      const ledger = join(SCRATCH, 'data/held.json')
      const held = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) as unknown : null
      leg!.data.restartHeldLedger = held
      check('initialize left an empty held-input ledger', Array.isArray(held) && held.length === 0, held)
      check('restart has a fresh epoch', conn.epoch !== oldEpoch, { oldEpoch, epoch: conn.epoch })
      check('restart found nothing left to restore or guard', fresh.frontmost === 'nothing' && fresh.pointer === 'nothing' && fresh.personGuard === undefined, fresh)
      check('restart left B in front', ax(B).front === B)
      leg!.data.rearmedUnavailable = 'SIGKILL has no restore reply; rearmed cannot be read for this leg'
    }
  })
} catch (error) {
  report.stopped = error instanceof Error ? error.stack ?? error.message : String(error)
  process.exitCode = 1
} finally {
  if (report.legs.some(l => l.checks.some(c => !c.passed))) process.exitCode = 1
  await cleanup()
}
console.log(`Report: ${join(WORK, 'report.md')}`)
