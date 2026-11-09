import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Principal } from '@shared/capabilities'
import type { SkillInput, SkillMeta } from '@shared/contract-skills'
import type { SessionMeta } from '@shared/events'
import type { ApprovalRequest } from '../drivers/types'
import { AddonStore } from '../addonStore'
import { SkillStore } from '../skillStore'
import { storeRpc } from '../storeRpc'
import { skillChanges, skillList, skillRemove, skillWrite, type SkillToolDeps } from './tools'

const LOCAL: Principal = { kind: 'local' }
const md = (name: string, body = ''): string => `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}`
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

let db: DatabaseSync
let skills: SkillStore
let cards: (ApprovalRequest & { sessionId: string })[]
let answer: 'allow' | 'deny' | 'away'
let settles: number
let settled: boolean
let calls: { input?: SkillInput; id?: string; expect: number }[]
let tmp: string

const thread = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 's-root', parentId: null, projectId: 'p1', workspaceId: 'w1', provider: 'claude', title: 'Tidy the repo', cwd: '/w', ...over }) as SessionMeta
const root = thread()
const sub = thread({ id: 's-sub', parentId: 's-root', title: 'A subagent', provider: 'codex' })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  skills = new SkillStore(db)
  cards = []
  answer = 'allow'
  settles = 0
  settled = true
  calls = []
  tmp = mkdtempSync(join(tmpdir(), 'tc-skill-tools-'))
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function deps(over: Partial<SkillToolDeps> = {}): SkillToolDeps {
  const rpc = storeRpc({ addons: new AddonStore(db), skills, sync: null })
  const refusal = (err: unknown): string => (err as Error).message
  return {
    environmentId: 'env_box',
    rootOf: (s) => (s.parentId ? root : s),
    workspaceOf: (s) => (s.workspaceId ? { id: s.workspaceId, name: 'temp-code' } : null),
    // As SessionRegistry.requestApproval: away answers false at once, with no card.
    requestApproval: async (sessionId, req) => {
      if (answer === 'away') return false
      cards.push({ sessionId, ...req })
      return answer === 'allow'
    },
    skills,
    write: async (input, expectUpdatedAt) => {
      calls.push({ input, expect: expectUpdatedAt })
      return rpc.handle({ method: 'skills.set', params: { skill: input, expectUpdatedAt } }, LOCAL).then((r) => r as { skill: SkillMeta }, refusal)
    },
    remove: async (id, expectUpdatedAt) => {
      calls.push({ id, expect: expectUpdatedAt })
      return rpc.handle({ method: 'skills.remove', params: { id, expectUpdatedAt } }, LOCAL).then((r) => r as { removed: boolean }, refusal)
    },
    settle: async () => {
      settles++
      return settled
    },
    ...over
  }
}

const personWrites = (name: string, body = '', workspaceId: string | null = 'w1', over: Partial<SkillInput> = {}): SkillMeta =>
  skills.set({ name, workspaceId, files: [{ path: 'SKILL.md', text: md(name, body) }], ...over }, { kind: 'person' })
const files = (name: string, body = '') => [{ path: 'SKILL.md', text: md(name, body) }]

describe('skill_list', () => {
  it('lists what the workspace sees, shadowing applied, disabled ones too, and whether this thread\'s CLI gets each', async () => {
    personWrites('tidy', 'global', null)
    personWrites('tidy', 'mine', 'w1')
    personWrites('cx', '', null, { harnesses: ['codex'] })
    personWrites('off', '', null, { enabled: false })
    personWrites('other-ws', '', 'w2')
    const rows = JSON.parse(await skillList(deps(), root)) as { name: string; scope: string; here: boolean; enabled: boolean; writtenBy: string }[]
    expect(rows.map((r) => [r.name, r.scope, r.enabled, r.here])).toEqual([
      ['cx', 'global', true, false],
      ['off', 'global', false, false],
      ['tidy', 'workspace', true, true]
    ])
    expect(rows[0]!.writtenBy).toBe('You')
    expect(JSON.parse(await skillList(deps(), sub)).find((r: { name: string }) => r.name === 'cx').here).toBe(true)
  })
})

describe('skill_write', () => {
  it('a new skill goes without a card, written by the root thread, expecting the name free, and the answer waits for the write-out', async () => {
    const out = await skillWrite(deps(), sub, { name: 'tidy', files: files('tidy') })
    expect(out).toBe('wrote tidy v1 (1 file, 42 B) for Claude, Codex and Muse in temp-code; every thread sees it from its next turn')
    expect(cards).toEqual([])
    expect(calls[0]!.expect).toBe(0)
    expect(settles).toBe(1)
    expect(skills.byName('w1', 'tidy')).toMatchObject({
      addedBy: { kind: 'thread', sessionId: 's-root', environmentId: 'env_box', title: 'Tidy the repo' },
      writtenBy: { kind: 'thread', sessionId: 's-root' }
    })
  })

  it('a rewrite of a thread\'s own skill goes without a card; one of a person\'s or an import\'s raises the schema\'s card with what changed', async () => {
    await skillWrite(deps(), root, { name: 'tidy', files: files('tidy') })
    expect(await skillWrite(deps(), root, { name: 'tidy', files: files('tidy', 'two') })).toMatch(/^wrote tidy v2 /)
    expect(cards).toEqual([])
    personWrites('mine', 'one')
    expect(await skillWrite(deps(), root, { name: 'mine', files: [...files('mine', 'two'), { path: 'notes.md', text: 'n' }], harnesses: ['claude'] }, { callId: 'toolu_1' })).toMatch(/^wrote mine v2 /)
    expect(cards).toEqual([
      {
        sessionId: 's-root',
        toolName: 'skill_write',
        callId: 'toolu_1',
        title: 'Change the skill mine',
        input: { where: 'temp-code', harnesses: 'Claude', files: '2 files, 46 B', changes: 'SKILL.md changed, notes.md added', writtenBy: 'You' }
      }
    ])
    skills.set({ name: 'imp', workspaceId: null, files: files('imp') }, { kind: 'import', from: '~/.claude/skills/imp' })
    await skillWrite(deps(), root, { name: 'imp', scope: 'global', files: files('imp'), harnesses: ['muse'] })
    expect(cards[1]).toMatchObject({ toolName: 'skill_write', title: 'Change the skill imp', input: { where: 'Every workspace', changes: 'only which CLIs get it', writtenBy: 'Imported' } })
    // A bridge call has no id of its own: the card carries one no row has.
    expect(cards[1]!.callId).toMatch(/^skill-card:[A-Za-z0-9_-]{8}$/)
  })

  it('a denial, or Away, writes nothing', async () => {
    const before = personWrites('mine', 'one')
    answer = 'deny'
    expect(await skillWrite(deps(), root, { name: 'mine', files: files('mine', 'two') })).toBe('refused: the person declined; mine is unchanged')
    answer = 'away'
    expect(await skillWrite(deps(), root, { name: 'mine', files: files('mine', 'two') })).toBe('refused: the person declined; mine is unchanged')
    expect(skills.byName('w1', 'mine')).toEqual(before)
    expect(calls).toEqual([])
  })

  it('the same files and CLIs write nothing and raise no card', async () => {
    personWrites('mine', 'one')
    expect(await skillWrite(deps(), root, { name: 'mine', files: files('mine', 'one') })).toBe('unchanged: mine v1')
    expect([cards, calls]).toEqual([[], []])
  })

  it('takes files or a folder, never both or neither', async () => {
    expect(await skillWrite(deps(), root, { name: 'x', files: files('x'), dir: '/tmp' })).toBe('refused: pass files or dir, not both')
    expect(await skillWrite(deps(), root, { name: 'x' })).toBe('refused: pass files or dir')
    expect(await skillWrite(deps(), root, { name: 'x', dir: 'relative/x' })).toBe('refused: dir must be an absolute folder on this host')
    const dir = join(tmp, 'x')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), md('x'))
    writeFileSync(join(dir, 'scripts/data.bin'), Uint8Array.from([0, 255, 1]))
    expect(await skillWrite(deps(), root, { name: 'x', dir })).toMatch(/^wrote x v1 \(2 files, /)
    expect(skills.files(skills.byName('w1', 'x')!.id).map((f) => f.path)).toEqual(['SKILL.md', 'scripts/data.bin'])
    expect(await skillWrite(deps(), root, { name: 'x', files: [{ path: 'SKILL.md', text: md('y') }] })).toBe('refused: SKILL.md names the skill y, not x')
  })

  it('a workspace scope with no workspace is refused; the default falls back to every workspace', async () => {
    const loose = thread({ workspaceId: null, projectId: null })
    expect(await skillWrite(deps(), loose, { name: 'x', scope: 'workspace', files: files('x') })).toBe('refused: this thread is in no workspace; pass scope "global"')
    expect(await skillWrite(deps(), loose, { name: 'x', files: files('x') })).toMatch(/ in every workspace; /)
    expect(skills.byName(null, 'x')).not.toBeNull()
  })

  it('passes the checked row\'s stamp; a row that moved meanwhile is refused with "call skill_write again"', async () => {
    const mine = personWrites('mine', 'one')
    const d = deps({
      requestApproval: async () => {
        // The person saves while the card waits.
        personWrites('mine', 'theirs')
        return true
      }
    })
    expect(await skillWrite(d, root, { name: 'mine', files: files('mine', 'two') })).toBe('refused: mine changed since this thread read it; call skill_write again')
    expect(calls[0]!.expect).toBe(mine.updatedAt)
    expect(skills.byName('w1', 'mine')?.writtenBy).toEqual({ kind: 'person' })
  })

  it('answers any other refusal as it is, and says when the host is still writing it out', async () => {
    expect(await skillWrite(deps({ write: async () => 'refused: add-ons and skills live on box; it is offline' }), root, { name: 'x', files: files('x') })).toBe(
      'refused: add-ons and skills live on box; it is offline'
    )
    settled = false
    expect(await skillWrite(deps(), root, { name: 'x', files: files('x') })).toMatch(/; this host is still writing it out$/)
  })
})

describe('skill_remove', () => {
  it('removes a thread\'s skill without a card and a person\'s with one, passing the checked stamp', async () => {
    await skillWrite(deps(), root, { name: 'own', files: files('own') })
    expect(await skillRemove(deps(), root, { name: 'own' })).toBe('removed own from temp-code')
    expect(cards).toEqual([])
    const mine = personWrites('mine')
    expect(await skillRemove(deps(), root, { name: 'mine' }, { callId: 'toolu_9' })).toBe('removed mine from temp-code')
    expect(cards).toEqual([{ sessionId: 's-root', toolName: 'skill_remove', callId: 'toolu_9', title: 'Remove the skill mine', input: { where: 'temp-code', writtenBy: 'You' } }])
    expect(calls.at(-1)).toEqual({ id: mine.id, expect: mine.updatedAt })
    expect(skills.list()).toEqual([])
  })

  it('names the other scope when the skill is there instead, and words a declined or moved removal', async () => {
    personWrites('glob', '', null)
    personWrites('local', '', 'w1')
    expect(await skillRemove(deps(), root, { name: 'glob' })).toBe('refused: no skill glob in temp-code; there is one in every workspace: pass scope "global"')
    expect(await skillRemove(deps(), root, { name: 'local', scope: 'global' })).toBe('refused: no skill local in every workspace; there is one in temp-code: pass scope "workspace"')
    answer = 'deny'
    expect(await skillRemove(deps(), root, { name: 'glob', scope: 'global' })).toBe('refused: the person declined; glob is unchanged')
    answer = 'allow'
    const moved = deps({
      requestApproval: async () => (personWrites('glob', 'again', null), true)
    })
    expect(await skillRemove(moved, root, { name: 'glob', scope: 'global' })).toBe('refused: glob changed since this thread read it; call skill_remove again')
    expect(skills.byName(null, 'glob')).not.toBeNull()
  })
})

describe('skillChanges', () => {
  const f = (path: string, text: string, executable = false) => ({ path, bytes: enc(text), executable })

  it('names changed, added and removed files, five at most, or says only the CLIs moved', () => {
    expect(skillChanges([f('SKILL.md', 'a'), f('old.md', 'x'), f('run.sh', 'a')], [f('SKILL.md', 'b'), f('run.sh', 'a', true), f('notes.md', 'n')])).toBe(
      'SKILL.md and run.sh changed, notes.md added, old.md removed'
    )
    const many = Array.from({ length: 8 }, (_, i) => f(`f${i}.md`, 'x'))
    expect(skillChanges([], many)).toBe('f0.md, f1.md, f2.md, f3.md and f4.md added, and 3 more')
    expect(skillChanges([f('a.md', '1'), f('b.md', '1'), f('c.md', '1')], [f('a.md', '2'), f('b.md', '2'), f('c.md', '2'), f('d.md', '1'), f('e.md', '1'), f('g.md', '1')])).toBe(
      'a.md, b.md and c.md changed, d.md and e.md added, and 1 more'
    )
    expect(skillChanges([f('SKILL.md', 'a')], [f('SKILL.md', 'a')])).toBe('only which CLIs get it')
  })
})
