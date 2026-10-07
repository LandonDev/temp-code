import { app, net, protocol } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSET_SCHEME, HTML_RENDERS_DIR, logoAssetUrl } from '@shared/assets'
import { previewPageHtml } from './htmlPreviewPages'

export { logoAssetUrl }

/** Must run before app ready, or the scheme is a plain opaque one. */
export function registerAssetScheme(): void {
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

/** A path under `root`, or null when the URL's path escapes it. */
function fenced(root: string, pathname: string): string | null {
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

/** One handler for every session that serves the scheme (the app's and the preview window's). */
export async function handleAssetRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.host === 'page') {
    // A page the hidden preview window is looking at, held in memory.
    const token = PREVIEW_PATH.exec(url.pathname)?.[1]
    if (token) {
      const html = previewPageHtml(token)
      return html === undefined
        ? new Response('not found', { status: 404 })
        : new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
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
