/**
 * The front guard against the real apps (docs/computer-protocol.md §23.9), a hand run on the Mac:
 * `bun run script:measure-front-guard`. For TextEdit (launch; open a scratch .txt; File › New over
 * AX), Chrome on a scratch profile (open a local file: page), Finder (open a scratch folder),
 * Calculator (launch) and IntelliJ (launch; open a scratch project folder) it records the time to
 * the service's answer, whether the app came forward by the service's word and by an independent
 * frontmost sample every 20 ms (`computer-proof-probe frontwatch`), how the guard ended it and in
 * how long, whether the pointer moved, and every other window of the app before and after.
 *
 * It starts only after five minutes with no input on an unlocked screen and stops at the person's
 * first input: that case is void and nothing after it runs. An app already running is the
 * person's and is skipped (its documents are theirs), unless `--running` asks for it; Chrome's
 * launch is always the script's own `open -n -g` with a scratch `--user-data-dir`, so the open
 * that follows goes into the scratch profile alone. Every app the script started is ended after
 * its case. `TC_PROOF_UNGATED=1` drops the idle wait for a run the person sits beside.
 *
 * Writes /tmp/tc-front-guard/report.md and report.json.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { COMPUTER_WAIT, SERVICE, type AppInfo, type ComputerNotification, type FrontReport, type LaunchedWindow } from '../../src/shared/computer/protocol'
import { parseObservation } from '../../src/shared/computer/observation'
import { ComputerService } from '../../src/main/server/computer/service'
import { COMPUTER_PROOF_ENV } from '../lib/computerProofProcesses'
import { waitForComputerProof } from '../lib/computerProofGate'
import { buildTcComputer, builtBinary } from '../lib/tcComputerBuild'
import { changedWindows, observeFront, reportTable, type CaseRow, type FrontSample } from '../lib/frontGuardMeasure'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = '/tmp/tc-front-guard'
const PROBE = join(WORK, 'computer-proof-probe')
const SESSION = 'front-guard-measure'
const UNGATED = process.env.TC_PROOF_UNGATED === '1'
const RUNNING = process.argv.includes('--running')
const IDLE_S = UNGATED ? 0 : 300
const WAIT_LIMIT_MS = 90 * 60_000
/** after the answer, how long the samples keep watching; a late steal may come up to the guard's watch */
const SETTLE_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const probe = <T>(...args: string[]): T => JSON.parse(execFileSync(PROBE, args, { encoding: 'utf8', timeout: 10_000 })) as T
const idleSeconds = (): number => probe<{ seconds: number }>('idle').seconds
const pointer = (): { x: number; y: number } => probe('pointer')

/** The person, through the probe: their input since `at` voids the case. */
class Person {
  touched = false
  private timer: NodeJS.Timeout | null = null
  watch(since: number): void {
    this.touched = false
    this.timer = setInterval(() => {
      if (!UNGATED && idleSeconds() * 1_000 < Date.now() - since) this.touched = true
    }, 500)
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** The frontmost samples, every 20 ms, for the whole run. */
function watchFront(): { samples: FrontSample[]; child: ChildProcess } {
  const samples: FrontSample[] = []
  const child = spawn(PROBE, ['frontwatch', '--every', '20'], { stdio: ['ignore', 'pipe', 'inherit'] })
  createInterface({ input: child.stdout! }).on('line', (line) => samples.push(JSON.parse(line) as FrontSample))
  return { samples, child }
}

interface Case {
  app: string
  action: string
  /** the app as apps.launch names it */
  launch: string
  /** the bundle id that says whether the person runs it */
  bundleId: string
  open?: () => string[]
  /** before the call: the script's own launch (Chrome's scratch profile) */
  prepare?: () => Promise<void>
  /** File › New over AX instead of a launch */
  menuNew?: boolean
  /** IntelliJ's project window opens past launchWindowMs: wait out the guard's watch for a late steal */
  settleMs?: number
}

const scratch = (name: string, text = 'front guard measurement\n'): string => {
  const path = join(WORK, name)
  writeFileSync(path, text)
  return path
}

const CASES: Case[] = [
  { app: 'TextEdit', action: 'launch', launch: 'TextEdit', bundleId: 'com.apple.TextEdit' },
  { app: 'TextEdit', action: 'open a scratch .txt', launch: 'TextEdit', bundleId: 'com.apple.TextEdit', open: () => [scratch('probe.txt')] },
  { app: 'TextEdit', action: 'File › New over AX', launch: 'TextEdit', bundleId: 'com.apple.TextEdit', menuNew: true },
  {
    app: 'Google Chrome',
    action: 'open a local file: page in a scratch profile',
    launch: 'Google Chrome',
    bundleId: 'com.google.Chrome',
    prepare: async () => {
      execFileSync('open', ['-n', '-g', '-a', 'Google Chrome', '--args', `--user-data-dir=${join(WORK, 'chrome')}`, '--no-first-run', '--no-default-browser-check'])
      await sleep(4_000)
    },
    open: () => [`file://${scratch('page.html', '<!doctype html><title>front guard page</title><p>front guard measurement</p>')}`]
  },
  {
    app: 'Finder',
    action: 'open a scratch folder',
    launch: 'Finder',
    bundleId: 'com.apple.finder',
    open: () => {
      const dir = join(WORK, 'folder')
      mkdirSync(dir, { recursive: true })
      return [dir]
    }
  },
  { app: 'Calculator', action: 'launch', launch: 'Calculator', bundleId: 'com.apple.calculator' },
  {
    app: 'IntelliJ IDEA',
    action: 'open a scratch project folder',
    launch: 'IntelliJ IDEA',
    bundleId: 'com.jetbrains.intellij',
    settleMs: SERVICE.frontWatchMs + 1_000,
    open: () => {
      const dir = join(WORK, 'project')
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src/Main.java'), 'class Main {}\n')
      return [dir]
    }
  }
]

const windowsOf = (apps: AppInfo[], pid: number): LaunchedWindow[] =>
  (apps.find((a) => a.pid === pid)?.windows ?? []).map((w) => ({ id: w.id, title: w.title }))

/**
 * A case runs on the script's own copy of an app; a copy the person ran when the script started is
 * theirs, and its documents with it, so it is skipped unless `--running` asks for it. Finder always
 * runs, and opening a scratch folder is all its case does. Chrome's case opens into the scratch
 * profile the script started, so the person's Chrome skips it whatever `--running` says.
 */
function skipWhy(c: Case, theirs: ReadonlySet<string>, running: AppInfo | undefined): string | null {
  if (c.bundleId === 'com.apple.finder') return null
  if (theirs.has(c.bundleId) && (c.prepare || !RUNNING)) return `the person's ${c.app} is running${c.prepare ? '' : ' (--running includes it)'}`
  if (c.menuNew && !running) return `${c.app} is not running`
  return null
}

async function runCase(svc: ComputerService, c: Case, theirs: ReadonlySet<string>, front: { samples: FrontSample[] }, notes: ComputerNotification[], person: Person): Promise<CaseRow> {
  const base = { app: c.app, action: c.action }
  const running = (await svc.request('apps.list', {})).apps.find((a) => a.bundleId === c.bundleId)
  const why = skipWhy(c, theirs, running)
  if (why) return { ...base, outcome: 'skipped', why }
  if (c.prepare) await c.prepare()

  const personPid = probe<{ pid: number }>('frontmost').pid
  const at = Date.now()
  person.watch(at)
  const pointerBefore = pointer()
  const listed = (await svc.request('apps.list', { windows: true })).apps
  const pidBefore = listed.find((a) => a.bundleId === c.bundleId)?.pid
  const windowsBefore = pidBefore ? windowsOf(listed, pidBefore) : []
  const notesFrom = notes.length
  let pid = pidBefore ?? 0
  let reported: FrontReport | undefined
  let window: LaunchedWindow | undefined
  let others: LaunchedWindow[] | undefined
  const t0 = performance.now()
  if (c.menuNew) {
    const target = { session: SESSION, app: { pid } }
    const read = await svc.request('state.get', { ...target, mode: 'full', menus: true, screenshot: 'never', wait: COMPUTER_WAIT.observe })
    const item = parseObservation(read.text).lines.find((l) => l.type === 'element' && l.role === 'menu item' && l.name === 'New')
    if (!item) return { ...base, outcome: 'failed', why: 'no File › New menu item in the read' }
    if (item.type !== 'element') return { ...base, outcome: 'failed', why: 'no File › New menu item in the read' }
    const r = await svc.request('action.run', { ...target, epoch: read.epoch, action: { action: 'left_click', element: item.index }, tiers: ['ax'], wait: COMPUTER_WAIT.action })
    reported = r.front
  } else {
    const r = await svc.request('apps.launch', { app: c.launch, session: SESSION, ...(c.open ? { open: c.open() } : {}) }, { timeoutMs: 60_000 })
    pid = r.pid
    reported = r.front
    window = r.window
    others = r.others
  }
  const answerMs = Math.round(performance.now() - t0)
  await sleep(c.settleMs ?? SETTLE_MS)
  const late = notes.slice(notesFrom).find((n) => n.method === 'apps/frontRestored' && n.params.pid === pid)
  const lateFront = late?.method === 'apps/frontRestored' ? late.params.front : undefined
  const end = Date.now()
  person.stop()
  if (person.touched) return { ...base, outcome: 'void', why: 'the person used the Mac during the case' }
  const pointerAfter = pointer()
  const windowsAfter = windowsOf((await svc.request('apps.list', { windows: true })).apps, pid)
  return {
    ...base,
    outcome: 'ran',
    answerMs,
    front: reported?.raised ? reported : (lateFront ?? reported),
    late: !reported?.raised && !!lateFront,
    observed: observeFront(front.samples, personPid, at, end),
    pointerMoved: Math.hypot(pointerAfter.x - pointerBefore.x, pointerAfter.y - pointerBefore.y) >= 0.5,
    ...(window ? { window } : {}),
    ...(others ? { others } : {}),
    changed: changedWindows(windowsBefore, windowsAfter).filter((t) => !window || !t.includes(JSON.stringify(window.title)))
  }
}

/** Ends what the script started since `before`: the apps it launched, and the scratch Chrome. */
function endStarted(before: ReadonlySet<number>, apps: AppInfo[]): void {
  for (const a of apps) if (!before.has(a.pid) && a.bundleId !== 'com.apple.finder') try {
    process.kill(a.pid, 'SIGKILL')
  } catch {
    // gone already
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('the front guard measurement runs on the Mac')
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  await waitForComputerProof(console.log)
  buildTcComputer({ root: ROOT, require: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })

  const deadline = Date.now() + WAIT_LIMIT_MS
  while (probe<{ locked: boolean; asleep: boolean }>('screen').locked || idleSeconds() < IDLE_S) {
    if (Date.now() > deadline) {
      console.log('not run: the Mac never had five quiet minutes')
      return
    }
    await sleep(5_000)
  }

  const svc = new ComputerService({ dataDir: join(WORK, 'data'), bin: () => builtBinary(ROOT), env: { ...process.env, ...COMPUTER_PROOF_ENV } })
  const notes: ComputerNotification[] = []
  svc.onNotification((n) => void notes.push(n))
  const front = watchFront()
  const person = new Person()
  const rows: CaseRow[] = []
  try {
    await svc.request('session.open', { session: SESSION })
    const start = (await svc.request('apps.list', {})).apps
    const theirs = new Set(start.flatMap((a) => (a.bundleId ? [a.bundleId] : [])))
    // an app's cases run on one copy (File › New needs the TextEdit the cases before it opened): it ends after its last
    let before = new Set(start.map((a) => a.pid))
    for (const [i, c] of CASES.entries()) {
      let row: CaseRow
      try {
        row = await runCase(svc, c, theirs, front, notes, person)
      } catch (e) {
        person.stop()
        row = { app: c.app, action: c.action, outcome: 'failed', why: (e as Error).message }
      }
      rows.push(row)
      console.log(`${c.app}, ${c.action}: ${row.outcome}${row.why ? ` (${row.why})` : ''}`)
      if (row.outcome === 'void' || CASES[i + 1]?.app !== c.app) {
        const now = (await svc.request('apps.list', {})).apps
        endStarted(before, now)
        before = new Set(now.filter((a) => before.has(a.pid)).map((a) => a.pid))
      }
      if (row.outcome === 'void') break
    }
  } finally {
    person.stop()
    front.child.kill()
    await svc.close()
  }
  const md = `# The front guard against the real apps\n\n${new Date().toISOString()}${UNGATED ? ', ungated' : ''}\n\n${reportTable(rows)}\n`
  writeFileSync(join(WORK, 'report.md'), md)
  writeFileSync(join(WORK, 'report.json'), JSON.stringify({ at: new Date().toISOString(), ungated: UNGATED, rows }, null, 2))
  console.log(`\n${md}\nreport: ${join(WORK, 'report.md')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
