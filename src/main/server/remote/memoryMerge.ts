import { posix } from 'node:path'

/**
 * The rules of the two-way memory sync (memorySync.ts), pure: given what
 * the driver listed, what is here, what the two agreed on last time and
 * the tombstones on both sides, one decision per path. The receiver
 * decides; the driver does what the answer says.
 *
 *  - unchanged on both sides since the last sync: nothing
 *  - changed on one side: that side's copy crosses
 *  - changed on both (or never synced and different): the newer mtime
 *    wins and the other is kept beside it as a conflict copy; MEMORY.md
 *    (Claude Code's index) is unioned instead (unionIndex)
 *  - deleted on one side: the deletion crosses, unless the other side
 *    edited it after the deletion (the edit wins and the file comes back);
 *    an edit the deletion beats is kept as a conflict copy
 *  - a tombstone is remembered 30 days (TOMBSTONE_MS)
 */

export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000

export interface Side {
  sha256: string
  mtime: number
}

export interface LedgerRow {
  /** The driver's hash of the file as last synced. */
  remote: string
  /** This host's hash of the file as last synced. */
  local: string
}

export interface DecideInput {
  remote?: Side
  remoteTombAt?: number
  local?: Side
  localTombAt?: number
  ledger?: LedgerRow
  /** Whether the path is a MEMORY.md index (unioned, never a conflict copy). */
  index: boolean
}

export type Decision =
  | { kind: 'nothing' }
  /** Take the driver's copy. `keep` 'conflict': this host's copy is kept beside it first. */
  | { kind: 'pull'; keep?: 'conflict' }
  /** Send this host's copy. `keep` 'conflict': the driver's copy is pulled first and kept beside as a conflict copy. */
  | { kind: 'push'; keep?: 'conflict' }
  /** Delete here (the driver's tombstone wins). `keep` 'conflict': this host's edit is kept beside first. */
  | { kind: 'delete-local'; keep?: 'conflict' }
  /** The driver deletes (this host's tombstone wins). `keep` 'conflict': the driver's edit is pulled as a conflict copy first. */
  | { kind: 'delete-remote'; keep?: 'conflict' }
  /** MEMORY.md changed on both sides: pull the driver's, union with this host's, send the result back. */
  | { kind: 'union' }

export function decide(input: DecideInput): Decision {
  const { remote, local, ledger, index } = input
  const remoteTomb = input.remoteTombAt
  const localTomb = input.localTombAt
  if (!remote && !local) return { kind: 'nothing' }
  if (remote && !local) {
    const tombAt = localTomb ?? (ledger ? 0 : undefined)
    if (tombAt === undefined) return { kind: 'pull' }
    // Deleted here. The driver's copy as it was when it was synced: the deletion wins.
    if (ledger && remote.sha256 === ledger.remote) return { kind: 'delete-remote' }
    // Edited there since: newer wins; a losing edit is kept beside.
    if (remote.mtime > tombAt) return { kind: 'pull' }
    return { kind: 'delete-remote', keep: 'conflict' }
  }
  if (local && !remote) {
    if (remoteTomb === undefined) return { kind: 'push' }
    if (ledger && local.sha256 === ledger.local) return { kind: 'delete-local' }
    if (local.mtime > remoteTomb) return { kind: 'push' }
    return { kind: 'delete-local', keep: 'conflict' }
  }
  // Both present.
  const r = remote!
  const l = local!
  if (ledger) {
    const remoteChanged = r.sha256 !== ledger.remote
    const localChanged = l.sha256 !== ledger.local
    if (!remoteChanged && !localChanged) return { kind: 'nothing' }
    if (remoteChanged && !localChanged) return { kind: 'pull' }
    if (!remoteChanged && localChanged) return { kind: 'push' }
  } else if (r.sha256 === l.sha256) return { kind: 'nothing' }
  if (index) return { kind: 'union' }
  return r.mtime >= l.mtime ? { kind: 'pull', keep: 'conflict' } : { kind: 'push', keep: 'conflict' }
}

/** Tombstones older than 30 days, gone. */
export function pruneTombstones<T extends { at: number }>(tombstones: Record<string, T>, now: number): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [path, t] of Object.entries(tombstones)) if (now - t.at < TOMBSTONE_MS) out[path] = t
  return out
}

// ── the MEMORY.md index ──────────────────────────────────────────────────

const INDEX_LINK = /\]\(([^)]+)\)/

/** The key a MEMORY.md line is deduped by: its linked file name, else the line itself; blank lines have none. */
export function indexLineKey(line: string): string | null {
  const t = line.trim()
  if (!t) return null
  const m = INDEX_LINK.exec(t)
  return m ? `file:${posix.basename(m[1].trim())}` : `text:${t}`
}

/**
 * The union of two MEMORY.md texts: `base` (the newer) in its order, with
 * every line of `other` it lacks inserted after the nearest line above it
 * that both share (at the end of the block when none). One line per
 * memory file; a line whose linked file `exists` says is gone from both
 * hosts is dropped.
 */
export function unionIndex(base: string, other: string, exists: (file: string) => boolean = () => true): string {
  const out: string[] = base.split('\n')
  const keys = new Map<string, number>()
  const rekey = (): void => {
    keys.clear()
    out.forEach((line, i) => {
      const k = indexLineKey(line)
      if (k && !keys.has(k)) keys.set(k, i)
    })
  }
  rekey()
  let anchor = -1
  for (const line of other.split('\n')) {
    const k = indexLineKey(line)
    if (!k) continue
    const at = keys.get(k)
    if (at !== undefined) {
      anchor = at
      continue
    }
    // A line the base lacks goes right after the last shared list line;
    // under a heading or with nothing shared above it yet, after the base's
    // last keyed line (the end of the list).
    const insertAt = anchor >= 0 && isListLine(out[anchor]) ? anchor + 1 : lastKeyed(out) + 1
    out.splice(insertAt, 0, line)
    rekey()
    anchor = insertAt
  }
  const kept = out.filter((line) => {
    const m = INDEX_LINK.exec(line)
    if (!m) return true
    const target = m[1].trim()
    if (/^[a-z]+:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return true
    return exists(target)
  })
  const text = kept.join('\n')
  return base.endsWith('\n') || other.endsWith('\n') ? text.replace(/\n*$/, '\n') : text
}

const isListLine = (line: string): boolean => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)

const lastKeyed = (lines: string[]): number => {
  for (let i = lines.length - 1; i >= 0; i--) if (indexLineKey(lines[i])) return i
  return lines.length - 1
}
