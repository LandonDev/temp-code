import type { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import type { Writer } from '@shared/addons'
import { SkillInputSchema, type Skill, type SkillFile, type SkillInput, type SkillMeta } from '@shared/contract-skills'
import { canonical } from './addonStore'
import { SKILL_MD, skillDigest, skillFrontmatter, skillProblem, visibleSkills, type SkillHarness, type SkillHarnesses } from '@shared/skills'

/**
 * The skills store on this host (CLAUDE.md "Add-ons and skills: one store,
 * on the box"): each skill's row and its files, written whole in one
 * transaction. One copy lives on the box; the Mac's writes go there and its
 * rows follow (remote/storeSync.ts), which writes here with `put`. The
 * skills store core materializes what each CLI gets from here.
 */

type Row = {
  id: string
  name: string
  workspace_id: string | null
  description: string
  harnesses: string
  enabled: number
  version: number
  digest: string
  bytes: number
  file_count: number
  added_by: string
  written_by: string
  created_at: number
  updated_at: number
}

/** One file as the store keeps it. */
export interface StoredFile {
  path: string
  bytes: Uint8Array
  executable: boolean
}

export const mintSkillId = (): string => `sk_${nanoid(12)}`

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** A wire file's bytes: text as UTF-8, else base64. */
export const fileBytes = (f: SkillFile): Uint8Array => (f.text !== undefined ? encoder.encode(f.text) : new Uint8Array(Buffer.from(f.base64 ?? '', 'base64')))

/** A stored file for the wire: `text` when it is UTF-8 (byte for byte, a BOM kept), else `base64`. */
export function wireFile(f: StoredFile): SkillFile {
  const out: SkillFile = { path: f.path }
  try {
    out.text = utf8.decode(f.bytes)
  } catch {
    out.base64 = Buffer.from(f.bytes).toString('base64')
  }
  if (f.executable) out.executable = true
  return out
}

const scopeKey = (workspaceId: string | null): string => workspaceId ?? ''
const encodeHarnesses = (h: SkillHarnesses): string => (h === 'all' ? 'all' : JSON.stringify(h))
const decodeHarnesses = (s: string): SkillHarnesses => (s === 'all' ? 'all' : (JSON.parse(s) as SkillHarness[]))
const sameHarnesses = (a: SkillHarnesses, b: SkillHarnesses): boolean => encodeHarnesses(a) === encodeHarnesses(b)

export class SkillStore {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        workspace_id TEXT,
        description  TEXT NOT NULL,
        harnesses    TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        version      INTEGER NOT NULL,
        digest       TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        file_count   INTEGER NOT NULL,
        added_by     TEXT NOT NULL,
        written_by   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS skills_scope_name ON skills(IFNULL(workspace_id, ''), name);
      CREATE TABLE IF NOT EXISTS skill_files (
        skill_id   TEXT NOT NULL,
        path       TEXT NOT NULL,
        content    BLOB NOT NULL,
        executable INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (skill_id, path)
      );
    `)
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** Every skill's row, every scope, without files: the global ones first, then by workspace and name. */
  list(): SkillMeta[] {
    const rows = this.db.prepare(`SELECT * FROM skills ORDER BY IFNULL(workspace_id, ''), name`).all() as unknown as Row[]
    return rows.flatMap((r) => this.decode(r))
  }

  meta(id: string): SkillMeta | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(id) as unknown as Row | undefined
    return row ? (this.decode(row)[0] ?? null) : null
  }

  /** One skill whole, its files as the wire carries them. */
  get(id: string): Skill | null {
    const meta = this.meta(id)
    return meta ? { ...meta, files: this.files(id).map(wireFile) } : null
  }

  byName(workspaceId: string | null, name: string): SkillMeta | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE IFNULL(workspace_id, '') = ? AND name = ?`).get(scopeKey(workspaceId), name) as unknown as Row | undefined
    return row ? (this.decode(row)[0] ?? null) : null
  }

  /** A skill's files as bytes, by path. */
  files(id: string): StoredFile[] {
    const rows = this.db.prepare(`SELECT path, content, executable FROM skill_files WHERE skill_id = ? ORDER BY path`).all(id) as unknown as {
      path: string
      content: Uint8Array
      executable: number
    }[]
    return rows.map((r) => ({ path: r.path, bytes: new Uint8Array(r.content), executable: r.executable === 1 }))
  }

  /** The enabled skills a `harness` thread in `workspaceId` gets. */
  visible(workspaceId: string | null, harness: SkillHarness): SkillMeta[] {
    return visibleSkills(this.list(), workspaceId, harness)
  }

  // ── writes ────────────────────────────────────────────────────────────

  /**
   * Write one skill whole (create, or replace by id, else by scope and
   * name): its files replace what was there, in one transaction with its
   * row. The description is SKILL.md's. Version is 1 on create and moves by
   * one on a write that changes the files, the harnesses or enabled.
   * Throws `refused: …`.
   */
  set(raw: SkillInput, writer: Writer): SkillMeta {
    const input = SkillInputSchema.parse(raw)
    const files: StoredFile[] = input.files.map((f) => ({ path: f.path, bytes: fileBytes(f), executable: f.executable === true }))
    const problem = skillProblem(input.name, files)
    if (problem) throw new Error(`refused: ${problem}`)
    const existing = input.id ? this.meta(input.id) : this.byName(input.workspaceId, input.name)
    const id = existing?.id ?? input.id ?? mintSkillId()
    const clash = this.byName(input.workspaceId, input.name)
    if (clash && clash.id !== id) throw new Error(`refused: a skill named ${input.name} already exists there`)
    const md = files.find((f) => f.path === SKILL_MD)!
    const digest = skillDigest(files)
    const harnesses = input.harnesses ?? existing?.harnesses ?? 'all'
    const enabled = input.enabled ?? existing?.enabled ?? true
    const moved = !existing || existing.digest !== digest || !sameHarnesses(existing.harnesses, harnesses) || existing.enabled !== enabled
    const now = this.now()
    const meta: SkillMeta = {
      id,
      name: input.name,
      workspaceId: input.workspaceId,
      description: skillFrontmatter(new TextDecoder().decode(md.bytes)).description ?? '',
      harnesses,
      enabled,
      version: existing ? existing.version + (moved ? 1 : 0) : 1,
      digest,
      bytes: files.reduce((n, f) => n + f.bytes.length, 0),
      fileCount: files.length,
      addedBy: existing?.addedBy ?? input.addedBy ?? writer,
      writtenBy: input.writtenBy ?? writer,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.transaction(() => {
      this.writeRow(meta)
      this.writeFiles(id, files)
    })
    this.emit()
    return meta
  }

  /**
   * The sync's write: the home's skill as it stands (its id, version,
   * times and writers). With `files` they replace this host's; without,
   * this host's files must already be the ones the digest names (the
   * follow fetches files only when the digest moved). A skill of this host
   * holding the same scope and name under another id gives way. Answers
   * whether anything changed.
   */
  put(skill: SkillMeta & { files?: SkillFile[] }): boolean {
    const { files: wire, ...meta } = skill
    const existing = this.meta(meta.id)
    let files: StoredFile[] | null = null
    if (wire) {
      files = wire.map((f) => ({ path: f.path, bytes: fileBytes(f), executable: f.executable === true }))
      if (skillDigest(files) !== meta.digest) throw new Error(`refused: the files of ${meta.name} do not match its digest`)
    } else if (existing?.digest !== meta.digest) throw new Error(`refused: ${meta.name} needs its files`)
    if (existing && canonical(existing) === canonical(meta)) return false
    const clash = this.byName(meta.workspaceId, meta.name)
    this.transaction(() => {
      if (clash && clash.id !== meta.id) this.deleteRows(clash.id)
      this.writeRow(meta)
      if (files) this.writeFiles(meta.id, files)
    })
    this.emit()
    return true
  }

  remove(id: string): boolean {
    let gone = false
    this.transaction(() => {
      gone = this.deleteRows(id)
    })
    if (gone) this.emit()
    return gone
  }

  /** A deleted workspace's skills leave with it; answers how many. */
  dropWorkspace(workspaceId: string): number {
    const ids = (this.db.prepare(`SELECT id FROM skills WHERE workspace_id = ?`).all(workspaceId) as unknown as { id: string }[]).map((r) => r.id)
    if (!ids.length) return 0
    this.transaction(() => {
      for (const id of ids) this.deleteRows(id)
    })
    this.emit()
    return ids.length
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ── the tables ────────────────────────────────────────────────────────

  private writeRow(m: SkillMeta): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO skills (id, name, workspace_id, description, harnesses, enabled, version, digest, bytes, file_count, added_by, written_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id,
        m.name,
        m.workspaceId,
        m.description,
        encodeHarnesses(m.harnesses),
        m.enabled ? 1 : 0,
        m.version,
        m.digest,
        m.bytes,
        m.fileCount,
        JSON.stringify(m.addedBy),
        JSON.stringify(m.writtenBy),
        m.createdAt,
        m.updatedAt
      )
  }

  private writeFiles(id: string, files: readonly StoredFile[]): void {
    this.db.prepare(`DELETE FROM skill_files WHERE skill_id = ?`).run(id)
    const insert = this.db.prepare(`INSERT INTO skill_files (skill_id, path, content, executable) VALUES (?, ?, ?, ?)`)
    for (const f of files) insert.run(id, f.path, f.bytes, f.executable ? 1 : 0)
  }

  private deleteRows(id: string): boolean {
    this.db.prepare(`DELETE FROM skill_files WHERE skill_id = ?`).run(id)
    return Number(this.db.prepare(`DELETE FROM skills WHERE id = ?`).run(id).changes) > 0
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private decode(r: Row): SkillMeta[] {
    try {
      return [
        {
          id: r.id,
          name: r.name,
          workspaceId: r.workspace_id,
          description: r.description,
          harnesses: decodeHarnesses(r.harnesses),
          enabled: r.enabled === 1,
          version: r.version,
          digest: r.digest,
          bytes: r.bytes,
          fileCount: r.file_count,
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

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        console.error('[skills] listener', err)
      }
    }
  }
}
