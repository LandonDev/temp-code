import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnsureLinkedArgs } from '@shared/projectLinks'
import type { ProjectMeta, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { openDb, Store } from './db'
import { ensureLinked, type EnsureLinkedDeps } from './projectLinks'
import { SessionRegistry } from './sessions'

const MAC_ROOT = '/Users/landon/IdeaProjects'
const BOX_ROOT = '/srv/agents/work'

const ws = (over: Partial<WorkspaceMeta> & { id: string; path: string }): WorkspaceMeta => ({
  name: over.path.split('/').pop()!,
  git: true,
  githubRepo: null,
  createdAt: 1,
  ...over
})
const proj = (over: Partial<ProjectMeta> & { id: string; workspaceId: string; name: string }): ProjectMeta => ({
  mode: 'local',
  branch: 'master',
  cwd: '/srv/agents/work/alpha',
  archived: false,
  createdAt: 1,
  ...over
})

/** An in-memory catalog behind the deps, with what each create was asked. */
function catalog(opts: { workspaces?: WorkspaceMeta[]; projects?: ProjectMeta[]; dirs?: string[]; worktreeFails?: boolean } = {}) {
  const workspaces = [...(opts.workspaces ?? [])]
  const projects = [...(opts.projects ?? [])]
  const calls: string[] = []
  let n = 0
  const deps: EnsureLinkedDeps = {
    listProjects: () => projects.map((p) => ({ ...p })),
    listWorkspaces: () => workspaces.map((w) => ({ ...w })),
    async createWorkspace(path, { linkId }) {
      calls.push(`workspace ${path} ${linkId}`)
      const row = ws({ id: `w${++n}`, path, linkId, createdAt: 100 + n })
      workspaces.push(row)
      return row
    },
    async createProject(workspaceId: string, name: string, mode: ProjectMode, o: { branch?: string; linkId: string }) {
      calls.push(`project ${workspaceId} ${name} ${mode} ${o.branch ?? '-'} ${o.linkId}`)
      if (mode === 'worktree' && opts.worktreeFails) throw new Error('worktree projects need a git workspace')
      const base = workspaces.find((w) => w.id === workspaceId)!.path
      const row = proj({ id: `p${++n}`, workspaceId, name, mode, branch: o.branch ?? 'master', cwd: mode === 'worktree' ? `/home/x/.temp-code/worktrees/${name}` : base, linkId: o.linkId, createdAt: 100 + n })
      projects.push(row)
      return row
    },
    linkCatalog(args) {
      for (const { id, linkId } of args.workspaces) {
        calls.push(`link workspace ${id} ${linkId}`)
        workspaces.find((w) => w.id === id)!.linkId = linkId
      }
      for (const { id, linkId } of args.projects) {
        calls.push(`link project ${id} ${linkId}`)
        projects.find((p) => p.id === id)!.linkId = linkId
      }
    },
    pathMap: () => ({ roots: {}, prefixes: {} }),
    workRoot: () => BOX_ROOT,
    exists: (p) => (opts.dirs ?? []).includes(p)
  }
  return { deps, workspaces, projects, calls }
}

const args = (over: Partial<EnsureLinkedArgs> = {}): EnsureLinkedArgs => ({
  projectLinkId: 'pl_alpha',
  workspaceLinkId: 'wl_alpha',
  name: 'Alpha',
  branch: 'tc/alpha',
  mode: 'local',
  callerWorkspacePath: `${MAC_ROOT}/alpha`,
  callerProjectCwd: `${MAC_ROOT}/alpha`,
  callerWorkRoot: MAC_ROOT,
  ...over
})

describe('ensureLinked: the resolution order', () => {
  it('a project with the link id is the copy, whatever else matches', async () => {
    const { deps, calls } = catalog({
      workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha', linkId: 'wl_alpha' })],
      projects: [proj({ id: 'p1', workspaceId: 'w1', name: 'Renamed here', linkId: 'pl_alpha', cwd: '/srv/x' })]
    })
    const r = await ensureLinked(deps, args())
    expect(r).toMatchObject({ cwd: '/srv/x', exists: true, project: { id: 'p1' }, note: null })
    expect(calls).toEqual([])
  })

  it('a workspace by its link id gets the project, created with the caller name, mode and the link id', async () => {
    const { deps, calls } = catalog({ workspaces: [ws({ id: 'w1', path: '/srv/elsewhere/a', linkId: 'wl_alpha' })] })
    const r = await ensureLinked(deps, args())
    expect(r).toMatchObject({ cwd: '/srv/elsewhere/a', exists: false, project: { name: 'Alpha', linkId: 'pl_alpha' }, note: null })
    expect(calls).toEqual(['project w1 Alpha local - pl_alpha'])
  })

  it('else the mapped folder: an existing row is used and stamped with the workspace link', async () => {
    const { deps, calls } = catalog({
      workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha/' })],
      dirs: ['/srv/agents/work/alpha']
    })
    const r = await ensureLinked(deps, args())
    expect(r.project).toMatchObject({ workspaceId: 'w1', linkId: 'pl_alpha' })
    expect(calls).toEqual(['link workspace w1 wl_alpha', 'project w1 Alpha local - pl_alpha'])
  })

  it('a folder with no row gets a workspace born with the link id', async () => {
    const { deps, calls, workspaces } = catalog({ dirs: ['/srv/agents/work/alpha'] })
    const r = await ensureLinked(deps, args())
    expect(workspaces).toEqual([expect.objectContaining({ path: '/srv/agents/work/alpha', linkId: 'wl_alpha' })])
    expect(r).toMatchObject({ cwd: '/srv/agents/work/alpha', exists: false })
    expect(calls[0]).toBe('workspace /srv/agents/work/alpha wl_alpha')
  })

  it('else by the GitHub repo, case aside', async () => {
    const { deps } = catalog({ workspaces: [ws({ id: 'w1', path: '/srv/other/name', githubRepo: 'LandonDev/Alpha' })] })
    const r = await ensureLinked(deps, args({ workspaceGithubRepo: 'landondev/alpha' }))
    expect(r.project).toMatchObject({ workspaceId: 'w1', linkId: 'pl_alpha' })
  })

  it('an unlinked project of the same name in the workspace is adopted, not duplicated', async () => {
    const { deps, calls, projects } = catalog({
      workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha', linkId: 'wl_alpha' })],
      projects: [
        proj({ id: 'p1', workspaceId: 'w1', name: ' alpha ', cwd: '/srv/agents/work/alpha' }),
        proj({ id: 'p0', workspaceId: 'w1', name: 'Alpha', linkId: 'pl_other' })
      ]
    })
    const r = await ensureLinked(deps, args())
    expect(r).toMatchObject({ exists: true, project: { id: 'p1', linkId: 'pl_alpha' } })
    expect(calls).toEqual(['link project p1 pl_alpha'])
    expect(projects).toHaveLength(2)
  })

  it("a worktree copy asks for the caller's branch; a failed worktree is a local copy with a note", async () => {
    const ok = catalog({ workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha', linkId: 'wl_alpha' })] })
    const r = await ensureLinked(ok.deps, args({ mode: 'worktree' }))
    expect(ok.calls).toEqual(['project w1 Alpha worktree tc/alpha pl_alpha'])
    expect(r).toMatchObject({ cwd: '/home/x/.temp-code/worktrees/Alpha', note: null })

    const bad = catalog({ workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha', linkId: 'wl_alpha' })], worktreeFails: true })
    const fallback = await ensureLinked(bad.deps, args({ mode: 'worktree' }))
    expect(fallback).toMatchObject({ cwd: '/srv/agents/work/alpha', project: { mode: 'local', linkId: 'pl_alpha' } })
    expect(fallback.note).toBe('a local copy at /srv/agents/work/alpha: the worktree failed (worktree projects need a git workspace)')
  })

  it('no workspace: no cwd, and the note names the missing folder and the work root', async () => {
    const { deps, calls } = catalog()
    const r = await ensureLinked(deps, args())
    expect(r).toEqual({
      cwd: null,
      exists: false,
      project: null,
      note: 'no checkout of alpha on this host (looked for /srv/agents/work/alpha); the thread starts in its work root /srv/agents/work'
    })
    expect(calls).toEqual([])
  })
})

describe('ensureLinked: dryRun changes nothing', () => {
  it('answers the copy that exists, the one it would make, and a host with no checkout', async () => {
    const linked = catalog({ projects: [proj({ id: 'p1', workspaceId: 'w1', name: 'Alpha', linkId: 'pl_alpha' })] })
    expect(await ensureLinked(linked.deps, args({ dryRun: true }))).toMatchObject({ exists: true, project: { id: 'p1' } })

    const make = catalog({ dirs: ['/srv/agents/work/alpha'] })
    expect(await ensureLinked(make.deps, args({ dryRun: true }))).toEqual({ cwd: '/srv/agents/work/alpha', exists: false, project: null, note: null })
    expect(make.calls).toEqual([])
    expect(make.workspaces).toEqual([])

    const adopt = catalog({
      workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha' })],
      projects: [proj({ id: 'p1', workspaceId: 'w1', name: 'Alpha' })],
      dirs: ['/srv/agents/work/alpha']
    })
    expect(await ensureLinked(adopt.deps, args({ dryRun: true }))).toMatchObject({ exists: true, project: { id: 'p1' } })
    expect(adopt.calls).toEqual([])
    expect(adopt.projects[0].linkId).toBeUndefined()

    const plain = catalog({ workspaces: [ws({ id: 'w1', path: '/srv/agents/work/alpha', linkId: 'wl_alpha', git: false })] })
    expect((await ensureLinked(plain.deps, args({ mode: 'worktree', dryRun: true }))).note).toBe(
      'a local copy at /srv/agents/work/alpha: it is not a git repository'
    )

    const none = catalog()
    expect(await ensureLinked(none.deps, args({ dryRun: true }))).toEqual({
      cwd: null,
      exists: false,
      project: null,
      note: 'no checkout of alpha on this host (looked for /srv/agents/work/alpha)'
    })
  })
})

// ── the real registry, a scratch git repo, a real worktree ─────────────

describe('ensureLinked over the registry', () => {
  let root: string
  let db: ReturnType<typeof openDb>
  let registry: SessionRegistry
  const home = process.env.HOME
  afterEach(async () => {
    process.env.HOME = home
    await registry?.disposeAll()
    db?.close()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it("creates the workspace and a worktree copy on the caller's branch, links both, and finds it again", async () => {
    root = await mkdtemp(join(tmpdir(), 'tc-ensure-linked-'))
    process.env.HOME = join(root, 'home') // addProjectWorktree puts worktrees under ~/.temp-code
    const work = join(root, 'work')
    const repo = join(work, 'alpha')
    mkdirSync(repo, { recursive: true })
    const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first')
    git('branch', 'tc/alpha')

    db = openDb(join(root, 'test.db'))
    registry = new SessionRegistry(new Store(db))
    const deps: EnsureLinkedDeps = {
      listProjects: () => registry.listProjects(),
      listWorkspaces: () => registry.listWorkspaces(),
      createWorkspace: (path, opts) => registry.createWorkspace(path, undefined, opts),
      createProject: (w, name, mode, opts) => registry.createProject(w, name, mode, opts),
      linkCatalog: (a) => registry.linkCatalog(a),
      pathMap: () => ({ roots: {}, prefixes: {} }),
      workRoot: () => work
    }
    const first = await ensureLinked(deps, args({ mode: 'worktree' }))
    expect(first.exists).toBe(false)
    expect(first.note).toBeNull()
    expect(first.project).toMatchObject({ name: 'Alpha', mode: 'worktree', branch: 'tc/alpha', linkId: 'pl_alpha' })
    expect(first.cwd).toBe(join(root, 'home', '.temp-code', 'worktrees', 'alpha'))
    expect(execFileSync('git', ['-C', first.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('tc/alpha')
    expect(registry.listWorkspaces()).toEqual([expect.objectContaining({ path: repo, linkId: 'wl_alpha', git: true })])

    const again = await ensureLinked(deps, args({ mode: 'worktree' }))
    expect(again).toMatchObject({ exists: true, project: { id: first.project!.id } })
    expect(registry.listProjects()).toHaveLength(1)

    // The caller side: a row's facts mint the ids it lacks, once.
    const local = await registry.createProject(registry.listWorkspaces()[0].id, 'Beta', 'local')
    const facts = registry.projectLinkFacts(local.id)!
    expect(facts).toMatchObject({ name: 'Beta', mode: 'local', workspaceLinkId: 'wl_alpha', workspacePath: repo, cwd: repo })
    expect(facts.linkId).toMatch(/^pl_/)
    expect(registry.getProject(local.id)?.linkId).toBe(facts.linkId)
    expect(registry.projectLinkFacts(local.id)?.linkId).toBe(facts.linkId)
  })
})
