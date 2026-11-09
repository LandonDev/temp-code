import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillFile } from '@shared/contract-skills'
import { SkillStore } from '../skillStore'
import {
  GENERATION_MANIFEST,
  SUPERSEDED_KEEP_MS,
  SkillMaterializer,
  configureMaterializedSkills,
  extrasDigest,
  generationName,
  materializedSkillsDir,
  type MaterializerDeps
} from './materialize'

const you = { kind: 'person' } as const
const HOME = '/home/me'
const md = (name: string, body = ''): SkillFile => ({ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}` })

let tmp: string
let root: string
let db: DatabaseSync
let store: SkillStore
let clock: number
let logs: string[]
let workspaces: { id: string; path: string }[]
let made: SkillMaterializer[]

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-materialize-')))
  root = join(tmp, 'harness')
  db = new DatabaseSync(':memory:')
  clock = 1_000_000
  store = new SkillStore(db, () => clock)
  logs = []
  workspaces = []
  made = []
})
afterEach(() => {
  for (const m of made) m.close()
  configureMaterializedSkills(null)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const put = (name: string, over: { body?: string; files?: SkillFile[]; workspaceId?: string | null; harnesses?: ['claude'] | 'all' } = {}) =>
  store.set({ name, workspaceId: over.workspaceId ?? null, harnesses: over.harnesses, files: [md(name, over.body), ...(over.files ?? [])] }, you)

function make(over: Partial<MaterializerDeps> = {}): SkillMaterializer {
  const m = new SkillMaterializer({
    root,
    skills: store,
    workspaces: () => workspaces,
    platform: 'linux',
    home: HOME,
    textMap: () => ({ roots: {}, prefixes: {} }),
    now: () => clock,
    log: (l) => logs.push(l),
    between: async () => {},
    ...over
  })
  made.push(m)
  return m
}

async function started(over: Partial<MaterializerDeps> = {}): Promise<SkillMaterializer> {
  const m = make(over)
  m.start()
  expect(await m.whenSettled()).toBe(true)
  return m
}

const view = (provider = 'claude', name = 'global'): string => join(root, provider, name)
const current = (provider = 'claude', name = 'global'): string => readlinkSync(view(provider, name))
const gens = (provider = 'claude'): string[] => readdirSync(join(root, provider)).filter((n) => /@[0-9a-f]{12}$/.test(n)).sort()
const inode = (path: string): number => statSync(path).ino

describe('a generation', () => {
  it('writes every skill read-only, executables 0555, behind a symlink to a generation of its own name', async () => {
    put('alpha', { files: [{ path: 'scripts/run.sh', text: 'echo hi\n', executable: true }] })
    const m = await started()
    expect(lstatSync(view()).isSymbolicLink()).toBe(true)
    expect(current()).toMatch(/^global@[0-9a-f]{12}$/)
    const skill = join(view(), 'skills', 'alpha')
    expect(statSync(join(skill, 'SKILL.md')).mode & 0o777).toBe(0o444)
    expect(statSync(join(skill, 'scripts/run.sh')).mode & 0o777).toBe(0o555)
    expect(m.dirFor('claude', null)).toBe(join(root, 'claude', current()))
    // Every provider has its global view, empty or not.
    expect(readdirSync(join(view('muse'), 'skills'))).toEqual(['alpha'])
    put('cl', { harnesses: ['claude'] })
    await m.whenSettled()
    expect(readdirSync(join(view('codex'), 'skills'))).toEqual(['alpha'])
    expect(readdirSync(join(view('claude'), 'skills'))).toEqual(['alpha', 'cl'])
    const manifest = JSON.parse(readFileSync(join(view(), GENERATION_MANIFEST), 'utf8'))
    expect(Object.keys(manifest.skills)).toEqual(['alpha', 'cl'])
    expect(logs.some((l) => /^claude\/global → global@[0-9a-f]{12} \(1 written, 1 linked\)$/.test(l))).toBe(true)
  })

  it('an unchanged view writes nothing', async () => {
    put('alpha')
    const m = await started()
    const before = statSync(join(view(), 'skills/alpha/SKILL.md')).mtimeMs
    const gen = current()
    // A write that leaves the row as it was still fires onChange.
    store.set({ name: 'alpha', workspaceId: null, files: [md('alpha')] }, you)
    await m.whenSettled()
    expect(current()).toBe(gen)
    expect(statSync(join(view(), 'skills/alpha/SKILL.md')).mtimeMs).toBe(before)
    expect(gens()).toEqual([gen])
  })

  it('one changed skill gives a new generation whose other skills share their inodes with the old one', async () => {
    put('alpha')
    put('beta')
    const m = await started()
    const old = current()
    const alphaIno = inode(join(root, 'claude', old, 'skills/alpha/SKILL.md'))
    put('beta', { body: 'new words' })
    await m.whenSettled()
    expect(current()).not.toBe(old)
    expect(inode(join(view(), 'skills/alpha/SKILL.md'))).toBe(alphaIno)
    expect(readFileSync(join(view(), 'skills/beta/SKILL.md'), 'utf8')).toContain('new words')
    // The old generation is still there, untouched.
    expect(readFileSync(join(root, 'claude', old, 'skills/beta/SKILL.md'), 'utf8')).not.toContain('new words')
  })

  it('rewrites a skill\'s own and its siblings\' install paths to the view\'s folder, and rewrites a skill again when a name it mentions joins or leaves the view', async () => {
    put('alpha', { body: 'Run ~/.claude/skills/alpha/scripts/run.sh, then ~/.codex/skills/beta/x.md.\n' })
    const m = await started()
    const text = (): string => readFileSync(join(view(), 'skills/alpha/SKILL.md'), 'utf8')
    expect(text()).toContain(`${view()}/skills/alpha/scripts/run.sh`)
    expect(text()).toContain('~/.codex/skills/beta/x.md')
    const first = inode(join(view(), 'skills/alpha/SKILL.md'))
    put('beta')
    await m.whenSettled()
    expect(text()).toContain(`${view()}/skills/beta/x.md`)
    expect(inode(join(view(), 'skills/alpha/SKILL.md'))).not.toBe(first)
    store.remove(store.byName(null, 'beta')!.id)
    await m.whenSettled()
    expect(text()).toContain('~/.codex/skills/beta/x.md')
  })

  it('a changed text map or extras gives a new generation name and leaves the old folder as it was', async () => {
    put('alpha', { body: '/Users/me/notes\n' })
    let map = { roots: {}, prefixes: {} as Record<string, string> }
    let extras: { path: string; bytes: Uint8Array }[] = []
    let moved: (() => void) | null = null
    const m = await started({ textMap: () => map, generationExtras: () => extras, onTextMap: (fn) => ((moved = fn), () => {}) })
    const first = current()
    const firstText = readFileSync(join(root, 'claude', first, 'skills/alpha/SKILL.md'), 'utf8')
    map = { roots: {}, prefixes: { '/Users/me': HOME } }
    moved!()
    await m.whenSettled()
    const second = current()
    expect(second).not.toBe(first)
    expect(readFileSync(join(view(), 'skills/alpha/SKILL.md'), 'utf8')).toContain(`${HOME}/notes`)
    expect(readFileSync(join(root, 'claude', first, 'skills/alpha/SKILL.md'), 'utf8')).toBe(firstText)
    extras = [{ path: '.claude-plugin/plugin.json', bytes: new TextEncoder().encode('{"name":"tc"}') }]
    expect(m.dirFor('claude', null)).not.toBe(join(root, 'claude', second))
    // The extras land at the generation's root, read-only.
    const extra = join(view(), '.claude-plugin/plugin.json')
    expect(readFileSync(extra, 'utf8')).toBe('{"name":"tc"}')
    expect(statSync(extra).mode & 0o777).toBe(0o444)
    // The name hashes the view digest, the text key and the extras' digest.
    const plan = { view: 'global', viewDigest: 'v' }
    expect(new Set([generationName(plan, 'a', ''), generationName(plan, 'b', ''), generationName(plan, 'a', extrasDigest(extras)), generationName({ ...plan, viewDigest: 'w' }, 'a', '')]).size).toBe(4)
  })

  it('a generation of another layout is never linked from: every skill is written fresh', async () => {
    put('alpha')
    put('beta')
    const m = await started()
    const old = join(root, 'claude', current())
    const manifest = join(old, GENERATION_MANIFEST)
    const data = JSON.parse(readFileSync(manifest, 'utf8'))
    chmodSync(manifest, 0o644)
    writeFileSync(manifest, JSON.stringify({ ...data, layout: 0 }))
    const alphaIno = inode(join(old, 'skills/alpha/SKILL.md'))
    put('beta', { body: 'x' })
    await m.whenSettled()
    expect(inode(join(view(), 'skills/alpha/SKILL.md'))).not.toBe(alphaIno)
    expect(logs.filter((l) => l.startsWith('claude/global')).at(-1)).toMatch(/\(2 written, 0 linked\)$/)
  })
})

describe('the swap', () => {
  it('renames the link over the view, so a reader through it sees the old generation whole until the new one is', async () => {
    put('alpha', { body: 'one' })
    put('beta', { body: 'one' })
    const reads: string[] = []
    const m = await started({
      between: async () => {
        // The first build has no link to read through yet.
        if (existsSync(view())) reads.push(readFileSync(join(view(), 'skills/alpha/SKILL.md'), 'utf8') + readFileSync(join(view(), 'skills/beta/SKILL.md'), 'utf8'))
      }
    })
    reads.length = 0
    put('alpha', { body: 'two' })
    put('beta', { body: 'two' })
    await m.whenSettled()
    expect(reads.length).toBeGreaterThan(0)
    for (const r of reads) expect(r.match(/one/g)?.length === 2 || r.match(/two/g)?.length === 2).toBe(true)
    expect(readFileSync(join(view(), 'skills/beta/SKILL.md'), 'utf8')).toContain('two')
    expect(readdirSync(join(root, 'claude')).filter((n) => /\.(tmp|lnk)-/.test(n))).toEqual([])
  })

  it('a workspace view comes and goes with the workspace\'s own skills', async () => {
    workspaces = [{ id: 'w1', path: join(tmp, 'w1') }]
    put('alpha')
    const m = await started()
    expect(existsSync(view('claude', 'ws-w1'))).toBe(false)
    const own = put('local', { workspaceId: 'w1' })
    await m.whenSettled()
    expect(readdirSync(join(view('claude', 'ws-w1'), 'skills'))).toEqual(['alpha', 'local'])
    expect(m.dirFor('claude', 'w1')).toBe(join(root, 'claude', current('claude', 'ws-w1')))
    expect(m.dirFor('claude', 'w2')).toBe(join(root, 'claude', current()))
    store.remove(own.id)
    await m.whenSettled()
    expect(existsSync(view('claude', 'ws-w1'))).toBe(false)
    expect(m.dirFor('claude', 'w1')).toBe(join(root, 'claude', current()))
  })

  it('removes what a dead process left at start, and keeps what this one is writing', async () => {
    for (const name of ['global@0123456789ab.tmp-999999-1', 'global.lnk-999999-2', `global@0123456789ab.tmp-${process.pid}-1`]) mkdirSync(join(root, 'claude', name), { recursive: true })
    writeFileSync(join(root, 'generations.json.tmp-999999-3'), '{}')
    await started()
    const left = readdirSync(join(root, 'claude')).filter((n) => n.includes('.tmp-') || n.includes('.lnk-'))
    expect(left).toEqual([`global@0123456789ab.tmp-${process.pid}-1`])
    expect(existsSync(join(root, 'generations.json.tmp-999999-3'))).toBe(false)
  })
})

describe('two builds of one view', () => {
  it('dirFor builds at once while a run is pending; the run then finds the folder in place and drops its own', async () => {
    put('alpha')
    put('beta')
    const m = await started()
    let synced: string | null = null
    const m2 = make({
      between: async () => {
        // The first yield of the async build: a spawn asks now.
        synced ??= m2.dirFor('claude', null)
      }
    })
    m.close()
    m2.start()
    put('beta', { body: 'changed' })
    expect(await m2.whenSettled()).toBe(true)
    expect(synced).toBe(join(root, 'claude', current()))
    expect(readFileSync(join(view(), 'skills/beta/SKILL.md'), 'utf8')).toContain('changed')
    expect(readdirSync(join(root, 'claude')).filter((n) => /\.(tmp|lnk)-/.test(n))).toEqual([])
    expect(logs.some((l) => l.includes('failed'))).toBe(false)
  })

  it('a workspace view dirFor links during a run is not removed by that run\'s end', async () => {
    workspaces = [{ id: 'w1', path: join(tmp, 'w1') }]
    put('alpha')
    const m = await started()
    let linked = false
    const m2 = make({
      between: async () => {
        if (linked) return
        linked = true
        // A write gives w1 its own view while the run (planned without it) is between skills; a spawn there asks now.
        put('local', { workspaceId: 'w1' })
        m2.dirFor('claude', 'w1')
      }
    })
    m.close()
    m2.start()
    put('alpha', { body: 'two' })
    await m2.whenSettled()
    expect(lstatSync(view('claude', 'ws-w1')).isSymbolicLink()).toBe(true)
    expect(logs.some((l) => l === 'claude/ws-w1 removed')).toBe(false)
  })

  it('dirFor answers the new generation for a write the run has not reached', async () => {
    put('alpha')
    const m = await started()
    const before = current()
    put('beta')
    const dir = m.dirFor('claude', null)
    expect(dir).not.toBe(join(root, 'claude', before))
    expect(readdirSync(join(dir, 'skills'))).toEqual(['alpha', 'beta'])
    await m.whenSettled()
    expect(join(root, 'claude', current())).toBe(dir)
  })

  it('an async build whose rows changed under it publishes no symlink; the next run publishes the newer one', async () => {
    put('alpha')
    put('beta')
    const m = await started()
    const pointed: string[] = []
    let added = false
    const m2 = make({
      between: async () => {
        pointed.push(current())
        if (!added) {
          added = true
          put('zeta')
        }
      }
    })
    m.close()
    m2.start()
    put('beta', { body: 'b2' })
    await m2.whenSettled()
    expect(readdirSync(join(view(), 'skills'))).toEqual(['alpha', 'beta', 'zeta'])
    // The generation planned before zeta was built but never pointed at.
    const built = gens().filter((g) => !pointed.includes(g) && join(root, 'claude', g) !== join(root, 'claude', current()))
    expect(built.length).toBeGreaterThan(0)
    for (const g of built) expect(readdirSync(join(root, 'claude', g, 'skills'))).toEqual(['alpha', 'beta'])
  })

  it('a skill rewritten between the plan and its file read drops the build: no folder of the old name holds the new bytes', async () => {
    put('alpha')
    put('beta')
    const m = await started()
    const seenTmp = new Set<string>()
    let step = 0
    const m2 = make({
      between: async () => {
        for (const n of readdirSync(join(root, 'claude'))) if (n.includes('.tmp-')) seenTmp.add(n.replace(/\.tmp-.*$/, ''))
        // After alpha, before beta's files are read.
        if (++step === 2) put('beta', { body: 'later' })
      }
    })
    m.close()
    m2.start()
    put('beta', { body: 'first' })
    await m2.whenSettled()
    expect(readFileSync(join(view(), 'skills/beta/SKILL.md'), 'utf8')).toContain('later')
    const stale = [...seenTmp].filter((g) => g.startsWith('global@') && g !== current())
    expect(stale.length).toBeGreaterThan(0)
    for (const g of stale) expect(existsSync(join(root, 'claude', g))).toBe(false)
  })
})

describe('settling', () => {
  it('whenSettled resolves after the run, and false at its timeout', async () => {
    put('alpha')
    let hold: (() => void) | null = null
    const m = make({ between: () => new Promise<void>((resolve) => (hold = resolve)) })
    m.start()
    expect(await m.whenSettled(30)).toBe(false)
    const done = m.whenSettled()
    // Let every yield through from now on.
    const drain = setInterval(() => hold?.(), 1)
    expect(await done).toBe(true)
    clearInterval(drain)
  })
})

describe('gc', () => {
  it('keeps the current generation, one in use and one superseded under a day; removes the rest', async () => {
    put('alpha', { body: '1' })
    const inUse = new Set<string>()
    const m = await started({ inUse: () => inUse })
    const g1 = current()
    put('alpha', { body: '2' })
    await m.whenSettled()
    const g2 = current()
    inUse.add(join(root, 'claude', g2))
    clock += 1_000
    put('alpha', { body: '3' })
    await m.whenSettled()
    const g3 = current()
    clock += SUPERSEDED_KEEP_MS - 500
    put('alpha', { body: '4' })
    await m.whenSettled()
    const g4 = current()
    // A folder no ledger knows: superseded from the first gc that sees it.
    mkdirSync(join(root, 'claude', 'global@ffffffffffff'))
    m.gc()
    // g1 went past a day; g2 is in use; g3 superseded under a day ago; g4 is current.
    expect(gens()).toEqual([g2, g3, g4, 'global@ffffffffffff'].sort())
    expect(gens()).not.toContain(g1)
    clock += SUPERSEDED_KEEP_MS + 1
    m.gc()
    expect(gens()).toEqual([g2, g4].sort())
    const ledger = JSON.parse(readFileSync(join(root, 'generations.json'), 'utf8'))
    expect(Object.keys(ledger)).toEqual([])
  })
})

describe('materializedSkillsDir', () => {
  it('is null before the materializer is configured, and its current generation after', async () => {
    expect(materializedSkillsDir('claude', null)).toBeNull()
    put('alpha')
    const m = await started()
    configureMaterializedSkills(m)
    expect(materializedSkillsDir('claude', null)).toBe(join(root, 'claude', current()))
  })
})
