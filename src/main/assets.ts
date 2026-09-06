import { app, net, protocol } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ASSET_SCHEME, logoAssetUrl } from '@shared/assets'

export { logoAssetUrl }

/** Must run before app ready, or the scheme is a plain opaque one. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

function logosDir(): string {
  return resolve(join(app.getPath('userData'), 'project-logos'))
}

/** The only directory this protocol will ever read from. */
export function resolveAssetPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.host !== 'logo') return null
  let relative: string
  try {
    relative = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
  if (!relative) return null
  const root = logosDir()
  const target = resolve(join(root, relative))
  return target === root || target.startsWith(root + sep) ? target : null
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const path = resolveAssetPath(request.url)
    if (!path) return new Response('not found', { status: 404 })
    try {
      return await net.fetch(pathToFileURL(path).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
