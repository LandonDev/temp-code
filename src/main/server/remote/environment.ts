import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A server's stable identity: `env_<22 base64url chars>`, kept in
 * `<userData>/environment.json` rather than SQLite on purpose. Dev
 * instances run on copies of the prod database, and a copy must not
 * inherit prod's identity; a project and its threads belong to one
 * environment, and clients check the id before trusting a route.
 */
export const ENVIRONMENT_FILE = 'environment.json'

export interface EnvironmentRecord {
  id: string
  createdAt: number
}

export const ENVIRONMENT_ID = /^env_[A-Za-z0-9_-]{22}$/

export function newEnvironmentId(): string {
  return `env_${randomBytes(16).toString('base64url')}`
}

function readRecord(path: string): EnvironmentRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<EnvironmentRecord>
    if (typeof parsed.id === 'string' && ENVIRONMENT_ID.test(parsed.id))
      return { id: parsed.id, createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0 }
  } catch {
    /* absent or unreadable */
  }
  return null
}

/**
 * Read the id, or create one atomically: the record is written to a temp
 * file and hard-linked into place, which fails when the file already
 * exists, so two creators racing agree on the first one's id and a reader
 * never sees a half-written file.
 */
export function loadEnvironmentId(userData: string): string {
  const path = join(userData, ENVIRONMENT_FILE)
  const existing = readRecord(path)
  if (existing) return existing.id
  mkdirSync(userData, { recursive: true })
  const record: EnvironmentRecord = { id: newEnvironmentId(), createdAt: Date.now() }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  try {
    linkSync(tmp, path)
  } catch {
    /* another process won the race; its record is read below */
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
  }
  return readRecord(path)?.id ?? record.id
}
