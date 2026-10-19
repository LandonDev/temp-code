import { net, protocol } from 'electron'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fenced } from './assets'

/**
 * `tempcode-app://renderer/` serves the built renderer (out/renderer) in the
 * packaged app instead of `file://`. Chromium keeps a V8 code cache only for
 * http(s), chrome and embedder schemes registered with `codeCache: true`
 * (content/browser/renderer_host/code_cache_host_impl.cc); `file:` gets no
 * cache key, so every launch compiled the 8 MB index bundle from source. The
 * scheme is privileged in assets.ts (registerSchemes) and handled here.
 */
export const APP_SCHEME = 'tempcode-app'
export const APP_HOST = 'renderer'

export function appIndexUrl(): string {
  return `${APP_SCHEME}://${APP_HOST}/index.html`
}

/** The built renderer beside out/main. */
export function rendererRoot(): string {
  return resolve(join(__dirname, '../renderer'))
}

/** A file under `root` for an app-scheme URL, or null: wrong scheme or host,
 *  an empty path, or a path that escapes the root. */
export function resolveAppPath(url: string, root: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null
  return fenced(resolve(root), parsed.pathname)
}

/** Module scripts and workers need a JavaScript type; a file:// fetch would
 *  sniff one, but spelling it keeps the renderer's loads deterministic. */
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

export function mimeFor(path: string): string | undefined {
  return MIME[extname(path).toLowerCase()]
}

export async function handleAppRequest(request: Request): Promise<Response> {
  const path = resolveAppPath(request.url, rendererRoot())
  if (!path) return new Response('not found', { status: 404 })
  try {
    const file = await net.fetch(pathToFileURL(path).toString())
    const mime = mimeFor(path)
    if (!mime || !file.ok) return file
    return new Response(file.body, { status: file.status, headers: { 'Content-Type': mime } })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** The default session only: the hidden preview window's partition keeps
 *  just the asset scheme (htmlPreview.ts). */
export function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, handleAppRequest)
}
