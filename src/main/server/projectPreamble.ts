/**
 * Project preambles: the house rules a project's briefs always open with
 * (worktree, gate, merge rule, what never to touch, which skills to use),
 * written once per project — or once per workspace as the default for its
 * projects without one — and prepended by the main process to every
 * thread's FIRST message in that project, on every path that starts a
 * thread (the composer, plan → build, app_start_thread, spawn_agent
 * children, a thread started from another host, the phone's New thread).
 * All of them end in SessionRegistry.send, which calls decidePreamble once
 * per first message; nothing else composes the block.
 *
 * The harness sees `## Project rules` + the substituted text + `## The
 * task` + what the person wrote. The visible user-text row keeps the
 * person's text as `text` and carries the rules as `preamble` (the stamp),
 * so the transcript shows the brief and folds the rules to one line — and
 * so a thread keeps the text it was started with: edits reach new threads
 * only.
 */
import { hostname } from 'node:os'
import type { PreambleStamp, SessionMeta } from '@shared/events'
import { effectivePreamble, normalizePreamble, stampOf, substitutePreamble, worktreeSlug } from '@shared/preamble'
import type { Store } from './db'

export {
  PREAMBLE_HEADING,
  PREAMBLE_VARIABLES,
  TASK_HEADING,
  composePreambled,
  effectivePreamble,
  normalizePreamble,
  stampOf,
  substitutePreamble,
  wordCount,
  worktreeSlug
} from '@shared/preamble'
export type { PreambleVars } from '@shared/preamble'

export interface DecideInput {
  store: Pick<Store, 'getProject' | 'listWorkspaces' | 'getSession' | 'firstUserPreamble'>
  session: SessionMeta
  /** the first message as the person wrote it (a placeholder title takes its first line) */
  text: string
  /** the spawner said `preamble: false` */
  optOut?: boolean
  /** this machine's name; defaults to the OS hostname */
  host?: string
}

/**
 * The stamp a session's first message carries, or null when nothing
 * applies: no project, the spawner opted out, the project (and its
 * workspace) has no enabled preamble, or — for a subagent — the parent
 * thread on this host opened without one (a fleet is all-or-nothing; a
 * parent on another host is unknown here, so its child follows the
 * project).
 */
export function decidePreamble(input: DecideInput): PreambleStamp | null {
  const { store, session } = input
  if (input.optOut || !session.projectId) return null
  const project = store.getProject(session.projectId)
  if (!project) return null
  if (session.parentId) {
    const parent = store.getSession(session.parentId)
    if (parent && !store.firstUserPreamble(parent.id)) return null
  }
  const workspace = store.listWorkspaces().find((w) => w.id === project.workspaceId) ?? null
  const template = effectivePreamble(project, workspace)
  if (!template) return null
  const title = session.title.trim() || input.text.trim().split('\n')[0]
  return stampOf(
    substitutePreamble(template, {
      worktree: worktreeSlug(title),
      project: project.name,
      host: input.host ?? hostname()
    })
  )
}

/** The house rules every temp-code brief opened with before this existed,
 *  minus the worktree name. Seeded once as the temp-code workspace's
 *  default, so every project under it (and any added later) carries them. */
export const HOUSE_PREAMBLE = `- Work in your own git worktree: \`git worktree add .claude/worktrees/{{worktree}} -b {{worktree}} master\`, symlink the main checkout's node_modules into it, bun is at /srv/agents/home/.bun/bin. Run vitest with NODE_ENV=test; gateway.test.ts fails on Linux and is not yours. \`bun run typecheck\`, the tests and \`bun run build\` must be green before you merge.
- When green: \`git fetch origin\`, rebase onto origin/master (many sibling threads merge in parallel; resolve conflicts, re-run the gate), fast-forward master, push origin master. Commit messages are plain prose, no AI attribution trailers.
- Never touch /Applications/TempCode.app, never run box-update or the Mac release, never edit the user's Mac checkout, never send into the user's threads.
- Update docs and CLAUDE.md so they say what is now true. Every new behaviour gets a unit test.
- For every renderer change: invoke /impeccable (run its context script once, read craft-floor before editing; Operate surface, precision and restraint), /emil-design-eng and /better-ui, and follow them. docs/DESIGN.md wins conflicts.`

const SEED_KEY = 'preamble-seeded:house'

/** Seeds HOUSE_PREAMBLE as the default of every workspace whose folder is
 *  named temp-code and has no default yet. Runs once per database (the
 *  marker setting), so a cleared default stays cleared. */
export function seedHousePreamble(
  store: Pick<Store, 'getSetting' | 'setSetting' | 'listWorkspaces' | 'setWorkspacePreamble'>,
  folderName = 'temp-code'
): string[] {
  if (store.getSetting(SEED_KEY) !== null) return []
  const seeded: string[] = []
  for (const w of store.listWorkspaces()) {
    const base = w.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (base !== folderName || normalizePreamble(w.preamble)) continue
    store.setWorkspacePreamble(w.id, HOUSE_PREAMBLE, true)
    seeded.push(w.id)
  }
  store.setSetting(SEED_KEY, String(Date.now()))
  return seeded
}
