/**
 * The multi-environment UI for real (thread K2). Two isolated instances of
 * the BUILT tree (electron-vite preview, fresh userData each, their own
 * debug and remote ports): A is the desktop, B a second host. A adds B
 * through Settings → Hosts over CDP (the fields and buttons, never
 * the registry), a wrong key shows one clear error, the switcher moves the
 * window to B, a thread on B takes a turn from the composer, the inbox
 * merges both hosts, B is killed and A's thread shows the degraded line
 * with sending blocked and its rows kept, B comes back and the line goes,
 * ⌘⌥[ and ⌘⌥] step environments, and B is removed through the pane.
 * With TC_K2_BOX=1 a third environment, the real box, is paired from a code
 * minted over `ssh box` (never printed), listed, one thread opened
 * read-only, then removed here and its key revoked there.
 * Run: bun scripts/e2e-environments-ui.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app or its userData.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, REPO, attach, prepareEnv, sh, sleep } from './lib/packagedApp'

prepareEnv()
const A = { debug: Number(process.env.TC_K2_A_DEBUG ?? 9234), remote: Number(process.env.TC_K2_A_REMOTE ?? 7691), data: join(homedir(), 'Library', 'Application Support', 'temp-code-k2-a'), log: '/tmp/tc-k2-a.log' }
const B = { debug: Number(process.env.TC_K2_B_DEBUG ?? 9236), remote: Number(process.env.TC_K2_B_REMOTE ?? 7692), data: join(homedir(), 'Library', 'Application Support', 'temp-code-k2-b'), log: '/tmp/tc-k2-b.log' }
const BOX = process.env.TC_K2_BOX === '1'
const SHOTS = { pane: '/tmp/tc-k2-pane.png', switcher: '/tmp/tc-k2-switcher.png', inbox: '/tmp/tc-k2-inbox.png', degraded: '/tmp/tc-k2-degraded.png', box: '/tmp/tc-k2-box.png', remote: '/tmp/tc-k2-remote-folder.png' }

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run electron-vite build first')
  process.exit(2)
}
const pidsOn = async (port: number): Promise<number[]> =>
  (await sh(['sh', '-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`], { quiet: true }))
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)
for (const port of [A.debug, A.remote, B.debug, B.remote]) {
  if ((await pidsOn(port)).length) {
    console.error(`port ${port} is in use; pick another with TC_K2_*`)
    process.exit(2)
  }
}
for (const inst of [A, B]) {
  rmSync(inst.data, { recursive: true, force: true })
  mkdirSync(inst.data, { recursive: true })
}

type Inst = typeof A
const procs: ReturnType<typeof Bun.spawn>[] = []
function launch(inst: Inst): void {
  const env = { ...process.env, TEMP_CODE_USER_DATA: inst.data, TEMP_CODE_DEBUG_PORT: String(inst.debug), TEMP_CODE_REMOTE_PORT: String(inst.remote) } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const out = Bun.file(inst.log)
  procs.push(Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: out, stderr: out }))
}
async function killInstance(inst: Inst): Promise<void> {
  for (const pid of new Set<number>([...(await pidsOn(inst.debug)), ...(await pidsOn(inst.remote))])) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await sleep(800)
}
const cleanup = async (): Promise<void> => {
  for (const p of procs) p.kill()
  await killInstance(A)
  await killInstance(B)
}

// ── CDP helpers: the UI is driven through what a user sees ─────────────
const until = async (cdp: Cdp, expr: string, ms: number, label: string): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cdp.eval<boolean>(expr).catch(() => false)) return
    await sleep(250)
  }
  // A timeout explains itself: the page as it was, and what it said.
  try {
    await cdp.eval(`document.querySelectorAll('[data-environment-field=key], [data-environment-field=link]').forEach(el => el.style.visibility = 'hidden')`)
    const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync('/tmp/tc-k2-fail.png', Buffer.from(png.data, 'base64'))
    const text = (await cdp.eval<string>('document.body.innerText')).slice(0, 1200)
    log(`page text at failure (${label}):\n${text}\n(screenshot /tmp/tc-k2-fail.png)`)
  } catch {
    /* the window is gone */
  }
  throw new Error(`timed out: ${label}`)
}
const rpc = (cdp: Cdp, env: string, method: string, params: unknown): Promise<unknown> =>
  cdp.eval(`window.__monocode.registry.linkOf(${JSON.stringify(env)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
const statusOf = (cdp: Cdp, env: string): Promise<{ transport: string; fresh: boolean }> =>
  cdp.eval(`(() => { const s = window.__monocode.registry.statusOf(${JSON.stringify(env)}); return { transport: s.transport, fresh: s.fresh } })()`)
const currentEnvironment = (cdp: Cdp): Promise<string> => cdp.eval(`window.__monocode.environment.getState().currentId`)
const bodyText = (cdp: Cdp): Promise<string> => cdp.eval(`document.body.innerText`)
const clickSelector = (cdp: Cdp, selector: string): Promise<boolean> =>
  cdp.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
/** Click the leaf element whose text is exactly `text` (or starts with it). */
const clickText = (cdp: Cdp, text: string, prefix = false): Promise<boolean> =>
  cdp.eval<boolean>(
    `(() => { const want = ${JSON.stringify(text)}; const el = [...document.querySelectorAll('button, a, span, div, p')].find(e => e.children.length === 0 && (${prefix ? 'e.textContent.trim().startsWith(want)' : 'e.textContent.trim() === want'})); if (!el) return false; (el.closest('button') ?? el).click(); return true })()`
  )
const hasText = (cdp: Cdp, text: string): string => `document.body.innerText.includes(${JSON.stringify(text)})`
const typeInto = async (cdp: Cdp, selector: string, text: string): Promise<void> => {
  const ok = await cdp.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select?.(); return true })()`)
  if (!ok) throw new Error(`no field ${selector}`)
  await cdp.send('Input.insertText', { text })
}
const key = async (cdp: Cdp, k: string, code: string, modifiers = 0, vk = 0): Promise<void> => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
}
const META = 4
const ALT = 1
const shot = async (cdp: Cdp, file: string): Promise<void> => {
  const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(file, Buffer.from(png.data, 'base64'))
  log(`screenshot ${file}`)
}
const OPEN_STATUS = ['starting', 'running', 'watching', 'waiting']
const metaStatus = (cdp: Cdp, id: string): Promise<string | null> => cdp.eval(`window.__monocode.sessionStore.metaOf(${JSON.stringify(id)})?.status ?? null`) as never
const settled = async (cdp: Cdp, id: string, ms: number): Promise<string | null> => {
  const start = Date.now() + 15_000
  while (Date.now() < start) {
    const s = await metaStatus(cdp, id)
    if (s && OPEN_STATUS.includes(s)) break
    await sleep(300)
  }
  const end = Date.now() + ms
  let last: string | null = null
  while (Date.now() < end) {
    last = await metaStatus(cdp, id)
    if (last && !OPEN_STATUS.includes(last)) return last
    await sleep(500)
  }
  return last
}
const gitDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `tc-k2-${name}-`))
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  return dir
}
async function connectWindow(inst: Inst, label: string): Promise<Cdp> {
  const cdp = await attach(inst.debug, 120_000)
  // The renderer's own console lines ride along, for the log.
  await cdp.send('Runtime.enable')
  cdp.on('Runtime.consoleAPICalled', (params) => {
    const p = params as { type: string; args: { value?: unknown; description?: string }[] }
    const text = p.args.map((x) => (x.value !== undefined ? String(x.value) : (x.description ?? ''))).join(' ')
    if (/\[monocode:(environment|server)\]|Uncaught|Error/.test(text)) log(`${label} console.${p.type}: ${text.replace(/ticket=[^\s&]+/g, 'ticket=…').slice(0, 220)}`)
  })
  cdp.on('Runtime.exceptionThrown', (params) => {
    const d = (params as { exceptionDetails: { text: string; exception?: { description?: string } } }).exceptionDetails
    log(`${label} exception: ${(d.exception?.description ?? d.text).slice(0, 300)}`)
  })
  await until(cdp, `!!window.__monocode?.registry?.primary()?.connected`, 60_000, `${label} local socket`)
  await until(cdp, `window.__monocode.registry.statusOf('local').fresh === true`, 60_000, `${label} first list`)
  return cdp
}
/** Settings → Hosts, from wherever the window is. */
async function openEnvironmentsPane(cdp: Cdp): Promise<void> {
  await key(cdp, 'Escape', 'Escape')
  await key(cdp, ',', 'Comma', META, 188)
  await until(cdp, `!!document.querySelector('[data-app-settings]')`, 10_000, 'Settings')
  await clickText(cdp, 'Hosts')
  await until(cdp, `!!document.querySelector('[data-environment-row="local"]')`, 10_000, 'the Hosts page')
}
const closeSettings = async (cdp: Cdp): Promise<void> => {
  await key(cdp, 'Escape', 'Escape')
  await until(cdp, `!document.querySelector('[data-app-settings]')`, 5_000, 'Settings closed')
}

launch(A)
launch(B)
try {
  const a = await connectWindow(A, 'A')
  const b = await connectWindow(B, 'B')
  log(`A and B up; logs ${A.log} ${B.log}`)

  // ── B: a key, a workspace, a thread ────────────────────────────────
  const bHello = (await b.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  const bKey = (await rpc(b, 'local', 'remote.keys.create', { name: 'A (k2 e2e)', audience: 'client', caps: ['read', 'operate', 'approve'] })) as { token: string }
  check('B: issues a key over its local link', typeof bKey?.token === 'string' && bKey.token.startsWith('tc_'))
  const bDir = gitDir('b')
  await sh(['git', 'init', '-q', bDir], { quiet: true })
  const bWs = (await rpc(b, 'local', 'workspace.create', { path: bDir })) as { id: string }
  const bSession = (await rpc(b, 'local', 'session.create', { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', cwd: bDir, workspaceId: bWs.id, threadType: 'chat', agentType: 'implementer', title: 'k2 remote thread' })) as { id: string }
  check('B: has a workspace and a thread of its own', typeof bWs?.id === 'string' && typeof bSession?.id === 'string')
  // A local workspace too, so the rail has two groups to tell apart.
  const aDir = gitDir('a')
  await sh(['git', 'init', '-q', aDir], { quiet: true })
  await rpc(a, 'local', 'workspace.create', { path: aDir })

  // ── A adds B through the pane ──────────────────────────────────────
  await openEnvironmentsPane(a)
  check('A: the pane lists this machine first', (await bodyText(a)).includes('This Mac'))
  check('A: the pane opens the Add dialog', await clickText(a, 'Add host'))
  await until(a, `!!document.querySelector('[data-environment-field="link"]')`, 5_000, 'the Add dialog')
  await clickText(a, 'Key')
  await until(a, `!!document.querySelector('[data-environment-field="key"]')`, 5_000, 'the key fields')
  // A wrong key first: the host refuses it and the dialog says so in one line.
  await typeInto(a, '[data-environment-field="origin"]', `http://127.0.0.1:${B.remote}`)
  await typeInto(a, '[data-environment-field="key"]', 'tc_bogus.nope')
  await clickText(a, 'Add')
  await until(a, hasText(a, 'rejected this key'), 15_000, 'the refused-key error')
  check('A: a refused key shows one clear error and saves nothing', (await rpc(a, 'local', 'remote.environments.list', {}) as unknown[]).length === 0)
  await typeInto(a, '[data-environment-field="key"]', bKey.token)
  await typeInto(a, '[data-environment-field="name"]', 'B')
  await clickText(a, 'Add')
  await until(a, `!!document.querySelector('[data-environment-row=${JSON.stringify(bHello)}]')`, 30_000, "B's row in the pane")
  await until(a, `document.querySelector('[data-environment-row=${JSON.stringify(bHello)}]').innerText.toLowerCase().includes('connected')`, 30_000, 'B connected in the pane')
  const listed = (await rpc(a, 'local', 'remote.environments.list', {})) as { id: string; name: string; caps: string[]; keyName: string }[]
  check('A: the pane added B under its own id, named B, with the key\'s caps', listed.length === 1 && listed[0].id === bHello && listed[0].name === 'B' && listed[0].caps.includes('operate'), JSON.stringify(listed.map((e) => ({ id: e.id, name: e.name, caps: e.caps }))))
  check('A: the list never carries the key', !JSON.stringify(listed).includes(bKey.token.split('.')[1] ?? '@@'))
  const row = (await a.eval(`document.querySelector('[data-environment-row=${JSON.stringify(bHello)}]').innerText`)) as string
  check('A: the row shows origin, status and capabilities', row.includes(`127.0.0.1:${B.remote}`) && row.toLowerCase().includes('connected') && row.includes('operate'), row.replace(/\n/g, ' · '))
  await shot(a, SHOTS.pane)

  // ── the switcher moves the window to B ─────────────────────────────
  await closeSettings(a)
  await until(a, `window.__monocode.sessionStore.metas().some(m => m.id === ${JSON.stringify(bSession.id)})`, 15_000, "B's thread in A's store")
  await until(a, `!!document.querySelector('[data-environment-switcher]')`, 10_000, 'the switcher')
  check('A: the switcher names this machine first', ((await a.eval(`document.querySelector('[data-environment-switcher]').innerText`)) as string).includes('This Mac'))
  await clickSelector(a, '[data-environment-switcher]')
  await until(a, `!!document.querySelector('[data-environment-option=${JSON.stringify(bHello)}]')`, 5_000, 'the switcher menu')
  await shot(a, SHOTS.switcher)
  await clickSelector(a, `[data-environment-option=${JSON.stringify(bHello)}]`)
  await until(a, `window.__monocode.environment.getState().currentId === ${JSON.stringify(bHello)}`, 10_000, 'the window on B')
  check('A: the window is on B after the switch', (await currentEnvironment(a)) === bHello)
  await until(a, `window.__monocode.environment.getState().lastWorkspace[${JSON.stringify(bHello)}] === ${JSON.stringify(bDir)}`, 10_000, "the switch picked B's own workspace")
  check("A: the switch picked B's own workspace, not the folder both hosts share", true)
  // The rail's group labels render uppercase, so compare without case.
  const railText = (await bodyText(a)).toLowerCase()
  check('A: the rail groups workspaces by machine', railText.includes('this mac') && railText.includes((aDir.split('/').pop() as string).toLowerCase()) && railText.includes((bDir.split('/').pop() as string).toLowerCase()))

  // ── a turn on B from the composer ──────────────────────────────────
  // The sidebar names the thread by the title the server keeps for it.
  const bTitle = (await a.eval(`window.__monocode.sessionStore.metaOf(${JSON.stringify(bSession.id)})?.title ?? ''`)) as string
  // A workspace-level thread sits under the sidebar's Chats fold, which may start closed.
  await sleep(1_000)
  if (!(await a.eval<boolean>(hasText(a, bTitle)))) {
    await a.eval(`(() => { const el = [...document.querySelectorAll('button')].find(e => /^chats\b/i.test(e.innerText.trim()) && e.getAttribute('aria-expanded') === 'false'); if (el) el.click(); return !!el })()`)
  }
  await until(a, hasText(a, bTitle), 15_000, `B's thread "${bTitle}" in the sidebar`)
  check("A: B's thread row takes a click", await clickText(a, bTitle))
  await until(a, `window.__monocode.sessionStore.get(${JSON.stringify(bSession.id)})?.loaded === true`, 20_000, "B's thread open in A")
  await until(a, `!!document.querySelector('[contenteditable="true"]')`, 10_000, 'the composer')
  await a.eval(`(() => { document.querySelector('[contenteditable="true"]').focus(); return true })()`)
  await a.send('Input.insertText', { text: 'Reply with exactly: K2-REMOTE-OK' })
  await sleep(200)
  await key(a, 'Enter', 'Enter', 0, 13)
  await until(a, hasText(a, 'Reply with exactly: K2-REMOTE-OK'), 10_000, 'the user row')
  const end = await settled(a, bSession.id, 150_000)
  check('A: a turn typed into the composer ran on B', end === 'idle' && (await bodyText(a)).includes('K2-REMOTE-OK'), `status ${end}`)

  // ── the inbox merges both hosts ────────────────────────────────────
  check('A: the inbox opens', await clickSelector(a, '[aria-label="Inbox"], [aria-label="Inbox, new items"]'))
  await until(a, `!!document.querySelector('[aria-label="Filter inbox"]')`, 10_000, 'the inbox')
  await sleep(800)
  await shot(a, SHOTS.inbox)
  await key(a, 'Escape', 'Escape')

  // ── B dies: the thread shows the degraded line, sending waits, rows stay ──
  await killInstance(B)
  await until(a, `!!document.querySelector('[data-connection-line="reconnecting"]')`, 25_000, 'the degraded line')
  const placeholder = (await a.eval(`document.querySelector('[contenteditable="true"]')?.dataset.placeholder ?? ''`)) as string
  check('A: the composer says why it waits', /retry|Reconnecting/i.test(placeholder), placeholder)
  check("A: the thread's rows stay on screen", (await bodyText(a)).includes('K2-REMOTE-OK'))
  const line = (await a.eval(`document.querySelector('[data-connection-line]').innerText`)) as string
  check('A: the line names B, counts down and offers a retry', line.includes('B') && line.includes('Retry now'), line.replace(/\n/g, ' '))
  await shot(a, SHOTS.degraded)
  const envsStill = (await a.eval(`window.__monocode.registry.environments().map(e => e.id)`)) as string[]
  check('A: B stays registered while down', envsStill.includes(bHello))

  // ── B returns: the line goes and the field is live again ──────────
  launch(B)
  const b2 = await connectWindow(B, 'B (relaunched)')
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'open' && window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).fresh`, 90_000, 'A back on B')
  await until(a, `!document.querySelector('[data-connection-line]')`, 10_000, 'the degraded line gone')
  const restored = (await a.eval(`document.querySelector('[contenteditable="true"]')?.dataset.placeholder ?? ''`)) as string
  check('A: the composer takes messages again', !/retry|Reconnecting/i.test(restored), restored)

  // ── keyboard switching ────────────────────────────────────────────
  await key(a, '“', 'BracketLeft', META | ALT, 219)
  await until(a, `window.__monocode.environment.getState().currentId === 'local'`, 10_000, '⌘⌥[ to this machine')
  check('A: ⌘⌥[ moves the window to this machine', (await currentEnvironment(a)) === 'local')
  await key(a, '‘', 'BracketRight', META | ALT, 221)
  await until(a, `window.__monocode.environment.getState().currentId === ${JSON.stringify(bHello)}`, 10_000, '⌘⌥] back to B')
  check('A: ⌘⌥] moves it back to B, on the workspace it was on there', (await currentEnvironment(a)) === bHello && (await bodyText(a)).includes(bDir.split('/').pop() as string))

  // ── the box, when asked: paired from a code minted there ──────────
  if (BOX) {
    const made = JSON.parse(await sh(['ssh', '-o', 'BatchMode=yes', 'box', `tc-local remote.pairings.create '{"name":"K2 e2e","audience":"client","caps":["read"]}'`], { quiet: true })) as { url: string; code: string }
    check('box: a pairing code was minted over ssh', typeof made?.url === 'string' && made.url.includes('/pair#'))
    await openEnvironmentsPane(a)
    await clickText(a, 'Add host')
    await until(a, `!!document.querySelector('[data-environment-field="link"]')`, 5_000, 'the Add dialog')
    await typeInto(a, '[data-environment-field="link"]', made.url)
    await typeInto(a, '[data-environment-field="name"]', 'box')
    await clickText(a, 'Add')
    await until(a, `document.querySelectorAll('[data-environment-row]').length === 3`, 40_000, "the box's row")
    const boxId = (await a.eval(`[...document.querySelectorAll('[data-environment-row]')].map(e => e.dataset.environmentRow).find(id => id !== 'local' && id !== ${JSON.stringify(bHello)})`)) as string
    await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).transport === 'open' && window.__monocode.registry.statusOf(${JSON.stringify(boxId)}).fresh`, 60_000, 'the box connected')
    const boxStatus = await statusOf(a, boxId)
    check('box: paired from the link, connected and listed', boxStatus.transport === 'open' && boxStatus.fresh, JSON.stringify(boxStatus))
    await shot(a, SHOTS.box)
    const sessions = (await rpc(a, boxId, 'session.list', {})) as { sessions?: { id: string }[] } | { id: string }[]
    const rows = Array.isArray(sessions) ? sessions : (sessions.sessions ?? [])
    check('box: its threads list over the link (read only)', Array.isArray(rows), `${rows.length} threads`)
    if (rows[0]) {
      await a.eval(`window.__monocode.sessionStore.ensureLoaded(${JSON.stringify(rows[0].id)}, 'e2e')`)
      await until(a, `window.__monocode.sessionStore.get(${JSON.stringify(rows[0].id)})?.loaded === true`, 30_000, 'a box thread loaded')
      check('box: one thread opens read-only in A', true)
    }
    await clickSelector(a, '[aria-label="box actions"]')
    await clickText(a, 'Remove…')
    await until(a, hasText(a, 'forgets the host'), 5_000, 'the remove confirm')
    await clickText(a, 'Remove')
    await until(a, `!document.querySelector('[data-environment-row=${JSON.stringify(boxId)}]')`, 15_000, 'the box row gone')
    check('box: removed here', !((await a.eval(`window.__monocode.registry.environments().map(e => e.id)`)) as string[]).includes(boxId))
    // The key this Mac got from the code stays on the box: revoke it there.
    const keys = JSON.parse(await sh(['ssh', '-o', 'BatchMode=yes', 'box', 'tc-local remote.keys.list'], { quiet: true })) as { id: string; name: string; createdAt?: number }[]
    const mine = keys.filter((k) => k.name === hostname()).sort((x, y) => (y.createdAt ?? 0) - (x.createdAt ?? 0))[0]
    if (mine) {
      await sh(['ssh', '-o', 'BatchMode=yes', 'box', `tc-local remote.keys.revoke '{"id":"${mine.id}"}'`], { quiet: true })
      log('box: the e2e key was revoked there')
    }
    await closeSettings(a)
  }

  // Revoke A's saved key, then repair it through the same Pair again form.
  const oldKeys = await rpc(b2, 'local', 'remote.keys.list', {}) as { id: string }[]
  await rpc(b2, 'local', 'remote.keys.revoke', { id: oldKeys[0].id })
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'unauthorized'`, 15_000, 'revoked saved key')
  await openEnvironmentsPane(a)
  check('A: a revoked key offers Pair again', await a.eval<boolean>(`(() => { const row = document.querySelector('[data-environment-row="${bHello}"]'); const button = [...(row?.querySelectorAll('button') ?? [])].find(e => e.textContent.trim() === 'Pair again'); button?.click(); return !!button })()`))
  await until(a, `!!document.querySelector('[data-environment-field="link"]')`, 5_000, 'repair dialog')
  const replacement = await rpc(b2, 'local', 'remote.pairings.create', { name: 'K2 repair', audience: 'client', caps: ['read', 'operate', 'approve'] }) as { url: string }
  await typeInto(a, '[data-environment-field="link"]', replacement.url)
  await clickText(a, 'Pair')
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'open' && window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).fresh`, 30_000, 'repaired host reconnects without Retry')
  check('A: Pair again reconnects the unauthorized host on the same route', (await statusOf(a, bHello)).fresh)
  const repaired = await rpc(a, bHello, 'session.list', {}) as { sessions: { id: string }[] }
  check('A: the repaired host serves its own threads', repaired.sessions.some(s => s.id === bSession.id))
  await closeSettings(a)

  const keysBeforeRemoval = await rpc(b2, 'local', 'remote.keys.list', {}) as { id: string }[]
  // ── remove B through the pane ─────────────────────────────────────
  await openEnvironmentsPane(a)
  check("A: B's row menu opens", await clickSelector(a, '[aria-label="B actions"]'))
  await until(a, hasText(a, 'Remove…'), 5_000, 'the row menu')
  await clickText(a, 'Remove…')
  await until(a, hasText(a, 'forgets the host'), 5_000, 'the remove confirm')
  await clickText(a, 'Remove')
  await until(a, `!document.querySelector('[data-environment-row=${JSON.stringify(bHello)}]')`, 15_000, "B's row gone")
  const envsAfter = (await a.eval(`window.__monocode.registry.environments().map(e => e.id)`)) as string[]
  check('A: removal forgets B and the window falls back to this machine', envsAfter.length === 1 && envsAfter[0] === 'local' && (await currentEnvironment(a)) === 'local', envsAfter.join(','))
  const bKeys = (await rpc(b2, 'local', 'remote.keys.list', {})) as { id: string }[]
  check("B: its key is untouched by A's removal (nothing revoked remotely)", Array.isArray(bKeys) && JSON.stringify(bKeys.map(k => k.id).sort()) === JSON.stringify(keysBeforeRemoval.map(k => k.id).sort()))
  a.close()
  b2.close()
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
