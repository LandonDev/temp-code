import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AddonSpec, AddonStatus } from '@shared/contract-addons'
import { Downstream, redact } from './downstream'
import { GRANT_REFUSED_LINE, type AddonCallResult, type DownstreamTool, type ResolvedGrant } from './addonWire'

const FAKE = fileURLToPath(new URL('../../../../scripts/lib/fakeMcpServer.ts', import.meta.url))
const RUN = process.versions.bun ? [] : ['--no-warnings']
const dir = mkdtempSync(join(tmpdir(), 'tc-downstream-'))
const LOG = join(dir, 'calls.log')
const TOKEN = 'sentinel-token-7f3a9c'
const prefix = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12)
const fields = (env: Record<string, string>, headers: Record<string, string> = {}, digest = JSON.stringify({ env, headers })): ResolvedGrant => ({ ok: true, env, headers, digest })

const stdioSpec: AddonSpec = { transport: 'stdio', command: process.execPath, args: [...RUN, FAKE, '--stdio', '--log', LOG], env: ['FAKE_TOKEN'], auth: 'fields' }
const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }

let http: ChildProcess
let ports: { http: number; sse: number }
beforeAll(async () => {
  http = spawn(process.execPath, [...RUN, FAKE, '--http', '0', '--sse', '0', '--require', 'X-Api-Key=right', '--log', LOG], { stdio: ['ignore', 'pipe', 'inherit'] })
  ports = await new Promise((resolve) => http.stdout!.once('data', (d: Buffer) => resolve(JSON.parse(d.toString()))))
})
afterAll(() => {
  http.kill()
  rmSync(dir, { recursive: true, force: true })
})

const open: Downstream[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()))
})

function make(spec: AddonSpec, grant: () => ResolvedGrant, extra: { backoffMs?: number[]; fetch?: typeof fetch; trace?: boolean } = {}) {
  const statuses: AddonStatus[] = []
  const tools: DownstreamTool[][] = []
  const logs: string[] = []
  let unauthorized = 0
  const down = new Downstream({
    launch: { id: 'ad_test', name: 'fake', spec, specDigest: 'digest-1' },
    baseEnv: BASE_ENV,
    cwd: dir,
    grant: async () => grant(),
    status: (s) => statuses.push(s),
    tools: (_d, t) => tools.push(t),
    unauthorized: () => unauthorized++,
    log: (line) => logs.push(line),
    trace: extra.trace ?? true,
    backoffMs: extra.backoffMs ?? [50],
    fetch: extra.fetch
  })
  open.push(down)
  down.start()
  return { down, statuses, tools, logs, unauthorized: () => unauthorized, states: () => statuses.map((s) => s.state) }
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const text = (r: AddonCallResult) => (r.content[0] as { text: string }).text
const call = (d: Downstream, tool: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  d.call(tool, args, { timeoutMs: 30_000, ...opts })
const logged = () => readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)

describe('redact', () => {
  it('replaces every value of four characters or more, longest first', () => {
    expect(redact('a abc sk-123 sk-1234567', ['abc', 'sk-1234567', 'sk-1'])).toBe('a abc …23 …')
  })
})

describe('a stdio add-on', () => {
  it('connects, lists two pages, passes calls through whole and sees no ambient variable', async () => {
    process.env.TC_AMBIENT_SENTINEL = 'leak'
    const t = make(stdioSpec, () => fields({ FAKE_TOKEN: TOKEN }))
    await until(() => t.down.current.state === 'ready')
    expect(t.states()).toEqual(['starting', 'ready'])
    expect(t.statuses.at(-1)!.tools).toBe(12)
    expect(t.tools[0]!.map((x) => x.name)).toContain('add_tool')
    expect(t.tools[0]!.find((x) => x.name === 'read')!.readOnly).toBe(true)
    expect(text(await call(t.down, 'echo', { text: 'ping' }))).toBe('ping')
    const image = await call(t.down, 'image')
    expect(image.content[0]).toEqual({ type: 'image', data: expect.stringMatching(/^iVBOR/), mimeType: 'image/png' })
    expect(await call(t.down, 'structured')).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } })
    expect(await call(t.down, 'fail')).toEqual({ content: [{ type: 'text', text: 'failed on purpose' }], isError: true })
    expect(text(await call(t.down, 'whoami'))).toBe(prefix(TOKEN))
    const env = JSON.parse(text(await call(t.down, 'env'))) as string[]
    expect(env).toContain('TEMP_CODE_ADDON')
    expect(env).toContain('FAKE_TOKEN')
    expect(env).not.toContain('TC_AMBIENT_SENTINEL')
    delete process.env.TC_AMBIENT_SENTINEL
  })

  it('passes 12 MB, refuses 16.5 MB, and fails a 17.5 MB message with a restart', async () => {
    const t = make(stdioSpec, () => fields({ FAKE_TOKEN: TOKEN }))
    await until(() => t.down.current.state === 'ready')
    expect(text(await call(t.down, 'big', { bytes: 12 * 1024 * 1024 })).length).toBe(12 * 1024 * 1024)
    expect(text(await call(t.down, 'big', { bytes: 16.5 * 1024 * 1024 }))).toBe('The result was 16.5 MB, over the 16 MB the app passes on.')
    const over = await call(t.down, 'big', { bytes: 17.5 * 1024 * 1024 })
    expect(over.isError).toBe(true)
    expect(text(over)).toContain('a message over 16 MB')
    expect(t.statuses.find((s) => s.state === 'failed')!.detail).toBe('Disconnected: a message over 16 MB')
    await until(() => t.down.current.state === 'ready')
  }, 30_000)

  it('reports an exit with its code and last stderr line, then restarts on the backoff', async () => {
    const t = make(stdioSpec, () => fields({ FAKE_TOKEN: TOKEN }))
    await until(() => t.down.current.state === 'ready')
    const crashed = await call(t.down, 'crash')
    expect(crashed).toEqual({ content: [{ type: 'text', text: 'Exited (code 3): fake crashing on purpose' }], isError: true })
    await until(() => t.states().length >= 4 && t.down.current.state === 'ready')
    expect(t.states()).toEqual(['starting', 'ready', 'failed', 'starting', 'ready'])
    expect(t.statuses[2]!.detail).toBe('Exited (code 3): fake crashing on purpose')
    expect(text(await call(t.down, 'echo', { text: 'back' }))).toBe('back')
    await call(t.down, 'crash', { signal: true })
    await until(() => t.statuses.filter((s) => s.state === 'failed').length === 2)
    expect(t.statuses.filter((s) => s.state === 'failed')[1]!.detail).toBe('Exited (signal SIGKILL): fake crashing on purpose')
  })

  it('keeps every grant value out of status details, error texts and log lines', async () => {
    let grant = fields({ FAKE_TOKEN: TOKEN })
    const t = make(stdioSpec, () => grant)
    await until(() => t.down.current.state === 'ready')
    const thrown = await call(t.down, 'printtoken')
    expect(thrown.isError).toBe(true)
    expect(text(thrown)).toContain('bad token …')
    // A grant rotated during a slow call: the late error names the old token, redacted.
    const slow = call(t.down, 'slow', { ms: 300, fail: true })
    await new Promise((r) => setTimeout(r, 50))
    grant = fields({ FAKE_TOKEN: 'rotated-token-2b81' })
    const regranted = t.down.grantsDropped()
    const late = await slow
    expect(text(late)).toMatch(/slow failed with token …$/)
    await regranted
    expect(text(await call(t.down, 'whoami'))).toBe(prefix('rotated-token-2b81'))
    await call(t.down, 'crash', { token: true })
    await until(() => t.statuses.some((s) => s.state === 'failed'))
    const failed = t.statuses.find((s) => s.state === 'failed')!
    expect(failed.detail).toBe('Exited (code 3): crashing with token …')
    const everything = JSON.stringify([t.statuses, t.logs])
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('rotated-token-2b81')
  })

  it('re-lists when the server says its tools changed', async () => {
    const t = make(stdioSpec, () => fields({ FAKE_TOKEN: TOKEN }))
    await until(() => t.down.current.state === 'ready')
    await call(t.down, 'add_tool', { name: 'zeta' })
    await until(() => t.tools.length === 2)
    expect(t.tools[1]!.map((x) => x.name)).toContain('zeta')
    expect(t.statuses.at(-1)).toMatchObject({ state: 'ready', tools: 13 })
  })

  it('follows the grant: missing then valid connects, changed restarts after the call in flight, removed closes', async () => {
    let grant: ResolvedGrant = { ok: false, gaps: ['FAKE_TOKEN'] }
    const t = make(stdioSpec, () => grant)
    await until(() => t.down.current.state === 'needs-grant')
    expect(t.down.current.detail).toBe('Needs values for FAKE_TOKEN')
    grant = fields({ FAKE_TOKEN: 'one-value' })
    await t.down.grantsDropped()
    expect(t.down.current.state).toBe('ready')
    const firstPid = t.down.pid
    const slow = call(t.down, 'slow', { ms: 300 })
    await new Promise((r) => setTimeout(r, 30))
    grant = fields({ FAKE_TOKEN: 'two-value' })
    const regrant = t.down.grantsDropped()
    expect(text(await slow)).toBe('waited 300')
    await regrant
    expect(t.down.pid).not.toBe(firstPid)
    expect(text(await call(t.down, 'whoami'))).toBe(prefix('two-value'))
    grant = { ok: false, gaps: ['FAKE_TOKEN'] }
    await t.down.grantsDropped()
    expect(t.down.current).toEqual({ state: 'needs-grant', detail: 'Needs values for FAKE_TOKEN', tools: 0 })
    expect(t.down.pid).toBeNull()
    expect((await call(t.down, 'echo', { text: 'x' })).isError).toBe(true)
  })

  it('a cancelled call and a call past its deadline each send notifications/cancelled', async () => {
    const t = make(stdioSpec, () => fields({ FAKE_TOKEN: TOKEN }))
    await until(() => t.down.current.state === 'ready')
    const before = logged().filter((l) => l.cancelled).length
    const abort = new AbortController()
    const cancelled = call(t.down, 'slow', { ms: 5_000 }, { signal: abort.signal })
    setTimeout(() => abort.abort(), 100)
    expect((await cancelled).isError).toBe(true)
    const late = await call(t.down, 'slow', { ms: 5_000 }, { timeoutMs: 150 })
    expect(late.isError).toBe(true)
    await until(() => logged().filter((l) => l.cancelled).length === before + 2)
  })
})

describe('an http add-on', () => {
  const httpSpec = (port: number, path = 'mcp'): AddonSpec => ({ transport: 'http', url: `http://127.0.0.1:${port}/${path}`, headers: ['X-Api-Key'], auth: 'fields' })

  it('connects with the grant\'s header, keeps the connection when the value changes, and refuses 16.5 MB', async () => {
    let grant = fields({}, { 'X-Api-Key': 'right' })
    const t = make(httpSpec(ports.http), () => grant)
    await until(() => t.down.current.state === 'ready')
    expect(text(await call(t.down, 'whoami'))).toBe(prefix('right'))
    expect(text(await call(t.down, 'big', { bytes: 16.5 * 1024 * 1024 }))).toBe('The result was 16.5 MB, over the 16 MB the app passes on.')
    grant = fields({}, { 'X-Api-Key': 'right' }, 'another-digest')
    await t.down.grantsDropped()
    expect(t.states()).toEqual(['starting', 'ready'])
  }, 20_000)

  it('a 401 sets needs-grant, tells main and dials nothing more for the same grant', async () => {
    let requests = 0
    const counting: typeof fetch = (input, init) => {
      requests++
      return fetch(input, init)
    }
    const t = make(httpSpec(ports.http), () => fields({}, { 'X-Api-Key': 'wrong' }), { fetch: counting })
    await until(() => t.down.current.state === 'needs-grant')
    expect(t.down.current.detail).toBe(GRANT_REFUSED_LINE)
    expect(t.unauthorized()).toBe(1)
    const seen = requests
    await t.down.grantsDropped()
    expect(t.down.current).toEqual({ state: 'needs-grant', detail: GRANT_REFUSED_LINE, tools: 0 })
    expect(requests).toBe(seen)
  })

  it('settles on SSE when the server answers 405 to a POST', async () => {
    const t = make(httpSpec(ports.sse, 'sse'), () => fields({}, { 'X-Api-Key': 'right' }))
    await until(() => t.down.current.state === 'ready')
    expect(t.logs.some((l) => l.includes('connected over sse'))).toBe(true)
    expect(text(await call(t.down, 'echo', { text: 'over sse' }))).toBe('over sse')
  })
})
