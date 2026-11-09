import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillInput } from '@shared/contract-skills'
import { SkillStore, fileBytes } from '../skillStore'
import { SKILL_IMPORT_KEY, importLine, importSkills, planImport, scanSkillRoots, type ImportDeps } from './import'

let tmp: string
let home: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-skill-import-')))
  home = join(tmp, 'home')
  mkdirSync(home)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const T = Date.UTC(2026, 10, 1) / 1000
/** A file under the fake HOME, its mtime `age` seconds after T. */
const put = (rel: string, content: string | Uint8Array, age = 0): void => {
  const path = join(home, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  utimesSync(path, T + age, T + age)
}
const skillMd = (name: string, body = ''): string => `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}`

const settings = () => {
  const rows: Record<string, string> = {}
  return { rows, getSetting: (k: string) => rows[k] ?? null, setSetting: (k: string, v: string | null) => (v === null ? delete rows[k] : (rows[k] = v), undefined) }
}

describe('scanSkillRoots and planImport', () => {
  it('one row for identical copies, its CLIs every root\'s, .agents counting as Claude and Codex', async () => {
    put('.agents/skills/beta/SKILL.md', skillMd('beta'))
    put('.codex/skills/beta/SKILL.md', skillMd('beta'))
    put('.config/muse/skills/mu/SKILL.md', skillMd('mu'))
    put('.claude/skills/solo/SKILL.md', skillMd('solo'))
    put('.claude/skills/every/SKILL.md', skillMd('every'))
    put('.agents/skills/every/SKILL.md', skillMd('every'))
    put('.config/muse/skills/every/SKILL.md', skillMd('every'))
    const { candidates } = await scanSkillRoots(home)
    const plan = planImport(candidates, [])
    expect(plan.rows.map((r) => [r.name, r.harnesses, r.from])).toEqual([
      ['beta', ['claude', 'codex'], '~/.codex/skills/beta'],
      ['every', 'all', '~/.claude/skills/every'],
      ['mu', ['muse'], '~/.config/muse/skills/mu'],
      ['solo', ['claude'], '~/.claude/skills/solo']
    ])
    expect(plan.merged).toEqual([])
  })

  it('copies that differ only by which root they spell merge as equal; truly different ones keep the newest and say so', async () => {
    put('.claude/skills/spell/SKILL.md', skillMd('spell', 'Run ~/.claude/skills/spell/run.sh\n'))
    put('.codex/skills/spell/SKILL.md', skillMd('spell', 'Run ~/.codex/skills/spell/run.sh\n'), 50)
    put('.claude/skills/gamma/SKILL.md', skillMd('gamma', 'old words\n'), 0)
    put('.agents/skills/gamma/SKILL.md', skillMd('gamma', 'new words\n'), 100)
    put('.agents/skills/gamma/extra.md', 'more', 100)
    const plan = planImport((await scanSkillRoots(home)).candidates, [])
    const spell = plan.rows.find((r) => r.name === 'spell')!
    expect(spell).toMatchObject({ harnesses: ['claude', 'codex'], from: '~/.claude/skills/spell' })
    const gamma = plan.rows.find((r) => r.name === 'gamma')!
    expect(gamma).toMatchObject({ harnesses: ['claude', 'codex'], from: '~/.agents/skills/gamma' })
    expect(gamma.files.map((f) => f.path)).toEqual(['SKILL.md', 'extra.md'])
    expect(plan.merged).toEqual([{ name: 'gamma', kept: '~/.agents/skills/gamma', dropped: ['~/.claude/skills/gamma'] }])
  })

  it('passes over the synced bucket, dot entries and plain files quietly, and names every other skip', async () => {
    put('.claude/skills/synced/b/SKILL.md', skillMd('b'))
    put('.codex/skills/.system/x/SKILL.md', skillMd('x'))
    put('.claude/skills/.trash/y/SKILL.md', skillMd('y'))
    put('.claude/skills/README.md', 'not a skill')
    put('.claude/skills/nosk/notes.md', 'no skill file')
    put('.claude/skills/Bad_Name/SKILL.md', skillMd('Bad_Name'))
    put('.claude/skills/wrong/SKILL.md', skillMd('other'))
    put('.claude/skills/leak/SKILL.md', skillMd('leak'))
    put('.claude/skills/leak/key.pem', 'secret')
    mkdirSync(join(tmp, 'outside/far'), { recursive: true })
    writeFileSync(join(tmp, 'outside/far/SKILL.md'), skillMd('far'))
    symlinkSync(join(tmp, 'outside/far'), join(home, '.claude/skills/far'))
    put('.ssh/hidden/SKILL.md', skillMd('hidden'))
    symlinkSync(join(home, '.ssh/hidden'), join(home, '.claude/skills/hidden'))
    put('IdeaProjects/linked/SKILL.md', skillMd('linked'))
    symlinkSync(join(home, 'IdeaProjects/linked'), join(home, '.claude/skills/linked'))
    const { candidates, skipped } = await scanSkillRoots(home)
    expect(candidates.map((c) => c.name)).toEqual(['linked'])
    expect(candidates[0]!.dir).toBe(join(home, 'IdeaProjects/linked'))
    expect(Object.fromEntries(skipped.map((s) => [s.name, s.reason]))).toEqual({
      'Bad_Name': 'not a skill name (lowercase letters, digits and dashes)',
      far: 'link outside home',
      hidden: 'link outside home',
      leak: 'key.pem looks like a credential; a skill never carries one',
      nosk: 'no SKILL.md',
      wrong: 'SKILL.md names the skill other, not wrong'
    })
  })

  it('drops a native binary and the binary cache from an otherwise good skill', async () => {
    put('.claude/skills/delta-bin/SKILL.md', skillMd('delta-bin'))
    put('.claude/skills/delta-bin/scripts/launch', '#!/bin/sh\n')
    put('.claude/skills/delta-bin/scripts/bin/linux-x64/tool', 'cached')
    put('.claude/skills/delta-bin/tool-mac', Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))
    const { candidates } = await scanSkillRoots(home)
    expect(candidates[0]!.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/launch'])
    expect(candidates[0]!.dropped).toEqual(['tool-mac'])
  })

  it('never takes a name the store already holds globally; a workspace row of that name is no clash', async () => {
    put('.claude/skills/tidy/SKILL.md', skillMd('tidy'))
    put('.claude/skills/ws-only/SKILL.md', skillMd('ws-only'))
    const plan = planImport((await scanSkillRoots(home)).candidates, [
      { name: 'tidy', workspaceId: null },
      { name: 'ws-only', workspaceId: 'w1' }
    ])
    expect(plan.rows.map((r) => r.name)).toEqual(['ws-only'])
    expect(plan.skipped).toEqual([{ name: 'tidy', from: '~/.claude/skills/tidy', reason: 'already in the store' }])
  })
})

describe('importSkills', () => {
  let db: DatabaseSync
  let store: SkillStore
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    store = new SkillStore(db)
    put('.claude/skills/alpha/SKILL.md', skillMd('alpha'))
    put('.agents/skills/beta/SKILL.md', skillMd('beta'))
  })
  afterEach(() => db.close())

  /** A Mac whose writes land in `store` as skills.set with expectUpdatedAt would. */
  const deps = (over: Partial<ImportDeps> = {}): ImportDeps & { writes: { input: SkillInput; expect: number }[]; settings: ReturnType<typeof settings> } => {
    const s = settings()
    const writes: { input: SkillInput; expect: number }[] = []
    return {
      platform: 'darwin',
      home,
      store: s,
      settings: s,
      writes,
      existing: () => store.list(),
      storeHome: () => null,
      follow: async () => {},
      write: async (input, expect) => {
        writes.push({ input, expect })
        try {
          return { skill: store.set(input, input.writtenBy!, { expectUpdatedAt: expect }) }
        } catch (err) {
          return (err as Error).message
        }
      },
      log: () => {},
      ...over
    }
  }

  it('writes each row as an import from its folder, expecting the name free, then sets the marker once', async () => {
    const d = deps()
    const report = await importSkills(d)
    expect(report?.imported).toEqual(['alpha', 'beta'])
    expect(d.writes.map((w) => w.expect)).toEqual([0, 0])
    expect(store.byName(null, 'alpha')).toMatchObject({ addedBy: { kind: 'import', from: '~/.claude/skills/alpha' }, writtenBy: { kind: 'import', from: '~/.claude/skills/alpha' }, harnesses: ['claude'] })
    expect(fileBytes(store.get(store.byName(null, 'beta')!.id)!.files[0]!)).toEqual(new TextEncoder().encode(skillMd('beta')))
    expect(JSON.parse(d.settings.rows[SKILL_IMPORT_KEY]!)).toMatchObject({ imported: 2, merged: 0, skipped: 0 })
    // A second run is a no-op.
    expect(await importSkills(d)).toBeNull()
    expect(d.writes).toHaveLength(2)
  })

  it('does nothing off the Mac', async () => {
    const d = deps({ platform: 'linux' })
    expect(await importSkills(d)).toBeNull()
    expect(d.writes).toEqual([])
    expect(d.settings.rows[SKILL_IMPORT_KEY]).toBeUndefined()
  })

  it('with the home elsewhere, plans only after a whole follow: a name the home holds is skipped', async () => {
    const order: string[] = []
    const d = deps({
      storeHome: () => ({ id: 'env_box', online: true }),
      follow: async (id) => {
        order.push(`follow ${id}`)
        store.set({ name: 'alpha', workspaceId: null, files: [{ path: 'SKILL.md', text: skillMd('alpha', 'the box\'s') }] }, { kind: 'person' })
      }
    })
    const report = await importSkills(d)
    expect(order).toEqual(['follow env_box'])
    expect(report?.imported).toEqual(['beta'])
    expect(report?.skipped).toEqual([{ name: 'alpha', from: '~/.claude/skills/alpha', reason: 'already in the store' }])
    expect(store.byName(null, 'alpha')?.writtenBy).toEqual({ kind: 'person' })
  })

  it('a home offline defers the run, no marker; a name taken since the follow is a skip, never an overwrite', async () => {
    const offline = deps({ storeHome: () => ({ id: 'env_box', online: false }) })
    expect(await importSkills(offline)).toBeNull()
    expect(offline.settings.rows[SKILL_IMPORT_KEY]).toBeUndefined()
    const d = deps({
      write: async (input, expect) => {
        // Someone wrote alpha on the home after the follow.
        if (input.name === 'alpha') store.set({ name: 'alpha', workspaceId: null, files: [{ path: 'SKILL.md', text: skillMd('alpha', 'theirs') }] }, { kind: 'person' })
        try {
          return { skill: store.set(input, input.writtenBy!, { expectUpdatedAt: expect }) }
        } catch (err) {
          return (err as Error).message
        }
      }
    })
    const report = await importSkills(d)
    expect(report?.imported).toEqual(['beta'])
    expect(report?.skipped).toEqual([{ name: 'alpha', from: '~/.claude/skills/alpha', reason: 'already in the store' }])
    expect(store.byName(null, 'alpha')?.writtenBy).toEqual({ kind: 'person' })
  })

  it('a write refused because the home went offline stops the run with no marker; the next run finishes', async () => {
    let down = true
    const logs: string[] = []
    const base = deps({ log: (l) => logs.push(l) })
    const d: ImportDeps = {
      ...base,
      write: async (input, expect) => (down ? 'refused: add-ons and skills live on box; it is offline' : base.write(input, expect))
    }
    expect(await importSkills(d)).toBeNull()
    expect(base.settings.rows[SKILL_IMPORT_KEY]).toBeUndefined()
    expect(logs).toEqual(['import stopped: add-ons and skills live on box; it is offline; it runs again at the next link-up'])
    down = false
    expect((await importSkills(d))?.imported).toEqual(['alpha', 'beta'])
    expect(base.settings.rows[SKILL_IMPORT_KEY]).toBeDefined()
  })

  it('says what it did in one line', () => {
    expect(
      importLine({
        rows: [],
        imported: ['a', 'b'],
        merged: [{ name: 'impeccable', kept: '~/.agents/skills/impeccable', dropped: ['~/.claude/skills/impeccable'] }],
        skipped: [{ name: 'nosk', from: '~/.claude/skills/nosk', reason: 'no SKILL.md' }]
      })
    ).toBe(
      'imported 2 skills from ~/.claude/skills, ~/.codex/skills, ~/.agents/skills, ~/.config/muse/skills; merged 1 (impeccable: kept ~/.agents/skills); skipped 1 (nosk: no SKILL.md)'
    )
  })
})

