import { lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SKILL_HARNESSES, type SkillHarness } from '@shared/skills'
import { SCOPE_DIR, type SkillMaterializer } from './materialize'

/**
 * One stable path per (provider, scope) that always reaches the scope's
 * current skills (CLAUDE.md "Skills: one store, materialized per host"):
 *
 *   <root>/<provider>/scope/<global|ws-<id>>   a symlink to ../<view>@<12 hex>
 *
 * A generation never changes, and the materializer's `<view>` link exists
 * only while that view does (a workspace's own view comes and goes with its
 * own skills), so a CLI that must follow its scope for its whole life points
 * here. Each pointer names `materializer.dirFor(provider, workspaceId)`: a
 * workspace with no view of its own names the global generation, and keeps
 * its path when it gains a view or loses one. A move writes a new link
 * beside and renames it over the old one.
 */

export type ScopeKey = 'global' | `ws-${string}`
export const scopeKeyOf = (workspaceId: string | null): ScopeKey => (workspaceId ? `ws-${workspaceId}` : 'global')

export interface SkillPointersDeps {
  /** <userData>/harness */
  root: string
  materializer: Pick<SkillMaterializer, 'dirFor' | 'onPublished'>
  workspaces: () => { id: string }[]
  /** The workspace list moved (registry.onCatalog). */
  onWorkspaces?: (fn: () => void) => () => void
  now?: () => number
  log?: (line: string) => void
}

type MovedFn = (provider: SkillHarness, scope: ScopeKey, generation: string) => void

const LEFTOVER_RE = /\.lnk-(\d+)-\d+$/
const SCOPE_RE = /^(global|ws-.+)$/

export class SkillPointers {
  private seq = 0
  private refreshing = false
  private again = false
  private closed = false
  private readonly offs: (() => void)[] = []
  private readonly movedAt = new Map<string, number>()
  private readonly listeners = new Set<MovedFn>()
  /** A real folder found where a pointer belongs: said once. */
  private readonly foreign = new Set<string>()

  constructor(private readonly deps: SkillPointersDeps) {}

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[skills] ${l}`)))(line)
  }

  start(): void {
    if (this.closed) return
    this.removeLeftovers()
    this.refresh()
    this.offs.push(this.deps.materializer.onPublished(() => this.refresh()))
    if (this.deps.onWorkspaces) this.offs.push(this.deps.onWorkspaces(() => this.refresh()))
  }

  close(): void {
    this.closed = true
    for (const off of this.offs.splice(0)) off()
    this.listeners.clear()
  }

  /** <root>/<provider>/scope/<scopeKey>, pointed at the scope's current generation now (made at once if absent). */
  path(provider: SkillHarness, workspaceId: string | null): string {
    this.point(provider, workspaceId)
    return this.linkPath(provider, scopeKeyOf(workspaceId))
  }

  /** The generation the pointer names now (an absolute path), and when it last moved (epoch ms; 0 = never since boot). */
  current(provider: SkillHarness, workspaceId: string | null): { generation: string; movedAt: number } {
    const scope = scopeKeyOf(workspaceId)
    const link = this.linkPath(provider, scope)
    const target = readLink(link) ?? (this.point(provider, workspaceId), readLink(link))
    const movedAt = this.movedAt.get(`${provider}/${scope}`) ?? 0
    // A real folder in the pointer's place is what the CLI reads.
    return { generation: target ? join(this.deps.root, provider, basename(target)) : link, movedAt }
  }

  onMoved(fn: MovedFn): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Re-point every scope whose generation changed, and drop the pointers of workspaces gone from the list. */
  refresh(): void {
    if (this.closed) return
    // dirFor may build, and so publish, from inside a refresh: run once more after this one instead of nesting.
    if (this.refreshing) {
      this.again = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.again = false
        this.refreshOnce()
      } while (this.again && !this.closed)
    } finally {
      this.refreshing = false
    }
  }

  private refreshOnce(): void {
    const ids = [...new Set(this.deps.workspaces().map((w) => w.id))]
    const wanted = new Set<string>(['global', ...ids.map((id) => scopeKeyOf(id))])
    for (const provider of SKILL_HARNESSES) {
      this.point(provider, null)
      for (const id of ids) this.point(provider, id)
      const dir = join(this.deps.root, provider, SCOPE_DIR)
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (wanted.has(name) || LEFTOVER_RE.test(name) || !SCOPE_RE.test(name)) continue
        const link = join(dir, name)
        if (!lstatOrNull(link)?.isSymbolicLink()) continue
        rmSync(link, { force: true })
        this.movedAt.delete(`${provider}/${name}`)
        this.log(`${provider}/${SCOPE_DIR}/${name} removed`)
      }
    }
  }

  private linkPath(provider: SkillHarness, scope: ScopeKey): string {
    return join(this.deps.root, provider, SCOPE_DIR, scope)
  }

  /** Point one scope at its generation; a move fires onMoved. */
  private point(provider: SkillHarness, workspaceId: string | null): void {
    if (this.closed) return
    const scope = scopeKeyOf(workspaceId)
    const generation = this.deps.materializer.dirFor(provider, workspaceId)
    const link = this.linkPath(provider, scope)
    const want = join('..', basename(generation))
    const st = lstatOrNull(link)
    if (st && !st.isSymbolicLink()) {
      if (!this.foreign.has(link)) this.log(`${link} is a folder, not the app's link; left as it is`)
      this.foreign.add(link)
      return
    }
    const was = st ? readLink(link) : null
    if (was === want) return
    mkdirSync(join(this.deps.root, provider, SCOPE_DIR), { recursive: true })
    const tmp = `${link}.lnk-${process.pid}-${++this.seq}`
    rmSync(tmp, { force: true })
    symlinkSync(want, tmp)
    renameSync(tmp, link)
    if (was === null) return
    this.movedAt.set(`${provider}/${scope}`, this.deps.now?.() ?? Date.now())
    for (const fn of [...this.listeners]) {
      try {
        fn(provider, scope, generation)
      } catch (err) {
        this.log(`a pointer listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** The links a process that died mid-move left. */
  private removeLeftovers(): void {
    for (const provider of SKILL_HARNESSES) {
      const dir = join(this.deps.root, provider, SCOPE_DIR)
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const m = LEFTOVER_RE.exec(name)
        if (m && Number(m[1]) !== process.pid) rmSync(join(dir, name), { force: true })
      }
    }
  }
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

// ── the one instance the drivers read ────────────────────────────────────

let configured: SkillPointers | null = null

export function configureSkillPointers(p: SkillPointers | null): void {
  configured = p
}

/** The scope pointers; null before they are configured (tests, a host without the store). */
export function skillPointers(): SkillPointers | null {
  return configured
}
