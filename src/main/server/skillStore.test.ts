import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SkillStore, fileBytes, wireFile } from './skillStore'
import type { SkillFile, SkillInput } from '@shared/contract-skills'
import { skillDigest } from '@shared/skills'

const you = { kind: 'person' } as const
const thread = { kind: 'thread', sessionId: 's1', environmentId: 'env_box', title: 'Write tidy' } as const
const md = (name: string, description = 'Use it when the code needs tidying.'): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` })
const input = (over: Partial<SkillInput> = {}): SkillInput => ({ name: 'tidy', workspaceId: null, files: [md('tidy'), { path: 'scripts/run.sh', text: 'echo hi\n', executable: true }], ...over })

let db: DatabaseSync
let clock: number
let store: SkillStore
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  clock = 1_000
  store = new SkillStore(db, () => clock)
})
afterEach(() => db.close())

describe('SkillStore', () => {
  it('writes a skill whole and reads its row and files back', () => {
    const meta = store.set(input(), you)
    expect(meta.id).toMatch(/^sk_[A-Za-z0-9_-]{12}$/)
    expect(meta).toMatchObject({
      name: 'tidy',
      workspaceId: null,
      description: 'Use it when the code needs tidying.',
      harnesses: 'all',
      enabled: true,
      version: 1,
      fileCount: 2,
      addedBy: you,
      writtenBy: you,
      createdAt: 1_000,
      updatedAt: 1_000
    })
    expect(meta.bytes).toBe(input().files.reduce((n, f) => n + fileBytes(f).length, 0))
    expect(meta.digest).toBe(skillDigest(store.files(meta.id)))
    expect(store.list()).toEqual([meta])
    expect(store.get(meta.id)?.files).toEqual([md('tidy'), { path: 'scripts/run.sh', text: 'echo hi\n', executable: true }])
  })

  it('moves the version only when the files, the harnesses or enabled change', () => {
    const first = store.set(input(), you)
    clock = 2_000
    expect(store.set(input(), thread)).toMatchObject({ version: 1, writtenBy: thread, addedBy: you, updatedAt: 2_000 })
    expect(store.set(input({ harnesses: ['claude'] }), thread).version).toBe(2)
    expect(store.set(input({ harnesses: ['claude'], enabled: false }), thread).version).toBe(3)
    const next = store.set(input({ harnesses: ['claude'], enabled: false, files: [md('tidy', 'New words.')] }), thread)
    expect(next).toMatchObject({ id: first.id, version: 4, description: 'New words.', fileCount: 1, createdAt: 1_000 })
    // Files left out of a write are gone.
    expect(store.files(first.id).map((f) => f.path)).toEqual(['SKILL.md'])
  })

  it('keeps binary files and the executable bit byte for byte', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 0x7f])
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('text with a BOM')])
    const meta = store.set(input({ files: [md('tidy'), { path: 'data.bin', base64: Buffer.from(bytes).toString('base64'), executable: true }, { path: 'bom.txt', base64: Buffer.from(bom).toString('base64') }] }), you)
    const files = store.files(meta.id)
    expect(files.find((f) => f.path === 'data.bin')).toEqual({ path: 'data.bin', bytes, executable: true })
    expect(files.find((f) => f.path === 'bom.txt')?.bytes).toEqual(bom)
    const wire = store.get(meta.id)!.files
    expect(wire.find((f) => f.path === 'data.bin')).toEqual({ path: 'data.bin', base64: Buffer.from(bytes).toString('base64'), executable: true })
    // UTF-8 rides as text, its BOM kept, so it decodes back to the same bytes.
    expect(fileBytes(wire.find((f) => f.path === 'bom.txt')!)).toEqual(bom)
    expect(wireFile({ path: 'x', bytes, executable: false }).base64).toBeDefined()
  })

  it('refuses what a skill may not hold, a name taken in its scope, and writes nothing', () => {
    store.set(input(), you)
    expect(() => store.set(input({ name: 'other', files: [md('tidy')] }), you)).toThrow('refused: SKILL.md names the skill tidy, not other')
    expect(() => store.set(input({ files: [md('tidy'), { path: 'auth.json', text: '{}' }] }), you)).toThrow(/^refused: auth.json looks like a credential/)
    const other = store.set(input({ name: 'other', files: [md('other')] }), you)
    expect(() => store.set(input({ id: other.id }), you)).toThrow('refused: a skill named tidy already exists there')
    expect(store.list().map((s) => s.name)).toEqual(['other', 'tidy'])
  })

  it('a write that fails partway leaves the old files', () => {
    const meta = store.set(input(), you)
    // A duplicate path breaks the insert after the delete; the transaction undoes both.
    const writeFiles = (store as unknown as { writeFiles: (id: string, f: unknown[]) => void }).writeFiles.bind(store)
    expect(() =>
      (store as unknown as { transaction: (w: () => void) => void }).transaction(() =>
        writeFiles(meta.id, [
          { path: 'a', bytes: new Uint8Array(1), executable: false },
          { path: 'a', bytes: new Uint8Array(1), executable: false }
        ])
      )
    ).toThrow()
    expect(store.files(meta.id).map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
  })

  it('a thread sees its workspace\'s skills over the global ones, for its CLI', () => {
    const global = store.set(input(), you)
    const ws = store.set(input({ workspaceId: 'ws1', harnesses: ['codex'] }), you)
    expect(store.visible('ws1', 'codex').map((s) => s.id)).toEqual([ws.id])
    expect(store.visible('ws1', 'claude')).toEqual([])
    expect(store.visible(null, 'claude').map((s) => s.id)).toEqual([global.id])
  })

  it('the sync puts the home\'s skill, with files when the digest moved and without when it did not', () => {
    const mine = store.set(input(), you)
    const home = { ...store.get(mine.id)!, id: 'sk_home00000001', version: 7, writtenBy: thread, createdAt: 5, updatedAt: 6 }
    expect(store.put(home)).toBe(true)
    // The local row of that name gave way.
    expect(store.list().map((s) => s.id)).toEqual(['sk_home00000001'])
    expect(store.files('sk_home00000001').map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    const { files: _files, ...meta } = home
    expect(store.put(meta)).toBe(false)
    expect(store.put({ ...meta, enabled: false, version: 8 })).toBe(true)
    expect(store.meta('sk_home00000001')).toMatchObject({ enabled: false, version: 8 })
    expect(() => store.put({ ...meta, digest: 'moved' })).toThrow(/needs its files/)
    expect(() => store.put({ ...home, digest: 'wrong' })).toThrow(/do not match its digest/)
  })

  it('removes a skill with its files, and drops a deleted workspace\'s skills', () => {
    let changes = 0
    store.onChange(() => changes++)
    const a = store.set(input(), you)
    store.set(input({ workspaceId: 'ws1' }), you)
    expect(store.dropWorkspace('ws1')).toBe(1)
    expect(store.remove(a.id)).toBe(true)
    expect(store.remove(a.id)).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_files').get()).toEqual({ n: 0 })
    expect(changes).toBe(4)
  })
})
