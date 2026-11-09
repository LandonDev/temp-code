import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { nanoid } from 'nanoid'
import { andList, visibleRows, writerWords, type Writer } from '@shared/addons'
import type { SkillFile, SkillInput, SkillMeta } from '@shared/contract-skills'
import type { SessionMeta } from '@shared/events'
import {
  SKILL_HARNESSES,
  harnessWords,
  harnessesFrom,
  runsOn,
  sizeWords,
  skillChangeCard,
  skillDigest,
  skillProblem,
  skillRemoveCard,
  skillWriteAsks,
  type SkillHarness,
  type SkillHarnesses
} from '@shared/skills'
import type { ApprovalRequest } from '../drivers/types'
import { readSkillDir } from '../skillFiles'
import { fileBytes, type SkillStore, type StoredFile } from '../skillStore'

/**
 * The skill tools every thread gets (CLAUDE.md "Skills: written out on
 * every host"): skill_list, skill_write and skill_remove, one body for
 * Claude's in-process tools (apptools.ts) and the bridge (index.ts's
 * app.skill* cases). A change to a skill a person wrote or an import
 * brought in asks them on a card first; a new skill, or one a thread wrote
 * last, goes without.
 */

export interface SkillToolDeps {
  environmentId: string
  /** the parentId chain's top: a subagent writes as the thread a person knows */
  rootOf: (session: SessionMeta) => SessionMeta
  /** the thread's workspace (its project's, else the one holding its folder) */
  workspaceOf: (session: SessionMeta) => { id: string; name: string } | null
  requestApproval: (sessionId: string, req: ApprovalRequest) => Promise<boolean>
  skills: Pick<SkillStore, 'list' | 'byName' | 'files'>
  /** skills.set through storeRpc (to the home when another host holds it); a string is a refusal */
  write: (input: SkillInput, expectUpdatedAt: number) => Promise<{ skill: SkillMeta } | string>
  remove: (id: string, expectUpdatedAt: number) => Promise<{ removed: boolean } | string>
  /** the materializer's whenSettled */
  settle: () => Promise<boolean>
}

/** The call's own id when the harness gives one: Claude's tool_use id. */
export interface SkillCall {
  callId?: string
}

export interface SkillWriteArgs {
  name: string
  harnesses?: readonly string[]
  scope?: 'workspace' | 'global'
  files?: { path: string; text: string; executable?: boolean }[]
  dir?: string
}
export interface SkillRemoveArgs {
  name: string
  scope?: 'workspace' | 'global'
}

const MOVED = / changed since it was read$/
const SEEN = 'threads that start from now see it, running threads do not'
const STILL_WRITING = 'this host is still writing it out'

type Scope = { workspaceId: string | null; workspaceName: string | null }

/** Where a write or removal lands: the thread's workspace by default, else every workspace; a refusal string when it cannot. */
function scopeFor(deps: SkillToolDeps, caller: SessionMeta, scope: 'workspace' | 'global' | undefined): Scope | string {
  const ws = deps.workspaceOf(caller)
  const want = scope ?? (ws ? 'workspace' : 'global')
  if (want === 'global') return { workspaceId: null, workspaceName: null }
  if (!ws) return 'refused: this thread is in no workspace; pass scope "global"'
  return { workspaceId: ws.id, workspaceName: ws.name }
}

const inWords = (s: Scope): string => (s.workspaceName === null ? 'every workspace' : s.workspaceName)

function writerOf(deps: SkillToolDeps, caller: SessionMeta): Writer {
  const root = deps.rootOf(caller)
  return { kind: 'thread', sessionId: root.id, environmentId: deps.environmentId, title: (root.title ?? '').slice(0, 200) }
}

const encodeHarnesses = (h: SkillHarnesses): string => (h === 'all' ? 'all' : JSON.stringify(h))
const bytesOf = (files: readonly SkillFile[]): StoredFile[] => files.map((f) => ({ path: f.path, bytes: fileBytes(f), executable: f.executable === true }))
const fileKey = (f: StoredFile): string => `${f.executable ? 1 : 0}:${createHash('sha256').update(f.bytes).digest('hex')}`

/** Which files differ from the stored copy: `SKILL.md and run.sh changed, notes.md added, old.md removed`, five named at most, then `and 3 more`. */
export function skillChanges(before: readonly StoredFile[], after: readonly StoredFile[]): string {
  const was = new Map(before.map((f) => [f.path, fileKey(f)]))
  const now = new Map(after.map((f) => [f.path, fileKey(f)]))
  const sorted = (xs: string[]): string[] => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const groups: [string, string[]][] = [
    ['changed', sorted([...now.keys()].filter((p) => was.has(p) && was.get(p) !== now.get(p)))],
    ['added', sorted([...now.keys()].filter((p) => !was.has(p)))],
    ['removed', sorted([...was.keys()].filter((p) => !now.has(p)))]
  ]
  const total = groups.reduce((n, [, paths]) => n + paths.length, 0)
  if (total === 0) return 'only which CLIs get it'
  let budget = 5
  const parts: string[] = []
  for (const [verb, paths] of groups) {
    const named = paths.slice(0, Math.max(0, budget))
    budget -= named.length
    if (named.length) parts.push(`${andList(named)} ${verb}`)
  }
  const more = total - 5
  return more > 0 ? `${parts.join(', ')}, and ${more} more` : parts.join(', ')
}

/** skill_list: the skills a thread in the caller's workspace sees, every CLI's, disabled ones included. */
export async function skillList(deps: SkillToolDeps, caller: SessionMeta): Promise<string> {
  const ws = deps.workspaceOf(caller)
  const own = (SKILL_HARNESSES as readonly string[]).includes(caller.provider) ? (caller.provider as SkillHarness) : null
  const rows = visibleRows(deps.skills.list(), ws?.id ?? null).map((s) => ({
    name: s.name,
    description: s.description,
    harnesses: s.harnesses,
    scope: s.workspaceId === null ? 'global' : 'workspace',
    version: s.version,
    enabled: s.enabled,
    writtenBy: writerWords(s.writtenBy),
    here: own !== null && s.enabled && runsOn(s.harnesses, own)
  }))
  return JSON.stringify(rows)
}

/** skill_write: one skill whole, from text files or a folder on this host. */
export async function skillWrite(deps: SkillToolDeps, caller: SessionMeta, args: SkillWriteArgs, call: SkillCall = {}): Promise<string> {
  if ((args.files === undefined) === (args.dir === undefined)) return args.files ? 'refused: pass files or dir, not both' : 'refused: pass files or dir'
  const scope = scopeFor(deps, caller, args.scope)
  if (typeof scope === 'string') return scope
  let files: SkillFile[]
  if (args.dir !== undefined) {
    if (!isAbsolute(args.dir)) return 'refused: dir must be an absolute folder on this host'
    try {
      files = await readSkillDir(args.dir)
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      return message.startsWith('refused: ') ? message : `refused: ${message}`
    }
  } else files = args.files!.map((f) => ({ path: f.path, text: f.text, ...(f.executable ? { executable: true } : {}) }))
  const next = bytesOf(files)
  const problem = skillProblem(args.name, next)
  if (problem) return `refused: ${problem}`
  const harnesses = harnessesFrom(args.harnesses)
  const existing = deps.skills.byName(scope.workspaceId, args.name)
  const digest = skillDigest(next)
  if (existing && existing.digest === digest && encodeHarnesses(existing.harnesses) === encodeHarnesses(harnesses)) return `unchanged: ${args.name} v${existing.version}`
  const bytes = next.reduce((n, f) => n + f.bytes.length, 0)
  if (existing && skillWriteAsks(existing)) {
    const card = skillChangeCard(
      { name: args.name, harnesses, fileCount: next.length, bytes, changes: skillChanges(deps.skills.files(existing.id), next) },
      existing,
      { workspaceName: scope.workspaceName }
    )
    const allow = await deps.requestApproval(caller.id, { toolName: 'skill_write', title: card.title, input: card.input, callId: call.callId ?? `skill-card:${nanoid(8)}` })
    if (!allow) return `refused: the person declined; ${args.name} is unchanged`
  }
  const writer = writerOf(deps, caller)
  const answer = await deps.write(
    { ...(existing ? { id: existing.id } : { addedBy: writer }), name: args.name, workspaceId: scope.workspaceId, harnesses, files, writtenBy: writer },
    existing?.updatedAt ?? 0
  )
  if (typeof answer === 'string') return MOVED.test(answer) ? `refused: ${args.name} changed since this thread read it; call skill_write again` : answer
  const settled = await deps.settle()
  const { skill } = answer
  return `wrote ${skill.name} v${skill.version} (${skill.fileCount} ${skill.fileCount === 1 ? 'file' : 'files'}, ${sizeWords(skill.bytes)}) for ${harnessWords(skill.harnesses)} in ${inWords(scope)}; ${settled ? SEEN : STILL_WRITING}`
}

/** skill_remove: a skill by name, in the caller's workspace or every workspace. */
export async function skillRemove(deps: SkillToolDeps, caller: SessionMeta, args: SkillRemoveArgs, call: SkillCall = {}): Promise<string> {
  const scope = scopeFor(deps, caller, args.scope)
  if (typeof scope === 'string') return scope
  const existing = deps.skills.byName(scope.workspaceId, args.name)
  if (!existing) {
    let hint = ''
    if (scope.workspaceId !== null && deps.skills.byName(null, args.name)) hint = '; there is one in every workspace: pass scope "global"'
    else if (scope.workspaceId === null) {
      const ws = deps.workspaceOf(caller)
      if (ws && deps.skills.byName(ws.id, args.name)) hint = `; there is one in ${ws.name}: pass scope "workspace"`
    }
    return `refused: no skill ${args.name} in ${inWords(scope)}${hint}`
  }
  if (skillWriteAsks(existing)) {
    const card = skillRemoveCard(existing, { workspaceName: scope.workspaceName })
    const allow = await deps.requestApproval(caller.id, { toolName: 'skill_remove', title: card.title, input: card.input, callId: call.callId ?? `skill-card:${nanoid(8)}` })
    if (!allow) return `refused: the person declined; ${args.name} is unchanged`
  }
  const answer = await deps.remove(existing.id, existing.updatedAt)
  if (typeof answer === 'string') return MOVED.test(answer) ? `refused: ${args.name} changed since this thread read it; call skill_remove again` : answer
  if (!answer.removed) return `refused: no skill ${args.name} in ${inWords(scope)}`
  const settled = await deps.settle()
  return `removed ${args.name} from ${inWords(scope)}${settled ? '' : `; ${STILL_WRITING}`}`
}

