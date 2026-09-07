import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  closeHarnessSse,
  execChild,
  freeHarnessPort,
  harnessEnv,
  harnessHttp,
  killAllChildren,
  killChild,
  openHarnessSse,
  spawnChild,
  unwatchChild,
  watchChild,
  watchSse,
  writeChild
} from './child'

afterAll(() => killAllChildren())

const exitOf = (sessionId: string, onLine: (l: string) => void = () => {}) =>
  new Promise<number | null>((resolve) => watchChild(sessionId, onLine, resolve))

describe('children', () => {
  test('lines flow in and out; exit reaches the watcher with its code', async () => {
    const lines: string[] = []
    const exit = exitOf('s1', (l) => lines.push(l))
    await spawnChild('s1', '/bin/sh', ['-c', 'read x; echo "got $x"; exit 3'], process.cwd())
    await writeChild('s1', 'hello')
    expect(await exit).toBe(3)
    expect(lines).toEqual(['got hello'])
    unwatchChild('s1')
  })

  test('a missing binary rejects', async () => {
    await expect(spawnChild('s2', '/nonexistent/bin', [], process.cwd())).rejects.toThrow()
    await expect(writeChild('s2', 'x')).rejects.toThrow(/no running child/)
  })

  test("a respawn drops the old child's exit (identity check)", async () => {
    const exits: Array<number | null> = []
    watchChild('s3', () => {}, (c) => exits.push(c))
    await spawnChild('s3', '/bin/sh', ['-c', 'sleep 30'], process.cwd())
    await spawnChild('s3', '/bin/sh', ['-c', 'exit 0'], process.cwd())
    await new Promise((r) => setTimeout(r, 300))
    expect(exits).toEqual([0])
    unwatchChild('s3')
  })

  test('killChild silences the watcher', async () => {
    const exits: Array<number | null> = []
    watchChild('s4', () => {}, (c) => exits.push(c))
    await spawnChild('s4', '/bin/sh', ['-c', 'sleep 30'], process.cwd())
    await killChild('s4')
    await new Promise((r) => setTimeout(r, 200))
    expect(exits).toEqual([])
  })

  test('execChild returns stdout and rejects on a non-zero exit', async () => {
    expect(await execChild('/bin/sh', ['-c', 'echo out'])).toBe('out\n')
    await expect(execChild('/bin/sh', ['-c', 'echo bad >&2; exit 2'])).rejects.toThrow(/exited \(2\): bad/)
  })

  test('harnessEnv carries a PATH', async () => {
    expect((await harnessEnv()).PATH).toBeTruthy()
  })
})

describe('http + sse', () => {
  let release: (() => void) | null = null
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/echo') {
      let body = ''
      for await (const chunk of req) body += chunk
      res.writeHead(201).end(`${req.method}:${body}`)
      return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: a\ndata: {"n":1}\n\n')
      res.write('data: line1\ndata: line2\n\n:comment\n\n')
      if (url.searchParams.has('hold')) {
        release = () => res.end()
        return
      }
      res.end()
      return
    }
    res.writeHead(404).end('nope')
  })
  let base = ''
  beforeAll(async () => {
    base = await new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
    )
  })
  afterAll(() => server.close())

  test('freeHarnessPort hands back a usable port', async () => {
    const port = await freeHarnessPort()
    expect(port).toBeGreaterThan(0)
  })

  test('harnessHttp posts and reads status + body; non-loopback is refused', async () => {
    expect(await harnessHttp({ url: `${base}/echo`, method: 'POST', body: 'hi' })).toEqual({ status: 201, body: 'POST:hi' })
    await expect(harnessHttp({ url: 'http://example.com/', method: 'GET' })).rejects.toThrow(/not loopback/)
  })

  test('sse events split on blank lines, data lines joined; onEnd when the server closes', async () => {
    const data: string[] = []
    const ended = new Promise<string | undefined>((resolve) => watchSse('e1', (d) => data.push(d), resolve))
    await openHarnessSse('e1', `${base}/events`)
    expect(await ended).toBeUndefined()
    expect(data).toEqual(['{"n":1}', 'line1\nline2'])
  })

  test('closeHarnessSse aborts without an onEnd; a bad status rejects', async () => {
    let ends = 0
    watchSse('e2', () => {}, () => ends++)
    await openHarnessSse('e2', `${base}/events?hold`)
    await new Promise((r) => setTimeout(r, 50))
    await closeHarnessSse('e2')
    release?.()
    await new Promise((r) => setTimeout(r, 50))
    expect(ends).toBe(0)
    await expect(openHarnessSse('e3', `${base}/missing`)).rejects.toThrow(/HTTP 404/)
  })
})
