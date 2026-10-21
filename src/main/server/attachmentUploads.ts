import { createHash, type Hash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { appendFile, open, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { ClientRequest } from '@shared/contract'
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_UPLOAD_TTL_MS,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  type AttachmentBeginAnswer,
  type AttachmentBeginParams,
  type AttachmentChunkAnswer,
  type AttachmentChunkParams,
  type AttachmentDigest,
  type AttachmentRange,
  type AttachmentSettings,
  type CommittedAttachment
} from '@shared/contract-attachments'
import { assertSessionId, attachmentDirsOf, type AttachmentSession } from './attachmentDir'
import { mimeFor } from './attachments'

/**
 * Chunked uploads into a thread's attachment directory (attachmentDir.ts):
 * `begin` reserves a hidden partial file in the landing dir, each `chunk`
 * (strictly in order) is appended and hashed before it is answered, and
 * `commit` checks the size and sha256 `begin` declared, then renames the
 * partial to the sanitized name (`name-1.ext` on a collision). An upload
 * nobody touched for ATTACHMENT_UPLOAD_TTL_MS is dropped with its partial.
 * Uploads belong to the principal that began them (a key id, or the local
 * socket); another caller's id answers "unknown upload".
 */

export const MAX_BYTES_KEY = 'attachment.maxBytes'

export type UploadErrorCode = 'too-large' | 'unknown-upload' | 'out-of-order' | 'size-mismatch' | 'sha-mismatch' | 'bad-name'

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

interface Upload {
  id: string
  owner: string
  sessionId: string
  dir: string
  partial: string
  name: string
  mime?: string
  size: number
  sha256: string
  received: number
  nextIndex: number
  hash: Hash
  touchedAt: number
  /** One chunk at a time: a second write while one is in flight is out of order by definition. */
  busy: boolean
}

export interface AttachmentUploadsDeps {
  /** The landing directory for a session's attachments (attachmentDir). */
  dirFor(sessionId: string): string
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  now?: () => number
  ttlMs?: number
  /** Sweep cadence for expired uploads; 0 turns the timer off (tests sweep by hand). */
  sweepEveryMs?: number
}

/** A name that is safe as one path segment: the last segment of whatever
 *  was sent, letters (non-ASCII kept), digits, `_`, dots and dashes only,
 *  no leading dots, at most 120 characters with the extension kept. */
export function sanitizeAttachmentName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? ''
  let safe = last.normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^\.+/, '').replace(/_+/g, '_')
  if (!safe || safe === '_') safe = 'attachment'
  if (safe.length > 120) {
    const ext = extname(safe).slice(0, 20)
    safe = safe.slice(0, 120 - ext.length) + ext
  }
  return safe
}

/** The first of `name`, `stem-1.ext`, `stem-2.ext`, … that does not exist in `dir`. */
export function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let n = 1; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
}

export class AttachmentUploads {
  private readonly uploads = new Map<string, Upload>()
  private readonly timer: NodeJS.Timeout | null
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: AttachmentUploadsDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? ATTACHMENT_UPLOAD_TTL_MS
    const every = deps.sweepEveryMs ?? 60_000
    this.timer = every > 0 ? setInterval(() => void this.sweepExpired(), every) : null
    this.timer?.unref()
  }

  settings(): AttachmentSettings {
    const raw = Number(this.deps.store.getSetting(MAX_BYTES_KEY))
    return {
      maxBytes: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ATTACHMENT_MAX_BYTES,
      chunkBytes: ATTACHMENT_CHUNK_BYTES
    }
  }

  setSettings(patch: { maxBytes: number | null }): AttachmentSettings {
    this.deps.store.setSetting(MAX_BYTES_KEY, patch.maxBytes === null ? null : String(patch.maxBytes))
    return this.settings()
  }

  /** Live uploads (tests, diagnostics). */
  get size(): number {
    return this.uploads.size
  }

  async begin(owner: string, params: AttachmentBeginParams): Promise<AttachmentBeginAnswer> {
    assertSessionId(params.sessionId)
    const { maxBytes } = this.settings()
    if (params.size > maxBytes) {
      throw new UploadError('too-large', `attachment too large: ${params.size} bytes is over this host's limit of ${maxBytes}`)
    }
    const dir = this.deps.dirFor(params.sessionId)
    mkdirSync(dir, { recursive: true })
    const id = nanoid(21)
    const partial = join(dir, `.upload-${id}.part`)
    await writeFile(partial, new Uint8Array(0))
    this.uploads.set(id, {
      id,
      owner,
      sessionId: params.sessionId,
      dir,
      partial,
      name: sanitizeAttachmentName(params.name),
      mime: params.mime,
      size: params.size,
      sha256: params.sha256,
      received: 0,
      nextIndex: 0,
      hash: createHash('sha256'),
      touchedAt: this.now(),
      busy: false
    })
    return { uploadId: id, chunkBytes: ATTACHMENT_CHUNK_BYTES }
  }

  private take(owner: string, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.owner !== owner) throw new UploadError('unknown-upload', 'unknown upload (expired, aborted or never begun)')
    if (this.now() - upload.touchedAt > this.ttlMs) {
      void this.drop(upload)
      throw new UploadError('unknown-upload', 'unknown upload (expired, aborted or never begun)')
    }
    return upload
  }

  async chunk(owner: string, params: AttachmentChunkParams): Promise<AttachmentChunkAnswer> {
    const upload = this.take(owner, params.uploadId)
    if (upload.busy || params.index !== upload.nextIndex) {
      throw new UploadError('out-of-order', `chunk ${params.index} out of order: expected ${upload.nextIndex}`)
    }
    const bytes = Buffer.from(params.dataBase64, 'base64')
    if (bytes.length > ATTACHMENT_CHUNK_BYTES) throw new UploadError('size-mismatch', 'chunk larger than the chunk size')
    if (upload.received + bytes.length > upload.size) {
      await this.drop(upload)
      throw new UploadError('size-mismatch', `upload is larger than the ${upload.size} bytes begin declared`)
    }
    upload.busy = true
    try {
      await appendFile(upload.partial, bytes)
    } catch (err) {
      await this.drop(upload)
      throw err
    } finally {
      upload.busy = false
    }
    upload.hash.update(bytes)
    upload.received += bytes.length
    upload.nextIndex += 1
    upload.touchedAt = this.now()
    return { received: upload.received }
  }

  async commit(owner: string, uploadId: string): Promise<CommittedAttachment> {
    const upload = this.take(owner, uploadId)
    if (upload.busy) throw new UploadError('out-of-order', 'a chunk is still being written')
    this.uploads.delete(upload.id)
    const fail = async (code: UploadErrorCode, message: string): Promise<never> => {
      await rm(upload.partial, { force: true })
      throw new UploadError(code, message)
    }
    if (upload.received !== upload.size) return fail('size-mismatch', `received ${upload.received} of ${upload.size} bytes`)
    const onDisk = await stat(upload.partial).catch(() => null)
    if (!onDisk || onDisk.size !== upload.size) return fail('size-mismatch', 'the partial file changed under the upload')
    const digest = upload.hash.digest('hex')
    if (digest !== upload.sha256) return fail('sha-mismatch', 'sha256 does not match what begin declared')
    // existsSync and renameSync back to back: nothing else in this process
    // can take the name in between.
    const name = freeName(upload.dir, upload.name)
    const path = join(upload.dir, name)
    renameSync(upload.partial, path)
    const mime = upload.mime || mimeFor(path)
    return {
      path,
      name,
      ...(mime ? { mime } : {}),
      kind: mime?.startsWith('image/') ? 'image' : 'file',
      size: upload.size
    }
  }

  async abort(owner: string, uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.owner !== owner) return
    await this.drop(upload)
  }

  /** Drop every upload of these sessions (the thread was deleted; its dir goes with it). */
  dropSessions(ids: readonly string[]): void {
    const gone = new Set(ids)
    for (const upload of [...this.uploads.values()]) if (gone.has(upload.sessionId)) void this.drop(upload)
  }

  /** Drop uploads idle past the TTL; answers how many went. */
  async sweepExpired(): Promise<number> {
    const now = this.now()
    const stale = [...this.uploads.values()].filter((u) => !u.busy && now - u.touchedAt > this.ttlMs)
    await Promise.all(stale.map((u) => this.drop(u)))
    return stale.length
  }

  private async drop(upload: Upload): Promise<void> {
    this.uploads.delete(upload.id)
    await rm(upload.partial, { force: true }).catch(() => undefined)
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    for (const upload of [...this.uploads.values()]) rmSync(upload.partial, { force: true })
    this.uploads.clear()
  }
}

/** sha256 and size of a file on this host, streamed. */
export async function digestFile(path: string): Promise<AttachmentDigest> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Not a file')
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve())
  })
  return { size: info.size, sha256: hash.digest('hex') }
}

/** Raw bytes [offset, offset + length) of a file on this host. */
export async function readRange(path: string, offset: number, length: number): Promise<AttachmentRange> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Not a file')
    const want = Math.max(0, Math.min(length, ATTACHMENT_CHUNK_BYTES, info.size - offset))
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { dataBase64: buffer.subarray(0, read).toString('base64'), size: info.size }
  } finally {
    await handle.close()
  }
}

/** Remove a thread's attachment directories (best effort). */
export function removeAttachmentDirs(dirs: readonly string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

/** The delete path's sweep: every directory the thread's attachments may
 *  sit in goes. A no-op before the server configured the directories. */
export function sweepThreadAttachments(session: AttachmentSession): void {
  try {
    removeAttachmentDirs(attachmentDirsOf(session))
  } catch {
    // not configured (unit tests), or a malformed id: nothing to sweep
  }
}

/** What the archive sweep needs to know about one session id. */
export type SweepVerdict = { archived: boolean; updatedAt: number } | null

/**
 * The retention sweep over the attachment roots: a thread archived for
 * `archivedDays` loses its attachment directory, and so does a directory no
 * session owns any more (a draft never sent, a thread deleted while its
 * host was off) once it is a day old. Live threads keep theirs. Answers the
 * directories removed.
 */
export function sweepAttachmentRoots(
  roots: readonly string[],
  lookup: (sessionId: string) => SweepVerdict,
  opts: { now?: number; archivedDays?: number; orphanMs?: number } = {}
): string[] {
  const now = opts.now ?? Date.now()
  const archivedMs = (opts.archivedDays ?? 30) * 86_400_000
  const orphanMs = opts.orphanMs ?? 86_400_000
  const removed: string[] = []
  for (const root of new Set(roots)) {
    let names: string[]
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(root, name)
      let mtime: number
      try {
        const info = statSync(dir)
        if (!info.isDirectory()) continue
        mtime = info.mtimeMs
      } catch {
        continue
      }
      const verdict = lookup(name)
      const drop = verdict ? verdict.archived && now - verdict.updatedAt > archivedMs : now - mtime > orphanMs
      if (!drop) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }
  return removed
}

/** The `attachment.*` upload requests, for the server's dispatch. `owner`
 *  is who is asking: a remote key's id, or 'local' for the desktop socket. */
export async function handleAttachmentUploads(
  req: ClientRequest,
  uploads: AttachmentUploads,
  owner: string
): Promise<{ handled: true; result: unknown } | { handled: false }> {
  switch (req.method) {
    case 'attachment.begin':
      return { handled: true, result: await uploads.begin(owner, req.params) }
    case 'attachment.chunk':
      return { handled: true, result: await uploads.chunk(owner, req.params) }
    case 'attachment.commit':
      return { handled: true, result: await uploads.commit(owner, req.params.uploadId) }
    case 'attachment.abort':
      await uploads.abort(owner, req.params.uploadId)
      return { handled: true, result: null }
    case 'attachment.digest':
      return { handled: true, result: await digestFile(req.params.path) }
    case 'attachment.readRange':
      return { handled: true, result: await readRange(req.params.path, req.params.offset, req.params.length) }
    case 'attachment.settings':
      return { handled: true, result: uploads.settings() }
    case 'attachment.settings.set':
      return { handled: true, result: uploads.setSettings(req.params) }
    default:
      return { handled: false }
  }
}
