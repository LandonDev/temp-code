import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type {
  MacBridgePush,
  MacBridgeRequest,
  MacWriteFileResult,
  MacWriteFileWire
} from '@shared/contract-macbridge'
import { MacBridge } from './macBridge'
import { writeDenied, writeLevel, writeMacFile, writeTarget, writeVerdict } from './macBridgeWrite'

let root: string
let home: string
let shared: string
let elsewhere: string
let managed: string
let dotShared: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-macwrite-')))
  home = join(root, 'Users', 'me')
  shared = join(home, 'Documents', 'shared')
  elsewhere = join(home, 'Private')
  managed = join(home, 'IdeaProjects', 'app')
  dotShared = join(home, '.config', 'tool')
  for (const d of [shared, elsewhere, managed, dotShared, join(home, 'Library', 'Preferences')])
    mkdirSync(d, { recursive: true })
  writeFileSync(join(elsewhere, 'secret.txt'), 'private')
  writeFileSync(join(shared, 'existing.txt'), 'old')
  chmodSync(join(shared, 'existing.txt'), 0o640)
  symlinkSync(elsewhere, join(shared, 'link-dir'))
  symlinkSync(join(elsewhere, 'secret.txt'), join(shared, 'link-file'))
  symlinkSync(join(elsewhere, 'nowhere.txt'), join(shared, 'dangling'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64')
const wire = (
  path: string,
  body: string | Buffer,
  extra: Partial<MacWriteFileWire> = {}
): MacWriteFileWire => {
  const data = Buffer.from(body)
  return {
    path,
    mode: 'create',
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
    dataBase64: data.toString('base64'),
    ...extra
  }
}

describe('writeLevel', () => {
  it('off unless set; read asks; read+run, full and any other level above read write', () => {
    expect(writeLevel(null)).toBe('off')
    expect(writeLevel('off')).toBe('off')
    expect(writeLevel('')).toBe('off')
    expect(writeLevel('read')).toBe('ask')
    expect(writeLevel('read+run')).toBe('write')
    expect(writeLevel('full')).toBe('write')
    expect(writeLevel('a-level-from-a-newer-build')).toBe('write')
  })
})

describe('writeDenied', () => {
  it('~/Library, dotfiles and dot-folders directly in home, and keys by name', () => {
    expect(writeDenied(join(home, '.zshrc'), home)).toBe(true)
    expect(writeDenied(join(home, '.ssh', 'authorized_keys'), home)).toBe(true)
    expect(writeDenied(join(home, '.config', 'tool', 'x.json'), home)).toBe(true)
    expect(writeDenied(join(home, 'Library', 'LaunchAgents', 'evil.plist'), home)).toBe(true)
    expect(writeDenied(join(home, 'library', 'x'), home)).toBe(true)
    expect(writeDenied(join(shared, 'server.pem'), home)).toBe(true)
    expect(writeDenied(join(shared, 'auth.json'), home)).toBe(true)
  })
  it('not an ordinary file, nor a dotfile deeper down, nor a path outside home', () => {
    expect(writeDenied(join(shared, 'notes.md'), home)).toBe(false)
    expect(writeDenied(join(shared, '.gitignore'), home)).toBe(false)
    expect(writeDenied(join(home, 'top.txt'), home)).toBe(false)
    expect(writeDenied('/tmp/x.txt', home)).toBe(false)
  })
})

describe('writeVerdict', () => {
  const rules = {
    level: 'write' as const,
    home: '',
    managed: [] as string[],
    shared: [] as string[],
    remembered: [] as string[]
  }
  beforeAll(() => {
    rules.home = home
    rules.managed = [managed]
    rules.shared = [shared, dotShared]
    rules.remembered = [join(elsewhere, 'ok')]
  })
  it('managed, shared and remembered land at once; elsewhere asks with its folder', () => {
    expect(writeVerdict(join(managed, 'a.txt'), rules)).toEqual({ allow: true, why: 'managed' })
    expect(writeVerdict(join(shared, 'a.txt'), rules)).toEqual({ allow: true, why: 'shared' })
    expect(writeVerdict(join(elsewhere, 'ok', 'a.txt'), rules)).toEqual({
      allow: true,
      why: 'remembered'
    })
    expect(writeVerdict(join(elsewhere, 'a.txt'), rules)).toEqual({
      allow: false,
      why: 'outside',
      folder: elsewhere
    })
  })
  it('directly in home asks with nothing to remember', () => {
    expect(writeVerdict(join(home, 'a.txt'), rules)).toEqual({
      allow: false,
      why: 'outside',
      folder: null
    })
  })
  it('the deny list asks even inside a shared folder, and is never remembered', () => {
    expect(writeVerdict(join(dotShared, 'cfg.json'), rules)).toEqual({
      allow: false,
      why: 'denied',
      folder: null
    })
    expect(writeVerdict(join(shared, 'id.key'), rules)).toMatchObject({
      allow: false,
      why: 'denied'
    })
  })
  it('policy read: every write asks, nothing to remember', () => {
    expect(writeVerdict(join(shared, 'a.txt'), { ...rules, level: 'ask' })).toEqual({
      allow: false,
      why: 'policy read',
      folder: null
    })
  })
})

describe('writeTarget', () => {
  it('real spelling: a symlinked folder or file is judged at its target', () => {
    expect(writeTarget(join(shared, 'link-dir', 'x.txt'), home)).toBe(join(elsewhere, 'x.txt'))
    expect(writeTarget(join(shared, 'link-file'), home)).toBe(join(elsewhere, 'secret.txt'))
    expect(writeTarget(join(shared, 'new', 'deeper', 'x.txt'), home)).toBe(
      join(shared, 'new', 'deeper', 'x.txt')
    )
    expect(writeTarget('~/Documents/shared/a.txt', home)).toBe(join(shared, 'a.txt'))
  })
  it('refuses relative paths and /', () => {
    expect(() => writeTarget('Documents/a.txt', home)).toThrow(/absolute/)
    expect(() => writeTarget('/', home)).toThrow(/not a file/)
  })
})

describe('writeMacFile', () => {
  const noTemps = (dir: string): boolean => !readdirSync(dir).some((n) => n.includes('.tc-write-'))
  it('create lands a new file atomically, makes missing folders, refuses an existing file', async () => {
    const dest = join(shared, 'made', 'here', 'new.txt')
    expect(await writeMacFile(dest, Buffer.from('hello'), 'create')).toEqual({ created: true })
    expect(readFileSync(dest, 'utf8')).toBe('hello')
    expect(statSync(dest).mode & 0o777).toBe(0o644)
    await expect(writeMacFile(dest, Buffer.from('again'), 'create')).rejects.toThrow(/exists/)
    expect(readFileSync(dest, 'utf8')).toBe('hello')
    expect(noTemps(join(shared, 'made', 'here'))).toBe(true)
  })
  it('overwrite replaces in one rename and keeps the mode unless told', async () => {
    const dest = join(shared, 'existing.txt')
    expect(await writeMacFile(dest, Buffer.from('new body'), 'overwrite')).toEqual({
      created: false
    })
    expect(readFileSync(dest, 'utf8')).toBe('new body')
    expect(statSync(dest).mode & 0o777).toBe(0o640)
    await writeMacFile(dest, Buffer.from('x'), 'overwrite', 0o600)
    expect(statSync(dest).mode & 0o777).toBe(0o600)
    expect(noTemps(shared)).toBe(true)
  })
  it('append adds to the end, creates a missing file, never makes folders', async () => {
    const dest = join(shared, 'log.txt')
    await writeMacFile(dest, Buffer.from('one\n'), 'append')
    await writeMacFile(dest, Buffer.from('two\n'), 'append')
    expect(readFileSync(dest, 'utf8')).toBe('one\ntwo\n')
    await expect(
      writeMacFile(join(shared, 'nope', 'log.txt'), Buffer.from('x'), 'append')
    ).rejects.toThrow(/no such folder/)
    expect(existsSync(join(shared, 'nope'))).toBe(false)
  })
  it('a dangling symlink is never followed out of the folder', async () => {
    const link = join(shared, 'dangling')
    await expect(writeMacFile(link, Buffer.from('x'), 'append')).rejects.toThrow()
    await expect(writeMacFile(link, Buffer.from('x'), 'create')).rejects.toThrow(/exists/)
    expect(existsSync(join(elsewhere, 'nowhere.txt'))).toBe(false)
  })
  it('a folder at the path is refused', async () => {
    await expect(writeMacFile(elsewhere, Buffer.from('x'), 'overwrite')).rejects.toThrow(/folder/)
  })
})

function bridge(link: ((method: string, params?: unknown) => Promise<unknown>) | null = null) {
  const settings = new Map<string, string>()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v))
    },
    managedRoots: () => [managed],
    environments: () => [{ id: 'env_box', name: 'box' }],
    link: () => link,
    home,
    shell: '/bin/sh',
    log: (l) => lines.push(l)
  })
  mb.subscribe((p) => pushes.push(p))
  const requests = (): MacBridgeRequest[] =>
    pushes
      .filter(
        (p): p is Extract<MacBridgePush, { push: 'macBridge.request' }> =>
          p.push === 'macBridge.request'
      )
      .map((p) => p.request)
  const nextRequest = async (index = 0): Promise<MacBridgeRequest> => {
    for (let i = 0; i < 200; i++) {
      if (requests().length > index) return requests()[index]
      await new Promise((ok) => setTimeout(ok, 5))
    }
    throw new Error('no request')
  }
  const write = (args: MacWriteFileWire, thread = 's1') =>
    mb.handle(
      'mac.writeFile',
      { thread: { id: thread, title: `thread ${thread}` }, args },
      { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    ) as Promise<MacWriteFileResult>
  return { mb, settings, lines, requests, nextRequest, write }
}

describe('MacBridge mac.writeFile', () => {
  it('off: refused, nothing written, nothing asked', async () => {
    const b = bridge()
    await expect(b.write(wire(join(shared, 'off.txt'), 'x'))).rejects.toThrow(/off for this host/)
    expect(existsSync(join(shared, 'off.txt'))).toBe(false)
    expect(b.requests()).toEqual([])
  })

  it('read: even a shared folder asks, with no remember; allowed, it lands', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read')
    b.mb.setShared('env_box', [shared])
    const dest = join(shared, 'read-policy.txt')
    const pending = b.write(wire(dest, 'body'))
    const req = await b.nextRequest()
    expect(req).toMatchObject({
      kind: 'write',
      method: 'mac.writeFile',
      path: dest,
      bytes: 4,
      writeMode: 'create'
    })
    expect(req.folder).toBeUndefined()
    b.mb.decide(req.id, true, true)
    await expect(pending).resolves.toEqual({ path: dest, bytes: 4, mode: 'create', created: true })
    // remember was not on offer: the next write asks again
    const again = b.write(wire(join(shared, 'read-policy-2.txt'), 'b'))
    const req2 = await b.nextRequest(1)
    b.mb.decide(req2.id, false)
    await expect(again).rejects.toThrow(/denied at the Mac/)
    expect(existsSync(join(shared, 'read-policy-2.txt'))).toBe(false)
  })

  it('read+run: shared and managed land with no prompt; one log line, never the contents', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    b.mb.setShared('env_box', [shared])
    const out = await b.write(wire(join(shared, 'plain.txt'), 'the secret body'))
    expect(out).toMatchObject({ bytes: 15, created: true })
    expect(readFileSync(join(shared, 'plain.txt'), 'utf8')).toBe('the secret body')
    await b.write(wire(join(managed, 'gen.txt'), 'm'))
    expect(b.requests()).toEqual([])
    const writes = b.lines.filter((l) => l.includes('mac.writeFile'))
    expect(writes).toEqual([
      `box (env_box) thread=s1 mac.writeFile path=${join(shared, 'plain.txt')} bytes=15 mode=create → written (shared)`,
      `box (env_box) thread=s1 mac.writeFile path=${join(managed, 'gen.txt')} bytes=1 mode=create → written (managed)`
    ])
    expect(b.lines.join('\n')).not.toContain('secret body')
  })

  it('outside: asks with the folder; denied writes nothing; allowed + remembered, the folder then takes writes for that thread only', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const target = join(elsewhere, 'out', 'a.txt')
    const denied = b.write(wire(target, 'x'))
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({
      kind: 'write',
      path: target,
      folder: join(elsewhere, 'out'),
      createsFolders: true
    })
    b.mb.decide(r1.id, false)
    await expect(denied).rejects.toThrow(/denied at the Mac/)
    expect(existsSync(join(elsewhere, 'out'))).toBe(false)
    const allowed = b.write(wire(target, 'x'))
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, true, true)
    await expect(allowed).resolves.toMatchObject({ path: target, created: true })
    await b.write(wire(join(elsewhere, 'out', 'b.txt'), 'y'))
    expect(b.requests()).toHaveLength(2)
    expect(b.lines.some((l) => l.endsWith('→ written (remembered)'))).toBe(true)
    // another thread still asks
    const other = b.write(wire(join(elsewhere, 'out', 'c.txt'), 'z'), 's2')
    const r3 = await b.nextRequest(2)
    b.mb.decide(r3.id, false)
    await expect(other).rejects.toThrow(/denied/)
  })

  it('a folder remembered for reads never admits a write: the memories are apart', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    const read = b.mb.handle(
      'mac.readFile',
      { thread: { id: 's1', title: 't' }, args: { path: join(elsewhere, 'secret.txt') } },
      { from: 'env_box', deadlineAt: Date.now() + 15 * 60_000 }
    )
    const r1 = await b.nextRequest()
    expect(r1.kind).toBe('read')
    b.mb.decide(r1.id, true, true)
    await read
    const write = b.write(wire(join(elsewhere, 'after-read.txt'), 'x'))
    const r2 = await b.nextRequest(1)
    expect(r2.kind).toBe('write')
    b.mb.decide(r2.id, false)
    await expect(write).rejects.toThrow(/denied/)
  })

  it('a symlink out of a shared folder asks, at its real path', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    b.mb.setShared('env_box', [shared])
    const pending = b.write(wire(join(shared, 'link-dir', 'escape.txt'), 'x'))
    const req = await b.nextRequest()
    expect(req.path).toBe(join(elsewhere, 'escape.txt'))
    b.mb.decide(req.id, false)
    await expect(pending).rejects.toThrow(/denied/)
    expect(existsSync(join(elsewhere, 'escape.txt'))).toBe(false)
  })

  it('an unknown level above read (full) writes like read+run; the deny list asks every time, even shared', async () => {
    const b = bridge()
    b.mb.setShared('env_box', [shared, dotShared])
    b.settings.set('macBridge.policy.env_box', 'full')
    await expect(b.write(wire(join(shared, 'full.txt'), 'f'))).resolves.toMatchObject({ bytes: 1 })
    expect(b.requests()).toEqual([])
    const zshrc = b.write(wire(join(home, '.zshrc'), 'evil', { mode: 'append' }))
    const r1 = await b.nextRequest()
    expect(r1).toMatchObject({ path: join(home, '.zshrc'), writeMode: 'append' })
    expect(r1.folder).toBeUndefined()
    b.mb.decide(r1.id, false)
    await expect(zshrc).rejects.toThrow(/denied/)
    expect(existsSync(join(home, '.zshrc'))).toBe(false)
    const cfg = b.write(wire(join(dotShared, 'cfg.json'), '{}'))
    const r2 = await b.nextRequest(1)
    b.mb.decide(r2.id, true, true)
    await expect(cfg).resolves.toMatchObject({ created: true })
    const cfg2 = b.write(wire(join(dotShared, 'cfg2.json'), '{}'))
    const r3 = await b.nextRequest(2)
    b.mb.decide(r3.id, false)
    await expect(cfg2).rejects.toThrow(/denied/)
    const plist = b.write(wire(join(home, 'Library', 'Preferences', 'x.plist'), 'p'))
    const r4 = await b.nextRequest(3)
    b.mb.decide(r4.id, false)
    await expect(plist).rejects.toThrow(/denied/)
  })

  it('a staged write is pulled over the link only after it is allowed, and checked against its hash', async () => {
    const body = Buffer.alloc(10_000, 7)
    const pieces = [b64(body).slice(0, 6000), b64(body).slice(6000)]
    const pulls: unknown[] = []
    const b = bridge(async (method, params) => {
      expect(method).toBe('peer.pull')
      pulls.push(params)
      return { data: pieces[(params as { index: number }).index] }
    })
    b.mb.setPolicy('env_box', 'read+run')
    const dest = join(elsewhere, 'staged.bin')
    const staged = { ...wire(dest, body), dataBase64: undefined, staged: { id: 'st1', chunks: 2 } }
    const pending = b.write(staged)
    const req = await b.nextRequest()
    expect(pulls).toEqual([])
    b.mb.decide(req.id, true)
    await expect(pending).resolves.toMatchObject({ bytes: 10_000 })
    expect(pulls).toEqual([
      { stageId: 'st1', index: 0 },
      { stageId: 'st1', index: 1 }
    ])
    expect(readFileSync(dest).equals(body)).toBe(true)
    b.mb.setShared('env_box', [shared])
    const bad = { ...staged, path: join(shared, 'bad.bin'), sha256: '0'.repeat(64) }
    await expect(b.write(bad)).rejects.toThrow(/damaged/)
    expect(existsSync(join(shared, 'bad.bin'))).toBe(false)
  })

  it('refuses a wire with both or neither of inline and staged bytes', async () => {
    const b = bridge()
    b.mb.setPolicy('env_box', 'read+run')
    b.mb.setShared('env_box', [shared])
    const w = wire(join(shared, 'none.txt'), 'x')
    await expect(b.write({ ...w, dataBase64: undefined })).rejects.toThrow(/no bytes/)
    await expect(b.write({ ...w, staged: { id: 's', chunks: 1 } })).rejects.toThrow(/no bytes/)
    expect(existsSync(join(shared, 'none.txt'))).toBe(false)
  })
})
