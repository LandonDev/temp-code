import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SkillPointers } from './pointers'

/**
 * Codex reads the skills store, and only the store (CLAUDE.md "Skills:
 * written out on every host"): the store's folder for the thread's scope is
 * an app-server extra root (`skills/extraRoots/set`, re-set on every live
 * app-server when the scope moves), and every skill in the person's
 * ~/.codex/skills and ~/.agents/skills is disabled for that one process by
 * its SKILL.md path (`-c skills.config=[…]`, which writes no config.toml).
 * Codex matches the path as spelled, so a symlinked skill dir is listed
 * both ways. Nothing is cached: a turn start rescans, and a skill added to
 * a home folder since the spawn reboots the thread's app-server.
 */

/** Group folders are walked this deep below a root for the skill dirs inside them. */
const GROUP_DEPTH = 3

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The person's Codex home: $CODEX_HOME of this process, else ~/.codex (sessionMove.ts codexHomeDir). */
const codexHome = (home: string): string => process.env.CODEX_HOME || join(home, '.codex')

/** SKILL.md paths under ~/.codex/skills (not .system) and ~/.agents/skills: each skill dir's own spelling and its real path, sorted, unique. */
export function homeSkillFiles(home: string = homedir()): string[] {
  const out = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      // Dot entries are not skills; codex's own bundled .system ones stay its own.
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      if (!isDir(path)) continue
      const file = join(path, 'SKILL.md')
      if (isFile(file)) {
        out.add(file)
        try {
          out.add(join(realpathSync(path), 'SKILL.md'))
        } catch {
          // a link that left: its own spelling is enough
        }
        continue
      }
      if (depth < GROUP_DEPTH) walk(path, depth + 1)
    }
  }
  walk(join(codexHome(home), 'skills'), 1)
  walk(join(home, '.agents', 'skills'), 1)
  return [...out].sort()
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** The `-c` pair that disables them for one app-server: ['-c', 'skills.config=[{path="…",enabled=false},…]'] (TOML strings escaped), [] when none. */
export function disableHomeSkillsArgs(files: readonly string[]): string[] {
  if (files.length === 0) return []
  return ['-c', `skills.config=[${files.map((f) => `{path=${tomlString(f)},enabled=false}`).join(',')}]`]
}

// ── the driver's seam ───────────────────────────────────────────────────

export interface CodexSkillsConfig {
  /** The workspace a thread reads skills for (views.ts workspaceOfThread of the thread itself). */
  scopeOf: (session: { workspaceId: string | null; projectId: string | null; cwd: string }) => string | null
  pointers: Pick<SkillPointers, 'current' | 'onMoved'>
  log?: (line: string) => void
}

/** A live codex handle's skills: its scope, the root its process holds, and how to give it another. */
export interface CodexSkillHandle {
  workspaceId: string | null
  /** The extra root the app-server holds now (null before the first set landed). */
  held: () => string | null
  /** The scope moved: set this root on the process. */
  moved: (root: string) => void
}

let configured: (CodexSkillsConfig & { off: () => void }) | null = null
const live = new Set<CodexSkillHandle>()

/** The store for codex threads; null is today's spawn exactly (tests, a host without the store). */
export function configureCodexSkills(cfg: CodexSkillsConfig | null): void {
  configured?.off()
  configured = null
  if (!cfg) return
  const off = cfg.pointers.onMoved((provider, scope) => {
    if (provider !== 'codex') return
    for (const h of [...live]) {
      if ((h.workspaceId ? `ws-${h.workspaceId}` : 'global') !== scope) continue
      const root = codexSkillRoot(h.workspaceId)
      if (root) h.moved(root)
    }
  })
  configured = { ...cfg, off }
}

/** The workspace a codex thread's skills come from; undefined when the store is not configured. */
export function codexSkillScope(session: { workspaceId: string | null; projectId: string | null; cwd: string }): { workspaceId: string | null } | undefined {
  return configured ? { workspaceId: configured.scopeOf(session) } : undefined
}

/** The extra root for a codex thread's scope: <generation>/skills. */
export function codexSkillRoot(workspaceId: string | null): string | null {
  return configured ? join(configured.pointers.current('codex', workspaceId).generation, 'skills') : null
}

/** A live handle joins the set a scope's move reaches; the returned function leaves it. */
export function trackCodexSkills(h: CodexSkillHandle): () => void {
  live.add(h)
  return () => live.delete(h)
}

/** The generation dir of every live codex handle's current extra root, which the materializer's gc spares. */
export function codexLiveRoots(): Set<string> {
  const out = new Set<string>()
  for (const h of live) {
    const root = h.held()
    if (root) out.add(dirname(root))
  }
  return out
}
