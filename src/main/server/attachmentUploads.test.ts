import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTACHMENT_CHUNK_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES } from '@shared/contract-attachments'
import { attachmentDir, attachmentDirsOf, type AttachmentDirContext } from './attachmentDir'
import {
  AttachmentUploads,
  UploadError,
  digestFile,
  freeName,
  readRange,
  sanitizeAttachmentName,
  sweepAttachmentRoots,
  sweepThreadAttachments
} from './attachmentUploads'
import { readAttachment } from './attachments'
import { setAttachmentDirContext } from './attachmentDir'

let dir: string
let clock: number
let settings: Map<string, string>
let uploads: AttachmentUploads

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const b64 = (b: Buffer): string => b.toString('base64')
const landing = (sessionId: string): string => join(dir, 'land', sessionId)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-uploads-'))
  clock = 1_000_000
  settings = new Map()
  uploads = new AttachmentUploads({
    dirFor: landing,
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    now: () => clock,
    sweepEveryMs: 0
  })
})
afterEach(() => {
  uploads.close()
  setAttachmentDirContext(null)
  rmSync(dir, { recursive: true, force: true })
})

/** Upload `bytes` in chunks of the contract's size; answers the committed attachment. */
async function upload(bytes: Buffer, name = 'report.pdf', sessionId = 's1', owner = 'local') {
  const { uploadId, chunkBytes } = await uploads.begin(owner, { sessionId, name, size: bytes.length, sha256: sha(bytes) })
  for (let i = 0, index = 0; i < bytes.length; i += chunkBytes, index += 1) {
    await uploads.chunk(owner, { uploadId, index, dataBase64: b64(bytes.subarray(i, i + chunkBytes)) })
  }
  return uploads.commit(owner, uploadId)
}

describe('AttachmentUploads', () => {
  it('lands a multi-chunk file byte for byte under the session dir, size and sha checked', async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES * 2 + 1234, 7)
    bytes.write('head', 0)
    bytes.write('tail', bytes.length - 4)
    const att = await upload(bytes)
    expect(att.path).toBe(join(landing('s1'), 'report.pdf'))
    expect(att).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', kind: 'file', size: bytes.length })
    expect(readFileSync(att.path).equals(bytes)).toBe(true)
    // No partial file left behind.
    expect(readdirSync(landing('s1'))).toEqual(['report.pdf'])
    expect(uploads.size).toBe(0)
  })

  it('takes an empty file', async () => {
    const att = await upload(Buffer.alloc(0), 'empty.txt')
    expect(readFileSync(att.path).length).toBe(0)
  })

  it('de-duplicates on a name collision', async () => {
    const a = await upload(Buffer.from('one'), 'shot.png')
    const b = await upload(Buffer.from('two'), 'shot.png')
    const c = await upload(Buffer.from('three'), 'shot.png')
    expect([a.name, b.name, c.name]).toEqual(['shot.png', 'shot-1.png', 'shot-2.png'])
    expect(b.kind).toBe('image')
    expect(readFileSync(b.path, 'utf8')).toBe('two')
  })

  it('sanitizes the name to one safe segment', async () => {
    const att = await upload(Buffer.from('x'), '../../etc/passwd')
    expect(att.path).toBe(join(landing('s1'), 'passwd'))
    expect(sanitizeAttachmentName('..')).toBe('attachment')
    expect(sanitizeAttachmentName('/Users/me/Desktop/My Report (final).pdf')).toBe('My_Report_final_.pdf')
    expect(sanitizeAttachmentName('C:\\Users\\me\\a.png')).toBe('a.png')
    expect(sanitizeAttachmentName('.env')).toBe('env')
    expect(sanitizeAttachmentName('ünïcode ✓.md')).toBe('ünïcode_.md')
    const long = sanitizeAttachmentName(`${'a'.repeat(300)}.json`)
    expect(long.length).toBe(120)
    expect(long.endsWith('.json')).toBe(true)
  })

  it('refuses a bad session id before touching the disk', async () => {
    await expect(uploads.begin('local', { sessionId: '../x', name: 'a', size: 1, sha256: sha(Buffer.from('a')) })).rejects.toThrow(
      'bad session id'
    )
    expect(existsSync(join(dir, 'land'))).toBe(false)
  })

  it('refuses a size over attachment.maxBytes, and the setting moves the limit', async () => {
    expect(uploads.settings().maxBytes).toBe(DEFAULT_ATTACHMENT_MAX_BYTES)
    uploads.setSettings({ maxBytes: 10 })
    await expect(uploads.begin('local', { sessionId: 's1', name: 'a', size: 11, sha256: sha(Buffer.alloc(11)) })).rejects.toMatchObject({
      code: 'too-large'
    })
    await expect(upload(Buffer.alloc(10))).resolves.toMatchObject({ size: 10 })
    uploads.setSettings({ maxBytes: null })
    expect(uploads.settings().maxBytes).toBe(DEFAULT_ATTACHMENT_MAX_BYTES)
  })

  it('refuses a chunk out of order and a repeated index', async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 10, 1)
    const { uploadId } = await uploads.begin('local', { sessionId: 's1', name: 'a.bin', size: bytes.length, sha256: sha(bytes) })
    await expect(uploads.chunk('local', { uploadId, index: 1, dataBase64: b64(bytes.subarray(0, 10)) })).rejects.toMatchObject({
      code: 'out-of-order'
    })
    await uploads.chunk('local', { uploadId, index: 0, dataBase64: b64(bytes.subarray(0, ATTACHMENT_CHUNK_BYTES)) })
    await expect(uploads.chunk('local', { uploadId, index: 0, dataBase64: b64(bytes.subarray(0, 10)) })).rejects.toMatchObject({
      code: 'out-of-order'
    })
    // Still good after the refusals: the right next chunk lands and commits.
    await uploads.chunk('local', { uploadId, index: 1, dataBase64: b64(bytes.subarray(ATTACHMENT_CHUNK_BYTES)) })
    const att = await uploads.commit('local', uploadId)
    expect(readFileSync(att.path).equals(bytes)).toBe(true)
  })

  it('refuses a commit short of the declared size, and more bytes than declared', async () => {
    const bytes = Buffer.from('hello world')
    const short = await uploads.begin('local', { sessionId: 's1', name: 'a.txt', size: bytes.length, sha256: sha(bytes) })
    await uploads.chunk('local', { uploadId: short.uploadId, index: 0, dataBase64: b64(bytes.subarray(0, 5)) })
    await expect(uploads.commit('local', short.uploadId)).rejects.toMatchObject({ code: 'size-mismatch' })
    const long = await uploads.begin('local', { sessionId: 's1', name: 'b.txt', size: 3, sha256: sha(bytes) })
    await expect(uploads.chunk('local', { uploadId: long.uploadId, index: 0, dataBase64: b64(bytes) })).rejects.toMatchObject({
      code: 'size-mismatch'
    })
    // Both partials are gone and nothing landed.
    expect(readdirSync(landing('s1'))).toEqual([])
    expect(uploads.size).toBe(0)
  })

  it('refuses a commit whose sha256 does not match', async () => {
    const bytes = Buffer.from('the real bytes')
    const { uploadId } = await uploads.begin('local', { sessionId: 's1', name: 'a.txt', size: bytes.length, sha256: sha(Buffer.from('other')) })
    await uploads.chunk('local', { uploadId, index: 0, dataBase64: b64(bytes) })
    let caught: unknown
    await uploads.commit('local', uploadId).catch((err) => (caught = err))
    expect(caught).toBeInstanceOf(UploadError)
    expect((caught as UploadError).code).toBe('sha-mismatch')
    expect(readdirSync(landing('s1'))).toEqual([])
    // A refused commit spends the upload.
    await expect(uploads.commit('local', uploadId)).rejects.toMatchObject({ code: 'unknown-upload' })
  })

  it("answers unknown for another principal's upload", async () => {
    const bytes = Buffer.from('mine')
    const { uploadId } = await uploads.begin('key:a', { sessionId: 's1', name: 'a.txt', size: bytes.length, sha256: sha(bytes) })
    await expect(uploads.chunk('key:b', { uploadId, index: 0, dataBase64: b64(bytes) })).rejects.toMatchObject({ code: 'unknown-upload' })
    await uploads.abort('key:b', uploadId) // a no-op for a stranger
    await uploads.chunk('key:a', { uploadId, index: 0, dataBase64: b64(bytes) })
    await expect(uploads.commit('key:a', uploadId)).resolves.toMatchObject({ size: 4 })
  })

  it('expires an upload idle past ten minutes, with its partial file', async () => {
    const bytes = Buffer.from('abcdef')
    const { uploadId } = await uploads.begin('local', { sessionId: 's1', name: 'a.txt', size: bytes.length, sha256: sha(bytes) })
    await uploads.chunk('local', { uploadId, index: 0, dataBase64: b64(bytes.subarray(0, 3)) })
    expect(readdirSync(landing('s1')).filter((n) => n.endsWith('.part'))).toHaveLength(1)
    // Each chunk restarts the clock: 9 minutes in, still alive.
    clock += 9 * 60_000
    expect(await uploads.sweepExpired()).toBe(0)
    clock += 2 * 60_000
    expect(await uploads.sweepExpired()).toBe(1)
    expect(readdirSync(landing('s1'))).toEqual([])
    await expect(uploads.chunk('local', { uploadId, index: 1, dataBase64: b64(bytes.subarray(3)) })).rejects.toMatchObject({
      code: 'unknown-upload'
    })
  })

  it('expires on access too, before the sweep runs', async () => {
    const bytes = Buffer.from('abc')
    const { uploadId } = await uploads.begin('local', { sessionId: 's1', name: 'a.txt', size: bytes.length, sha256: sha(bytes) })
    clock += 11 * 60_000
    await expect(uploads.chunk('local', { uploadId, index: 0, dataBase64: b64(bytes) })).rejects.toMatchObject({ code: 'unknown-upload' })
  })

  it('abort and dropSessions remove the partials', async () => {
    const a = await uploads.begin('local', { sessionId: 's1', name: 'a.txt', size: 3, sha256: sha(Buffer.from('abc')) })
    await uploads.begin('local', { sessionId: 's2', name: 'b.txt', size: 3, sha256: sha(Buffer.from('abc')) })
    await uploads.abort('local', a.uploadId)
    expect(readdirSync(landing('s1'))).toEqual([])
    uploads.dropSessions(['s2'])
    await new Promise((r) => setTimeout(r, 20))
    expect(readdirSync(landing('s2'))).toEqual([])
    expect(uploads.size).toBe(0)
  })
})

describe('freeName', () => {
  it('counts up past taken names, extensionless too', () => {
    writeFileSync(join(dir, 'notes'), '')
    writeFileSync(join(dir, 'notes-1'), '')
    expect(freeName(dir, 'notes')).toBe('notes-2')
    expect(freeName(dir, 'fresh.md')).toBe('fresh.md')
  })
})

describe('digestFile / readRange', () => {
  it('hash the whole file and read it back in ranges', async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 99)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251
    const path = join(dir, 'big.bin')
    writeFileSync(path, bytes)
    expect(await digestFile(path)).toEqual({ size: bytes.length, sha256: sha(bytes) })
    const first = await readRange(path, 0, ATTACHMENT_CHUNK_BYTES)
    const rest = await readRange(path, ATTACHMENT_CHUNK_BYTES, ATTACHMENT_CHUNK_BYTES)
    expect(first.size).toBe(bytes.length)
    expect(Buffer.concat([Buffer.from(first.dataBase64, 'base64'), Buffer.from(rest.dataBase64, 'base64')]).equals(bytes)).toBe(true)
    expect((await readRange(path, bytes.length, 10)).dataBase64).toBe('')
    await expect(digestFile(dir)).rejects.toThrow()
  })
})

describe('attachmentDir', () => {
  const ctx = (): AttachmentDirContext => ({
    session: (id) =>
      ({
        p1: { id: 'p1', projectId: 'proj', workspaceId: null },
        w1: { id: 'w1', projectId: null, workspaceId: 'ws' },
        gone: { id: 'gone', projectId: 'deleted-project', workspaceId: null }
      })[id] ?? null,
    projectCwd: (id) => (id === 'proj' ? join(dir, 'repo') : null),
    workspacePath: (id) => (id === 'ws' ? join(dir, 'ws') : null),
    dataDir: join(dir, 'userData')
  })
  it('prefers the project cwd, then the workspace path, then userData', () => {
    const c = ctx()
    expect(attachmentDir('p1', c)).toBe(join(dir, 'repo', '.temp-code', 'attachments', 'p1'))
    expect(attachmentDir('w1', c)).toBe(join(dir, 'ws', '.temp-code', 'attachments', 'w1'))
    expect(attachmentDir('draft', c)).toBe(join(dir, 'userData', 'attachments', 'draft'))
    expect(attachmentDir('gone', c)).toBe(join(dir, 'userData', 'attachments', 'gone'))
    expect(attachmentDir({ id: 'x', projectId: 'proj', workspaceId: null }, c)).toBe(join(dir, 'repo', '.temp-code', 'attachments', 'x'))
    expect(() => attachmentDir('../etc', c)).toThrow('bad session id')
  })
  it('lists the landing dir and the userData fallback for the sweep', () => {
    expect(attachmentDirsOf('p1', ctx())).toEqual([
      join(dir, 'repo', '.temp-code', 'attachments', 'p1'),
      join(dir, 'userData', 'attachments', 'p1')
    ])
    expect(attachmentDirsOf('draft', ctx())).toEqual([join(dir, 'userData', 'attachments', 'draft')])
  })
  it('throws before the server configured it', () => {
    expect(() => attachmentDir('p1')).toThrow('not configured')
  })
})

describe('sweeps', () => {
  it('the delete sweep removes every directory of the thread', () => {
    setAttachmentDirContext({
      session: () => null,
      projectCwd: () => join(dir, 'repo'),
      workspacePath: () => null,
      dataDir: join(dir, 'userData')
    })
    const project = join(dir, 'repo', '.temp-code', 'attachments', 's1')
    const fallback = join(dir, 'userData', 'attachments', 's1')
    const other = join(dir, 'repo', '.temp-code', 'attachments', 's2')
    for (const d of [project, fallback, other]) {
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'f'), 'x')
    }
    sweepThreadAttachments({ id: 's1', projectId: 'proj', workspaceId: null })
    expect(existsSync(project)).toBe(false)
    expect(existsSync(fallback)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('the retention sweep drops threads archived 30 days ago and old orphans, nothing else', async () => {
    const now = Date.now()
    const day = 86_400_000
    const root = join(dir, 'root')
    const make = (name: string, mtime = now) => {
      const d = join(root, name)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'f'), 'x')
      utimesSync(d, mtime / 1000, mtime / 1000)
      return d
    }
    const live = make('live')
    const freshArchive = make('fresh-archive')
    const oldArchive = make('old-archive')
    const newOrphan = make('new-orphan')
    const oldOrphan = make('old-orphan', now - 2 * day)
    writeFileSync(join(root, 'stray-file'), 'x')
    const rows: Record<string, { archived: boolean; updatedAt: number }> = {
      live: { archived: false, updatedAt: now - 90 * day },
      'fresh-archive': { archived: true, updatedAt: now - 29 * day },
      'old-archive': { archived: true, updatedAt: now - 31 * day }
    }
    const removed = await sweepAttachmentRoots([root, join(dir, 'missing-root')], (id) => rows[id] ?? null, { now })
    expect(removed.sort()).toEqual([oldArchive, oldOrphan].sort())
    expect(existsSync(live) && existsSync(freshArchive) && existsSync(newOrphan)).toBe(true)
    expect(existsSync(join(root, 'stray-file'))).toBe(true)
  })
})

describe('the retention sweep and a restore', () => {
  it('a thread restored while the sweep paused keeps its files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-sweep-restore-'))
    const root = join(dir, 'attachments')
    const target = join(root, 'old-archive')
    mkdirSync(target, { recursive: true })
    const now = Date.now()
    const row = { archived: true, updatedAt: now - 40 * 86_400_000 }
    const removed = await sweepAttachmentRoots([root], () => row, {
      now,
      between: async () => {
        // The person restores the thread while the sweep waits for a quiet loop.
        row.archived = false
      }
    })
    expect(removed).toEqual([])
    expect(existsSync(target)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('readAttachment', () => {
  it('refuses a sibling whose name only starts with a root (the old startsWith check)', async () => {
    const root = join(dir, 'repo')
    const sibling = join(dir, 'repo-evil')
    mkdirSync(root, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(root, 'a.png'), 'png')
    writeFileSync(join(sibling, 'b.png'), 'png')
    await expect(readAttachment(join(root, 'a.png'), [root])).resolves.toMatch(/^data:image\/png;base64,/)
    await expect(readAttachment(join(sibling, 'b.png'), [root])).rejects.toThrow('outside app-managed')
    await expect(readAttachment(join(root, '..', 'repo-evil', 'b.png'), [root])).rejects.toThrow('outside app-managed')
  })
})
