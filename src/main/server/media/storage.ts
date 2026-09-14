import { mkdirSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'

import {
  type AssetMaxBytesLookup,
  type AssetPath,
  type AssetPathSegment,
  type AssetSource,
  assetMaxBytesForSource,
  MAX_ASSET_BYTES,
  validateAssetDescriptor
} from './assets'

type SqliteForeignKeyListRow = { from: string; table: string }

let db: DatabaseSync | null = null

export function getTempCodeUserData(): string {
  return process.env.TEMP_CODE_USER_DATA || app.getPath('userData')
}

export function mediaRoot(): string {
  return path.join(getTempCodeUserData(), 'media')
}

export function sessionsDir(): string {
  return path.join(mediaRoot(), 'sessions')
}

function sessionAssetsRoot(sessionId: string): string {
  return path.join(sessionsDir(), sessionId, 'assets')
}

function getMediaDb(): DatabaseSync {
  if (!db) {
    const dir = path.join(getTempCodeUserData(), 'db')
    const dbPath = path.join(dir, 'media.db')
    mkdirSync(dir, { recursive: true })
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA foreign_keys = ON')
    ensureSchema(db)
  }
  return db
}

/** Orphan assignment FKs (e.g. after a failed sync) break purge until repaired. */
export async function ensureAssignedConstraintIntegrity(): Promise<void> {
  const database = getMediaDb()
  const assignments = database
    .prepare(
      `SELECT aa.id, aa.asset_id
       FROM asset_assignments aa
       WHERE aa.asset_id NOT IN (SELECT id FROM assets)`
    )
    .all() as { id: string; asset_id: string }[]

  if (assignments.length === 0) return

  console.warn(
    `[media] repairing ${assignments.length} orphan asset_assignments (missing assets row)`
  )
  for (const row of assignments) {
    database.prepare('DELETE FROM asset_assignments WHERE id = ?').run(row.id)
    await unlinkAssetRowIfPresent(row.asset_id)
  }
}

function ensureSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf')),
      mime TEXT,
      role TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'purged')) DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at INTEGER,
      bytes INTEGER,
      width INTEGER,
      height INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_assets_session ON assets(session_id);
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

    CREATE TABLE IF NOT EXISTS recipient_assets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      turn_id TEXT,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('chat', 'runtime_chat', 'planning', 'implementation', 'verification', 'cross_thread')),
      recipient_id TEXT NOT NULL,
      recipient_role TEXT NOT NULL CHECK (recipient_role IN ('trigger', 'parent', 'self')),
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(recipient_kind, recipient_id, asset_id),
      CHECK (recipient_kind != 'cross_thread' OR turn_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_recipient_assets_turn ON recipient_assets(turn_id);
    CREATE INDEX IF NOT EXISTS idx_recipient_assets_target ON recipient_assets(recipient_kind, recipient_id);

    CREATE TABLE IF NOT EXISTS asset_assignments (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(asset_id, target_kind, target_id)
    );
  `)

  const assetColumns = database.prepare(`PRAGMA table_info(assets)`).all() as { name: string }[]
  const assignmentColumns = database
    .prepare(`PRAGMA table_info(asset_assignments)`)
    .all() as { name: string }[]
  const assignmentForeignKeys = database
    .prepare(`PRAGMA foreign_key_list(asset_assignments)`)
    .all() as SqliteForeignKeyListRow[]

  const assetColumnNames = new Set(assetColumns.map((column) => column.name))
  if (!assetColumnNames.has('turn_id')) {
    try {
      database.exec(`ALTER TABLE assets ADD COLUMN turn_id TEXT`)
    } catch {
      // column already exists
    }
  }

  const hasRecipientAssets = database
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='recipient_assets'`)
    .get() as { name: string } | undefined
  if (!hasRecipientAssets) {
    backfillRecipientAssetsFromLegacyTables(database)
  }

  const assignmentColumnNames = new Set(assignmentColumns.map((column) => column.name))
  const hasAssetIdColumn = assignmentColumnNames.has('asset_id')
  const assetAssignmentsFkTargetsAsset = assignmentForeignKeys.some(
    (fk) => fk.from === 'asset_id' && fk.table === 'assets'
  )

  if (!hasAssetIdColumn || !assetAssignmentsFkTargetsAsset) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS asset_assignments_v2 (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(asset_id, target_kind, target_id)
      );
    `)
    try {
      database.exec(`
        INSERT OR IGNORE INTO asset_assignments_v2 (id, asset_id, target_kind, target_id, created_at)
        SELECT aa.id, aa.asset_id, aa.target_kind, aa.target_id, aa.created_at
        FROM asset_assignments aa
        INNER JOIN assets a ON a.id = aa.asset_id;
      `)
    } catch (error) {
      console.warn('[media] asset_assignments backfill skipped incompatible rows', error)
    }
    database.exec(`
      DROP TABLE asset_assignments;
      ALTER TABLE asset_assignments_v2 RENAME TO asset_assignments;
    `)
  }
}

function backfillRecipientAssetsFromLegacyTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS recipient_assets (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      turn_id TEXT,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('chat', 'runtime_chat', 'planning', 'implementation', 'verification', 'cross_thread')),
      recipient_id TEXT NOT NULL,
      recipient_role TEXT NOT NULL CHECK (recipient_role IN ('trigger', 'parent', 'self')),
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(recipient_kind, recipient_id, asset_id),
      CHECK (recipient_kind != 'cross_thread' OR turn_id IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_recipient_assets_turn ON recipient_assets(turn_id);
    CREATE INDEX IF NOT EXISTS idx_recipient_assets_target ON recipient_assets(recipient_kind, recipient_id);
  `)

  try {
    database.exec(`
      INSERT OR IGNORE INTO recipient_assets (
        id, session_id, ordinal, turn_id, recipient_kind, recipient_id, recipient_role, asset_id
      )
      SELECT
        lower(hex(randomblob(16))),
        session_id,
        ordinal,
        NULL,
        CASE kind
          WHEN 'chat' THEN 'chat'
          WHEN 'runtime_chat' THEN 'runtime_chat'
          WHEN 'planning' THEN 'planning'
          WHEN 'implementation' THEN 'implementation'
          WHEN 'verification' THEN 'verification'
          ELSE 'chat'
        END,
        recipient_id,
        recipient_role,
        asset_id
      FROM turn_assets
      WHERE kind IN ('chat', 'runtime_chat', 'planning', 'implementation', 'verification');
    `)
  } catch {
    // turn_assets may not exist on very old databases.
  }

  const threadTurnAssets = database
    .prepare(
      `SELECT id, session_id, ordinal, turn_id, thread_id, role, asset_id FROM thread_turn_assets`
    )
    .all() as {
    id: string
    session_id: string
    ordinal: number
    turn_id: string | null
    thread_id: string
    role: string
    asset_id: string
  }[]

  if (threadTurnAssets.length === 0) return

  const maxOrdinalByTurn = new Map<string, number>()
  for (const row of threadTurnAssets) {
    if (!row.turn_id) continue
    const current = maxOrdinalByTurn.get(row.turn_id) ?? 0
    if (row.ordinal > current) maxOrdinalByTurn.set(row.turn_id, row.ordinal)
  }

  const ordinalKeyForThread = (
    row: Pick<typeof threadTurnAssets[number], 'turn_id' | 'ordinal' | 'thread_id'>
  ) => row.turn_id ?? `thread:${row.thread_id}`

  const ordinalCursor = new Map<string, number>()
  const nextOrdinal = (
    row: Pick<typeof threadTurnAssets[number], 'turn_id' | 'ordinal' | 'thread_id'>
  ): number => {
    const key = ordinalKeyForThread(row)
    const current = ordinalCursor.get(key) ?? maxOrdinalByTurn.get(key) ?? 0
    const next = current + 1
    ordinalCursor.set(key, next)
    return next
  }

  const insert = database.prepare(
    `INSERT OR IGNORE INTO recipient_assets (
      id, session_id, ordinal, turn_id, recipient_kind, recipient_id, recipient_role, asset_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )

  for (const row of threadTurnAssets) {
    const recipientKind = row.role === 'trigger' ? 'chat' : 'cross_thread'
    const recipientId =
      recipientKind === 'chat'
        ? row.session_id
        : `${row.turn_id ?? 'orphan'}::${row.thread_id}::${row.role}`
    const recipientRole = row.role === 'trigger' ? 'trigger' : row.role

    insert.run(
      row.id,
      row.session_id,
      nextOrdinal(row),
      row.turn_id,
      recipientKind,
      recipientId,
      recipientRole,
      row.asset_id
    )
  }
}

function stagingAssetDescriptor(
  sessionId: string,
  assetId: string,
  segment: AssetPathSegment,
  maxBytesTier?: AssetMaxBytesLookup['source'],
  subpath?: string
): AssetPath {
  return validateAssetDescriptor(sessionId, sessionsDir(), {
    id: assetId,
    segment,
    subpath,
    lifecycle: 'live',
    maxBytesTier
  })
}

export function descriptorForAssignedRead(sessionId: string, assetId: string): AssetPath {
  return validateAssetDescriptor(sessionId, sessionsDir(), {
    id: assetId,
    segment: 'assigned',
    lifecycle: 'frozen'
  })
}

/** Remove a row and its file when the caller already owns the delete path (assignments, orphans). */
export async function unlinkAssetRow(assetId: string): Promise<void> {
  await unlinkAssetRowIfPresent(assetId)
}

async function unlinkAssetRowIfPresent(assetId: string): Promise<void> {
  const database = getMediaDb()
  const row = database
    .prepare('SELECT session_id FROM assets WHERE id = ?')
    .get(assetId) as { session_id: string } | undefined

  database.prepare('DELETE FROM assets WHERE id = ?').run(assetId)

  if (row) {
    await fs.rm(path.join(sessionAssetsRoot(row.session_id), assetId), {
      recursive: true,
      force: true
    }).catch(() => undefined)
  }
}

export async function createInboxAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'inbox', source)
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function createOutboxAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'outbox', source)
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function writeOutboxAssetFromDescriptor(
  descriptor: AssetPath,
  _mime: string,
  bytes: Uint8Array
): Promise<void> {
  const maxBytes = descriptor.maxBytesTier
    ? assetMaxBytesForSource(descriptor.maxBytesTier)
    : MAX_ASSET_BYTES
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Asset exceeds maximum size of ${maxBytes} bytes`)
  }
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  await fs.writeFile(descriptor.abs, bytes)
}

export async function createListeningAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'listening', source)
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function createReasoningAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'reasoning', source, '0.png')
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function createResponseAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'response', source, '0.png')
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function writeResponseAssetPng(
  sessionId: string,
  assetId: string,
  pngBytes: Uint8Array,
  source?: AssetMaxBytesLookup['source']
): Promise<void> {
  const descriptor = await createResponseAssetPath(sessionId, assetId, source)
  await writeOutboxAssetFromDescriptor(descriptor, 'image/png', pngBytes)
}

export async function createMetaAssetPath(
  sessionId: string,
  assetId: string,
  source?: AssetMaxBytesLookup['source']
): Promise<AssetPath> {
  const descriptor = stagingAssetDescriptor(sessionId, assetId, 'meta', source, 'meta.json')
  await fs.mkdir(path.dirname(descriptor.abs), { recursive: true })
  return descriptor
}

export async function assignAndPromoteAssetPath(
  sessionId: string,
  descriptor: AssetPath,
  segment: AssetPathSegment,
  subpath?: string
): Promise<string> {
  const promoted = validateAssetDescriptor(sessionId, sessionsDir(), {
    id: descriptor.id,
    segment,
    subpath,
    lifecycle: 'frozen',
    maxBytesTier: descriptor.maxBytesTier
  })
  const assigned = descriptorForAssignedRead(sessionId, promoted.id)
  await fs.mkdir(path.dirname(assigned.abs), { recursive: true })
  await fs.rename(descriptor.abs, assigned.abs)
  return assigned.abs
}

export async function activateAssetRecord(
  assetId: string,
  sessionId: string,
  kind: 'image' | 'pdf',
  mime: string,
  role: string,
  bytes: number
): Promise<void> {
  const database = getMediaDb()
  database
    .prepare(
      `INSERT OR REPLACE INTO assets (id, session_id, kind, mime, role, status, bytes, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, unixepoch(), NULL)`
    )
    .run(assetId, sessionId, kind, mime, role, bytes)
}

export type RecipientAssetDescriptor = {
  sessionId: string
  ordinal: number
  recipientKind:
    | 'chat'
    | 'runtime_chat'
    | 'planning'
    | 'implementation'
    | 'verification'
    | 'cross_thread'
  recipientId: string
  recipientRole: string
  assetId: string
  turnId?: string | null
}

export async function bindRecipientAsset(descriptor: RecipientAssetDescriptor): Promise<void> {
  const database = getMediaDb()
  database
    .prepare(
      `INSERT OR IGNORE INTO recipient_assets (
        id, session_id, ordinal, turn_id, recipient_kind, recipient_id, recipient_role, asset_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      descriptor.sessionId,
      descriptor.ordinal,
      descriptor.turnId ?? null,
      descriptor.recipientKind,
      descriptor.recipientId,
      descriptor.recipientRole,
      descriptor.assetId
    )
}

export async function bindRecipientAssets(descriptors: RecipientAssetDescriptor[]): Promise<void> {
  for (const descriptor of descriptors) {
    await bindRecipientAsset(descriptor)
  }
}

export async function promoteAssetFromPath(
  assetId: string,
  sessionId: string,
  mime: string,
  role: string,
  bytes: number,
  segment: AssetPathSegment,
  subpath?: string,
  source?: AssetSource
): Promise<AssetPath> {
  const inbox = stagingAssetDescriptor(sessionId, assetId, 'inbox', source)
  await assignAndPromoteAssetPath(sessionId, inbox, segment, subpath)
  const kind: 'image' | 'pdf' = mime === 'application/pdf' ? 'pdf' : 'image'
  await activateAssetRecord(assetId, sessionId, kind, mime, role, bytes)
  return descriptorForAssignedRead(sessionId, assetId)
}

export async function bindAssetToTarget(
  assetId: string,
  targetKind: string,
  targetId: string
): Promise<void> {
  const database = getMediaDb()
  database
    .prepare(
      `INSERT OR IGNORE INTO asset_assignments (id, asset_id, target_kind, target_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), assetId, targetKind, targetId)
}

export async function assetRoleForAssetId(assetId: string): Promise<string | null> {
  const database = getMediaDb()
  const row = database
    .prepare('SELECT role FROM assets WHERE id = ? AND status = ?')
    .get(assetId, 'active') as { role: string } | undefined
  return row?.role ?? null
}

export type SessionAssetRecord = {
  id: string
  sessionId: string
  kind: 'image' | 'pdf'
  mime: string
  role: string
  status: 'active' | 'purged'
  createdAt: number
  deletedAt?: number
  bytes?: number
  width?: number
  height?: number
}

export type AssetAssignmentRecord = {
  id: string
  assetId: string
  targetKind: string
  targetId: string
  createdAt: number
}

export async function activeAssetsForSession(sessionId: string): Promise<SessionAssetRecord[]> {
  const database = getMediaDb()
  const rows = database
    .prepare(
      `SELECT id, session_id, kind, mime, role, status, created_at, deleted_at, bytes, width, height
       FROM assets
       WHERE session_id = ? AND status = 'active'
       ORDER BY created_at ASC`
    )
    .all(sessionId) as {
    id: string
    session_id: string
    kind: 'image' | 'pdf'
    mime: string
    role: string
    status: 'active' | 'purged'
    created_at: number
    deleted_at: number | null
    bytes: number | null
    width: number | null
    height: number | null
  }[]

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    mime: row.mime,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? undefined,
    bytes: row.bytes ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined
  }))
}

export async function assetAssignmentsForSession(sessionId: string): Promise<AssetAssignmentRecord[]> {
  const database = getMediaDb()
  const rows = database
    .prepare(
      `SELECT aa.id, aa.asset_id, aa.target_kind, aa.target_id, aa.created_at
       FROM asset_assignments aa
       INNER JOIN assets a ON a.id = aa.asset_id
       WHERE a.session_id = ? AND a.status = 'active'
       ORDER BY aa.created_at ASC`
    )
    .all(sessionId) as {
    id: string
    asset_id: string
    target_kind: string
    target_id: string
    created_at: number
  }[]

  return rows.map((row) => ({
    id: row.id,
    assetId: row.asset_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    createdAt: row.created_at
  }))
}

export async function purgeAsset(assetId: string): Promise<boolean> {
  const database = getMediaDb()
  const row = database
    .prepare('SELECT session_id, status FROM assets WHERE id = ?')
    .get(assetId) as { session_id: string; status: string } | undefined

  if (!row) return false

  if (row.status === 'purged') {
    await fs.rm(path.join(sessionAssetsRoot(row.session_id), assetId), {
      recursive: true,
      force: true
    }).catch(() => undefined)
    return true
  }

  database
    .prepare('UPDATE assets SET status = ?, deleted_at = unixepoch() WHERE id = ?')
    .run('purged', assetId)

  await fs.rm(path.join(sessionAssetsRoot(row.session_id), assetId), {
    recursive: true,
    force: true
  }).catch(() => undefined)

  return true
}

// Re-export cap helpers for handshake wiring (chunk 2).
export {
  assetMaxBytesForSource,
  MAX_ASSET_BYTES,
  MAX_ASSET_BYTES_BY_SOURCE,
  type AssetMaxBytesLookup,
  type AssetPathSegment,
  type AssetSource
} from './assets'
