/**
 * Drive the isolated dev instance over CDP (bun, the global WebSocket) and
 * confirm the LOCAL renderer still paints the seeded busy thread: tool
 * rows, edit rows that open onto their diff, tool details that open onto
 * their output, an html render frame. Writes /tmp/wire-local.png.
 *
 *   bun scripts/wire-cdp-check.ts 9228
 */
const port = Number(process.argv[2] ?? 9228)
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
  type: string
  url: string
  webSocketDebuggerUrl: string
}[]
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools') && !t.url.includes('migrate.html'))
if (!page) throw new Error(`no page target on ${port}: ${JSON.stringify(targets.map((t) => t.url))}`)
console.log(`page ${page.url}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  ws.onerror = () => reject(new Error('cdp socket error'))
})
let nextId = 1
const pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>()
const errors: string[] = []
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify((msg.params as { exceptionDetails?: { text?: string } }).exceptionDetails?.text ?? msg.params))
  if (msg.method === 'Runtime.consoleAPICalled') {
    const p = msg.params as { type: string; args: { value?: unknown; description?: string }[] }
    if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' '))
  }
}
const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async <T>(expression: string): Promise<T> => {
  const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
    result: { value: T }
    exceptionDetails?: { text: string; exception?: { description?: string } }
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const checks: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

await send('Runtime.enable')
await send('Page.enable')
for (let i = 0; i < 60; i++) {
  const ready = await evaluate<boolean>('!!window.__app && window.__app.store.metas().length > 0').catch(() => false)
  if (ready) break
  await sleep(500)
}
const serverPort = await evaluate<number>('window.api.getServerPort()')
const metas = await evaluate<number>('window.__app.store.metas().length')
console.log(`server port ${serverPort}; ${metas} metas listed`)
check('shell lists the seeded threads', metas >= 600, `${metas} metas (800 shell threads, half archived, plus the fleet)`)

await evaluate('window.__app.openSession("wire-busy")')
await sleep(2500)
const painted = await evaluate<{ tools: number; edits: number; frames: number; blocks: number }>(`(() => ({
  tools: document.querySelectorAll('[aria-label^="Tool call:"]').length,
  edits: document.querySelectorAll('.edit-row').length,
  frames: document.querySelectorAll('iframe[src^="tempcode-asset://page/"]').length,
  blocks: (window.__app.store.get('wire-busy')?.blocks ?? []).length
}))()`)
console.log(JSON.stringify(painted))
check('transcript folded', painted.blocks > 100, `${painted.blocks} blocks`)
check('tool rows painted', painted.tools > 0, `${painted.tools} tool rows in the window`)
check('edit rows painted', painted.edits > 0, `${painted.edits} edit rows`)

// Edits open onto their diff.
const diffRows = await evaluate<number>(`(async () => {
  const btn = document.querySelector('.edit-row button[aria-label="Show diff"]');
  if (!btn) return -1;
  const row = btn.closest('.edit-row');
  const before = row.querySelectorAll('*').length;
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  return btn.getAttribute('aria-expanded') === 'true' ? row.querySelectorAll('*').length - before : -2;
})()`)
check('an edit row opens onto its diff', diffRows > 20, `${diffRows} elements added by the opened diff body`)

// Tool details open onto their output.
const details = await evaluate<{ opened: number; outputChars: number }>(`(async () => {
  const rows = [...document.querySelectorAll('[aria-label^="Tool call:"]')].filter((r) => r.classList.contains('cursor-pointer'));
  const row = rows[rows.length - 1];
  if (!row) return { opened: -1, outputChars: 0 };
  row.click();
  await new Promise((r) => setTimeout(r, 500));
  const body = row.parentElement && row.parentElement.querySelector('pre');
  return { opened: document.querySelectorAll('[aria-expanded="true"]').length, outputChars: body ? body.textContent.length : 0 };
})()`)
check('a tool row opens onto its output', details.outputChars > 0, `${details.outputChars} characters of output shown`)

// An html render frame: scroll earlier pages in until one is in the window.
let frames = painted.frames
for (let i = 0; i < 8 && frames === 0; i++) {
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Load earlier')); if (b) b.click(); })()`)
  await sleep(600)
  frames = await evaluate<number>(`document.querySelectorAll('iframe[src^="tempcode-asset://page/"]').length`)
}
check('an html render frame is in the transcript', frames > 0, `${frames} frames`)
if (frames > 0) {
  const loaded = await evaluate<{ src: string; height: number }>(`(() => { const f = document.querySelector('iframe[src^="tempcode-asset://page/"]'); return { src: f.src, height: f.getBoundingClientRect().height }; })()`)
  check('the frame has a page and a height', loaded.height >= 80, `${loaded.src} ${Math.round(loaded.height)}px`)
}

const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
await Bun.write('/tmp/wire-local.png', Buffer.from(shot.data, 'base64'))
console.log('screenshot /tmp/wire-local.png')
check('no renderer errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'none')
ws.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; server port ${serverPort}`)
process.exit(failed.length ? 1 : 0)
