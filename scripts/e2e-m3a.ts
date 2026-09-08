import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { startServer, type RunningServer } from '../src/main/server'
import { BUILT_IN_DRIVERS } from '../src/main/server/drivers'
import type { ClientRequest } from '../src/shared/contract'

// Session checks exercise storage and WS routing without starting chat turns.
// text.generate uses the real SDK and usage uses the real credential service.
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
const sessionSchema = z.object({
  id: z.string(),
  pinned: z.boolean(),
  workspaceId: z.string().nullable()
})
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  git: z.boolean(),
  createdAt: z.number()
})
const projectSchema = z.object({ id: z.string(), name: z.string(), archived: z.boolean() })
const noteSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})
const searchSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      relative: z.string(),
      line: z.number(),
      column: z.number(),
      preview: z.string()
    })
  ),
  truncated: z.boolean()
})
const usageSchema = z
  .object({
    status: z.enum(['ok', 'error', 'unavailable']),
    httpStatus: z.number().nullable(),
    body: z.string().nullable(),
    error: z.string().nullable()
  })
  .strict()

class Client {
  readonly ws: WebSocket
  readonly pushes: unknown[] = []
  private sequence = 0
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => {
      const raw: unknown = JSON.parse(String(data))
      const response = responseSchema.safeParse(raw)
      if (!response.success) {
        this.pushes.push(raw)
        return
      }
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
      }, 180_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
    })
  }
  async close(): Promise<void> {
    this.ws.close()
    await once(this.ws, 'close')
  }
}

const root = await mkdtemp(join(tmpdir(), 'tc-m3a-'))
const dbPath = join(root, 'temp-code.db')
const repo = join(root, 'repo')
let server: RunningServer | undefined
const clients: Client[] = []
const pass = (label: string): void => {
  console.log(`PASS  ${label}`)
}
try {
  await mkdir(repo)
  execFileSync('git', ['-C', repo, 'init', '-q'])
  await writeFile(join(repo, 'hello.txt'), 'hello M3a\nsecond line\n')
  execFileSync('git', ['-C', repo, 'add', '.'])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-qm',
    'init'
  ])
  server = await startServer(dbPath)
  const client = new Client(server.port)
  const observer = new Client(server.port)
  clients.push(client, observer)
  await Promise.all([client.ready(), observer.ready()])
  const session = sessionSchema.parse(
    await client.request('session.create', { id: 'caller-session', cwd: repo, provider: 'claude' })
  )
  assert.equal(session.id, 'caller-session')
  await assert.rejects(
    client.request('session.create', { id: session.id, cwd: repo }),
    /already taken/
  )
  pass('session.create caller id and duplicate rejection')
  const workspace = workspaceSchema.parse(
    await client.request('workspace.create', { path: repo, name: 'M3a' })
  )
  // A request on the observer drains its prior pushes before returning.
  await observer.request('workspace.list')
  const workspacesPush = z.object({
    push: z.literal('workspaces'),
    workspaces: z.array(workspaceSchema)
  })
  assert(
    observer.pushes.some((p) => {
      const parsed = workspacesPush.safeParse(p)
      return parsed.success && parsed.data.workspaces.some((w) => w.id === workspace.id)
    })
  )
  assert(client.pushes.some((p) => workspacesPush.safeParse(p).success))
  assert.equal(
    z
      .array(sessionSchema)
      .parse(await client.request('session.list'))
      .find((s) => s.id === session.id)?.workspaceId,
    workspace.id
  )
  pass('workspace.create pushes to both clients and adopts path-only session')
  const project = projectSchema.parse(
    await client.request('project.create', {
      workspaceId: workspace.id,
      name: 'Local',
      mode: 'local'
    })
  )
  await client.request('project.rename', { projectId: project.id, name: 'Renamed' })
  await client.request('project.archive', { projectId: project.id, archived: true })
  await client.request('project.delete', { projectId: project.id })
  await observer.request('project.list')
  const projectsPush = z.object({ push: z.literal('projects'), projects: z.array(projectSchema) })
  assert.equal(observer.pushes.filter((p) => projectsPush.safeParse(p).success).length, 4)
  pass('project create/rename/archive/delete catalog pushes')
  assert.equal(await client.request('workspace.getSnapshot'), null)
  assert.equal(
    await client.request('workspace.setSnapshot', { snapshot: { tabs: [{ id: session.id }] } }),
    null
  )
  assert.deepEqual(await client.request('workspace.getSnapshot'), { tabs: [{ id: session.id }] })
  await assert.rejects(client.request('workspace.setSnapshot', { snapshot: [] }), /bad request/)
  await assert.rejects(
    client.request('workspace.setSnapshot', { snapshot: { x: 'x'.repeat(2_000_001) } }),
    /too large/
  )
  pass('workspace snapshots round-trip and reject invalid/oversized values')
  assert.deepEqual(await client.request('notes.list'), [])
  assert.equal(await client.request('notes.get', { id: 'missing' }), null)
  const note = noteSchema.parse(
    await client.request('notes.upsert', {
      note: {
        id: 'note-1',
        title: 'Hello note',
        body: 'one\r\ntwo',
        sourceSessionId: session.id,
        sourceCwd: repo
      }
    })
  )
  assert.equal(note.body, 'one\ntwo')
  assert.equal(noteSchema.parse(await client.request('notes.get', { id: note.id })).slug, note.slug)
  assert.equal(z.array(noteSchema).parse(await client.request('notes.list')).length, 1)
  await client.request('notes.delete', { id: note.id })
  assert.equal(await client.request('notes.get', { id: note.id }), null)
  pass('notes list/get/upsert/delete shapes and CRUD')
  const hits = searchSchema.parse(
    await client.request('search.project', {
      options: { cwd: repo, query: 'm3a', wholeWord: true, include: '*.txt' }
    })
  )
  assert.equal(hits.matches.length, 1)
  assert.equal(hits.matches[0].column, 7)
  pass('search.project on a real git repo')
  const logo = join(root, 'logo.svg')
  await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const saved = z
    .string()
    .parse(await client.request('projectLogo.save', { projectPath: repo, sourcePath: logo }))
  assert(saved.startsWith(join(root, 'project-logos')))
  assert.equal(await readFile(saved, 'utf8'), await readFile(logo, 'utf8'))
  assert.equal(await client.request('projectLogo.remove', { projectPath: repo }), null)
  await assert.rejects(readFile(saved))
  pass('projectLogo.save/remove stored path and file effects')
  await client.request('session.pin', { sessionId: session.id, pinned: true })
  assert.equal(
    z
      .array(sessionSchema)
      .parse(await client.request('session.list'))
      .find((s) => s.id === session.id)?.pinned,
    true
  )
  await assert.rejects(
    client.request('session.pin', { sessionId: 'missing', pinned: true }),
    /unknown session/
  )
  pass('session.pin persisted value and missing-session rejection')
  const text = z
    .object({ text: z.string().nullable() })
    .strict()
    .parse(
      await client.request('text.generate', {
        prompt: 'Reply with exactly: M3a text generation works',
        cwd: repo
      })
    )
  console.log(`REAL  text.generate ${JSON.stringify(text)}`)
  pass('text.generate real call result shape')
  const usage = usageSchema.parse(await client.request('rateLimits.claudeUsage'))
  // Report response shape/status without copying account data or credentials.
  console.log(
    `REAL  rateLimits.claudeUsage ${JSON.stringify({ ...usage, body: usage.body === null ? null : `<string: ${Buffer.byteLength(usage.body)} bytes>` })}`
  )
  pass('rateLimits.claudeUsage real call result shape')
  await Promise.all(clients.map((c) => c.close()))
  clients.length = 0
  await server.close()
  server = undefined
  server = await startServer(dbPath)
  const reopened = new Client(server.port)
  clients.push(reopened)
  await reopened.ready()
  const sessions = z.array(sessionSchema).parse(await reopened.request('session.list'))
  assert.equal(sessions.find((s) => s.id === session.id)?.pinned, true)
  assert.deepEqual(await reopened.request('workspace.getSnapshot'), { tabs: [{ id: session.id }] })
  pass('server restart retains pin and workspace snapshot')
  await reopened.request('workspace.delete', { workspaceId: workspace.id })
  await reopened.request('workspace.list')
  assert(
    reopened.pushes.some((p) => {
      const parsed = workspacesPush.safeParse(p)
      return parsed.success && parsed.data.workspaces.length === 0
    })
  )
  pass('workspace.delete catalog push')
  console.log('ALL PASS')
} catch (error) {
  console.error(`FAIL  ${error instanceof Error ? error.message : 'Unexpected e2e failure'}`)
  process.exitCode = 1
} finally {
  await Promise.all(clients.map((c) => c.close()))
  await server?.close()
  await rm(root, { recursive: true, force: true })
}
