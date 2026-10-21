/**
 * Attachments on a remote thread, for real: two isolated headless instances
 * of the BUILT tree (out/main), each with its own HOME, userData, Aliax vault
 * dir, TMPDIR and fixed port, launched the way scripts/e2e-harness-sync.ts
 * launches them (TEMP_CODE_HEADLESS=1; on Linux under xvfb-run and a private
 * D-Bus). "mac" holds the file on its disk; "box" runs the thread. This
 * script plays the desktop renderer: it reads the file off mac's local
 * socket in ranges (attachment.digest / attachment.readRange, what
 * lib/attachmentUpload.ts does for a picked file) and streams it to box over
 * box's REMOTE socket (/api/ticket → /ws?ticket=…) under a client key with
 * read+operate, the way the Mac's link to the box carries it. Then:
 *  - a 5 MiB + 17 byte file crosses in 2 MiB chunks, each awaited, and
 *    lands byte for byte under <project cwd>/.temp-code/attachments/<sid>/
 *  - a second upload of the same name lands de-duplicated (name-1.ext)
 *  - a chunk out of order, a short commit and a wrong sha256 are refused
 *  - session.send with the landed path passes the fence and the stored user
 *    row carries it; session.send and queue.add with a Mac-style path
 *    outside the roots are refused with the typed fence error
 *  - a read-only key cannot begin an upload (operate), and readRange of a
 *    path outside the roots is fenced
 *  - an upload left uncommitted expires (TEMP_CODE_ATTACHMENT_TTL_MS) with
 *    its partial file, and a chunk after that answers "unknown upload"
 *  - deleting the thread removes its attachment directory
 * Run: bun scripts/e2e-attachments.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault or the box's live temp-code.service. Provider calls go to a
 * dead loopback origin (TEMP_CODE_FAKE_PROVIDERS), so no turn reaches a model.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_ATT_KEEP === '1'
const TTL_MS = 4_000
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

// realpath: on macOS tmpdir() is a symlink under /var, and the fence compares real paths.
const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-attach-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), remote: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')

// The file on the Mac's disk, and the repo the box's thread works in.
const BIG = randomBytes(5 * 1024 * 1024 + 17)
const macFile = join(mac.home, 'Desktop', 'Quarterly Report.pdf')
mkdirSync(join(mac.home, 'Desktop'), { recursive: true })
writeFileSync(macFile, BIG)
const repo = join(box.home, 'work', 'shop')
mkdirSync(repo, { recursive: true })
writeFileSync(join(repo, 'README.md'), '# shop\n')
Bun.spawnSync(['git', 'init', '-q', repo])

function launch(inst: Inst): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_ATTACHMENT_TTL_MS: String(TTL_MS),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 120_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${inst.name}: ${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

type Answer = { ok: boolean; result?: unknown; error?: string }
/** A remote client's socket on an instance's fixed port: bearer → ticket → /ws?ticket=…. */
async function remoteSocket(inst: Inst, key: string): Promise<{ call: (method: string, params?: unknown, ms?: number) => Promise<Answer>; close: () => void }> {
  const base = `http://127.0.0.1:${inst.remote}`
  const res = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })
  const { ticket } = (await res.json()) as { ticket: string }
  const ws = new WebSocket(`ws://127.0.0.1:${inst.remote}/ws?ticket=${ticket}`)
  const waiting = new Map<string, (a: Answer) => void>()
  let hello: (() => void) | null = null
  const helloSeen = new Promise<void>((r) => (hello = r))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { id?: string; push?: string; ok?: boolean; result?: unknown; error?: string }
    if (frame.push === 'hello') hello?.()
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)!({ ok: !!frame.ok, result: frame.result, error: frame.error })
      waiting.delete(frame.id)
    }
  })
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error(`${inst.name}: remote socket failed`)))
  })
  await helloSeen
  let next = 1
  const call = (method: string, params: unknown = {}, ms = 60_000): Promise<Answer> =>
    new Promise((ok) => {
      const id = `r${next++}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        ok({ ok: false, error: `timeout: ${method}` })
      }, ms)
      waiting.set(id, (a) => {
        clearTimeout(timer)
        ok(a)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { call, close: () => ws.close() }
}

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const cleanup = async (): Promise<void> => {
  kill(mac)
  kill(box)
  await sleep(1500)
  for (const inst of [mac, box]) {
    try {
      if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

launch(mac)
launch(box)
try {
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const boxStatus = await rpc<{ environmentId: string; port: number; running: boolean }>(box, 'remote.status')
  check('box: the fixed-port listener is up on its own port', boxStatus.running && boxStatus.port === box.remote, JSON.stringify(boxStatus))
  log(`logs ${mac.log} ${box.log}`)

  // ── the box's project and thread (admin, over its local socket) ──────
  const ws = await rpc<{ id: string }>(box, 'workspace.create', { path: repo, name: 'shop' })
  const project = await rpc<{ id: string; cwd: string }>(box, 'project.create', { workspaceId: ws.id, name: 'shop', mode: 'local' })
  const thread = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', model: 'claude-haiku-5-5', projectId: project.id, threadType: 'chat', permission: 'edits', title: 'attachments e2e' })
  const threadDir = join(project.cwd, '.temp-code', 'attachments', thread.id)
  log(`box project ${project.cwd}, thread ${thread.id}`)

  // ── keys: operate for the upload, read to prove the gate ─────────────
  const operate = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate'] })
  const reader = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'reader (e2e)', audience: 'client', caps: ['read'] })
  const remote = await remoteSocket(box, operate.token)
  const readOnly = await remoteSocket(box, reader.token)

  // ── 1. the upload: read ranges off mac, chunk into box ───────────────
  const settings = (await remote.call('attachment.settings', {})).result as { maxBytes: number; chunkBytes: number }
  check('box answers its attachment limit and chunk size', settings?.maxBytes === 200 * 1024 * 1024 && settings.chunkBytes === 2 * 1024 * 1024, JSON.stringify(settings))
  const digest = await rpc<{ size: number; sha256: string }>(mac, 'attachment.digest', { path: macFile })
  check('mac digests the file on its own disk', digest.size === BIG.length && digest.sha256 === sha(BIG))

  const upload = async (name: string, bytes: number, sha256: string): Promise<{ answer: Answer; chunks: number }> => {
    const begun = await remote.call('attachment.begin', { sessionId: thread.id, name, size: bytes, sha256, mime: 'application/pdf' })
    if (!begun.ok) return { answer: begun, chunks: 0 }
    const { uploadId, chunkBytes } = begun.result as { uploadId: string; chunkBytes: number }
    let chunks = 0
    for (let offset = 0, index = 0; offset < bytes; offset += chunkBytes, index += 1) {
      const range = await rpc<{ dataBase64: string }>(mac, 'attachment.readRange', { path: macFile, offset, length: Math.min(chunkBytes, bytes - offset) })
      const sent = await remote.call('attachment.chunk', { uploadId, index, dataBase64: range.dataBase64 })
      if (!sent.ok) return { answer: sent, chunks }
      chunks += 1
    }
    return { answer: await remote.call('attachment.commit', { uploadId }), chunks }
  }
  const first = await upload('Quarterly Report.pdf', digest.size, digest.sha256)
  const landed = first.answer.result as { path: string; name: string; size: number; kind: string; mime?: string } | undefined
  check('a 5 MiB file crossed in three awaited 2 MiB chunks and committed', first.answer.ok && first.chunks === 3, first.answer.error ?? JSON.stringify(landed))
  check('it landed under <project cwd>/.temp-code/attachments/<sessionId>/, the name sanitized', landed?.path === join(threadDir, 'Quarterly_Report.pdf') && landed.size === BIG.length && landed.mime === 'application/pdf', landed?.path)
  check('byte for byte', !!landed && existsSync(landed.path) && readFileSync(landed.path).equals(BIG))
  check('no partial file left in the thread dir', readdirSync(threadDir).every((n) => !n.endsWith('.part')), readdirSync(threadDir).join(','))
  const again = await upload('Quarterly Report.pdf', digest.size, digest.sha256)
  check('the same name again lands de-duplicated', (again.answer.result as { name?: string })?.name === 'Quarterly_Report-1.pdf', JSON.stringify(again.answer))

  // ── 2. refusals the store owns ───────────────────────────────────────
  const small = Buffer.from('hello box')
  const b1 = (await remote.call('attachment.begin', { sessionId: thread.id, name: 'a.txt', size: small.length, sha256: sha(small) })).result as { uploadId: string }
  const skip = await remote.call('attachment.chunk', { uploadId: b1.uploadId, index: 1, dataBase64: small.toString('base64') })
  check('a chunk out of order is refused', !skip.ok && /out of order/.test(skip.error ?? ''), skip.error)
  await remote.call('attachment.chunk', { uploadId: b1.uploadId, index: 0, dataBase64: small.subarray(0, 4).toString('base64') })
  const short = await remote.call('attachment.commit', { uploadId: b1.uploadId })
  check('a commit short of the declared size is refused', !short.ok && /received 4 of 9 bytes/.test(short.error ?? ''), short.error)
  const b2 = (await remote.call('attachment.begin', { sessionId: thread.id, name: 'b.txt', size: small.length, sha256: sha(Buffer.from('other')) })).result as { uploadId: string }
  await remote.call('attachment.chunk', { uploadId: b2.uploadId, index: 0, dataBase64: small.toString('base64') })
  const wrong = await remote.call('attachment.commit', { uploadId: b2.uploadId })
  check('a commit whose sha256 does not match is refused, nothing landed', !wrong.ok && /sha256/.test(wrong.error ?? '') && !existsSync(join(threadDir, 'b.txt')), wrong.error)
  const tooBig = await remote.call('attachment.begin', { sessionId: thread.id, name: 'huge.bin', size: settings.maxBytes + 1, sha256: sha(small) })
  check('a size over attachment.maxBytes is refused at begin', !tooBig.ok && /too large/.test(tooBig.error ?? ''), tooBig.error)
  const denied = await readOnly.call('attachment.begin', { sessionId: thread.id, name: 'a.txt', size: 1, sha256: sha(small) })
  check('a read-only key cannot begin an upload', !denied.ok && denied.error === 'forbidden: attachment.begin needs operate', denied.error)
  const fenced = await remote.call('attachment.readRange', { path: '/etc/hostname', offset: 0, length: 10 })
  check('a remote readRange outside the roots is fenced', !fenced.ok && fenced.error === 'forbidden: attachment.readRange is outside app-managed roots', fenced.error)

  // ── 3. the turn: the landed path passes the fence; a Mac path does not ──
  const macPath = '/Users/landon/Desktop/Quarterly Report.pdf'
  const refusedSend = await remote.call('session.send', { sessionId: thread.id, text: 'read this', attachments: [{ path: macPath, name: 'Quarterly Report.pdf', kind: 'file' }] })
  check('session.send with a Mac path is refused by the fence', !refusedSend.ok && refusedSend.error === 'forbidden: session.send is outside app-managed roots', refusedSend.error)
  const refusedQueue = await remote.call('queue.add', { sessionId: thread.id, text: 'read this', attachments: [{ path: macPath, name: 'Quarterly Report.pdf', kind: 'file' }] })
  check('queue.add with a Mac path is refused by the fence', !refusedQueue.ok && refusedQueue.error === 'forbidden: queue.add is outside app-managed roots', refusedQueue.error)
  check('the refusal never names the path', !(refusedSend.error ?? '').includes('/Users'))
  // The send itself may fail later inside the turn (no model is reachable
  // here); what matters is that the fence let it through and the stored user
  // row names the path on the box.
  const sent = await remote.call('session.send', { sessionId: thread.id, text: 'read the attached report', attachments: [{ path: landed!.path, name: landed!.name, mime: 'application/pdf', kind: 'file' }] }, 30_000)
  check('session.send with the landed path passes the fence', sent.ok || !/outside app-managed roots/.test(sent.error ?? ''), sent.error ?? 'ok')
  const recorded = await until('the user row with the attachment', 20_000, async () => {
    const page = await rpc<unknown>(box, 'session.events', { sessionId: thread.id, afterSeq: 0 })
    const rows = (Array.isArray(page) ? page : (page as { rows?: unknown[] }).rows ?? []) as { event?: { type?: string; attachments?: { path: string }[] } }[]
    return rows.some((r) => r.event?.attachments?.some((a) => a.path === landed!.path))
  })
  check("the thread's stored user turn carries the box path", recorded)

  // ── 4. expiry: an upload left uncommitted goes, with its partial ─────
  const stale = (await remote.call('attachment.begin', { sessionId: thread.id, name: 'stale.bin', size: 100, sha256: sha(Buffer.alloc(100)) })).result as { uploadId: string }
  await remote.call('attachment.chunk', { uploadId: stale.uploadId, index: 0, dataBase64: Buffer.alloc(40).toString('base64') })
  check('the partial file sits hidden in the thread dir while the upload lives', readdirSync(threadDir).some((n) => n.startsWith('.upload-') && n.endsWith('.part')))
  const expired = await until('the stale upload expires', TTL_MS * 4, () => readdirSync(threadDir).every((n) => !n.endsWith('.part')))
  check(`an uncommitted upload expired after ${TTL_MS / 1000} s idle, its partial removed`, expired, readdirSync(threadDir).join(','))
  const late = await remote.call('attachment.chunk', { uploadId: stale.uploadId, index: 1, dataBase64: Buffer.alloc(60).toString('base64') })
  check('a chunk after the expiry answers unknown upload', !late.ok && /unknown upload/.test(late.error ?? ''), late.error)

  // ── 5. deleting the thread sweeps its directory ──────────────────────
  remote.close()
  readOnly.close()
  await rpc(box, 'session.delete', { sessionId: thread.id })
  check("deleting the thread removed its attachment directory", await until('the dir goes', 10_000, () => !existsSync(threadDir)))
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
