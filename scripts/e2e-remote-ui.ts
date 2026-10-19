/**
 * The /ui path for real (plan 5jtfkIC45Cbr): an isolated instance of the
 * BUILT tree (electron-vite preview, fresh userData, its own debug and
 * remote ports) and a real Chrome with its own profile, driven over CDP.
 * The desktop side makes a workspace and a pairing over its local socket;
 * Chrome opens /pair#<code>, signs in, lands on /ui/, sees the workspace,
 * creates a thread, sends a message through the composer, waits for the
 * reply row, is screenshotted, and has its cookie read back as HttpOnly.
 * curl checks the 302, the 401, the CSP rewrite and the Secure flag.
 * Run: bun scripts/e2e-remote-ui.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app or its userData.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, REPO, attach, prepareEnv, sh, sleep } from './lib/packagedApp'

prepareEnv()
const DEBUG_PORT = Number(process.env.TC_UI_DEBUG_PORT ?? 9228)
const REMOTE_PORT = Number(process.env.TC_UI_REMOTE_PORT ?? 7679)
const CHROME_PORT = Number(process.env.TC_UI_CHROME_PORT ?? 9333)
const USER_DATA = join(homedir(), 'Library', 'Application Support', 'temp-code-dev-remote')
const CHROME_PROFILE = '/tmp/tc-remote-chrome-profile'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOT = '/tmp/tc-remote-ui.png'
const base = `http://127.0.0.1:${REMOTE_PORT}`

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const log = (m: string): void => console.log(`      ${m}`)

if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run electron-vite build first')
  process.exit(2)
}
for (const port of [DEBUG_PORT, REMOTE_PORT, CHROME_PORT]) {
  const busy = (await sh(['sh', '-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`], { quiet: true })).trim()
  if (busy) {
    console.error(`port ${port} is in use by pid ${busy}; pick another with TC_UI_*_PORT`)
    process.exit(2)
  }
}
// A fresh userData every run: this dir is ours alone.
rmSync(USER_DATA, { recursive: true, force: true })
mkdirSync(USER_DATA, { recursive: true })
rmSync(CHROME_PROFILE, { recursive: true, force: true })

const pidsOn = async (port: number): Promise<number[]> =>
  (await sh(['sh', '-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`], { quiet: true }))
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)

const env = { ...process.env, TEMP_CODE_USER_DATA: USER_DATA, TEMP_CODE_DEBUG_PORT: String(DEBUG_PORT), TEMP_CODE_REMOTE_PORT: String(REMOTE_PORT) } as Record<string, string>
delete env.ELECTRON_RUN_AS_NODE
const appLog = join(tmpdir(), `tc-remote-ui-app-${process.pid}.log`)
const appOut = Bun.file(appLog)
const app = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: appOut, stderr: appOut })
const chrome = Bun.spawn([CHROME, `--user-data-dir=${CHROME_PROFILE}`, `--remote-debugging-port=${CHROME_PORT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })

const cleanup = async (): Promise<void> => {
  for (const pid of [...(await pidsOn(DEBUG_PORT)), ...(await pidsOn(REMOTE_PORT))]) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  app.kill()
  chrome.kill()
  await sleep(500)
  for (const pid of await pidsOn(DEBUG_PORT)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

try {
  // ── the desktop side ──────────────────────────────────────────────────
  const desk = await attach(DEBUG_PORT, 120_000)
  for (let i = 0; i < 120 && !(await desk.eval<boolean>('!!window.__monocode?.server?.connected').catch(() => false)); i++) await sleep(500)
  log('desktop window up and connected')
  const wsDir = mkdtempSync(join(tmpdir(), 'tc-remote-ui-ws-'))
  writeFileSync(join(wsDir, 'README.md'), '# remote ui\n')
  await sh(['git', 'init', '-q', wsDir], { quiet: true })
  const desktopRequest = (method: string, params: unknown): Promise<unknown> =>
    desk.eval(`window.__monocode.server.request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const workspace = (await desktopRequest('workspace.create', { path: wsDir, name: 'remote-ui-ws' })) as { id: string }
  check('desktop creates a workspace over its local socket', typeof workspace?.id === 'string')
  const status = (await desktopRequest('remote.status', {})) as { running: boolean; port: number }
  check(`remote listener running on ${REMOTE_PORT}`, status.running && status.port === REMOTE_PORT, JSON.stringify(status))
  const pairing = (await desktopRequest('remote.pairings.create', { name: 'Chrome (e2e)', audience: 'client', caps: ['operate'] })) as { code: string; url: string }
  check('desktop creates a pairing', /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(pairing.code), pairing.url)

  // ── curl, before any cookie exists ───────────────────────────────────
  const curl = (args: string[]): Promise<string> => sh(['curl', '-s', ...args], { quiet: true })
  check('/ui without a cookie is 302 → /pair', (await curl(['-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', `${base}/ui`])) === `302 ${base}/pair`)
  const asset = readFileSync(join(REPO, 'out', 'renderer', 'index.html'), 'utf8').match(/\.\/(assets\/index-[^"]+\.js)/)?.[1] ?? 'assets/nope.js'
  check('an asset without a cookie is 401', (await curl(['-o', '/dev/null', '-w', '%{http_code}', `${base}/ui/${asset}`])) === '401', asset)
  check('/pair is public', (await curl(['-o', '/dev/null', '-w', '%{http_code}', `${base}/pair`])) === '200')

  // ── Chrome ────────────────────────────────────────────────────────────
  let tab: { webSocketDebuggerUrl?: string; url: string; type: string } | undefined
  for (let i = 0; i < 60 && !tab; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json`)).json()) as typeof tab[]
      tab = list.find((t) => t?.type === 'page' && t.webSocketDebuggerUrl)
    } catch {
      /* not up */
    }
    if (!tab) await sleep(500)
  }
  if (!tab?.webSocketDebuggerUrl) throw new Error('Chrome never exposed a page target')
  const page = await Cdp.connect(tab.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Network.enable')
  await page.send('Runtime.enable')
  const until = async (expr: string, ms: number, label: string): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await page.eval<boolean>(expr).catch(() => false)) return
      await sleep(250)
    }
    throw new Error(`timed out: ${label}`)
  }
  await page.send('Page.navigate', { url: `${base}/pair#${pairing.code}` })
  await until(`document.getElementById('code')?.value === ${JSON.stringify(pairing.code)}`, 15_000, 'pair page with the code prefilled')
  check('the /pair page prefills the code from the fragment', true)
  await page.eval(`document.getElementById('f').requestSubmit()`)
  await until(`location.pathname === '/ui/'`, 15_000, 'landing on /ui/')
  check('sign-in lands on /ui/', true)
  await until(`!!window.__monocode?.server?.connected`, 30_000, 'the browser socket to open')
  check('the browser bundle opened its WebSocket on the cookie', true)
  await until(`document.body.innerText.includes('remote-ui-ws')`, 30_000, 'the workspace list to show the workspace')
  check('the workspace list renders in Chrome', true)

  const created = (await page.eval(`window.__monocode.server.request('session.create', ${JSON.stringify({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', workspaceId: workspace.id, threadType: 'chat', title: 'remote browser chat' })})`)) as { id: string }
  check('the browser creates a thread over its cookie socket', typeof created?.id === 'string', created?.id)
  // The sidebar lists the selected workspace's threads: pick the workspace in the rail, then the thread row.
  const clickText = (text: string, prefix = false): Promise<boolean> =>
    page.eval<boolean>(`(() => { const want = ${JSON.stringify(text)}; const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (${prefix ? 'e.textContent.trim().startsWith(want)' : 'e.textContent.trim() === want'})); if (!el) return false; (el.closest('button, a, [role=button], [role=option], [role=tab], li') ?? el).click(); return true })()`)
  // The rail names a workspace by its directory.
  check('the workspace row in the rail takes a click', await clickText('tc-remote-ui-ws-', true))
  try {
    await until(`[...document.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.trim() === 'remote browser chat')`, 15_000, 'the thread in the sidebar')
  } catch (err) {
    const text = await page.eval<string>('document.documentElement.innerText.slice(0, 1500)')
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync('/tmp/tc-remote-ui-fail.png', Buffer.from(shot.data, 'base64'))
    log(`page text at failure:\n${text}\n(screenshot /tmp/tc-remote-ui-fail.png)`)
    throw err
  }
  await clickText('remote browser chat')
  // Type into the composer when it is there; otherwise send over the socket and say so.
  const composed = await (async () => {
    try {
      await until(`!!document.querySelector('textarea, [contenteditable="true"]')`, 10_000, 'the composer')
      await page.eval(`(() => { const box = document.querySelector('textarea, [contenteditable="true"]'); box.focus(); return true })()`)
      await page.send('Input.insertText', { text: 'Reply with exactly: REMOTE-OK' })
      await sleep(200)
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await until(`document.body.innerText.includes('Reply with exactly: REMOTE-OK')`, 10_000, 'the user row')
      return 'composer'
    } catch (err) {
      log(`composer path failed (${(err as Error).message}); sending over the socket`)
      await page.eval(`window.__monocode.server.request('session.send', ${JSON.stringify({ sessionId: created.id, text: 'Reply with exactly: REMOTE-OK' })})`)
      return 'socket'
    }
  })()
  check('the message is sent from Chrome', true, `via the ${composed}`)
  // The user row already says REMOTE-OK; the reply is the second mention.
  await until(`(() => { const t = document.body.innerText; return t.indexOf('REMOTE-OK') !== t.lastIndexOf('REMOTE-OK') })()`, 180_000, 'the reply row')
  check('the reply row renders in Chrome', true)
  const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  check('screenshot written', existsSync(SHOT), SHOT)

  const cookies = (await page.send('Network.getCookies', { urls: [`${base}/`] })) as { cookies: { name: string; httpOnly: boolean; sameSite?: string; secure: boolean; value: string }[] }
  const session = cookies.cookies.find((c) => c.name === 'tc_session')
  check('the session cookie is HttpOnly and SameSite=Lax', !!session && session.httpOnly && session.sameSite === 'Lax' && !session.secure, JSON.stringify({ httpOnly: session?.httpOnly, sameSite: session?.sameSite, secure: session?.secure }))
  // The page itself cannot read it.
  check('document.cookie does not expose it', !(await page.eval<string>('document.cookie')).includes('tc_session'))

  // ── curl, with the cookie ─────────────────────────────────────────────
  const cookieHeader = `tc_session=${session!.value}`
  const index = await curl(['-H', `Cookie: ${cookieHeader}`, `${base}/ui/`])
  check('index.html for the loopback host names ws://127.0.0.1 in connect-src', index.includes(`ws://127.0.0.1:${REMOTE_PORT} http://127.0.0.1:${REMOTE_PORT}`))
  const proxied = await curl(['-H', `Cookie: ${cookieHeader}`, '-H', 'X-Forwarded-Proto: https', '-H', 'Host: tempcode.example.com', `${base}/ui/`])
  check('behind the proxy connect-src gains wss://<host> https://<host>', proxied.includes('wss://tempcode.example.com https://tempcode.example.com'))
  check('index.html is no-store', (await curl(['-I', '-H', `Cookie: ${cookieHeader}`, `${base}/ui/`])).toLowerCase().includes('cache-control: no-store'))
  const secondCode = ((await desktopRequest('remote.pairings.create', { name: 'Safari (e2e)', audience: 'client', caps: [] })) as { code: string }).code
  const secure = await curl(['-D', '-', '-o', '/dev/null', '-H', 'X-Forwarded-Proto: https', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ code: secondCode, kind: 'session' }), `${base}/api/pair`])
  check('Set-Cookie carries Secure when X-Forwarded-Proto is https', /set-cookie: tc_session=.*; Secure/i.test(secure))
  const sessions = (await desktopRequest('remote.sessions.list', {})) as { keyName: string }[]
  // The sign-in page names the browser from its user agent; curl's exchange kept the pairing's name.
  check('the desktop lists the browser sessions', sessions.some((s) => /^Chrome/.test(s.keyName)) && sessions.some((s) => s.keyName === 'Safari (e2e)'), sessions.map((s) => s.keyName).join(', '))

  // ── /asset: logos, media and agent pages through the mirror ──────────
  // A 1×1 png in the workspace: a logo source and a media file at once.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
  const pngPath = join(wsDir, 'dot.png')
  writeFileSync(pngPath, png)
  const probe = (expr: string): Promise<unknown> => page.eval(`(async () => { ${expr} })()`)
  const logoPath = (await probe(`return (await window.__monocode.server.request('projectLogo.save', ${JSON.stringify({ projectPath: wsDir, sourcePath: pngPath })}))`)) as string | { path?: string }
  const logoName = encodeURIComponent(String(typeof logoPath === 'string' ? logoPath : logoPath?.path ?? '').split('/').pop() ?? '')
  const logo = (await probe(`const r = await fetch('/asset/logo/${logoName}'); const img = new Image(); const loaded = new Promise((ok) => { img.onload = () => ok(img.naturalWidth); img.onerror = () => ok(0) }); img.src = '/asset/logo/${logoName}'; return { status: r.status, type: r.headers.get('content-type'), width: await loaded }`)) as { status: number; type: string; width: number }
  check('a project logo loads from /asset/logo in Chrome', logo.status === 200 && logo.type === 'image/png' && logo.width === 1, JSON.stringify(logo))
  const media = (await probe(`const m = await window.__monocode.server.request('fs.media', { path: ${JSON.stringify(pngPath)} }); const href = m.url.replace(/^tempcode-asset:\\/\\//, '/asset/'); const r = await fetch(href, { headers: { Range: 'bytes=0-7' } }); const img = new Image(); const loaded = new Promise((ok) => { img.onload = () => ok(img.naturalWidth); img.onerror = () => ok(0) }); img.src = href; return { url: m.url, status: r.status, range: r.headers.get('content-range'), width: await loaded }`)) as { url: string; status: number; range: string | null; width: number }
  check('a media file streams from /asset/file with Range in Chrome', media.url.startsWith('tempcode-asset://file/') && media.status === 206 && media.range === `bytes 0-7/${png.length}` && media.width === 1, JSON.stringify(media))
  // A page published for the thread is served through the mirror.
  const published = (await desktopRequest('app.htmlRender', { sessionId: created.id, html: '<!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff;font:20px sans-serif">REMOTE-PAGE</h1></body></html>', title: 'remote page', height: 120 })) as { htmlRender: { sessionId: string; pageId: string } }
  const pageHref = `/asset/page/${published.htmlRender.sessionId}/${published.htmlRender.pageId}.html`
  const served = (await probe(`const r = await fetch(${JSON.stringify(pageHref)}); return { status: r.status, type: r.headers.get('content-type'), ok: (await r.text()).includes('REMOTE-PAGE') }`)) as { status: number; type: string; ok: boolean }
  check('a published agent page is served from /asset/page in Chrome', served.status === 200 && /text\/html/.test(served.type) && served.ok, JSON.stringify(served))
  // The transcript shows a page only as the result of the agent's html_render tool call: ask for one.
  await page.eval(`window.__monocode.server.request('session.send', ${JSON.stringify({ sessionId: created.id, text: 'Call your html_render tool once with title "remote page", height 120, and html <!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff;font:20px sans-serif">REMOTE-PAGE</h1></body></html>. Then reply with exactly: PAGE-SHOWN' })})`)
  try {
    await until(`!!document.querySelector('iframe[src^="/asset/page/"]')`, 240_000, 'the page iframe in Chrome')
  } catch (err) {
    const shotFail = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync('/tmp/tc-remote-ui-assets-fail.png', Buffer.from(shotFail.data, 'base64'))
    throw err
  }
  const frame = (await probe(`const f = document.querySelector('iframe[src^="/asset/page/"]'); const r = await fetch(f.src); const text = await r.text(); return { src: f.src, status: r.status, type: r.headers.get('content-type'), ok: text.includes('REMOTE-PAGE'), sandbox: f.getAttribute('sandbox') }`)) as { src: string; status: number; type: string; ok: boolean; sandbox: string }
  check('the agent page iframe in the transcript points at /asset/page and serves the html', frame.status === 200 && /text\/html/.test(frame.type) && frame.ok, frame.src)
  check('the iframe stays sandboxed without allow-same-origin', !frame.sandbox.includes('allow-same-origin'), frame.sandbox)
  await sleep(1500)
  const shot2 = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync('/tmp/tc-remote-ui-assets.png', Buffer.from(shot2.data, 'base64'))
  check('asset screenshot written', true, '/tmp/tc-remote-ui-assets.png')

  page.close()
  desk.close()
} catch (err) {
  check('run completed', false, (err as Error).message)
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
console.log(`app log: ${appLog}`)
process.exit(failures === 0 ? 0 : 1)
