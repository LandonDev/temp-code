/**
 * The renderer itself as a REMOTE client: navigate the dev window to
 * `?profile=remote`, open the seeded busy thread, and confirm the rows
 * paint from summaries, fetch their bodies when opened, page older
 * history in on demand, and still show html renders. Navigates back to
 * the local profile at the end. Writes /tmp/wire-remote.png.
 *
 *   bun scripts/wire-cdp-remote.ts 9228
 */
const port = Number(process.argv[2] ?? 9228)
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:5173'))
if (!page) throw new Error(`no dev page on ${port}`)
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
const waitFor = async (expression: string, ms = 20_000): Promise<boolean> => {
  for (let t = 0; t < ms; t += 300) {
    if (await evaluate<boolean>(expression).catch(() => false)) return true
    await sleep(300)
  }
  return false
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: 'http://localhost:5173/?profile=remote' })
await sleep(1500)
check('renderer booted as a remote client', await waitFor('!!window.__app && window.__app.store.metas().length > 0'), await evaluate<string>('location.search').catch(() => '?'))
await sleep(1000)
const metas = await evaluate<number>('window.__app.store.metas().length')
check('shell lists every page of the list', metas >= 600, `${metas} metas`)

await evaluate('window.__app.openSession("wire-busy")')
await sleep(2500)
const painted = await evaluate<{ tools: number; edits: number; frames: number; blocks: number; omitted: number; older: boolean }>(`(() => {
  const s = window.__app.store.get('wire-busy');
  const blocks = s ? s.blocks : [];
  return {
    tools: document.querySelectorAll('[aria-label^="Tool call:"]').length,
    edits: document.querySelectorAll('.edit-row').length,
    frames: document.querySelectorAll('iframe[src^="tempcode-asset://page/"]').length,
    blocks: blocks.length,
    omitted: blocks.filter((b) => b.tool && b.tool.omitted).length,
    older: !!document.querySelector('button') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Load earlier'))
  };
})()`)
console.log(JSON.stringify(painted))
check('the tail painted from summaries', painted.blocks > 100 && painted.omitted > 0, `${painted.blocks} blocks, ${painted.omitted} with bodies still on the server`)
check('tool and edit rows painted', painted.tools > 0 && painted.edits > 0, `${painted.tools} tool rows, ${painted.edits} edit rows`)

// A tool row with an omitted output: open it, watch the note, then the body.
const toolResult = await evaluate<{ id: string; before: number; note: boolean; after: number; omittedAfter: boolean; loadedChars: number }>(`(async () => {
  const s = window.__app.store.get('wire-busy');
  const block = [...s.blocks].reverse().find((b) => b.tool && b.tool.omitted && b.tool.name === 'Bash');
  if (!block) return { id: '', before: -1, note: false, after: -1, omittedAfter: false, loadedChars: 0 };
  const row = document.querySelector('[data-block="' + block.id + '"] [aria-label^="Tool call:"]');
  if (!row) return { id: block.id, before: -2, note: false, after: -2, omittedAfter: false, loadedChars: 0 };
  const before = (block.tool.detail || '').length;
  row.click();
  await new Promise((r) => setTimeout(r, 120));
  const note = !!document.querySelector('[data-block="' + block.id + '"]') && document.querySelector('[data-block="' + block.id + '"]').textContent.includes('Loading');
  for (let i = 0; i < 40; i++) {
    const cur = window.__app.store.get('wire-busy').blocks.find((b) => b.id === block.id);
    if (cur && !cur.tool.omitted) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const cur = window.__app.store.get('wire-busy').blocks.find((b) => b.id === block.id);
  const pre = document.querySelector('[data-block="' + block.id + '"] pre');
  return { id: block.id, before, note, after: (cur.tool.detail || '').length, omittedAfter: !!cur.tool.omitted, loadedChars: pre ? pre.textContent.length : 0 };
})()`)
console.log(JSON.stringify(toolResult))
check('a tool row fetches its output on open', toolResult.before < 2048 && toolResult.after >= 2048 && !toolResult.omittedAfter, `detail ${toolResult.before} → ${toolResult.after} chars; note shown=${toolResult.note}; ${toolResult.loadedChars} chars in the opened body`)

// An edit row: counts in the header, diff after the fetch. Edit cards
// carry no data-block, so the row is found by itself and the store is
// read for how many edits still wait on their text.
const edit = await evaluate<{ header: string; omittedBefore: number; omittedAfter: number; added: number; expanded: string | null }>(`(async () => {
  const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
  const omittedEdits = () => window.__app.store.get('wire-busy').blocks.filter((b) => b.tool && b.tool.omitted && EDITS.includes(b.tool.name)).length;
  const omittedBefore = omittedEdits();
  const btn = document.querySelector('.edit-row button[aria-label="Show diff"]');
  if (!btn) return { header: 'no row', omittedBefore, omittedAfter: omittedBefore, added: -1, expanded: null };
  const row = btn.closest('.edit-row');
  const header = row.querySelector('.tabular-nums') ? row.querySelector('.tabular-nums').textContent : '';
  const before = row.querySelectorAll('*').length;
  btn.click();
  for (let i = 0; i < 40 && omittedEdits() === omittedBefore; i++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 900));
  return { header, omittedBefore, omittedAfter: omittedEdits(), added: row.querySelectorAll('*').length - before, expanded: btn.getAttribute('aria-expanded') };
})()`)
console.log(JSON.stringify(edit))
check('an edit row shows its counts and fetches its diff on open', /\d/.test(edit.header) && edit.omittedAfter === edit.omittedBefore - 1 && edit.added > 20 && edit.expanded === 'true', `header "${edit.header}", omitted edits ${edit.omittedBefore} → ${edit.omittedAfter}, ${edit.added} elements added`)

// Older history on demand.
const history = await evaluate<{ before: number; older: boolean; after: number; stillOlder: boolean }>(`(async () => {
  const before = window.__app.store.get('wire-busy').blocks.length;
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Load earlier'));
  const older = !!btn;
  for (let i = 0; i < 6 && window.__app.store.get('wire-busy').blocks.length === before; i++) {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Load earlier'));
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 700));
  }
  const after = window.__app.store.get('wire-busy').blocks.length;
  return { before, older, after, stillOlder: [...document.querySelectorAll('button')].some((x) => x.textContent.includes('Load earlier')) };
})()`)
console.log(JSON.stringify(history))
check('older history pages in on demand', history.older && history.after > history.before, `${history.before} → ${history.after} blocks`)

let frames = await evaluate<number>(`document.querySelectorAll('iframe[src^="tempcode-asset://page/"]').length`)
for (let i = 0; i < 6 && frames === 0; i++) {
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Load earlier')); if (b) b.click(); })()`)
  await sleep(700)
  frames = await evaluate<number>(`document.querySelectorAll('iframe[src^="tempcode-asset://page/"]').length`)
}
check('an html render frame paints on the remote profile', frames > 0, `${frames} frames`)

const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
await Bun.write('/tmp/wire-remote.png', Buffer.from(shot.data, 'base64'))
check('no renderer errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'none')

await send('Page.navigate', { url: 'http://localhost:5173/' })
await sleep(1500)
check('back on the local profile', await waitFor('!!window.__app && location.search === ""'), await evaluate<string>('location.search').catch(() => '?'))
ws.close()
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
