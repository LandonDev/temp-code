import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DevRunPush, DevTarget } from '@shared/contract-devservers'
import { devRunWord } from '@shared/contract-devservers'
import { DevRuns, forwardIdOf } from './devRuns'
import { SharedScanner } from './threadPorts'

let dir: string
let runs: DevRuns
let pushes: DevRunPush[]
let offersChanged = 0
const target = (id: string, command: string, macOnly = false): DevTarget => ({ id, name: 'site', script: id, kind: 'web', framework: 'node', dir: '', command, macOnly })
let targets: DevTarget[]

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-devruns-'))
  // A server that announces itself on a port the OS picks.
  writeFileSync(
    join(dir, 'server.cjs'),
    "const s=require('http').createServer((q,r)=>r.end('hi'));s.listen(0,'127.0.0.1',()=>console.log('  ➜  Local:   http://localhost:'+s.address().port+'/'))"
  )
  targets = [target('serve', `node server.cjs`), target('boom', 'echo nope >&2; exit 3'), target('ios:./App.xcodeproj', 'xcodebuild', true)]
  pushes = []
  offersChanged = 0
  runs = new DevRuns({
    project: (id) => (id === 'p1' ? { id, name: 'site', cwd: dir } : null),
    scanner: new SharedScanner(),
    forwardsOf: (id) => (id.startsWith('dev:') ? [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 5174, error: null }] : []),
    offersChanged: () => void offersChanged++,
    detect: async () => targets,
    platform: 'linux',
    log: () => {}
  })
  runs.onPush((p) => void pushes.push(p))
})
afterEach(async () => {
  runs.disposeAll()
  await new Promise((r) => setTimeout(r, 100))
  rmSync(dir, { recursive: true, force: true })
})

describe('DevRuns', () => {
  it('runs a target, streams its log, finds its port under its tree, offers it, and stops the group', async () => {
    const run = await runs.start('p1', 'serve')
    expect(run).toMatchObject({ status: 'running', name: 'site', script: 'serve', cwd: dir })
    await until(() => runs.offers().length === 1)
    const port = runs.offers()[0].port
    expect(runs.offers()[0]).toMatchObject({ id: forwardIdOf(run.id, port), label: `http://localhost:${port}`, runId: run.id, sessionId: null })
    expect(runs.history(run.id).lines.join('\n')).toContain(`Local:   http://localhost:${port}/`)
    expect(runs.history(run.id).run.ports).toEqual([{ port, url: `http://localhost:${port}`, forwards: [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 5174, error: null }] }])
    expect(offersChanged).toBeGreaterThan(0)
    expect(pushes.some((p) => p.lines.some((l) => l.includes('Local:')))).toBe(true)

    const stopped = await runs.stop(run.id)
    expect(stopped).toMatchObject({ status: 'stopped', ports: [] })
    expect(devRunWord(stopped)).toBe('Stopped')
    expect(runs.offers()).toEqual([])
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  }, 20_000)

  it('says a run failed with its exit code and keeps its log', async () => {
    const run = await runs.start('p1', 'boom')
    await until(() => runs.history(run.id).run.status !== 'running')
    const h = runs.history(run.id)
    expect(h.run).toMatchObject({ status: 'failed', exitCode: 3 })
    expect(devRunWord(h.run)).toBe('Exited with 3')
    expect(h.lines).toContain('nope')
  })

  it('restarts a run as a new one and lists runs newest first', async () => {
    const first = await runs.start('p1', 'serve')
    const second = await runs.restart(first.id)
    expect(second.id).not.toBe(first.id)
    const { runs: list } = await runs.targets('p1')
    expect(list.map((r) => r.id)).toEqual([second.id])
  }, 20_000)

  it('offers an iOS target only on a Mac', async () => {
    expect((await runs.targets('p1')).targets.map((t) => t.id)).toEqual(['serve', 'boom'])
  })

  it('refuses a Mac-only target off a Mac, and a target the host did not detect', async () => {
    await expect(runs.start('p1', 'ios:./App.xcodeproj')).rejects.toThrow('runs on a Mac')
    await expect(runs.start('p1', 'rm -rf /')).rejects.toThrow('no such dev target')
    await expect(runs.start('nope', 'serve')).rejects.toThrow('unknown project')
  })
})
