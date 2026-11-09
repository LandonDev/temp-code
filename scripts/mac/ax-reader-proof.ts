/**
 * The AX reader's live proof (plan .temp-code/plan-8sO1AAx_glmS.md §7.4), run
 * by scripts/mac/ax-reader-proof.sh with TC_AX_BIN (tc-ax) and TC_AX_RECORDER
 * (the fixture recorder, for one key event posted to a pid) built.
 *
 * The person's rules (2026-11-08): every window is read in the background and
 * never activated (`open -g`, AX reads and AX actions only); each scratch app
 * starts only once the Mac has had no input for TC_AX_IDLE_ANY seconds (30),
 * IntelliJ's scratch project for 120, waiting up to TC_AX_IDLE_WAIT seconds
 * (900) and else "skipped: the person is active"; a launch that brings its app
 * in front ends the run; IntelliJ's licence prompt is avoided (no run when it
 * already shows) or answered only with a button that dismisses it; the
 * scratch project leaves IntelliJ's recent list.
 *
 * Report: /tmp/tc-ax-proof/report.json { checks, timings, findings, skipped };
 * observation text stays in memory and is never written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PAGES = join(ROOT, 'src/main/server/computer/fixtures/page')
const OUT = '/tmp/tc-ax-proof'
const TCAX = process.env.TC_AX_BIN ?? join(ROOT, 'native/tc-computer/.build/release/tc-ax')
const REC = process.env.TC_AX_RECORDER ?? ''
const IDLE_ANY = Number(process.env.TC_AX_IDLE_ANY ?? 30)
const IDLE_IDEA = 120
const IDLE_WAIT = Number(process.env.TC_AX_IDLE_WAIT ?? 900)

type Check = { app: string; name: string; pass: boolean; detail: string }
const checks: Check[] = []
const timings: Record<string, unknown> = {}
const findings: string[] = []
const skipped: Record<string, string> = {}
const allow = new Set<number>()
let stopAll = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sh(cmd: string[], env?: Record<string, string>): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() }
}

function check(app: string, name: string, pass: boolean, detail = ''): boolean {
  checks.push({ app, name, pass, detail })
  console.log(`${pass ? 'pass' : 'FAIL'}  ${app.padEnd(12)} ${name}${detail ? `  (${detail})` : ''}`)
  return pass
}

/** Seconds since the person's last keyboard or pointer input. */
function idleSeconds(): number {
  const m = /"HIDIdleTime" = (\d+)/.exec(sh(['ioreg', '-c', 'IOHIDSystem']).out)
  return m ? Number(m[1]) / 1e9 : 0
}

/** The frontmost app: its name and ASN (`lsappinfo info -only name` prints `"TempCode" ASN:0x0-0x220220: (in front)`), '' when unknown. */
function frontApp(): string {
  const asn = sh(['lsappinfo', 'front']).out.trim()
  if (!asn) return ''
  return `${/^"([^"]*)"/.exec(sh(['lsappinfo', 'info', '-only', 'name', asn]).out)?.[1] ?? '?'} ${asn}`
}

/** Wait until the Mac has had no input for `seconds`; false when the person stays active. */
async function waitIdle(seconds: number, app: string): Promise<boolean> {
  const deadline = Date.now() + IDLE_WAIT * 1000
  while (idleSeconds() < seconds) {
    if (Date.now() > deadline) {
      skipped[app] = 'skipped: the person is active'
      console.log(`skip  ${app.padEnd(12)} skipped: the person is active`)
      return false
    }
    await sleep(5000)
  }
  return true
}

/** After a launch: the person's front app must still be in front. */
function stillBehind(before: string, app: string): boolean {
  const now = frontApp()
  if (now === before && now !== '') return true
  stopAll = `${now} came in front of ${before} after the ${app} launch`
  check(app, 'the launch stayed in the background', false, stopAll)
  return false
}

function pidsOf(exe: string): number[] {
  return sh(['ps', '-axo', 'pid=,comm=']).out.split('\n').flatMap((l) => {
    const m = /^\s*(\d+) (.*)$/.exec(l)
    return m && m[2].endsWith(exe) ? [Number(m[1])] : []
  })
}

async function newPid(exe: string, before: number[], match: (pid: number) => boolean = () => true): Promise<number> {
  for (let i = 0; i < 120; i++) {
    const pid = pidsOf(exe).find((p) => !before.includes(p) && match(p))
    if (pid) return pid
    await sleep(500)
  }
  throw new Error(`no new process running ${exe}`)
}

const axEnv = () => ({ TC_AX_ALLOW_PIDS: [...allow].join(',') })

/** The window titles of an allowed pid. */
function windowsOf(pid: number): { id: number; title: string }[] {
  const r = sh([TCAX, 'windows', '--pid', String(pid)], axEnv())
  try {
    return JSON.parse(r.out) as { id: number; title: string }[]
  } catch {
    return []
  }
}

async function waitWindow(pid: number, title: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!windowsOf(pid).some((w) => w.title === title)) {
    if (Date.now() > deadline) throw new Error(`no window ${JSON.stringify(title)} on pid ${pid}`)
    await sleep(500)
  }
}

type Answer = { ok?: boolean; kind?: string; text?: string; error?: { kind: string; message: string }; [k: string]: unknown }

/** One `tc-ax session`: a JSON line in, a JSON line out. */
class Session {
  private proc
  private buffer = ''
  private reader

  constructor(pid: number, title: string, contains?: string, windowId?: number) {
    const cmd = [TCAX, 'session', '--pid', String(pid), '--expect-title', title, ...(contains ? ['--contains', contains] : []), ...(windowId ? ['--window-id', String(windowId)] : [])]
    this.proc = Bun.spawn(cmd, { env: { ...process.env, ...axEnv() }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    this.reader = this.proc.stdout.getReader()
  }

  async send(line: string, timeoutMs = 30_000): Promise<Answer> {
    this.proc.stdin.write(line + '\n')
    this.proc.stdin.flush()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl >= 0) {
        const out = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        return JSON.parse(out) as Answer
      }
      if (Date.now() > deadline) throw new Error(`no answer to ${line.split(' ')[0]}`)
      const chunk = await this.reader.read()
      if (chunk.done) throw new Error(`tc-ax session ended: ${await new Response(this.proc.stderr).text()}`)
      this.buffer += new TextDecoder().decode(chunk.value)
    }
  }

  observe(opts: Record<string, unknown> = {}): Promise<Answer> {
    return this.send(`observe ${JSON.stringify(opts)}`)
  }

  close(): void {
    try {
      this.proc.stdin.write('quit\n')
      this.proc.stdin.end()
    } catch {}
    this.proc.kill()
  }
}

/** The number on the first line matching `pattern` (`[12] button "close"`). */
function indexOf(text: string | undefined, pattern: RegExp): number {
  for (const line of (text ?? '').split('\n')) {
    const m = /\[(\d+)\] (.*)$/.exec(line)
    if (m && pattern.test(m[2])) return Number(m[1])
  }
  throw new Error(`no line matching ${pattern}`)
}

function bench(app: string, pid: number, title: string, contains?: string, windowId?: number): void {
  const r = sh([TCAX, 'bench', '--pid', String(pid), '--expect-title', title, '--reads', '20', '--warm', '2', '--signature', '50',
                ...(contains ? ['--contains', contains] : []), ...(windowId ? ['--window-id', String(windowId)] : [])], axEnv())
  try {
    timings[app] = JSON.parse(r.out)
    console.log(`time  ${app.padEnd(12)} ${r.out.trim()}`)
  } catch {
    findings.push(`${app}: bench failed: ${r.err.trim().split('\n').pop()}`)
  }
}

const cleanups: (() => Promise<void> | void)[] = []
async function cleanUp(): Promise<void> {
  while (cleanups.length) {
    try {
      await cleanups.pop()!()
    } catch {}
  }
}

// ── TextEdit ─────────────────────────────────────────────────────────────

async function textedit(): Promise<void> {
  const app = 'textedit'
  if (!(await waitIdle(IDLE_ANY, app))) return
  const front = frontApp()
  const exe = 'TextEdit.app/Contents/MacOS/TextEdit'
  const before = pidsOf(exe)
  // a separate instance that restores none of the person's documents (the recorder's flags)
  sh(['open', '-n', '-g', '-a', 'TextEdit', '--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO', '-NSDocumentSaveNewDocumentsToCloud', 'NO'])
  const pid = await newPid(exe, before)
  allow.add(pid)
  cleanups.push(() => discardTextEdit(pid))
  if (!stillBehind(front, app)) return
  const title = 'Untitled'
  await waitWindow(pid, title, 20_000)
  const s = new Session(pid, title)
  cleanups.push(() => s.close())

  const full = await s.observe({ mode: 'full' })
  const area = indexOf(full.text, /^text area/)
  check(app, 'a full read focuses the text area', full.kind === 'full' && new RegExp(`\\[${area}\\] text area[^\\n]* focused`).test(full.text ?? ''), `[${area}]`)
  check(app, 'a second read is unchanged', (await s.observe()).kind === 'unchanged')

  const sig0 = await s.send('signature')
  const last0 = await s.send('last-change')
  await s.send(`poke set-value ${area} ${JSON.stringify('Hello from the proof\nSecond line')}`)
  await sleep(400)
  const sig1 = await s.send('signature')
  const last1 = await s.send('last-change')
  const typed = await s.observe()
  check(app, 'set-value is a ~ line on the same number', typed.kind === 'diff' && (typed.text ?? '').includes(`\n~ [${area}] text area = "Hello from the proof\\nSecond line"`))
  check(app, 'the signature moved', sig1.signature !== sig0.signature, `${sig0.ms} ms, ${sig1.ms} ms`)
  check(app, 'lastChange moved', BigInt(String(last1.lastChange)) > BigInt(String(last0.lastChange)))

  await s.send(`poke select ${area} 0 5`)
  await sleep(200)
  check(app, 'select shows selection 0..5', /selection 0\.\.5/.test((await s.observe()).text ?? ''))

  const menus = await s.observe({ mode: 'full', menus: true })
  check(app, 'with menus the menu bar is read', /\n\[\d+\] menu bar( actions: [^\n]*)?\n/.test(menus.text ?? ''))
  await s.observe({ mode: 'full' })

  // a real key event to the pid marks the document edited, so its close button asks first
  if (REC) {
    sh([REC, 'select-range', '--pid', String(pid), '--title', title, '--role', 'AXTextArea', '--range', '32,0'])
    sh([REC, 'key', '--pid', String(pid), '--key', '1', '--mods', 'shift'])
    await sleep(600)
  }
  const base = await s.observe({ mode: 'full' })
  await s.send(`poke press ${indexOf(base.text, /^button "close"/)}`)
  await sleep(1200)
  const sheet = await s.observe()
  check(app, "the close button's sheet is + in [1]", sheet.kind === 'diff' && /\n\+ in \[1\]:\n  \[\d+\] sheet/.test(sheet.text ?? ''))
  await s.send(`poke press ${indexOf(sheet.text, /^button "Cancel"/)}`)
  await sleep(1000)
  const gone = await s.observe()
  check(app, 'Cancel removes the sheet with its count', /\n- \[\d+\] sheet[^\n]* \(and \d+ inside\)/.test(gone.text ?? ''))

  // a stopped app answers timeout within 2.5 s
  sh(['kill', '-STOP', String(pid)])
  const t0 = Date.now()
  let stopped: Answer
  try {
    stopped = await s.observe({ mode: 'full' })
  } finally {
    sh(['kill', '-CONT', String(pid)])
  }
  const took = Date.now() - t0
  check(app, 'a stopped app answers timeout within 2.5 s', stopped.ok === false && stopped.error?.kind === 'timeout' && took <= 2_500, `${stopped.error?.kind ?? stopped.kind} in ${took} ms`)

  s.close()
  bench(app, pid, title)
}

/** Close the document unsaved through its sheet's Delete, then end the instance. Never Save. */
async function discardTextEdit(pid: number): Promise<void> {
  if (sh(['kill', '-0', String(pid)]).code !== 0) return
  try {
    const s = new Session(pid, 'Untitled')
    const now = await s.observe({ mode: 'full' })
    if (!/button "Delete"/.test(now.text ?? '')) {
      await s.send(`poke press ${indexOf(now.text, /^button "close"/)}`)
      await sleep(1000)
    }
    const sheet = await s.observe({ mode: 'full' })
    if (/button "Delete"/.test(sheet.text ?? '')) await s.send(`poke press ${indexOf(sheet.text, /^button "Delete"/)}`)
    s.close()
    await sleep(500)
  } catch {}
  sh(['kill', String(pid)])
}

// ── Chrome ───────────────────────────────────────────────────────────────

/** A throwaway Chrome on one scratch page; resolves to its pid and title. */
async function chromeOn(page: string, title: string): Promise<number> {
  const profile = '/tmp/tc-ax-chrome'
  rmSync(profile, { recursive: true, force: true })
  const exe = 'Google Chrome.app/Contents/MacOS/Google Chrome'
  const before = pidsOf(exe)
  const front = frontApp()
  sh(['open', '-n', '-g', '-a', 'Google Chrome', '--args', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', '--force-renderer-accessibility', `file://${PAGES}/${page}`])
  const pid = await newPid(exe, before, (p) => sh(['ps', '-o', 'command=', '-p', String(p)]).out.includes(`--user-data-dir=${profile}`))
  allow.add(pid)
  stopChrome = async () => {
    sh(['kill', String(pid)])
    for (let i = 0; i < 20 && sh(['kill', '-0', String(pid)]).code === 0; i++) await sleep(500)
    rmSync(profile, { recursive: true, force: true })
  }
  cleanups.push(stopChrome)
  if (!stillBehind(front, 'chrome')) throw new Error(stopAll)
  await waitWindow(pid, title, 30_000)
  return pid
}

/** The running Chrome's stop, also in `cleanups` until endChrome runs it. */
let stopChrome: (() => Promise<void>) | undefined

/** Stop the Chrome chromeOn started (not the last cleanup, which may be a session's close). */
async function endChrome(): Promise<void> {
  const stop = stopChrome
  if (!stop) return
  stopChrome = undefined
  const i = cleanups.indexOf(stop)
  if (i >= 0) cleanups.splice(i, 1)
  await stop()
}

/** Read until the page's tree has landed (a few seconds after the window). */
async function settled(s: Session, mark: RegExp): Promise<Answer> {
  for (let i = 0; i < 60; i++) {
    const r = await s.observe({ mode: 'full' })
    if (mark.test(r.text ?? '')) return r
    await sleep(500)
  }
  throw new Error(`the page never showed ${mark}`)
}

async function chrome(): Promise<void> {
  const app = 'chrome'
  if (!(await waitIdle(IDLE_ANY, app))) return
  const title = 'Computer fixture form - Google Chrome'
  const pid = await chromeOn('form.html', title)
  const s = new Session(pid, title)
  cleanups.push(() => s.close())
  const first = await settled(s, /button "Load prices"/)
  findings.push(`chrome: AXManualAccessibility ${first.chromium ? 'took' : 'refused'} (--force-renderer-accessibility carries the tree)`)
  check(app, 'the first read is not thin', (first as { stats?: { thin?: boolean } }).stats?.thin === false)

  const name = indexOf(first.text, /^input "Name"/)
  await s.send(`poke set-value ${name} ${JSON.stringify('Ada')}`)
  await sleep(400)
  const typed = await s.observe()
  check(app, 'set-value on an input is a ~ line on its number', (typed.text ?? '').includes(`\n~ [${name}] input "Name" = "Ada"`))

  await s.send(`poke press ${indexOf(typed.kind === 'full' ? typed.text : first.text, /^button "Review order"/)}`)
  await sleep(800)
  const dialog = await s.observe()
  check(app, 'the dialog button adds the dialog', dialog.kind === 'diff' && /\n\+ (in \[\d+\]|at top):\n(  .*\n)*  .*(dialog|Review order)/.test(dialog.text ?? ''))
  try {
    await s.send(`poke press ${indexOf(dialog.text, /^button "Cancel"/)}`)
    await sleep(500)
  } catch {}
  const back = await s.observe({ mode: 'full' })

  // the spinner: busy within 500 ms of the press, and not once it ends
  await s.send(`poke press ${indexOf(back.text, /^button "Load prices"/)}`)
  const pressed = Date.now()
  let seen = -1
  while (Date.now() - pressed < 500) {
    if ((await s.send('busy')).busy === true) {
      seen = Date.now() - pressed
      break
    }
    await sleep(40)
  }
  if (seen < 0) {
    // not announced: a walk finds it, which counts from then on (A11)
    await s.observe()
    if ((await s.send('busy')).busy === true) findings.push('chrome: the spinner was not announced; the next walk found it')
  }
  check(app, 'the spinner reads busy within 500 ms', seen >= 0, seen >= 0 ? `${seen} ms` : 'not within 500 ms')
  let cleared = -1
  while (Date.now() - pressed < 6_000) {
    if ((await s.send('busy')).busy === false) {
      cleared = Date.now() - pressed
      break
    }
    await sleep(100)
  }
  check(app, 'busy ends after the spinner', cleared >= 0, `${cleared} ms`)

  // scroll the 60-row box by AX: its summary counts change (A2)
  const before = await s.observe({ mode: 'full' })
  const rows = (before.text ?? '').split('\n').filter((l) => /\] text = "Order \d+"/.test(l))
  const lastRow = indexOf(rows.at(-1), /^text = "Order/)
  await s.send(`poke action ${lastRow} AXScrollToVisible`)
  await sleep(600)
  const scrolled = await s.observe()
  check(app, "scrolling the list is a ~ on the list with its new summary", /\n~ \[\d+\] list "Past orders"\n  … \d+ more below, \d+ above/.test(scrolled.text ?? ''))

  s.close()
  bench(app, pid, title)
  await endChrome()

  // the rebuilt-element rule on a real rebuild
  const rtitle = 'Computer rebuild page - Google Chrome'
  const rpid = await chromeOn('rebuild.html', rtitle)
  const r = new Session(rpid, rtitle)
  cleanups.push(() => r.close())
  const rb = await settled(r, /input "Item 20"/)
  const item7 = indexOf(rb.text, /^input "Item 7"/)
  await r.send(`poke press ${indexOf(rb.text, /^button "Rebuild the same"/)}`)
  await sleep(700)
  const same = await r.observe()
  check(app, 'an identical rebuild reads unchanged', same.kind === 'unchanged', same.kind === 'unchanged' ? '' : (same.text ?? '').split('\n').length + ' lines')
  await r.send(`poke press ${indexOf(rb.text, /^button "Rebuild with one change"/)}`)
  await sleep(700)
  const one = await r.observe()
  const lines = (one.text ?? '').split('\n').slice(1)
  // the line may go on with what the element lists (` actions: press`: Chrome's inputs list AXPress)
  check(app, 'a rebuild with one value changed is one ~ on the kept number', lines.length === 1 && lines[0].startsWith(`~ [${item7}] input "Item 7" = "value 7 edited"`), lines.join(' | ').slice(0, 200))
  r.close()
  await endChrome()

  const htitle = 'Computer heavy page - Google Chrome'
  const hpid = await chromeOn('heavy.html', htitle)
  const h = new Session(hpid, htitle)
  await settled(h, /heading "Section 1"/)
  h.close()
  bench('chrome-heavy', hpid, htitle)
  await endChrome()
}

// ── TempCode dev instance ────────────────────────────────────────────────

async function tempcodeDev(): Promise<void> {
  const app = 'tempcode-dev'
  if (!existsSync(join(ROOT, 'out/main/index.js'))) {
    console.log('build the clone once: bun install && bunx electron-vite build')
    sh(['bun', 'install', '--frozen-lockfile'])
    sh(['bunx', 'electron-vite', 'build'])
  }
  if (!(await waitIdle(IDLE_ANY, app))) return
  const data = '/tmp/tc-ax-dev'
  rmSync(data, { recursive: true, force: true })
  for (const d of ['aliax', 'claude', 'codex']) mkdirSync(join(data, d), { recursive: true })
  const front = frontApp()
  // its own data, vault and CLI config; TEMP_CODE_SOAK_WINDOW=1 opens the window inactive (src/main/soakWindow.ts)
  const env = {
    ...process.env, TEMP_CODE_USER_DATA: data, TEMP_CODE_DEBUG_PORT: '9241', TEMP_CODE_REMOTE_PORT: '0', TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
    ALIAX_CREDENTIAL_BACKEND: 'file', CLAUDE_CONFIG_DIR: join(data, 'claude'), CODEX_HOME: join(data, 'codex'), TEMP_CODE_WARM_HARNESS: '0', TEMP_CODE_SOAK_WINDOW: '1'
  } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const preview = Bun.spawn(['bunx', 'electron-vite', 'preview', '--skipBuild'], { cwd: ROOT, env, stdout: 'ignore', stderr: 'ignore' })
  const exe = join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  const pid = await newPid(exe, [], (p) => sh(['ps', 'eww', '-o', 'command=', '-p', String(p)]).out.includes(`TEMP_CODE_USER_DATA=${data}`))
  allow.add(pid)
  cleanups.push(async () => {
    sh(['kill', String(pid)])
    preview.kill()
    for (let i = 0; i < 20 && sh(['kill', '-0', String(pid)]).code === 0; i++) await sleep(500)
    rmSync(data, { recursive: true, force: true })
  })
  if (!stillBehind(front, app)) return
  const title = 'New thread'
  await waitWindow(pid, title, 60_000)
  await sleep(3000)
  const s = new Session(pid, title)
  cleanups.push(() => s.close())
  const first = await s.observe({ mode: 'full' })
  check(app, 'the dev window is not thin', (first as { stats?: { thin?: boolean } }).stats?.thin === false)
  check(app, 'two reads are unchanged', (await s.observe()).kind === 'unchanged')
  // an in-app popup, never "Add workspace…" (it may open the system's folder panel, a window of its own that takes focus)
  const options = indexOf(first.text, /^pop up "Workspace options"/)
  await s.send(`poke press ${options}`)
  await sleep(1000)
  const dialog = await s.observe()
  check(app, 'a popup opening keeps every number that stayed', dialog.kind === 'diff' && /\n\+ /.test(dialog.text ?? '') && !/\n- /.test(dialog.text ?? ''), dialog.kind ?? '')
  await s.send(`poke press ${options}`)
  s.close()
  bench(app, pid, title)
}

// ── IntelliJ ─────────────────────────────────────────────────────────────

const LICENCE = /licen[cs]e|subscription|activat|evaluat|trial/i
/** Buttons that only put a licence prompt away; never one that quits, buys or signs in. */
const DISMISS = /^(remind me later|later|not now|close|cancel|skip|continue|dismiss)$/i

function recentFiles(): string[] {
  const base = join(homedir(), 'Library/Application Support/JetBrains')
  if (!existsSync(base)) return []
  return readdirSync(base).filter((d) => d.startsWith('IntelliJIdea') || d.startsWith('IdeaIC')).map((d) => join(base, d, 'options/recentProjects.xml')).filter(existsSync)
}

/** Every recent-projects entry naming the scratch folder, out. */
function forgetScratch(): number {
  let removed = 0
  for (const file of recentFiles()) {
    const xml = readFileSync(file, 'utf8')
    const kept = xml
      .replace(/\s*<entry key="[^"]*tc-fixture-idea[^"]*">[\s\S]*?<\/entry>/g, () => {
        removed++
        return ''
      })
      .replace(/\s*<option value="[^"]*tc-fixture-idea[^"]*" \/>/g, () => {
        removed++
        return ''
      })
    if (kept !== xml) writeFileSync(file, kept)
  }
  return removed
}

async function intellij(): Promise<void> {
  const app = 'intellij'
  if (!(await waitIdle(IDLE_IDEA, app))) return
  const exe = 'IntelliJ IDEA.app/Contents/MacOS/idea'
  const running = pidsOf(exe)[0]
  if (running) {
    allow.add(running)
    const prompt = windowsOf(running).find((w) => LICENCE.test(w.title))
    if (prompt) {
      skipped[app] = `skipped: IntelliJ shows a licence prompt (${prompt.title})`
      console.log(`skip  ${app.padEnd(12)} ${skipped[app]}`)
      return
    }
  }
  const dir = '/tmp/tc-fixture-idea/Hello'
  rmSync('/tmp/tc-fixture-idea', { recursive: true, force: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/Hello.java'), 'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hello from the fixture");\n    }\n}\n')
  cleanups.push(() => {
    const n = forgetScratch()
    findings.push(`intellij: ${n} recent-projects entries for the scratch folder removed${running ? '; the running IDE keeps its list in memory and may write it back on its next save' : ''}`)
    rmSync('/tmp/tc-fixture-idea', { recursive: true, force: true })
  })
  const before = new Set((running ? windowsOf(running) : []).map((w) => w.id))
  const front = frontApp()
  sh(['open', '-g', '-a', 'IntelliJ IDEA', dir])
  cleanups.push(() => void findings.push(`intellij: in front before ${JSON.stringify(front)}, after ${JSON.stringify(frontApp())}`))
  const pid = running ?? (await newPid(exe, []))
  allow.add(pid)
  if (!running) cleanups.push(() => void sh(['kill', String(pid)]))
  if (!stillBehind(front, app)) return
  const mark = 'AXButton=Project: Hello, menu'
  let s: Session | undefined
  let scratch = 0
  for (let i = 0; i < 120 && !s; i++) {
    await sleep(1000)
    if (idleSeconds() < 2) {
      findings.push('intellij: the person came back; the scratch window was closed early')
      break
    }
    // the project window may come up well after the open returned
    if (!stillBehind(front, app)) return
    // the trust prompt a first open of a folder may ask
    const trust = windowsOf(pid).find((w) => w.title === "Trust and Open Project 'Hello'?")
    if (trust) {
      const t = new Session(pid, trust.title)
      const tr = await t.observe({ mode: 'full' })
      await t.send(`poke press ${indexOf(tr.text, /^button "Trust Project"/)}`)
      t.close()
      await sleep(1000)
      if (!stillBehind(front, app)) return
    }
    // a licence prompt: answered only with a dismissing button, else left and reported
    for (const w of windowsOf(pid).filter((w) => !before.has(w.id) && LICENCE.test(w.title))) {
      const p = new Session(pid, w.title)
      const pr = await p.observe({ mode: 'full' })
      const button = (pr.text ?? '').split('\n').map((l) => /\[(\d+)\] button "([^"]+)"/.exec(l)).find((m) => m && DISMISS.test(m[2]))
      if (button) {
        await p.send(`poke press ${button[1]}`)
        findings.push(`intellij: licence prompt "${w.title}" answered with "${button[2]}"`)
      } else {
        findings.push(`intellij: licence prompt "${w.title}" has no dismissing button; left for the person`)
      }
      p.close()
      before.add(w.id)
      await sleep(1000)
      if (!stillBehind(front, app)) return
    }
    // only the window that appeared since the open, and only if it holds the scratch project's button
    const fresh = windowsOf(pid).find((w) => !before.has(w.id) && w.title === '')
    if (fresh) {
      try {
        const probe = new Session(pid, '', mark, fresh.id)
        const r = await probe.observe({ mode: 'full' })
        if (r.ok === false) probe.close()
        else {
          s = probe
          scratch = fresh.id
        }
      } catch {}
    }
  }
  if (!s) {
    check(app, 'the scratch project window was read', false, 'not found within 2 minutes')
    return
  }
  const full = await s.observe({ mode: 'full' })
  const stubs = ((full.text ?? '').match(/items not exposed to accessibility/g) ?? []).length
  findings.push(`intellij: ${(full as { stats?: { elements?: number } }).stats?.elements} elements kept, thin=${(full as { stats?: { thin?: boolean } }).stats?.thin}, ${stubs} stub lines`)
  check(app, 'the scratch project window was read', full.kind === 'full')
  s.close()
  bench(app, pid, '', mark, scratch)
  // only the scratch window closes: its own close button, after its id, title and mark matched it
  const c = new Session(pid, '', mark, scratch)
  const now = await c.observe({ mode: 'full' })
  await c.send(`poke press ${indexOf(now.text, /^button "close"/)}`)
  c.close()
  await sleep(3000)
}

// ── run ──────────────────────────────────────────────────────────────────

const apps: Record<string, () => Promise<void>> = { textedit, chrome, 'tempcode-dev': tempcodeDev, intellij }
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(apps)
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const name of wanted) {
  if (stopAll) break
  try {
    await apps[name]!()
  } catch (e) {
    check(name, 'ran to the end', false, String((e as Error).message ?? e).slice(0, 200))
  } finally {
    await cleanUp()
  }
}
const failed = checks.filter((c) => !c.pass).length
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ checks, timings, findings, skipped, stopped: stopAll || undefined }, null, 2))
console.log(`\n${checks.length - failed} passed, ${failed} failed, ${Object.keys(skipped).length} skipped; ${join(OUT, 'report.json')}`)
for (const f of findings) console.log(`note  ${f}`)
process.exit(failed ? 1 : 0)
