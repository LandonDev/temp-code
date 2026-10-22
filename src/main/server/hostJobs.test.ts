import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { HostLogPush } from '@shared/contract-host'
import {
  DEPLOY_NOT_INSTALLED,
  DeployTrigger,
  HostLog,
  Publisher,
  handleHost,
  notesFrom,
  releaseCommand,
  scriptsEnv,
  subjectClause
} from './hostJobs'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-hostjobs-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const triggerDir = (): string => {
  const dir = join(root, 'deploy')
  mkdirSync(dir, { recursive: true })
  return dir
}
/** What deploy-runner does when it picks the request up, in the same order. */
const runnerStart = (dir: string): void => {
  const ref = readFileSync(join(dir, 'request'), 'utf8').trim()
  rmSync(join(dir, 'exit'), { force: true })
  writeFileSync(join(dir, 'log'), '')
  writeFileSync(join(dir, 'ref'), `${ref}\n`)
  rmSync(join(dir, 'request'))
}
const runnerLog = (dir: string, text: string): void => writeFileSync(join(dir, 'log'), text, { flag: 'a' })
const runnerExit = (dir: string, code: number): void => writeFileSync(join(dir, 'exit'), `${code}\n`)

describe('HostLog', () => {
  it('keeps the text, pushes appends and statuses to subscribers, and caps the text at a line', () => {
    const log = new HostLog('deploy', false)
    const seen: HostLogPush[] = []
    const off = log.subscribe(1, (p) => seen.push(p))
    log.append('one\n')
    log.setStatus({ ...log.status, phase: 'running' })
    expect(log.snapshot().text).toBe('one\n')
    expect(seen.map((p) => p.append ?? p.status.phase)).toEqual(['one\n', 'running'])
    log.reset({ ...log.status, phase: 'pending' })
    expect(log.snapshot().text).toBe('')
    expect(seen[2]?.reset).toBe(true)
    off()
    log.append('unseen')
    expect(seen).toHaveLength(3)
    log.append('x'.repeat(600 * 1024) + '\ntail\n')
    expect(log.snapshot().text.length).toBeLessThanOrEqual(512 * 1024)
    expect(log.snapshot().text.endsWith('tail\n')).toBe(true)
  })
})

describe('DeployTrigger', () => {
  it('refuses a ref that is not master or a v1.0.N tag before touching the directory', async () => {
    const dir = triggerDir()
    const trigger = new DeployTrigger({ dir, version: '1.0.270', pollMs: 5 })
    for (const bad of ['main', 'v1.0', 'v2.0.1', 'master; rm -rf /', '../x', 'release-3', ''])
      await expect(trigger.deploy(bad)).rejects.toThrow('master or a v1.0.N tag only')
    expect(existsSync(join(dir, 'request'))).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'host.deploy', params: { ref: 'main' } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'host.deploy', params: { ref: 'v1.0.273' } }).success).toBe(true)
    trigger.dispose()
  })

  it('refuses when the trigger directory is missing or not writable, naming the install step', async () => {
    const missing = new DeployTrigger({ dir: join(root, 'nope'), version: '1.0.270' })
    expect(missing.status().installed).toBe(false)
    expect(missing.status().installHint).toContain('--from 87')
    await expect(missing.deploy('master')).rejects.toThrow(DEPLOY_NOT_INSTALLED)
    const dir = triggerDir()
    chmodSync(dir, 0o500)
    const readOnly = new DeployTrigger({ dir, version: '1.0.270' })
    const expectWritable = process.getuid?.() === 0 // root writes anywhere
    expect(readOnly.status().installed).toBe(expectWritable)
    chmodSync(dir, 0o700)
    missing.dispose()
    readOnly.dispose()
  })

  it('drops the request, follows the runner through pending, running and done, and refuses a second deploy meanwhile', async () => {
    const dir = triggerDir()
    let now = 1_000_000
    const trigger = new DeployTrigger({ dir, version: '1.0.270', pollMs: 5, now: () => now })
    const seen: HostLogPush[] = []
    trigger.subscribe(7, (p) => seen.push(p))
    const status = await trigger.deploy('master')
    expect(readFileSync(join(dir, 'request'), 'utf8')).toBe('master\n')
    expect(status.phase).toBe('pending')
    expect(status.target).toBe('master')
    expect(status.startedAt).toBe(now)
    expect(status.stoppable).toBe(false)
    await expect(trigger.deploy('master')).rejects.toThrow('in progress')

    runnerStart(dir)
    runnerLog(dir, '== box-update master\nbuilding\n')
    await new Promise((r) => setTimeout(r, 30))
    expect(trigger.status().phase).toBe('running')
    expect(trigger.log.snapshot().text).toContain('building\n')
    await expect(trigger.deploy('v1.0.273')).rejects.toThrow('in progress')

    runnerLog(dir, 'PASS\n')
    runnerExit(dir, 0)
    await new Promise((r) => setTimeout(r, 30))
    const done = trigger.status()
    expect(done.phase).toBe('done')
    expect(done.exit).toBe(0)
    expect(done.finishedAt).not.toBeNull()
    expect(trigger.log.snapshot().text).toContain('PASS\n')
    const appends = seen.filter((p) => p.append).map((p) => p.append).join('')
    expect(appends).toContain('building\n')
    expect(appends).toContain('PASS\n')
    expect(seen.some((p) => p.reset)).toBe(true)
    // Done: the next deploy is allowed again, and the log starts over.
    now += 60_000
    await trigger.deploy('v1.0.273')
    expect(trigger.log.snapshot().text).not.toContain('PASS')
    expect(trigger.status().target).toBe('v1.0.273')
    trigger.dispose()
  })

  it('reads a deploy in flight or finished from the files alone (this process restarted into the new build)', async () => {
    const dir = triggerDir()
    writeFileSync(join(dir, 'ref'), 'master\n')
    writeFileSync(join(dir, 'log'), 'cloning\nbuilding\n')
    const running = new DeployTrigger({ dir, version: '1.0.273', pollMs: 5 })
    expect(running.status().phase).toBe('running')
    expect(running.status().target).toBe('master')
    const seen: HostLogPush[] = []
    running.subscribe(1, (p) => seen.push(p))
    expect(running.log.snapshot().text).toBe('cloning\nbuilding\n')
    runnerLog(dir, 'PASS: deployed\n')
    runnerExit(dir, 0)
    await new Promise((r) => setTimeout(r, 30))
    expect(running.status().phase).toBe('done')
    expect(seen.map((p) => p.append).filter(Boolean)).toEqual(['PASS: deployed\n'])
    running.dispose()

    const finished = new DeployTrigger({ dir, version: '1.0.273' })
    const s = finished.status()
    expect(s.phase).toBe('done')
    expect(s.exit).toBe(0)
    expect(finished.log.snapshot().text).toContain('PASS: deployed')
    finished.dispose()

    const idle = new DeployTrigger({ dir: triggerDir() + '', version: '1.0.273' })
    rmSync(join(dir, 'log'))
    rmSync(join(dir, 'exit'))
    rmSync(join(dir, 'ref'))
    expect(new DeployTrigger({ dir, version: '1.0.273' }).status().phase).toBe('idle')
    idle.dispose()
  })

  it('withdraws a request nobody picks up and says the trigger is not installed', async () => {
    const dir = triggerDir()
    let now = 5_000
    const trigger = new DeployTrigger({ dir, version: '1.0.270', pollMs: 5, pickupMs: 100, now: () => now })
    await trigger.deploy('master')
    now += 200
    await new Promise((r) => setTimeout(r, 30))
    const status = trigger.status()
    expect(status.phase).toBe('done')
    expect(status.exit).toBeNull()
    expect(existsSync(join(dir, 'request'))).toBe(false)
    expect(trigger.log.snapshot().text).toContain(DEPLOY_NOT_INSTALLED)
    trigger.dispose()
  })
})

// ── the Mac ─────────────────────────────────────────────────────────────

type FakeChild = EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => boolean; killed: string[] }
const fakeChild = (): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = []
  child.kill = (sig) => {
    child.killed.push(sig ?? 'SIGTERM')
    return true
  }
  return child
}

const store = () => {
  const rows: Record<string, string> = {}
  return {
    rows,
    getSetting: (key: string) => rows[key] ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) delete rows[key]
      else rows[key] = value
    }
  }
}

/** A checkout as git would answer for it. */
function fakeGit(state: { dirty?: string; branch?: string; version?: string; master?: string; tag?: string; subjects?: string[] }) {
  const calls: string[][] = []
  const git = async (args: string[]): Promise<string> => {
    calls.push(args)
    const key = args.join(' ')
    if (key === 'status --porcelain') return state.dirty ?? ''
    if (key === 'rev-parse --abbrev-ref HEAD') return `${state.branch ?? 'master'}\n`
    if (key === 'show HEAD:package.json') return JSON.stringify({ version: state.version ?? '1.0.273' })
    if (key === 'show origin/master:package.json') {
      if (state.master === undefined) throw new Error('no origin/master')
      return JSON.stringify({ version: state.master })
    }
    if (key.startsWith('describe --tags')) {
      if (!state.tag) throw new Error('no tag')
      return `${state.tag}\n`
    }
    if (args[0] === 'log') return (state.subjects ?? []).join('\n') + '\n'
    throw new Error(`unexpected git ${key}`)
  }
  return { git, calls }
}

const checkoutAt = (dir: string, n = 272): string => {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ n, notes: 'x', ts: 1 }))
  return dir
}

describe('Publisher', () => {
  it('reads release.checkout, defaulting to ~/IdeaProjects/temp-code, and the status prefills the notes from the commits since the last tag', async () => {
    const s = store()
    const home = join(root, 'home')
    const checkout = checkoutAt(join(home, 'IdeaProjects', 'temp-code'))
    const { git } = fakeGit({
      tag: 'v1.0.270',
      master: '1.0.273',
      subjects: [
        'release: v273 — Restored panes keep their host',
        'A full-access thread is never prompted on the Mac: the box sends the thread\'s permission with every mac.* call',
        'Mark all read in the rail'
      ]
    })
    const publisher = new Publisher({ store: s, home, git, feedVersion: async () => null })
    expect(publisher.checkout()).toBe(checkout)
    const status = await publisher.status()
    expect(status.readable).toBe(true)
    expect(status.branch).toBe('master')
    expect(status.version).toBe('1.0.273')
    expect(status.masterVersion).toBe('1.0.273')
    expect(status.publishedVersion).toBe('1.0.270')
    expect(status.commits).toEqual(['A full-access thread is never prompted on the Mac', 'Mark all read in the rail'])
    expect(status.notes).toBe('A full-access thread is never prompted on the Mac; Mark all read in the rail')
    expect(status.refusal).toBeNull()
    publisher.setCheckout('~/elsewhere')
    expect(s.rows['release.checkout']).toBe('~/elsewhere')
    expect(publisher.checkout()).toBe(join(home, 'elsewhere'))
    expect((await publisher.status()).refusal).toContain('not a checkout')
    publisher.setCheckout('')
    expect(s.rows['release.checkout']).toBeUndefined()
  })

  it('refuses a dirty tree, a branch other than master, a published version and a running publish', async () => {
    const home = join(root, 'home')
    checkoutAt(join(home, 'IdeaProjects', 'temp-code'))
    const make = (state: Parameters<typeof fakeGit>[0], feed: string | null = null) =>
      new Publisher({ store: store(), home, git: fakeGit(state).git, feedVersion: async () => feed, spawnScripts: () => fakeChild() as never })
    await expect(make({ dirty: ' M src/a.ts\n' }).publish('notes')).rejects.toThrow('uncommitted changes')
    expect((await make({ dirty: '?? scratch.txt\n' }).status()).refusal).toBeNull()
    await expect(make({ branch: 'feature' }).publish('notes')).rejects.toThrow('on feature, not master')
    await expect(make({ version: '1.0.270', tag: 'v1.0.273' }).publish('notes')).rejects.toThrow('already published')
    await expect(make({}, '1.0.273').publish('notes')).rejects.toThrow('v1.0.273 is already published; the feed serves it')
    await expect(make({}).publish('   ')).rejects.toThrow('empty')
    const running = make({})
    await running.publish('notes')
    await expect(running.publish('again')).rejects.toThrow('already running')
    expect((await running.status()).refusal).toBe('a publish is already running')
  })

  it('runs the scripts in the checkout with the notes in the environment, streams their output, and Stop kills the group', async () => {
    const home = join(root, 'home')
    const checkout = checkoutAt(join(home, 'IdeaProjects', 'temp-code'), 272)
    const spawned: { cwd: string; notes: string; env: NodeJS.ProcessEnv; child: FakeChild }[] = []
    const kills: [number, string][] = []
    const realKill = process.kill
    process.kill = ((pid: number, sig: string) => {
      kills.push([pid, sig])
      return true
    }) as never
    try {
      const publisher = new Publisher({
        store: store(),
        home,
        git: fakeGit({ tag: 'v1.0.270', subjects: ['one'] }).git,
        feedVersion: async () => '1.0.270',
        spawnScripts: (opts) => {
          const child = fakeChild()
          spawned.push({ cwd: opts.cwd, notes: opts.notes, env: opts.env, child })
          return child as never
        },
        env: { PATH: '/usr/bin', HOME: home },
        now: () => 99
      })
      const seen: HostLogPush[] = []
      publisher.subscribe(3, (p) => seen.push(p))
      const status = await publisher.publish('  Panes keep their host  ')
      expect(spawned).toHaveLength(1)
      expect(spawned[0].cwd).toBe(checkout)
      expect(spawned[0].notes).toBe('Panes keep their host')
      expect(status.phase).toBe('running')
      expect(status.target).toBe('v1.0.273')
      expect(status.startedAt).toBe(99)
      expect(status.stoppable).toBe(true)
      spawned[0].child.stdout.emit('data', Buffer.from('› typecheck\n'))
      spawned[0].child.stderr.emit('data', 'tree has uncommitted changes — commit your work first\n')
      expect(publisher.log.snapshot().text).toContain('› typecheck\n')
      expect(publisher.log.snapshot().text).toContain('uncommitted changes')
      publisher.stop()
      expect(kills).toEqual([[-4242, 'SIGTERM']])
      spawned[0].child.emit('exit', null, 'SIGTERM')
      const done = await publisher.status()
      expect(done.phase).toBe('done')
      expect(done.exit).toBe(143)
      expect(publisher.log.snapshot().text).toContain('== stopped (SIGTERM)')
      expect(seen.at(-1)?.status.phase).toBe('done')
      // A failed script's exit lands as its status.
      await publisher.publish('again')
      spawned[1].child.emit('exit', 1, null)
      expect((await publisher.status()).exit).toBe(1)
      expect(publisher.log.snapshot().text).toContain('== exited 1')
    } finally {
      process.kill = realKill
    }
  })

  it('publishes HEAD without the train when a peer already cut the release, using that version for the target and feed check', async () => {
    const home = join(root, 'home')
    // Deliberately different from HEAD: no-train mode must use package.json, not n + 1.
    const checkout = checkoutAt(join(home, 'IdeaProjects', 'temp-code'), 999)
    const children: FakeChild[] = []
    const spawned: { train: boolean; cwd: string }[] = []
    const make = (feed: string) => new Publisher({
      store: store(), home, git: fakeGit({ version: '1.0.273' }).git,
      feedVersion: async () => feed,
      spawnScripts: (opts) => {
        spawned.push(opts)
        const child = fakeChild()
        children.push(child)
        return child as never
      }
    })
    await expect(make('1.0.273').publish('notes', { train: false })).rejects.toThrow('v1.0.273 is already published; the feed serves it')
    expect(spawned).toHaveLength(0)
    const publisher = make('1.0.272')
    const status = await publisher.publish('notes', { train: false })
    expect(status.target).toBe('v1.0.273')
    expect(spawned).toEqual([expect.objectContaining({ cwd: checkout, train: false })])
    expect(releaseCommand({ train: false })).toBe('bun run release:publish')
    expect(releaseCommand()).toBe('bun scripts/release.ts "$TC_RELEASE_NOTES" && bun run release:publish')
    expect(releaseCommand({ train: true })).toBe(releaseCommand())
    children[0].emit('exit', 0, null)
  })

  it('scriptsEnv drops what Electron, npm and the post-commit hook leak', () => {
    const env = scriptsEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1', npm_config_x: 'y', GIT_INDEX_FILE: '/i', NODE_ENV: 'production', TEMP_CODE_USER_DATA: '/d', HOME: '/h' })
    expect(env).toEqual({ PATH: '/x', HOME: '/h', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' })
  })

  it('subjectClause and notesFrom cut each subject to its first clause and skip the train\'s own commits', () => {
    expect(subjectClause('Mac bridge commands from a box no longer fill the Mac\'s screen: a command or job admitted')).toBe(
      'Mac bridge commands from a box no longer fill the Mac\'s screen'
    )
    expect(subjectClause('fix: typo')).toBe('fix: typo')
    expect(subjectClause('a'.repeat(50) + ' ' + 'b'.repeat(80))).toBe('a'.repeat(50) + '…')
    expect(notesFrom(['release: v273 — x', 'Second', 'The first clause: its detail'])).toBe('Second; The first clause')
    expect(notesFrom([])).toBe('')
  })
})

describe('handleHost', () => {
  it('routes host.log to the job and registers the close, and leaves other methods alone', async () => {
    const dir = triggerDir()
    const deploy = new DeployTrigger({ dir, version: '1.0.270', pollMs: 5 })
    const publish = new Publisher({ store: store(), home: root, git: fakeGit({}).git, feedVersion: async () => null })
    const offs: (() => void)[] = []
    const pushes: HostLogPush[] = []
    const caller = { connection: 9, send: (p: HostLogPush) => pushes.push(p), onClose: (off: () => void) => offs.push(off) }
    const req = (method: string, params?: unknown) => ClientRequestSchema.parse({ id: 'r', method, params })
    const log = await handleHost(req('host.log', { job: 'deploy' }), { deploy, publish }, caller)
    expect(log).toEqual({ handled: true, result: { text: '', status: expect.objectContaining({ phase: 'idle', job: 'deploy' }) } })
    expect(offs).toHaveLength(1)
    const started = await handleHost(req('host.deploy', { ref: 'master' }), { deploy, publish }, caller)
    expect(started.handled && (started.result as { phase: string }).phase).toBe('pending')
    expect(pushes.some((p) => p.reset)).toBe(true)
    offs[0]()
    deploy.log.append('after close')
    expect(pushes.some((p) => p.append === 'after close')).toBe(false)
    expect(await handleHost(req('host.deployStatus'), { deploy, publish }, caller)).toMatchObject({ handled: true, result: { installed: true, phase: 'pending' } })
    expect(await handleHost(req('catalog.get'), { deploy, publish }, caller)).toEqual({ handled: false })
    expect(await handleHost(req('host.log', { job: 'publish' }), { deploy, publish }, caller)).toMatchObject({ handled: true, result: { text: '' } })
    deploy.dispose()
  })
})

describe('Publisher: the update phase', () => {
  it('a green script is followed by the app fetching the version its total line names, as a phase of the same log; a red one is not', async () => {
    const home = join(root, 'home')
    checkoutAt(join(home, 'IdeaProjects', 'temp-code'), 272)
    const children: FakeChild[] = []
    let settle!: (outcome: 'ready' | 'error') => void
    const asked: string[] = []
    let now = 1000
    const publisher = new Publisher({
      store: store(),
      home,
      git: fakeGit({ tag: 'v1.0.270', subjects: ['one'] }).git,
      feedVersion: async () => '1.0.270',
      spawnScripts: () => {
        const child = fakeChild()
        children.push(child)
        return child as never
      },
      selfUpdate: (version) => {
        asked.push(version)
        return new Promise((resolve) => (settle = resolve))
      },
      now: () => now
    })
    await publisher.publish('notes')
    children[0].stdout.emit('data', 'phase › gate\nphase ✓ gate 71s\nphase ✓ total 4m12s 1.0.273\n')
    children[0].emit('exit', 0, null)
    expect(asked).toEqual(['1.0.273'])
    // Still running: the job ends with the update phase.
    expect((await publisher.status()).phase).toBe('running')
    expect(publisher.log.snapshot().text).toContain('== exited 0\nphase › update\n')
    now += 31_000
    settle('ready')
    await new Promise((r) => setTimeout(r, 0))
    expect((await publisher.status()).phase).toBe('done')
    expect((await publisher.status()).exit).toBe(0)
    expect(publisher.log.snapshot().text).toContain('phase ✓ update 31s\n')
    // A red script asks nothing.
    await publisher.publish('again')
    children[1].emit('exit', 1, null)
    expect(asked).toEqual(['1.0.273'])
    expect((await publisher.status()).phase).toBe('done')
  })

  it('without a total line the target version is fetched; a skipped update is said so', async () => {
    const home = join(root, 'home')
    checkoutAt(join(home, 'IdeaProjects', 'temp-code'), 272)
    const children: FakeChild[] = []
    const asked: string[] = []
    const publisher = new Publisher({
      store: store(),
      home,
      git: fakeGit({ tag: 'v1.0.270', subjects: ['one'] }).git,
      feedVersion: async () => '1.0.270',
      spawnScripts: () => {
        const child = fakeChild()
        children.push(child)
        return child as never
      },
      selfUpdate: async (version) => {
        asked.push(version)
        return 'current'
      }
    })
    await publisher.publish('notes')
    children[0].emit('exit', 0, null)
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual(['1.0.273'])
    expect(publisher.log.snapshot().text).toContain('phase – update skipped (current)\n')
    expect((await publisher.status()).phase).toBe('done')
  })
})
