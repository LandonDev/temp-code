#!/usr/bin/env node
/**
 * M2a exit test. Drives the dev instance over CDP (port 9226) and exercises
 * everything the milestone put on `window.api`: a real shell, a 6 MB read
 * under byte-credit flow control, the menu, zoom, the dock badge and the
 * window facade.
 *
 *   node scripts/m2a-cdp.mjs [port]
 */
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const PORT = Number(process.argv[2] || 9226)
const BIG = '/tmp/m2a-big.txt'
const BIG_LINES = 120000

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

function targets() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: '/json' }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await targets()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // the instance is still coming up
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`no CDP page on ${PORT}`)
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** Runs an async expression in the page and returns its JSON value. */
  async eval(expression, timeoutMs = 120000) {
    const res = await Promise.race([
      this.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true
      }),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('eval timed out')), timeoutMs))
    ])
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'page threw')
    }
    return res.result.value
  }
}

function makeBigFile() {
  const parts = []
  for (let i = 1; i <= BIG_LINES; i++) parts.push(`${i} ${'x'.repeat(40)}`)
  const text = parts.join('\n') + '\n'
  writeFileSync(BIG, text)
  return { bytes: Buffer.byteLength(text), lines: BIG_LINES }
}

// Collector installed in the page: keeps per-id byte totals and text, and
// acks lazily so main's pause/resume path actually fires.
const INSTALL = `
  window.__m2a = { out: new Map(), exits: new Map(), menu: [], bytes: new Map() }
  const dec = new TextDecoder()
  if (window.__m2aOff) window.__m2aOff.forEach((f) => f())
  window.__m2aOff = []
  window.__m2aOff.push(window.api.pty.onData((id, data) => {
    const m = window.__m2a
    m.out.set(id, (m.out.get(id) || '') + dec.decode(data, { stream: true }))
    m.bytes.set(id, (m.bytes.get(id) || 0) + data.length)
    const owed = (m.owed ||= new Map())
    const timers = (m.timers ||= new Map())
    owed.set(id, (owed.get(id) || 0) + data.length)
    const flushAck = () => {
      const n = owed.get(id) || 0
      if (!n) return
      owed.set(id, 0)
      window.api.pty.ack(id, n)
    }
    clearTimeout(timers.get(id))
    // Lazy on purpose: 256 KiB at a time, 20 ms late, so main really does
    // hit the high-water mark. The longer timer pays off the tail, which is
    // what lets a paused pty resume once the flood stops.
    timers.set(id, setTimeout(flushAck, owed.get(id) >= 256 * 1024 ? 20 : 150))
  }))
  window.__m2aOff.push(window.api.pty.onExit((id, code) => window.__m2a.exits.set(id, code)))
  window.__m2aOff.push(window.api.menu.onCommand((id) => window.__m2a.menu.push(id)))
  return 'installed'
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const big = makeBigFile()
  // The asset protocol only serves <userData>/project-logos.
  const logos = join(
    process.env.TEMP_CODE_USER_DATA ||
      join(process.env.HOME, 'Library', 'Application Support', 'temp-code-dev2'),
    'project-logos'
  )
  mkdirSync(logos, { recursive: true })
  writeFileSync(join(logos, 'm2a-probe.txt'), 'm2a asset probe\n')
  const page = await findPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  check('cdp: page attached', (await cdp.eval("return typeof window.api")) === 'object')
  await cdp.eval(INSTALL)

  // (a) a shell in a chosen cwd, resize, clean exit
  const missing = await cdp.eval(
    "return await window.api.pty.spawn({ id: 'a', cwd: '/tmp', cols: 80, rows: 24 })"
  )
  check('a: spawn in /tmp reports no missing dir', missing === null, `returned ${missing}`)
  await cdp.eval("await window.api.pty.write('a', 'pwd\\n')")
  await sleep(1200)
  let out = await cdp.eval("return window.__m2a.out.get('a') || ''")
  check('a: pwd echoes /tmp', /(^|\n)\/(private\/)?tmp\r?\n/.test(out), JSON.stringify(out.slice(-60)))

  await cdp.eval("await window.api.pty.resize('a', 120, 40)")
  await sleep(200)
  await cdp.eval("window.__m2a.out.set('a', ''); await window.api.pty.write('a', 'stty size\\n')")
  await sleep(1000)
  out = await cdp.eval("return window.__m2a.out.get('a') || ''")
  check('a: resize to 120x40 reaches the tty', /40 120/.test(out), JSON.stringify(out.slice(-40)))

  const status = await cdp.eval("return await window.api.pty.status('a')")
  check('a: status of an idle shell is null', status && status.foreground === null, JSON.stringify(status))

  // A running command should name itself; the shell alone should not.
  await cdp.eval("await window.api.pty.write('a', 'sleep 20\\n')")
  await sleep(1200)
  const busy = await cdp.eval("return await window.api.pty.status('a')")
  check('a: status names the foreground command', busy && busy.foreground === 'sleep', JSON.stringify(busy))
  // Interrupt it, then clear $? so the shell's own exit is a clean 0.
  await cdp.eval("await window.api.pty.write('a', '\\u0003')")
  await sleep(500)
  await cdp.eval("await window.api.pty.write('a', 'true\\n')")
  await sleep(500)

  // A cwd that does not exist falls back to $HOME and says so.
  const home = await cdp.eval('return await window.api.app.homeDir()')
  const fallback = await cdp.eval(
    "return await window.api.pty.spawn({ id: 'm', cwd: '/nope/does/not/exist', cols: 80, rows: 24 })"
  )
  await sleep(800)
  await cdp.eval("window.__m2a.out.set('m',''); await window.api.pty.write('m', 'pwd\\n')")
  await sleep(1000)
  const homeOut = await cdp.eval("return window.__m2a.out.get('m') || ''")
  check(
    'a: a missing cwd falls back to home and reports the missing path',
    fallback === '/nope/does/not/exist' && homeOut.includes(home),
    `returned ${fallback}`
  )
  await cdp.eval("await window.api.pty.kill('m')")

  await cdp.eval("await window.api.pty.write('a', 'exit\\n')")
  await sleep(1500)
  const code = await cdp.eval("return window.__m2a.exits.has('a') ? window.__m2a.exits.get('a') : 'none'")
  check('a: exit reports code 0', code === 0, `code ${code}`)

  // (b) 6 MB through the batching + credit path, in order
  const before = await cdp.eval('return await window.api.debug.ptyFlow()')
  await cdp.eval("return await window.api.pty.spawn({ id: 'b', cwd: '/tmp', cols: 200, rows: 50 })")
  await sleep(600)
  await cdp.eval(
    `window.__m2a.out.set('b',''); window.__m2a.bytes.set('b',0); await window.api.pty.write('b', 'cat ${BIG}\\n')`
  )
  // Wait for the byte count to stop growing (three quiet polls in a row, so
  // a paused pty waiting on the ack tail is not mistaken for the end).
  let last = -1
  let quiet = 0
  for (let i = 0; i < 240; i++) {
    await sleep(500)
    const n = await cdp.eval("return window.__m2a.bytes.get('b') || 0")
    quiet = n === last && n > 0 ? quiet + 1 : 0
    last = n
    if (quiet >= 3) break
  }
  const verdict = await cdp.eval(`
    const text = window.__m2a.out.get('b') || ''
    let seen = 0, expected = 1, bad = null
    for (const line of text.split('\\n')) {
      // The macOS line discipline sprinkles an extra CR into a long run of
      // output; tolerate any number of them.
      const m = /^(\\d+) x{40}\\r*$/.exec(line)
      if (!m) continue
      seen++
      if (Number(m[1]) !== expected) { bad = bad ?? (m[1] + ' at ' + expected); }
      expected = Number(m[1]) + 1
    }
    return { seen, bad, bytes: window.__m2a.bytes.get('b') || 0 }
  `)
  check(
    'b: all 6 MB arrived, in order',
    verdict.seen === big.lines && verdict.bad === null,
    `${verdict.seen}/${big.lines} lines, ${verdict.bytes} bytes received for a ${big.bytes}-byte file (the tty turns every LF into CRLF), out-of-order: ${verdict.bad}`
  )
  const after = await cdp.eval('return await window.api.debug.ptyFlow()')
  check(
    'b: main paused and resumed the pty',
    after.pauses > before.pauses && after.resumes > before.resumes,
    `pauses ${before.pauses}->${after.pauses}, resumes ${before.resumes}->${after.resumes}`
  )
  await cdp.eval("await window.api.pty.kill('b')")

  // (c) menu wiring
  await cdp.eval("window.__m2a.menu.length = 0")
  const clicked = await cdp.eval("return await window.api.debug.menuClick('open_settings')")
  await sleep(300)
  const menu = await cdp.eval('return window.__m2a.menu')
  check('c: open_settings reaches the page', clicked === true && menu.includes('open_settings'), JSON.stringify(menu))

  // (d) zoom
  const w0 = await cdp.eval('return document.documentElement.clientWidth')
  await cdp.eval('await window.api.win.setZoom(1.25)')
  await sleep(300)
  const w1 = await cdp.eval('return document.documentElement.clientWidth')
  await cdp.eval('await window.api.win.setZoom(1)')
  await sleep(300)
  const w2 = await cdp.eval('return document.documentElement.clientWidth')
  check('d: zoom 1.25 shrinks layout width and 1.0 restores it', w1 < w0 && w2 === w0, `${w0} -> ${w1} -> ${w2}`)

  // (e) dock badge
  await cdp.eval('await window.api.app.dockBadge(3)')
  await sleep(200)
  const badge3 = await cdp.eval('return await window.api.debug.dockBadge()')
  await cdp.eval('await window.api.app.dockBadge(0)')
  await sleep(200)
  const badge0 = await cdp.eval('return await window.api.debug.dockBadge()')
  check('e: dock badge follows the count', badge3 === '3' && badge0 === '', `"${badge3}" then "${badge0}"`)

  // (f) app info
  const info = await cdp.eval(`return {
    home: await window.api.app.homeDir(),
    cwd: await window.api.app.defaultCwd(),
    version: await window.api.app.version()
  }`)
  check(
    'f: home/cwd/version are sane strings',
    info.home.startsWith('/') && info.cwd.startsWith('/') && /\d/.test(info.version),
    JSON.stringify(info)
  )

  // (g) window facade
  const flags = await cdp.eval(`return {
    focused: await window.api.win.isFocused(),
    maximized: await window.api.win.isMaximized()
  }`)
  check(
    'g: is-focused/is-maximized are booleans',
    typeof flags.focused === 'boolean' && typeof flags.maximized === 'boolean',
    JSON.stringify(flags)
  )
  await cdp.eval("await window.api.win.setTitle('M2a title probe')")
  await sleep(200)
  const title = await cdp.eval('return await window.api.debug.windowTitle()')
  check('g: set-title changes the native title', title === 'M2a title probe', `native title "${title}"`)

  // tempcode-asset:// serves the logo dir and nothing else. The page's own
  // CSP (the OLD renderer's) forbids the scheme, so this goes through main.
  const served = await cdp.eval(
    "return await window.api.debug.assetFetch('tempcode-asset://logo/m2a-probe.txt')"
  )
  const escaped = await cdp.eval(
    "return await window.api.debug.assetFetch('tempcode-asset://logo/../../Preferences')"
  )
  check(
    'i: asset protocol serves the logo dir and refuses to escape it',
    served.status === 200 && served.body === 'm2a asset probe\n' && escaped.status === 404,
    `${JSON.stringify(served)} / ${JSON.stringify(escaped)}`
  )

  // asset URL helper mirrors main
  const url = await cdp.eval("return window.api.app.logoUrl('/x/y/My Logo.png')")
  check('h: logo URL helper', url === 'tempcode-asset://logo/My%20Logo.png', url)

  // The transfer slot is bound to the next window that opens, so the window
  // that staged it cannot take it back.
  await cdp.eval("await window.api.win.stageTransfer({ probe: 1 })")
  const stolen = await cdp.eval('return await window.api.win.takeTransfer()')
  check('j: a staged transfer is not readable by the staging window', stolen === null, JSON.stringify(stolen))

  await cdp.eval('await window.api.pty.killAll()')
  ws.close()
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('exit test crashed:', e.message)
  process.exit(1)
})
