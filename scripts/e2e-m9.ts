import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { startServer, type RunningServer } from '../src/main/server'
import { BUILT_IN_DRIVERS } from '../src/main/server/drivers'
import type { ClientRequest } from '../src/shared/contract'

// M9 exit test: the six checkpoint.* WS methods against a running server.
// The claude driver is stubbed; no chat turn runs.
BUILT_IN_DRIVERS.claude = {
  id: 'claude',
  async start() {
    return { async send() {}, interrupt() {}, async dispose() {} }
  }
}
const responseSchema = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string() })
])
const statusSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string(),
          relative: z.string(),
          status: z.string(),
          additions: z.number(),
          deletions: z.number()
        })
        .strict()
    )
  })
  .strict()

class Client {
  readonly ws: WebSocket
  private sequence = 0
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => {
      const response = responseSchema.safeParse(JSON.parse(String(data)))
      if (!response.success) return
      const frame = response.data
      const waiter = this.pending.get(frame.id)
      if (!waiter) return
      this.pending.delete(frame.id)
      clearTimeout(waiter.timer)
      if (frame.ok) waiter.resolve(frame.result)
      else waiter.reject(new Error(frame.error))
    })
  }
  async ready(): Promise<void> {
    await once(this.ws, 'open')
  }
  request(method: ClientRequest['method'], params?: unknown): Promise<unknown> {
    const id = String(++this.sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
    })
  }
  async close(): Promise<void> {
    this.ws.close()
    await once(this.ws, 'close')
  }
}

const root = await mkdtemp(join(tmpdir(), 'tc-m9-'))
const dbPath = join(root, 'temp-code.db')
const repo = join(root, 'repo')
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], {
    encoding: 'utf8'
  })
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )
let server: RunningServer | undefined
let client: Client | undefined
const pass = (label: string): void => {
  console.log(`PASS  ${label}`)
}
try {
  await mkdir(repo)
  git('init', '-q', '-b', 'main')
  await writeFile(join(repo, 'a.txt'), 'a\n')
  await writeFile(join(repo, 'b.txt'), 'b\n')
  await writeFile(join(repo, 'gone.txt'), 'gone\n')
  await writeFile(join(repo, 'user.txt'), 'user\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  // The user's own edit, dirty before the session starts.
  await writeFile(join(repo, 'user.txt'), 'user edit\n')

  server = await startServer(dbPath)
  client = new Client(server.port)
  await client.ready()
  const session = 'm9-session'
  await client.request('session.create', { id: session, cwd: repo, provider: 'claude' })
  const scope = { sessionId: session, cwd: repo }

  const stored = join(root, 'checkpoints', session, 'manifest.json')
  await client.request('checkpoint.ensure', scope)
  assert.equal(await exists(stored), true, 'manifest lives under <dataDir>/checkpoints')
  pass('checkpoint.ensure writes the manifest beside the database')

  // Three edits (one modify, one staged modify, one new) and one delete.
  await writeFile(join(repo, 'a.txt'), 'a\nagent\n')
  await writeFile(join(repo, 'b.txt'), 'agent b\n')
  git('add', 'b.txt')
  await writeFile(join(repo, 'new.txt'), 'new\n')
  await unlink(join(repo, 'gone.txt'))
  await client.request('checkpoint.capture', { ...scope, paths: ['a.txt', join(repo, 'b.txt'), 'new.txt', 'gone.txt'] })
  await client.request('checkpoint.sync', scope)
  const status = statusSchema.parse(await client.request('checkpoint.status', scope))
  assert.deepEqual(
    status.files.map((f) => f.relative),
    ['a.txt', 'b.txt', 'gone.txt', 'new.txt']
  )
  assert.equal(status.files.find((f) => f.relative === 'a.txt')?.additions, 1)
  assert.equal(status.files.find((f) => f.relative === 'gone.txt')?.status, 'deleted')
  assert.ok(status.files.every((f) => f.path === join(repo, f.relative)))
  pass('checkpoint.status lists three edits and one delete, not the user edit')

  const kept = statusSchema.parse(await client.request('checkpoint.keep', { ...scope, relative: 'new.txt' }))
  assert.deepEqual(
    kept.files.map((f) => f.relative),
    ['a.txt', 'b.txt', 'gone.txt']
  )
  assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new\n')
  pass('checkpoint.keep drops one path from review and leaves the file')

  const one = statusSchema.parse(await client.request('checkpoint.undo', { ...scope, relative: 'gone.txt' }))
  assert.deepEqual(
    one.files.map((f) => f.relative),
    ['a.txt', 'b.txt']
  )
  assert.equal(await readFile(join(repo, 'gone.txt'), 'utf8'), 'gone\n')
  pass('checkpoint.undo restores a single deleted file')

  const all = statusSchema.parse(await client.request('checkpoint.undo', { ...scope, relative: null }))
  assert.deepEqual(all.files, [])
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'b\n')
  assert.equal(await readFile(join(repo, 'user.txt'), 'utf8'), 'user edit\n')
  assert.equal(await readFile(join(repo, 'new.txt'), 'utf8'), 'new\n', 'kept file survives undo-all')
  assert.equal(git('status', '--porcelain').trim(), ' M user.txt\n?? new.txt'.trim())
  assert.equal(git('diff', '--cached', '--name-only').trim(), '', 'staged edit left the index')
  assert.equal(await exists(join(root, 'checkpoints', session)), false)
  pass('checkpoint.undo restores bytes and index state and clears the session dir')

  const after = statusSchema.parse(await client.request('checkpoint.status', scope))
  assert.deepEqual(after.files, [])
  await assert.rejects(client.request('checkpoint.status', { sessionId: '../x', cwd: repo }), /bad request/)
  await assert.rejects(client.request('checkpoint.ensure', { sessionId: session, cwd: join(root, 'nope') }), /Not a directory/)
  pass('bad session ids and missing cwds are rejected')
  console.log('M9 e2e: all checks passed')
} finally {
  await client?.close()
  await server?.close()
  await rm(root, { recursive: true, force: true })
}
