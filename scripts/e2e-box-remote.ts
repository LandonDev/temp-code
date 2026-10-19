/**
 * The agent host through its tunnel, from this Mac (docs/box.md): hello and
 * healthz over HTTPS, a pairing code exchanged for a bearer key, a ticket,
 * the WebSocket on that ticket, a second code exchanged by a real Chrome on
 * /pair for a session cookie, the WebSocket on that cookie, and /ui, which
 * Cloudflare Access may gate (then only the gate can be checked here).
 *
 * Run: bun scripts/e2e-box-remote.ts (mints short-lived test pairings over SSH).
 * TC_PAIR_CODES can supply codes for another origin; automatic setup is box-only.
 * Mint the codes on the box: tc-local remote.pairings.create
 *   '{"name":"e2e key","audience":"client","caps":["operate"]}'  (twice)
 * TC_ORIGIN overrides https://tempcode.landonhale.com.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { Cdp, sleep } from './lib/packagedApp'

const ORIGIN = (process.env.TC_ORIGIN ?? 'https://tempcode.landonhale.com').replace(/\/+$/, '')
let CODES = (process.env.TC_PAIR_CODES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const runName = `box e2e ${Date.now()}`
const automatic = CODES.length === 0 && !process.env.TC_ORIGIN
function local(method: string, params: unknown = {}): unknown {
  const quoted = JSON.stringify(params).replaceAll("'", "'\\''")
  const result = Bun.spawnSync(
    ['ssh', '-o', 'BatchMode=yes', 'box', `tc-local ${method} '${quoted}'`],
    { stdout: 'pipe', stderr: 'pipe' }
  )
  if (result.exitCode !== 0) throw new Error(`box tc-local ${method} failed`)
  return JSON.parse(result.stdout.toString())
}
const CHROME_PORT = Number(process.env.TC_BOX_CHROME_PORT ?? 9334)
const CHROME_PROFILE = '/tmp/tc-box-chrome-profile'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOT = '/tmp/tc-box-remote.png'
const wsOrigin = ORIGIN.replace(/^http/, 'ws')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const log = (m: string): void => console.log(`      ${m}`)
if (automatic) {
  CODES = ['key', 'cookie'].map(
    (kind) =>
      (
        local('remote.pairings.create', {
          name: `${runName} ${kind}`,
          audience: 'client',
          caps: ['read']
        }) as { code: string }
      ).code
  )
}
if (CODES.length < 2) {
  console.error('TC_PAIR_CODES needs two fresh pairing codes (see the header)')
  process.exit(2)
}

/** One request over a contract socket: the hello, then the reply to `method`. */
async function overSocket(
  url: string,
  headers: Record<string, string>,
  method: string,
  params: unknown
): Promise<{
  hello: { environmentId: string; caps: string[]; contract: number }
  reply: { ok: boolean; result?: unknown; error?: string }
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as never)
    let hello: { environmentId: string; caps: string[]; contract: number } | null = null
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} in 20 s`)), 20_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data))
      if (frame.push === 'hello') hello = frame
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      // Settle before closing: Bun fires 'close' inside close() itself.
      if (hello) resolve({ hello, reply: frame })
      else reject(new Error('reply before hello'))
      ws.close()
    })
    ws.addEventListener('error', () => reject(new Error('socket error')))
    ws.addEventListener('close', (ev) => reject(new Error(`socket closed ${ev.code}`)))
  })
}

try {
  // ── plain HTTPS through Cloudflare ───────────────────────────────────────
  const health = await fetch(`${ORIGIN}/healthz`)
  check(
    '/healthz answers ok through the tunnel',
    health.status === 200 && (await health.text()) === 'ok',
    `HTTP ${health.status}`
  )
  const hello = (await (await fetch(`${ORIGIN}/api/hello`)).json()) as {
    environmentId: string
    name: string
    version: string
    contract: number
  }
  check(
    '/api/hello names the environment',
    /^env_[A-Za-z0-9_-]{22}$/.test(hello.environmentId),
    `${hello.environmentId} ${hello.name} v${hello.version} contract ${hello.contract}`
  )

  // ── bearer: code → key → ticket → /ws ────────────────────────────────────
  const keyRes = await fetch(`${ORIGIN}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODES[0], kind: 'key', name: `${runName} key` })
  })
  const keyBody = (await keyRes.json()) as {
    key?: string
    keyId?: string
    caps?: string[]
    environmentId?: string
    error?: string
  }
  check(
    'the first code exchanges for a bearer key',
    keyRes.status === 200 &&
      typeof keyBody.key === 'string' &&
      keyBody.environmentId === hello.environmentId,
    keyBody.error ?? `${keyBody.keyId} ${keyBody.caps?.join(',')}`
  )
  const ticketRes = await fetch(`${ORIGIN}/api/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keyBody.key}` }
  })
  const ticket = (await ticketRes.json()) as { ticket?: string; error?: string }
  check(
    'the key mints a ticket',
    ticketRes.status === 200 && typeof ticket.ticket === 'string',
    ticket.error ?? 'ok'
  )
  try {
    const { hello: h, reply } = await overSocket(
      `${wsOrigin}/ws?ticket=${ticket.ticket}`,
      {},
      'workspace.list',
      {}
    )
    check(
      '/ws upgrades on the ticket and answers workspace.list',
      reply.ok && h.environmentId === hello.environmentId && h.contract === hello.contract,
      `caps ${h.caps.join(',')}; ${Array.isArray(reply.result) ? reply.result.length : '?'} workspaces`
    )
  } catch (err) {
    check('/ws upgrades on the ticket and answers workspace.list', false, (err as Error).message)
  }
  check(
    'a spent code is refused',
    (
      await fetch(`${ORIGIN}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: CODES[0], kind: 'key' })
      })
    ).status === 401
  )

  // ── a real Chrome on /pair → cookie → /ws, then /ui ──────────────────────
  rmSync(CHROME_PROFILE, { recursive: true, force: true })
  const chrome = Bun.spawn(
    [
      CHROME,
      `--user-data-dir=${CHROME_PROFILE}`,
      `--remote-debugging-port=${CHROME_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  )
  try {
    let tab: { webSocketDebuggerUrl?: string; type: string } | undefined
    for (let i = 0; i < 60 && !tab; i++) {
      try {
        const list = (await (
          await fetch(`http://127.0.0.1:${CHROME_PORT}/json`)
        ).json()) as (typeof tab)[]
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
    await page.send('Page.navigate', { url: `${ORIGIN}/pair#${CODES[1]}` })
    await until(
      `document.getElementById('code')?.value === ${JSON.stringify(CODES[1])}`,
      20_000,
      'the pair page with the code prefilled'
    )
    check('Chrome loads /pair through the tunnel with the code prefilled', true)
    await page.eval(`document.getElementById('f').requestSubmit()`)
    await until(
      `location.pathname === '/ui/' || location.hostname.endsWith('cloudflareaccess.com')`,
      20_000,
      'leaving /pair'
    )
    const landed = await page.eval<string>('location.href')
    const gated = landed.includes('cloudflareaccess.com')
    check(
      `sign-in leaves /pair for ${gated ? 'the Cloudflare Access gate' : '/ui/'}`,
      true,
      landed.slice(0, 80)
    )
    const cookies = (await page.send('Network.getCookies', { urls: [`${ORIGIN}/`] })) as {
      cookies: {
        name: string
        httpOnly: boolean
        secure: boolean
        sameSite?: string
        value: string
      }[]
    }
    const session = cookies.cookies.find((c) => c.name === 'tc_session')
    check(
      'the session cookie is set, HttpOnly, Secure, SameSite=Lax',
      !!session && session.httpOnly && session.secure && session.sameSite === 'Lax',
      JSON.stringify({
        httpOnly: session?.httpOnly,
        secure: session?.secure,
        sameSite: session?.sameSite
      })
    )
    if (session) {
      try {
        const { hello: h, reply } = await overSocket(
          `${wsOrigin}/ws`,
          { cookie: `tc_session=${session.value}`, origin: ORIGIN },
          'workspace.list',
          {}
        )
        check(
          '/ws upgrades on the cookie and answers workspace.list',
          reply.ok && h.environmentId === hello.environmentId && h.contract === hello.contract,
          `caps ${h.caps.join(',')}`
        )
      } catch (err) {
        check(
          '/ws upgrades on the cookie and answers workspace.list',
          false,
          (err as Error).message
        )
      }
    }
    if (!gated) {
      await until(`!!window.__monocode?.server?.connected`, 30_000, 'the browser socket to open')
      check('the /ui bundle opened its WebSocket on the cookie', true)
    } else {
      log('/ui is behind Cloudflare Access: check it from a browser signed into Access')
    }
    const shot = (await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
    check('screenshot written', existsSync(SHOT), SHOT)
  } catch (err) {
    check('the Chrome flow', false, (err as Error).message)
  } finally {
    chrome.kill()
  }
} finally {
  if (automatic) {
    try {
      const keys = local('remote.keys.list') as { id: string; name: string }[]
      for (const key of keys.filter((key) => key.name.startsWith(runName)))
        local('remote.keys.revoke', { id: key.id })
      const pairings = local('remote.pairings.list') as { id: string; name: string }[]
      for (const pairing of pairings.filter((pairing) => pairing.name.startsWith(runName)))
        local('remote.pairings.revoke', { id: pairing.id })
      check('test keys and pairings revoked', true)
    } catch {
      check('test credential cleanup', false)
    }
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
