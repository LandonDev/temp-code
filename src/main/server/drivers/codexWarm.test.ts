import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { codexWarm } from './codex'
import type { WarmSpec } from './warm'

/** A `codex` whose `app-server` is the fixture: the real driver passes `app-server` as the one argument. */
let bin: string
let dir: string
const spec = (over: Partial<WarmSpec> = {}): WarmSpec => ({ command: bin, args: ['app-server'], cwd: dir, env: { PATH: process.env.PATH }, ...over })

describe('the warm codex app-server', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tc-codex-warm-'))
    bin = join(dir, 'codex')
    writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${join(__dirname, 'fixtures', 'fake-app-server.mjs')} "$@"\n`)
    chmodSync(bin, 0o755)
  })
  afterEach(() => codexWarm.retire())
  afterAll(async () => {
    codexWarm.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('is spawned and initialized ahead of a thread; the thread of its shape adopts it and starts without another initialize', async () => {
    codexWarm.noteStart(spec())
    await codexWarm.settled()
    expect(codexWarm.status().warm).toHaveLength(1)
    const warm = codexWarm.adopt(spec())
    expect(warm).not.toBeNull()
    const conn = warm!.proc
    expect(conn.alive).toBe(true)
    const notes: unknown[] = []
    conn.attach((method, params) => notes.push([method, params]), () => {}, () => {})
    const res = (await conn.request('thread/start', { cwd: dir })) as { thread: { id: string } }
    expect(res.thread.id).toBe('th-fake')
    // initialize happened once, while warm; thread/start is the first thing the thread sent.
    expect(notes).toEqual([['fake/seen', { seen: ['initialize', 'thread/start'], cwd: dir }]])
    expect(codexWarm.status().warm).toEqual([])
    conn.kill()
  })

  it('another cwd or env is another shape: it boots cold and re-shapes the pool', async () => {
    codexWarm.noteStart(spec())
    await codexWarm.settled()
    const first = codexWarm.status().warm[0]?.id
    expect(codexWarm.adopt(spec({ cwd: tmpdir() }))).toBeNull()
    expect(codexWarm.status().warm).toEqual([])
    await codexWarm.settled()
    expect(codexWarm.status().warm[0]?.id).not.toBe(first)
    expect(codexWarm.status().warm[0]?.cwd).toBe(tmpdir())
  })
})
