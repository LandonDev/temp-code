import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import { addonProblem, visibleRows, type Writer } from '@shared/addons'
import { AddonInputSchema, type AddonInput, type AddonRow, type AddonSpec, type AddonStatus, type AddonTool } from '@shared/contract-addons'
import { sha256Hex } from '@shared/sha256'

/**
 * The add-on registry's rows on this host (CLAUDE.md "Add-ons and skills:
 * one store, on the box"). One copy lives on the box: the Mac's writes go
 * there and its rows follow (remote/storeSync.ts), which writes here with
 * `put`. No column ever holds a secret. Two things never sync: the tools
 * this host last listed per add-on (`addon_tool_cache`, voided when the
 * spec changes) and the in-memory status the registry core sets, since
 * each host runs its own downstream servers.
 */

type Row = {
  id: string
  name: string
  workspace_id: string | null
  description: string
  spec: string
  enabled: number
  added_by: string
  written_by: string
  created_at: number
  updated_at: number
}

export const mintAddonId = (): string => `ad_${nanoid(12)}`

/** A value as one string whatever its keys' order: a spec's digest names the tools it was listed under, and a put that changes nothing is told by it. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v
  )
export const specDigest = (spec: AddonSpec): string => sha256Hex(canonical(spec))

const scopeKey = (workspaceId: string | null): string => workspaceId ?? ''

export class AddonStore {
  private readonly changeListeners = new Set<() => void>()
  private readonly statusListeners = new Set<() => void>()
  private readonly statuses = new Map<string, AddonStatus>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS addons (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        workspace_id TEXT,
        description  TEXT NOT NULL DEFAULT '',
        spec         TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        added_by     TEXT NOT NULL,
        written_by   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS addons_scope_name ON addons(IFNULL(workspace_id, ''), name);
      CREATE TABLE IF NOT EXISTS addon_tool_cache (
        addon_id    TEXT PRIMARY KEY,
        spec_digest TEXT NOT NULL,
        tools       TEXT NOT NULL,
        fetched_at  INTEGER NOT NULL
      );
    `)
  }

  // ── rows ──────────────────────────────────────────────────────────────

  /** Every row, every scope: the global ones first, then by workspace and name. */
  list(): AddonRow[] {
    const rows = this.db.prepare(`SELECT * FROM addons ORDER BY IFNULL(workspace_id, ''), name`).all() as unknown as Row[]
    return rows.flatMap((r) => this.decode(r))
  }

  get(id: string): AddonRow | null {
    const row = this.db.prepare(`SELECT * FROM addons WHERE id = ?`).get(id) as unknown as Row | undefined
    return row ? (this.decode(row)[0] ?? null) : null
  }

  byName(workspaceId: string | null, name: string): AddonRow | null {
    const row = this.db.prepare(`SELECT * FROM addons WHERE IFNULL(workspace_id, '') = ? AND name = ?`).get(scopeKey(workspaceId), name) as unknown as Row | undefined
    return row ? (this.decode(row)[0] ?? null) : null
  }

  /** What a thread in `workspaceId` sees, a workspace row shadowing the global one of its name; disabled rows included. */
  visible(workspaceId: string | null): AddonRow[] {
    return visibleRows(this.list(), workspaceId)
  }

  /**
   * Create or replace (by id, else by scope and name). Validates the spec,
   * mints an id for a new row, stamps times, keeps the creator, and stamps
   * `writer` as the last writer unless the input carries its own (the sync,
   * which storeRpc admits only for an admin caller). Throws `refused: …`.
   */
  set(raw: AddonInput, writer: Writer): AddonRow {
    const input = AddonInputSchema.parse(raw)
    const problem = addonProblem(input.spec, input.name)
    if (problem) throw new Error(`refused: ${problem}`)
    const existing = input.id ? this.get(input.id) : this.byName(input.workspaceId, input.name)
    const id = existing?.id ?? input.id ?? mintAddonId()
    const clash = this.byName(input.workspaceId, input.name)
    if (clash && clash.id !== id) throw new Error(`refused: an add-on named ${input.name} already exists there`)
    const now = this.now()
    const row: AddonRow = {
      id,
      name: input.name,
      workspaceId: input.workspaceId,
      description: input.description ?? existing?.description ?? '',
      spec: input.spec,
      enabled: input.enabled ?? existing?.enabled ?? true,
      addedBy: existing?.addedBy ?? input.addedBy ?? writer,
      writtenBy: input.writtenBy ?? writer,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.write(row, existing)
    this.emit(this.changeListeners)
    return row
  }

  /**
   * The sync's write: the home's row as it stands (its id, times and
   * writers). A row of this host holding the same scope and name under
   * another id gives way. Answers whether anything changed.
   */
  put(row: AddonRow): boolean {
    const existing = this.get(row.id)
    if (existing && canonical(existing) === canonical(row)) return false
    const clash = this.byName(row.workspaceId, row.name)
    if (clash && clash.id !== row.id) this.delete(clash.id)
    this.write(row, existing)
    this.emit(this.changeListeners)
    return true
  }

  remove(id: string): boolean {
    if (!this.delete(id)) return false
    this.emit(this.changeListeners)
    return true
  }

  /** A deleted workspace's rows leave with it; answers how many. */
  dropWorkspace(workspaceId: string): number {
    const ids = (this.db.prepare(`SELECT id FROM addons WHERE workspace_id = ?`).all(workspaceId) as unknown as { id: string }[]).map((r) => r.id)
    for (const id of ids) this.delete(id)
    if (ids.length) this.emit(this.changeListeners)
    return ids.length
  }

  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  // ── this host's tools and status: never synced ────────────────────────

  /** The tools this host last listed, while the add-on's spec is the one they were listed under. */
  tools(id: string): { tools: AddonTool[]; fetchedAt: number } | null {
    const row = this.get(id)
    if (!row) return null
    const cache = this.db.prepare(`SELECT spec_digest, tools, fetched_at FROM addon_tool_cache WHERE addon_id = ?`).get(id) as unknown as
      | { spec_digest: string; tools: string; fetched_at: number }
      | undefined
    if (!cache || cache.spec_digest !== specDigest(row.spec)) return null
    try {
      return { tools: JSON.parse(cache.tools) as AddonTool[], fetchedAt: cache.fetched_at }
    } catch {
      return null
    }
  }

  /** The registry core's tools/list for an add-on, under its current spec. */
  setTools(id: string, tools: AddonTool[], at = this.now()): void {
    const row = this.get(id)
    if (!row) return
    this.db
      .prepare(`INSERT OR REPLACE INTO addon_tool_cache (addon_id, spec_digest, tools, fetched_at) VALUES (?, ?, ?, ?)`)
      .run(id, specDigest(row.spec), JSON.stringify(tools), at)
  }

  /** This host's status of every add-on the registry core has reported. */
  status(): Record<string, AddonStatus> {
    return Object.fromEntries(this.statuses)
  }

  setStatus(id: string, status: AddonStatus | null): void {
    const before = this.statuses.get(id)
    if (status === null ? !before : before && JSON.stringify(before) === JSON.stringify(status)) return
    if (status === null) this.statuses.delete(id)
    else this.statuses.set(id, status)
    this.emit(this.statusListeners)
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  // ── the table ─────────────────────────────────────────────────────────

  private write(row: AddonRow, existing: AddonRow | null): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO addons (id, name, workspace_id, description, spec, enabled, added_by, written_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.name,
        row.workspaceId,
        row.description,
        JSON.stringify(row.spec),
        row.enabled ? 1 : 0,
        JSON.stringify(row.addedBy),
        JSON.stringify(row.writtenBy),
        row.createdAt,
        row.updatedAt
      )
    if (existing && specDigest(existing.spec) !== specDigest(row.spec)) this.db.prepare(`DELETE FROM addon_tool_cache WHERE addon_id = ?`).run(row.id)
  }

  private delete(id: string): boolean {
    const gone = Number(this.db.prepare(`DELETE FROM addons WHERE id = ?`).run(id).changes) > 0
    this.db.prepare(`DELETE FROM addon_tool_cache WHERE addon_id = ?`).run(id)
    if (this.statuses.delete(id)) this.emit(this.statusListeners)
    return gone
  }

  private decode(r: Row): AddonRow[] {
    try {
      return [
        {
          id: r.id,
          name: r.name,
          workspaceId: r.workspace_id,
          description: r.description,
          spec: JSON.parse(r.spec) as AddonSpec,
          enabled: r.enabled === 1,
          addedBy: JSON.parse(r.added_by) as Writer,
          writtenBy: JSON.parse(r.written_by) as Writer,
          createdAt: r.created_at,
          updatedAt: r.updated_at
        }
      ]
    } catch {
      return []
    }
  }

  private emit(listeners: Set<() => void>): void {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        console.error('[addons] listener', err)
      }
    }
  }
}
