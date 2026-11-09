import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillFile } from '@shared/contract-skills'
import { SkillStore } from '../skillStore'
import { SCOPE_DIR, SkillMaterializer } from './materialize'
import { SkillPointers, configureSkillPointers, scopeKeyOf, skillPointers } from './pointers'

const you = { kind: 'person' } as const
const md = (name: string, body = ''): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}` })

let tmp: string
let root: string
let db: DatabaseSync
let store: SkillStore
let clock: number
let logs: string[]
let workspaces: { id: string; path: string }[]
let m: SkillMaterializer
let made: SkillPointers[]

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-pointers-')))
  root = join(tmp, 'harness')
  db = new DatabaseSync(':memory:')
  clock = 1_000_000
  store = new SkillStore(db, () => clock)
  logs = []
  workspaces = [{ id: 'w1', path: join(tmp, 'w1') }]
  made = []
  m = new SkillMaterializer({
    root,
    skills: store,
    workspaces: () => workspaces,
    platform: 'linux',
    home: '/home/me',
    textMap: () => ({ roots: {}, prefixes: {} }),
    now: () => clock,
    log: (l) => logs.push(l),
    between: async () => {}
  })
  m.start()
  await m.whenSettled()
})
afterEach(() => {
  for (const p of made) p.close()
  m.close()
  configureSkillPointers(null)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const put = (name: string, over: { body?: string; workspaceId?: string | null } = {}) =>
  store.set({ name, workspaceId: over.workspaceId ?? null, files: [md(name, over.body)] }, you)

function pointers(over: Partial<ConstructorParameters<typeof SkillPointers>[0]> = {}): SkillPointers {
  const p = new SkillPointers({ root, materializer: m, workspaces: () => workspaces, now: () => clock, log: (l) => logs.push(l), ...over })
  made.push(p)
  return p
}

const link = (provider: string, scope: string): string => join(root, provider, SCOPE_DIR, scope)
const viewGen = (provider: string, view = 'global'): string => readlinkSync(join(root, provider, view))

describe('scope pointers', () => {
  it('give each provider a global pointer and one per workspace, a workspace with no view of its own naming the global generation', () => {
    put('alpha')
    const p = pointers()
    p.start()
    for (const provider of ['claude', 'codex', 'muse']) {
      expect(readdirSync(join(root, provider, SCOPE_DIR)).sort()).toEqual(['global', 'ws-w1'])
      expect(lstatSync(link(provider, 'global')).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link(provider, 'ws-w1'))).toBe(join('..', viewGen(provider)))
    }
    expect(p.path('claude', 'w1')).toBe(link('claude', 'ws-w1'))
    expect(p.current('claude', 'w1')).toEqual({ generation: join(root, 'claude', viewGen('claude')), movedAt: 0 })
    expect(readdirSync(join(p.path('claude', null), 'skills'))).toEqual(['alpha'])
    expect(scopeKeyOf(null)).toBe('global')
    expect(scopeKeyOf('w1')).toBe('ws-w1')
  })

  it('keep their path when a workspace gains a view and when it loses it, moving by rename and saying so once per changed pointer', async () => {
    put('alpha')
    const p = pointers()
    p.start()
    const moves: string[] = []
    p.onMoved((provider, scope, generation) => moves.push(`${provider}/${scope}→${generation}`))
    const path = p.path('claude', 'w1')
    clock = 2_000_000
    const own = put('local', { workspaceId: 'w1' })
    await m.whenSettled()
    expect(p.path('claude', 'w1')).toBe(path)
    expect(readlinkSync(path)).toBe(join('..', viewGen('claude', 'ws-w1')))
    expect(readdirSync(join(path, 'skills'))).toEqual(['alpha', 'local'])
    expect(p.current('claude', 'w1').movedAt).toBe(2_000_000)
    // The global pointers did not move: one move per provider, the workspace's.
    expect(moves.map((x) => x.split('→')[0]).sort()).toEqual(['claude/ws-w1', 'codex/ws-w1', 'muse/ws-w1'])
    expect(moves[0]).toContain(join(root, 'claude', viewGen('claude', 'ws-w1')))
    moves.length = 0
    store.remove(own.id)
    await m.whenSettled()
    expect(readlinkSync(path)).toBe(join('..', viewGen('claude')))
    expect(moves.length).toBe(3)
    // Nothing changed: nothing moves.
    moves.length = 0
    p.refresh()
    expect(moves).toEqual([])
    expect(readdirSync(join(root, 'claude', SCOPE_DIR)).filter((n) => n.includes('.lnk-'))).toEqual([])
  })

  it('a change to the global view moves every scope that reads it', async () => {
    put('alpha')
    const p = pointers()
    p.start()
    const moves: string[] = []
    p.onMoved((provider, scope) => moves.push(`${provider}/${scope}`))
    put('beta')
    await m.whenSettled()
    expect(moves.sort()).toEqual(['claude/global', 'claude/ws-w1', 'codex/global', 'codex/ws-w1', 'muse/global', 'muse/ws-w1'])
    expect(readdirSync(join(link('codex', 'ws-w1'), 'skills'))).toEqual(['alpha', 'beta'])
  })

  it('drop a deleted workspace\'s pointer on the next workspace change', () => {
    let changed: (() => void) | null = null
    const p = pointers({ onWorkspaces: (fn) => ((changed = fn), () => {}) })
    p.start()
    expect(existsSync(link('muse', 'ws-w1'))).toBe(true)
    workspaces = []
    changed!()
    for (const provider of ['claude', 'codex', 'muse']) expect(readdirSync(join(root, provider, SCOPE_DIR))).toEqual(['global'])
    expect(logs).toContain(`claude/${SCOPE_DIR}/ws-w1 removed`)
  })

  it('a pointer asked for a workspace the list does not know yet is made at once', () => {
    const p = pointers()
    p.start()
    expect(existsSync(link('claude', 'ws-w9'))).toBe(false)
    const path = p.path('claude', 'w9')
    expect(readlinkSync(path)).toBe(join('..', viewGen('claude')))
    expect(p.current('codex', 'w9').generation).toBe(join(root, 'codex', viewGen('codex')))
  })

  it('leave a real folder at a pointer\'s path alone, with one log line', () => {
    mkdirSync(link('claude', 'global'), { recursive: true })
    const p = pointers()
    p.start()
    p.refresh()
    expect(lstatSync(link('claude', 'global')).isDirectory()).toBe(true)
    expect(logs.filter((l) => l.includes('is a folder')).length).toBe(1)
    expect(p.current('claude', null).generation).toBe(link('claude', 'global'))
  })

  it('remove the links a dead process left mid-move, and keep this one\'s', () => {
    mkdirSync(join(root, 'claude', SCOPE_DIR), { recursive: true })
    symlinkSync('../nowhere', join(root, 'claude', SCOPE_DIR, 'global.lnk-999999-1'))
    symlinkSync('../nowhere', join(root, 'claude', SCOPE_DIR, `ws-w1.lnk-${process.pid}-1`))
    pointers().start()
    expect(readdirSync(join(root, 'claude', SCOPE_DIR)).sort()).toEqual(['global', 'ws-w1', `ws-w1.lnk-${process.pid}-1`])
  })

  it('are null until configured', () => {
    expect(skillPointers()).toBeNull()
    const p = pointers()
    configureSkillPointers(p)
    expect(skillPointers()).toBe(p)
  })
})
