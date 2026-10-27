import { app, net, protocol } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSET_SCHEME, HTML_RENDERS_DIR, logoAssetUrl } from '@shared/assets'
import { APP_SCHEME } from './appScheme'
import { previewPageHtml } from './htmlPreviewPages'
import { MEDIA_READ_CHUNK_BYTES, parseRange, serveMedia } from './server/media'
import type { MediaRange } from '@shared/contract-fsgit'

export { logoAssetUrl }

/** Must run before app ready, or the schemes are plain opaque ones; and
 *  only once per process, so both schemes share this one call. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      // corsEnabled lets the renderer `fetch()` a logo from its own origin;
      // without it only <img>/<link> loads work.
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    },
    {
      // The renderer's own origin (appScheme.ts). codeCache needs standard;
      // the rest is what T3 Code and VS Code give their app schemes.
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        codeCache: true
      }
    }
  ])
}

function logosDir(): string {
  return resolve(join(app.getPath('userData'), 'project-logos'))
}

/** Where agent HTML pages live: `<root>/<sessionId>/<pageId>.html`. */
export function pagesRoot(): string {
  return resolve(join(app.getPath('userData'), HTML_RENDERS_DIR))
}

/**
 * Pages of threads on other hosts (`?host=<environment id>` on a page URL):
 * fetched once over the peer link and kept here, since a published page
 * never changes. Set once the server is up; a URL naming this host reads
 * from disk as before.
 */
export interface RemotePages {
  environmentId: string
  read: (host: string, sessionId: string, pageId: string) => Promise<string | null>
}
let remotePages: RemotePages | null = null
export function setRemotePages(next: RemotePages | null): void {
  remotePages = next
}
function remotePagesRoot(): string {
  return resolve(join(app.getPath('userData'), `${HTML_RENDERS_DIR}-remote`))
}

/**
 * Media of threads on other hosts (`&host=<environment id>` on every URL
 * server/media.ts mints): the token lives in that host's table, so the
 * bytes are read from there over the peer link in ranges and streamed
 * through, never kept (a screenshot an agent rewrites must not stick).
 */
export interface RemoteMedia {
  environmentId: string
  read: (host: string, token: string, offset: number, length: number) => Promise<MediaRange | null>
}
let remoteMedia: RemoteMedia | null = null
export function setRemoteMedia(next: RemoteMedia | null): void {
  remoteMedia = next
}

const MEDIA_TOKEN_PATH = /^\/([a-f0-9]{32})\/[^/]*$/

/** `tempcode-asset://file/<token>/<name>?host=<id>`: the host's bytes, in the requested range. */
export async function serveRemoteMedia(host: string, url: URL, request: Request): Promise<Response> {
  const token = MEDIA_TOKEN_PATH.exec(url.pathname)?.[1]
  if (!token || !remoteMedia) return new Response('not found', { status: 404 })
  const read = (offset: number, length: number) => remoteMedia!.read(host, token, offset, length)
  // The first read answers the size with its bytes; a suffix range (`bytes=-N`)
  // needs the size first, so it reads again from where the suffix starts.
  const asked = /^bytes=(\d+)-/.exec(request.headers.get('range')?.trim() ?? '')
  let first: MediaRange | null
  try {
    first = await read(asked ? Number(asked[1]) : 0, MEDIA_READ_CHUNK_BYTES)
  } catch (err) {
    return new Response(`The file is on another host that is not reachable right now (${err instanceof Error ? err.message : err})`, { status: 503 })
  }
  if (!first) return new Response('not found', { status: 404 })
  const { size } = first
  const headers = new Headers({
    'Content-Type': first.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': new Date(first.mtimeMs).toUTCString()
  })
  const range = parseRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const status = range ? 206 : 200
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
  let next = start
  let buffered: MediaRange | null = asked && Number(asked[1]) === start ? first : !asked && start === 0 ? first : null
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next > end) {
        controller.close()
        return
      }
      try {
        const part = buffered ?? (await read(next, Math.min(MEDIA_READ_CHUNK_BYTES, end - next + 1)))
        buffered = null
        const bytes = part ? Buffer.from(part.dataBase64, 'base64').subarray(0, end - next + 1) : Buffer.alloc(0)
        if (bytes.length === 0) {
          controller.error(new Error('the host answered no bytes'))
          return
        }
        next += bytes.length
        controller.enqueue(bytes)
      } catch (err) {
        controller.error(err)
      }
    }
  })
  return new Response(body, { status, headers })
}

/** A page of another host: its cached copy, else fetched and cached. */
export async function serveRemotePage(host: string, url: URL): Promise<Response> {
  const [sessionId, file] = url.pathname.replace(/^\/+/, '').split('/')
  const pageId = file?.endsWith('.html') ? file.slice(0, -'.html'.length) : undefined
  const cached = fenced(remotePagesRoot(), `${host}/${url.pathname}`)
  if (!pageId || !cached || !remotePages) return new Response('not found', { status: 404 })
  const html = { 'Content-Type': 'text/html; charset=utf-8' }
  try {
    return new Response(await readFile(cached, 'utf8'), { headers: html })
  } catch {}
  let page: string | null
  try {
    page = await remotePages.read(host, sessionId!, pageId)
  } catch (err) {
    return new Response(`The page is on another host that is not reachable right now (${err instanceof Error ? err.message : err})`, { status: 503 })
  }
  if (page === null) return new Response('not found', { status: 404 })
  await mkdir(dirname(cached), { recursive: true })
  await writeFile(cached, page)
  return new Response(page, { headers: html })
}

/** A path under `root`, or null when the URL's path escapes it. */
export function fenced(root: string, pathname: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!relative) return null
  const target = resolve(join(root, relative))
  return target === root || target.startsWith(root + sep) ? target : null
}

/** The only directories this protocol will ever read from. */
export function resolveAssetPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:`) return null
  if (parsed.host === 'logo') return fenced(logosDir(), parsed.pathname)
  if (parsed.host === 'page') {
    const target = fenced(pagesRoot(), parsed.pathname)
    return target?.endsWith('.html') ? target : null
  }
  return null
}

const PREVIEW_PATH = /^\/preview\/([a-f0-9]+)\.html$/

/** The desktop renderer's name for its own main process (`LOCAL_ENVIRONMENT_ID`). */
export const LOCAL_HOST = 'local'

/** Whether a `host` param on an asset URL names another machine: no host, `local` and this server's own id are this one. */
export function isOtherHost(host: string | null, self: string | undefined): boolean {
  return !!host && host !== LOCAL_HOST && host !== self
}

/** One handler for every session that serves the scheme (the app's and the preview window's). */
export async function handleAssetRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // Media files from the file viewer: token-addressed, fenced to the open
  // roots, streamed with Range support (server/media.ts).
  if (url.host === 'file') {
    // A thread of another host: its token lives there, not in this process's table.
    const host = url.searchParams.get('host')
    if (remoteMedia && isOtherHost(host, remoteMedia.environmentId)) return serveRemoteMedia(host!, url, request)
    return serveMedia(request)
  }
  if (url.host === 'page') {
    // A page the hidden preview window is looking at, held in memory.
    const token = PREVIEW_PATH.exec(url.pathname)?.[1]
    if (token) {
      const html = previewPageHtml(token)
      return html === undefined
        ? new Response('not found', { status: 404 })
        : new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    // A thread of another host: its page lives there, not under this userData.
    const host = url.searchParams.get('host')
    if (remotePages && isOtherHost(host, remotePages.environmentId)) return serveRemotePage(host!, url)
  }
  const path = resolveAssetPath(request.url)
  if (!path) return new Response('not found', { status: 404 })
  try {
    const file = await net.fetch(pathToFileURL(path).toString())
    if (url.host !== 'page') return file
    return new Response(file.body, {
      status: file.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, handleAssetRequest)
}
