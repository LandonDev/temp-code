import { mkdirSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { insideRoots } from './remote/fence'
import { nanoid } from 'nanoid'
import type { Attachment } from '@shared/events'

/**
 * Attachments: pasted bytes get persisted under ~/.temp-code/attachments so
 * every attachment is a plain file path — the one shape all three harnesses
 * can consume. attachment.read serves data URLs back for thumbnails.
 */

/** Where `attachment.save` lands small pastes (the thread-agnostic dir). */
export const ATTACH_DIR = join(homedir(), '.temp-code', 'attachments')
const MAX_READ_BYTES = 20 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
}

export function mimeFor(path: string): string | undefined {
  return MIME[extname(path).toLowerCase()]
}

export function attachmentFor(path: string): Attachment {
  const mime = mimeFor(path)
  return {
    path,
    name: basename(path),
    mime,
    kind: mime?.startsWith('image/') ? 'image' : 'file'
  }
}

export async function saveAttachment(name: string, dataBase64: string): Promise<Attachment> {
  mkdirSync(ATTACH_DIR, { recursive: true })
  const safe = basename(name).replace(/[^\w.-]+/g, '_') || 'attachment'
  const path = join(ATTACH_DIR, `${nanoid(8)}-${safe}`)
  await writeFile(path, Buffer.from(dataBase64, 'base64'))
  return attachmentFor(path)
}

/** Data URL for thumbnails. Fenced to the attachments dir and the
 *  app-managed roots, by real path on a segment boundary (fence.ts
 *  insideRoots): `/a/b` holds `/a/b/c`, never the sibling `/a/bc` a bare
 *  startsWith admitted, nor a symlink inside that points out. */
export async function readAttachment(path: string, allowedRoots: string[]): Promise<string> {
  const abs = resolve(path)
  if (!insideRoots(abs, [ATTACH_DIR, ...allowedRoots])) {
    throw new Error('path outside app-managed directories')
  }
  const info = await stat(abs)
  if (info.size > MAX_READ_BYTES) throw new Error('attachment too large to preview')
  const bytes = await readFile(abs)
  return `data:${mimeFor(abs) ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
}
