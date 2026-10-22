import { randomBytes } from 'node:crypto'
import { closeSync, createReadStream, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { ASSET_SCHEME } from '@shared/assets'
import type { FsMedia, FsMediaKind, MediaRange } from '@shared/contract-fsgit'

/**
 * Media files in the file viewer: what counts as an image, video or audio
 * file, and how the renderer gets the bytes. The renderer never sees a disk
 * path it can dereference: `fs.media` fences the path to the open project
 * and workspace roots, mints a random token for it, and hands back a
 * `tempcode-asset://file/<token>/<name>` URL. The protocol handler looks
 * the token up, re-checks the fence on the real path (a symlink that points
 * out of a root is refused), and streams the file from disk with Range
 * support, so a 2 GB video scrubs without ever being read into memory.
 */

export interface MediaType {
  kind: FsMediaKind
  mime: string
}

const t = (kind: FsMediaKind, mime: string): MediaType => ({ kind, mime })

/** Extension → type. The authority when the bytes carry no signature. */
const BY_EXT: Record<string, MediaType> = {
  png: t('image', 'image/png'),
  jpg: t('image', 'image/jpeg'),
  jpeg: t('image', 'image/jpeg'),
  gif: t('image', 'image/gif'),
  webp: t('image', 'image/webp'),
  svg: t('image', 'image/svg+xml'),
  bmp: t('image', 'image/bmp'),
  ico: t('image', 'image/x-icon'),
  avif: t('image', 'image/avif'),
  // Chromium has no HEIC decoder; listed so the viewer explains instead of
  // showing the binary stub.
  heic: t('image', 'image/heic'),
  heif: t('image', 'image/heif'),
  mp4: t('video', 'video/mp4'),
  m4v: t('video', 'video/mp4'),
  mov: t('video', 'video/quicktime'),
  webm: t('video', 'video/webm'),
  mkv: t('video', 'video/x-matroska'),
  ogv: t('video', 'video/ogg'),
  mp3: t('audio', 'audio/mpeg'),
  m4a: t('audio', 'audio/mp4'),
  aac: t('audio', 'audio/aac'),
  wav: t('audio', 'audio/wav'),
  ogg: t('audio', 'audio/ogg'),
  oga: t('audio', 'audio/ogg'),
  flac: t('audio', 'audio/flac')
}

/** How many leading bytes the sniffer wants. */
export const MEDIA_SNIFF_BYTES = 64

const ascii = (buf: Buffer, start: number, end: number): string => buf.toString('latin1', start, end)

/** A type from the file's signature alone, or null when the bytes say nothing certain. */
export function sniffMedia(head: Buffer, ext: string): MediaType | null {
  if (head.length < 4) return null
  if (head.length >= 8 && ascii(head, 0, 8) === '\x89PNG\r\n\x1a\n') return BY_EXT.png
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return BY_EXT.jpeg
  if (ascii(head, 0, 4) === 'GIF8') return BY_EXT.gif
  if (ascii(head, 0, 4) === 'RIFF' && head.length >= 12) {
    const form = ascii(head, 8, 12)
    if (form === 'WEBP') return BY_EXT.webp
    if (form === 'WAVE') return BY_EXT.wav
    return null
  }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12)
    if (brand === 'avif' || brand === 'avis') return BY_EXT.avif
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return BY_EXT.heic
    if (brand === 'qt  ') return BY_EXT.mov
    if (brand === 'M4A ') return BY_EXT.m4a
    // Every other ISO BMFF brand: trust an audio extension, else it is video.
    return BY_EXT[ext]?.kind === 'audio' ? BY_EXT[ext] : BY_EXT.mp4
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return ascii(head, 0, head.length).includes('webm') ? BY_EXT.webm : BY_EXT.mkv
  }
  if (ascii(head, 0, 4) === 'OggS') return ext === 'ogv' ? BY_EXT.ogv : BY_EXT.ogg
  if (ascii(head, 0, 4) === 'fLaC') return BY_EXT.flac
  if (ascii(head, 0, 3) === 'ID3') return BY_EXT.mp3
  return null
}

/** The extension without its dot, lower-cased. */
export function mediaExt(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

/** Signature first, extension second; null for anything that is not media. */
export function classifyMedia(path: string, head: Buffer): MediaType | null {
  const ext = mediaExt(path)
  return sniffMedia(head, ext) ?? BY_EXT[ext] ?? null
}

function readHead(path: string): Buffer {
  const buf = Buffer.alloc(MEDIA_SNIFF_BYTES)
  const fd = openSync(path, 'r')
  try {
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

// ── fence ────────────────────────────────────────────────────────────────

/** Where git originals of changed media are materialised for the diff view. */
export const MEDIA_SCRATCH_DIR = join(tmpdir(), 'temp-code-media')

let rootsProvider: () => string[] = () => []

/** The server installs the open project cwds and workspace paths here. */
export function setMediaRoots(provider: () => string[]): void {
  rootsProvider = provider
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Strict containment: the file's real path must sit under a root's real
 * path on a segment boundary. Unlike fspaths.withinRoots this never accepts
 * the symlink's own spelling, so a link inside a project that points at
 * ~/.ssh is refused.
 */
export function insideRealRoots(realPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const real = realOrNull(resolve(root))
    return real !== null && (realPath === real || realPath.startsWith(real + sep))
  })
}

function allRoots(): string[] {
  return [...rootsProvider(), MEDIA_SCRATCH_DIR]
}

// ── tokens ───────────────────────────────────────────────────────────────

interface Entry {
  path: string
  type: MediaType
}

const MAX_TOKENS = 1024
const tokens = new Map<string, Entry>()
const tokenByPath = new Map<string, string>()

let mediaHost = ''

/** This host's environment id, stamped on every media URL so the desktop
 *  showing a thread of another host fetches the bytes from there. */
export function setMediaHost(environmentId: string): void {
  mediaHost = environmentId
}

/** The URL the renderer loads `path` from; one token per path per process. */
export function mediaUrl(path: string, type: MediaType, mtimeMs: number): string {
  let token = tokenByPath.get(path)
  if (!token) {
    token = randomBytes(16).toString('hex')
    tokens.set(token, { path, type })
    tokenByPath.set(path, token)
    if (tokens.size > MAX_TOKENS) {
      const oldest = tokens.keys().next().value!
      tokenByPath.delete(tokens.get(oldest)!.path)
      tokens.delete(oldest)
    }
  }
  // mtime in the query so an edited file is fetched again, not served from cache.
  const host = mediaHost ? `&host=${encodeURIComponent(mediaHost)}` : ''
  return `${ASSET_SCHEME}://file/${token}/${encodeURIComponent(basename(path))}?v=${Math.floor(mtimeMs)}${host}`
}

/** Drop every token (tests). */
export function resetMediaTokens(): void {
  tokens.clear()
  tokenByPath.clear()
}

/**
 * `fs.media`: the viewer's first question about a file. Null for anything
 * that is not media or lies outside the open roots, so the caller falls
 * through to the text path and its stub.
 */
export async function fsMedia(path: string): Promise<FsMedia | null> {
  const abs = resolve(path)
  const st = await stat(abs).catch(() => null)
  if (!st?.isFile()) return null
  const type = classifyMedia(abs, readHead(abs))
  if (!type) return null
  const real = realOrNull(abs)
  if (!real || !insideRealRoots(real, allRoots())) return null
  return describeMedia(abs, type, st.size, st.mtimeMs)
}

/** The wire shape for a file already known to be media and inside the fence. */
export function describeMedia(path: string, type: MediaType, size: number, mtimeMs: number): FsMedia {
  return { kind: type.kind, mime: type.mime, url: mediaUrl(path, type, mtimeMs), size, mtimeMs }
}

// ── serving ──────────────────────────────────────────────────────────────

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

/** One `bytes=` range against a file of `size` bytes; null = whole file. */
export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (size === 0) return 'unsatisfiable'
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(m[1])
  if (start >= size) return 'unsatisfiable'
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

const TOKEN_PATH = /^\/([a-f0-9]{32})\/[^/]*$/

/** The most bytes one `media.read` answer carries. */
export const MEDIA_READ_CHUNK_BYTES = 2 * 1024 * 1024

/** The token's file on disk, re-fenced, or null (unknown token, file gone, out of the roots). */
function tokenFile(token: string): { entry: Entry; real: string; size: number; mtimeMs: number } | null {
  const entry = tokens.get(token)
  if (!entry) return null
  const real = realOrNull(entry.path)
  if (!real || !insideRealRoots(real, allRoots())) return null
  let st
  try {
    st = statSync(real)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  return { entry, real, size: st.size, mtimeMs: st.mtimeMs }
}

/**
 * `media.read`: bytes [offset, offset + length) of a token's file, for the
 * desktop of another host streaming it over the peer link. Ids only: the
 * token was minted for a path already inside this host's fence, and the
 * answer never names the path.
 */
export async function readMediaRange(token: string, offset: number, length: number): Promise<MediaRange | null> {
  const file = tokenFile(token)
  if (!file) return null
  const want = Math.max(0, Math.min(length, MEDIA_READ_CHUNK_BYTES, file.size - offset))
  const buffer = Buffer.alloc(want)
  let read = 0
  if (want > 0) {
    const fd = openSync(file.real, 'r')
    try {
      while (read < want) {
        const n = readSync(fd, buffer, read, want - read, offset + read)
        if (n === 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
  }
  return { dataBase64: buffer.subarray(0, read).toString('base64'), mime: file.entry.type.mime, size: file.size, mtimeMs: file.mtimeMs }
}

/** `tempcode-asset://file/<token>/<name>` → the bytes, streamed from disk. */
export function serveMedia(request: Request): Response {
  const url = new URL(request.url)
  const token = TOKEN_PATH.exec(url.pathname)?.[1]
  const entry = token ? tokens.get(token) : undefined
  if (!entry) return new Response('not found', { status: 404 })
  const real = realOrNull(entry.path)
  if (!real) return new Response('not found', { status: 404 })
  if (!insideRealRoots(real, allRoots())) return new Response('forbidden', { status: 403 })
  let st
  try {
    st = statSync(real)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!st.isFile()) return new Response('not found', { status: 404 })

  const headers = new Headers({
    'Content-Type': entry.type.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString()
  })
  const range = parseRange(request.headers.get('range'), st.size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${st.size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? st.size - 1
  headers.set('Content-Length', String(st.size === 0 ? 0 : end - start + 1))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${st.size}`)
  const status = range ? 206 : 200
  if (request.method === 'HEAD' || st.size === 0) return new Response(null, { status, headers })
  const stream = createReadStream(real, { start, end })
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers })
}
