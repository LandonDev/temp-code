import * as fs from 'node:fs'
import * as path from 'node:path'

const RASTER_MIME_BY_EXT: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

export class BlockedAssetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedAssetError'
  }
}

export class AssetNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssetNotFoundError'
  }
}

/** Max asset bytes accepted from the handshake (LLM-side wire limit). */
export const MAX_ASSET_BYTES = 1.5 * 1024 * 1024

/** Handshake handler must still reject on read so a trusted listener cannot accept oversize staging. */
export const MAX_ASSET_BYTES_BY_SOURCE = {
  listener: 16 * 1024 * 1024,
  legacy: MAX_ASSET_BYTES,
  process: MAX_ASSET_BYTES
} as const

export type AssetSource = keyof typeof MAX_ASSET_BYTES_BY_SOURCE
export type AssetPathSegment =
  | 'assigned'
  | 'inbox'
  | 'listening'
  | 'meta'
  | 'outbox'
  | 'reasoning'
  | 'response'
  | 'sessions'
export type AssetLifecycle = 'frozen' | 'live'
export type AssetSourceKind = AssetSource
/** Listener bytes may scale to canvas + reasoning caps; legacy/process uploads remain 1.5 MiB. */
export type AssetMaxBytesTier = AssetSource

export interface AssetMaxBytesLookup {
  source: AssetSourceKind
}

export type AssetPath = {
  id: string
  segment: AssetPathSegment
  subpath?: string
  abs: string
  lifecycle: AssetLifecycle
  /** Handshake-scaled cap (storage may write below this tier ceiling). */
  maxBytesTier?: AssetMaxBytesTier
}

export function guessRasterMimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase()
  return RASTER_MIME_BY_EXT[ext]
}

export function assetMaxBytesForSource(source: AssetMaxBytesLookup['source']): number {
  return MAX_ASSET_BYTES_BY_SOURCE[source]
}

/** Parse an on-disk path back into a descriptor (marker must be `assets/`). */
export function newAssetPath(absPath: string, lifecycle: AssetLifecycle): AssetPath {
  const marker = `assets${path.sep}`
  const markerIndex = absPath.indexOf(marker)
  if (markerIndex < 0) {
    throw new Error(`Asset path is not under assets: ${absPath}`)
  }

  const rel = absPath.slice(markerIndex + marker.length)
  const parts = rel.split(path.sep)
  if (parts.length < 2) {
    throw new Error(`Asset path is incomplete: ${absPath}`)
  }

  return {
    id: parts[0],
    segment: parts[1] as AssetPathSegment,
    subpath: parts.slice(2).join(path.sep),
    abs: absPath,
    lifecycle
  }
}

export function assertAllowedAssetSegment(segment: string | undefined): AssetPathSegment {
  switch (segment) {
    case 'sessions':
    case 'inbox':
    case 'listening':
    case 'outbox':
    case 'meta':
    case 'reasoning':
    case 'response':
    case 'assigned':
      return segment
    default:
      throw new BlockedAssetError(`Blocked asset segment: ${segment ?? 'unknown'}`)
  }
}

/** Relative path under the sessions directory root. */
export function assetRelPath(
  sessionId: string,
  assetId: string,
  segment: AssetPathSegment,
  subpath?: string
): string {
  const parts = [sessionId, 'assets', assetId, segment]
  if (subpath) parts.push(subpath)
  return path.join(...parts)
}

export function assetAbsPathFromDescriptor(
  sessionsRoot: string,
  sessionId: string,
  descriptor: Omit<AssetPath, 'abs'>
): string {
  return path.join(sessionsRoot, assetRelPath(sessionId, descriptor.id, descriptor.segment, descriptor.subpath))
}

export function resolveSessionAssetReadPath(
  sessionsRoot: string,
  sessionId: string,
  assetId: string,
  segment: AssetPathSegment | string,
  subpath?: string
): string {
  const allowedSegment = assertAllowedAssetSegment(segment)
  const absPath = path.join(
    sessionsRoot,
    assetRelPath(sessionId, assetId, allowedSegment, subpath)
  )
  if (!fs.existsSync(absPath)) {
    throw new AssetNotFoundError(`Asset not found: ${assetId}`)
  }
  return absPath
}

export function validateAssetDescriptor(
  sessionId: string,
  sessionsRoot: string,
  descriptor: Omit<AssetPath, 'abs'>
): AssetPath {
  const allowedSegment = assertAllowedAssetSegment(descriptor.segment)
  const abs = path.join(
    sessionsRoot,
    assetRelPath(sessionId, descriptor.id, allowedSegment, descriptor.subpath)
  )
  return {
    ...descriptor,
    abs,
    segment: allowedSegment
  }
}
