import { app, net, protocol } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSET_SCHEME, HTML_RENDERS_DIR, logoAssetUrl } from '@shared/assets'
import { APP_SCHEME } from './appScheme'
import { previewPageHtml } from './htmlPreviewPages'
import { serveMedia } from './server/media'

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

/** One handler for every session that serves the scheme (the app's and the preview window's). */
export async function handleAssetRequest(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // Media files from the file viewer: token-addressed, fenced to the open
  // roots, streamed with Range support (server/media.ts).
  if (url.host === 'file') return serveMedia(request)
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
