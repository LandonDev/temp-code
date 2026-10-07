import { nanoid } from 'nanoid'
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  clampHtmlRenderHeight,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MEASURE_WIDTHS,
  injectHtmlRenderBootstrap,
  type HtmlRenderAppearance,
  type HtmlRenderReference
} from '@shared/htmlRender'

/**
 * Agent HTML pages (ported from T3 Code's HtmlRender.ts): local images are
 * inlined as data URIs, the theme bootstrap is injected, and the page is
 * stored under `<root>/<sessionId>/<pageId>.html` for the asset protocol to
 * serve. Previews and measurements go through an injected previewer
 * (src/main/htmlPreview.ts) so this module has no Electron import and the
 * e2e scripts can load it.
 */

const MIB = 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * MIB
export const MAX_PAGE_BYTES = 25 * MIB
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`

// Every message is built here and tells the agent what to do next.
export class HtmlRenderImagesNotFoundError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `These local images could not be read: ${paths.join(', ')}. Use absolute paths to existing image files, or remove them.`
    )
  }
}
export class HtmlRenderImageTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly sizeBytes: number
  ) {
    super(
      `${path} is ${formatMib(sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`
    )
  }
}
export class HtmlRenderPageTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(
      `With its images inlined the page is ${formatMib(sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`
    )
  }
}

export interface ConsoleMessage {
  readonly level: 'log' | 'info' | 'warning' | 'error'
  readonly text: string
}

export interface PreviewResult {
  /** Base64 PNG of the top `capturedHeight` pixels. */
  readonly png: string
  /** Height the page needs to show without scrolling. */
  readonly contentHeight: number
  readonly capturedHeight: number
  readonly consoleMessages: readonly ConsoleMessage[]
}

export interface HtmlPreview extends PreviewResult {
  readonly width: number
  /** Local image paths that could not be read; they show as broken images. */
  readonly missingImages?: readonly string[]
}

/** The hidden window main provides; tests stub it. */
export interface HtmlPreviewer {
  preview(input: {
    html: string
    width: number
    appearance: HtmlRenderAppearance
  }): Promise<PreviewResult>
  measure(html: string, widths: readonly number[]): Promise<Array<readonly [number, number]>>
}

let previewer: HtmlPreviewer | null = null
export function setHtmlPreviewer(next: HtmlPreviewer | null): void {
  previewer = next
}

let root: string | null = null
/** `<userData>/html-renders`, set at boot (tests point it at a temp dir). */
export function setHtmlRenderRoot(dir: string): void {
  root = resolve(dir)
}

export function pagesDir(sessionId: string): string {
  if (!root) throw new Error('HTML render storage is not configured')
  const dir = resolve(join(root, sessionId))
  if (!dir.startsWith(root + sep)) throw new Error('invalid session id')
  return dir
}

// ── local images ─────────────────────────────────────────────────────

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join('|')
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  'gid'
)

export function findLocalImages(html: string): Array<{ start: number; end: number; path: string }> {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3]
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : []
  })
}

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll('\\\\', '\\') : reference

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'};base64,`

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12)
  if (
    head.startsWith('\x89PNG') ||
    head.startsWith('\xff\xd8\xff') ||
    head.startsWith('GIF8') ||
    head.startsWith('\0\0\x01\0') ||
    (head.startsWith('BM') && head.slice(6, 10) === '\0\0\0\0') ||
    (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)))
}

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from)
  return at === -1 ? -1 : at + token.length
}

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
const hasSvgRoot = (text: string) => {
  let at = 0
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1
    if (text.startsWith('<?', at)) at = after(text, '?>', at + 2)
    else if (text.startsWith('<!--', at)) at = after(text, '-->', at + 4)
    else if (text.slice(at, at + 9).toLowerCase() === '<!doctype') at = afterDoctype(text, at + 9)
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5))
  }
  return false
}

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
const afterDoctype = (text: string, from: number) => {
  let inSubset = false
  let at = from
  while (at !== -1 && at < text.length) {
    const char = text[at]
    if (char === '"' || char === "'") at = after(text, char, at + 1)
    else if (inSubset && text.startsWith('<!--', at)) at = after(text, '-->', at + 4)
    else if (inSubset && text.startsWith('<?', at)) at = after(text, '?>', at + 2)
    else if (char === '>' && !inSubset) return at + 1
    else {
      if (char === '[') inSubset = true
      else if (char === ']') inSubset = false
      at += 1
    }
  }
  return -1
}

/** Up to `limit` bytes of a file: files can grow after `stat`. */
async function readCapped(path: string, limit: number): Promise<Uint8Array | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(limit)
    let total = 0
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, total, limit - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return buffer.subarray(0, total)
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** Replaces every local image reference with a data URI; unreadable paths stay as written. */
export async function inlineLocalImages(
  html: string
): Promise<{ html: string; missing: string[] }> {
  const references = findLocalImages(html)
  const files: Array<{ path: string; size: number | undefined }> = []
  for (const path of new Set(references.map((reference) => reference.path))) {
    const info = await stat(filePathFor(path)).catch(() => null)
    files.push({ path, size: info?.isFile() ? info.size : undefined })
  }
  const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES)
  if (oversized?.size !== undefined) {
    throw new HtmlRenderImageTooLargeError(oversized.path, oversized.size)
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]))
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path)
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          Math.ceil(size / 3) * 4 -
          Buffer.byteLength(reference.path)
  }, Buffer.byteLength(html))
  if (pageBytes > MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError(pageBytes)
  // Each read stops one byte past the image limit, and reading stops once
  // the images read so far cannot fit the page.
  let readBytes = 0
  const dataUris = new Map<string, string>()
  for (const file of files) {
    if (file.size === undefined) continue
    const bytes = await readCapped(filePathFor(file.path), MAX_IMAGE_BYTES + 1)
    if (bytes === null || !isImageBytes(bytes)) continue
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HtmlRenderImageTooLargeError(file.path, bytes.byteLength)
    }
    readBytes += Math.ceil(bytes.byteLength / 3) * 4
    if (readBytes > MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError(readBytes)
    dataUris.set(file.path, dataUriPrefix(file.path) + Buffer.from(bytes).toString('base64'))
  }
  const parts: string[] = []
  let cursor = 0
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path)
    if (dataUri === undefined) continue
    parts.push(html.slice(cursor, reference.start), dataUri)
    cursor = reference.end
  }
  parts.push(html.slice(cursor))
  const inlined = parts.join('')
  const inlinedBytes = Buffer.byteLength(inlined)
  if (inlinedBytes > MAX_PAGE_BYTES) throw new HtmlRenderPageTooLargeError(inlinedBytes)
  return {
    html: inlined,
    missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path)
  }
}

// ── prepare, preview, publish, remove ────────────────────────────────

const MIN_PREVIEW_WIDTH = 240
const MAX_PREVIEW_WIDTH = 1_600

// The bootstrap goes in first so its head scan never runs over inlined image data.
const inline = (html: string) => inlineLocalImages(injectHtmlRenderBootstrap(html))

/** The self-contained page that gets stored: local images inlined, theme bootstrap injected. */
export async function prepare(html: string): Promise<string> {
  const inlined = await inline(html)
  if (inlined.missing.length > 0) throw new HtmlRenderImagesNotFoundError(inlined.missing)
  return inlined.html
}

/** Screenshots a page in the hidden window, tolerating unreadable local images. */
export async function preview(input: {
  html: string
  width?: number
  appearance?: HtmlRenderAppearance
}): Promise<HtmlPreview> {
  if (!previewer) throw new Error('The preview window is not available in this build.')
  const width = Math.min(
    MAX_PREVIEW_WIDTH,
    Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH))
  )
  const inlined = await inline(input.html)
  const shot = await previewer.preview({
    html: inlined.html,
    width,
    appearance: input.appearance ?? 'dark'
  })
  return {
    ...shot,
    width,
    ...(inlined.missing.length === 0 ? {} : { missingImages: inlined.missing })
  }
}

async function measure(html: string): Promise<HtmlRenderReference['heights']> {
  if (!previewer) return undefined
  try {
    const heights = await previewer.measure(html, HTML_RENDER_MEASURE_WIDTHS)
    return [...heights].sort(([left], [right]) => left - right)
  } catch (err) {
    console.error('[html-render] could not measure a page; publishing it without heights:', err)
    return undefined
  }
}

/**
 * Stores a prepared page for the renderer to show inline, measuring its
 * height at each frame width.
 */
export async function publish(input: {
  sessionId: string
  html: string
  title: string
  height: number
}): Promise<HtmlRenderReference> {
  const html = await prepare(input.html)
  const dir = pagesDir(input.sessionId)
  const pageId = nanoid(16)
  const filePath = join(dir, `${pageId}.html`)
  await mkdir(dir, { recursive: true })
  await writeFile(filePath, html)
  let heights: HtmlRenderReference['heights']
  try {
    heights = await measure(html)
  } catch (err) {
    // Only the returned reference lets thread deletion find the page.
    await rm(filePath, { force: true })
    throw err
  }
  return {
    sessionId: input.sessionId,
    pageId,
    title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || 'HTML',
    height: clampHtmlRenderHeight(input.height),
    ...(heights === undefined ? {} : { heights })
  }
}

/** Deletes every page of the given threads. */
export async function removePages(sessionIds: readonly string[]): Promise<void> {
  if (!root) return
  for (const id of sessionIds) {
    try {
      await rm(pagesDir(id), { recursive: true, force: true })
    } catch {
      // an id that cannot name a directory had no pages
    }
  }
}
