import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogLinkArgsSchema, EnsureLinkedArgsSchema, type CatalogLinkArgs, type EnsureLinkedArgs } from '@shared/projectLinks'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import { ensureLinked } from '../projectLinks'
import { LINK_DEBOUNCE_MS, LINK_PERIOD_MS, ProjectLinker, type LinkerLink } from './projectLinks'

const MAC = 'env_mac'
const BOX = 'env_box'

const ws = (id: string, path: string, createdAt: number, extra: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  id,
  name: path.split('/').pop() ?? path,
  path,
  git: true,
  createdAt,
  ...extra
})
const pr = (id: string, workspaceId: string, name: string, createdAt: number, extra: Partial<ProjectMeta> = {}): ProjectMeta =>
  ({ id, workspaceId, name, mode: 'local', branch: null, cwd: '/x', archived: false, createdAt, ...extra }) as ProjectMeta

/**
 * One host's catalog: the registry's view of it, stamping as linkCatalog
 * does, and the real `ensureLinked` over it (a project created as
 * sessions.ts createProject would; `fail` makes the create throw).
 */
function catalog(workspaces: WorkspaceMeta[] = [], projects: ProjectMeta[] = []) {
  const listeners = new Set<(kind: 'workspaces' | 'projects') => void>()
  const calls: CatalogLinkArgs[] = []
  const ensured: EnsureLinkedArgs[] = []
  let made = 0
  const host = {
    workspaces,
    projects,
    calls,
    ensured,
    fail: null as string | null,
    listWorkspaces: () => workspaces.map((w) => ({ ...w })),
    listProjects: () => projects.map((p) => ({ ...p })),
    linkCatalog(args: CatalogLinkArgs) {
      calls.push(args)
      for (const s of args.workspaces) Object.assign(workspaces.find((w) => w.id === s.id)!, { linkId: s.linkId })
      for (const s of args.projects) Object.assign(projects.find((p) => p.id === s.id)!, { linkId: s.linkId, linkNote: null })
      for (const n of args.notes ?? []) Object.assign(projects.find((p) => p.id === n.id)!, { linkNote: n.note })
      if (args.workspaces.length) for (const l of listeners) l('workspaces')
      if (args.projects.length || args.notes?.length) for (const l of listeners) l('projects')
    },
    ensureLinked(args: EnsureLinkedArgs) {
      ensured.push(args)
      return ensureLinked(
        {
          listProjects: host.listProjects,
          listWorkspaces: host.listWorkspaces,
          createWorkspace: () => Promise.reject(new Error('the linker never makes a workspace')),
          async createProject(workspaceId, name, mode, opts) {
            if (host.fail) throw new Error(host.fail)
            const row = pr(`made${++made}`, workspaceId, name, 100 + made, { mode, linkId: opts.linkId, ...(opts.branch ? { branch: opts.branch } : {}) })
            projects.push(row)
            for (const l of listeners) l('projects')
            return { ...row }
          },
          linkCatalog: host.linkCatalog,
          pathMap: () => ({ roots: {}, prefixes: {} }),
          workRoot: () => '/root',
          exists: () => false
        },
        args
      )
    },
    onCatalog(l: (kind: 'workspaces' | 'projects') => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    change() {
      for (const l of listeners) l('projects')
    }
  }
  return host
}

/** A link to `peer`, answering the methods the linker calls the way the host's dispatch would. */
function linkTo(id: string, peer: ReturnType<typeof catalog>, platform: string | null) {
  const methods: string[] = []
  const link: LinkerLink & { methods: string[] } = {
    id,
    connected: true,
    build: platform ? { platform } : null,
    methods,
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (!link.connected) throw new Error(`${id} is not connected`)
      methods.push(method)
      if (method === 'workspace.list') return JSON.parse(JSON.stringify(peer.listWorkspaces())) as T
      if (method === 'project.list') return JSON.parse(JSON.stringify(peer.listProjects())) as T
      if (method === 'catalog.link') {
        peer.linkCatalog(CatalogLinkArgsSchema.parse(params))
        return null as T
      }
      if (method === 'project.ensureLinked') return JSON.parse(JSON.stringify(await peer.ensureLinked(EnsureLinkedArgsSchema.parse(params)))) as T
      throw new Error(`unknown method ${method}`)
    }
  }
  return link
}

function setup(opts: { me?: string; platform?: string; peerId?: string; peerPlatform?: string | null } = {}) {
  const local = catalog()
  const peer = catalog()
  const link = linkTo(opts.peerId ?? BOX, peer, opts.peerPlatform === undefined ? 'linux' : opts.peerPlatform)
  let n = 0
  const linker = new ProjectLinker({
    environmentId: opts.me ?? MAC,
    platform: opts.platform ?? 'darwin',
    registry: local,
    peers: { get: (id) => (id === link.id ? link : undefined), all: () => [link] },
    ensureLinked: (args) => local.ensureLinked(args),
    workRoot: () => '/mac-root',
    mint: { workspace: () => `wl_${++n}`, project: () => `pl_${++n}` },
    now: () => 1_000,
    log: () => {}
  })
  return { local, peer, link, linker }
}

describe('ProjectLinker: pairing', () => {
  it('links workspaces with the same GitHub repo, whatever their folders are called', async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/Users/l/IdeaProjects/temp-code', 1, { githubRepo: 'LandonDev/temp-code' }))
    peer.workspaces.push(ws('wb', '/srv/agents/work/tc', 5, { githubRepo: 'landondev/temp-code' }))
    await linker.run(BOX)
    expect(local.workspaces[0].linkId).toBe('wl_1')
    expect(peer.workspaces[0].linkId).toBe('wl_1')
    expect(link.methods).toEqual(['workspace.list', 'project.list', 'catalog.link'])
    expect(linker.status(BOX)).toEqual({ lastRunAt: 1_000, pairs: { workspaces: 1, projects: 0 } })
  })

  it('falls back to the folder name when a side has no repo', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/Users/l/IdeaProjects/Shop', 1))
    peer.workspaces.push(ws('wb', '/srv/agents/work/shop', 2))
    peer.workspaces.push(ws('wx', '/srv/agents/work/other', 3))
    await linker.run(BOX)
    expect(local.workspaces[0].linkId).toBe('wl_1')
    expect(peer.workspaces.map((w) => w.linkId)).toEqual(['wl_1', undefined])
  })

  it('links projects by name inside paired workspaces only', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1), ws('wm2', '/m/blog', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    local.projects.push(pr('pm', 'wm', ' Alpha ', 1), pr('pm2', 'wm2', 'alpha', 1))
    peer.projects.push(pr('pb', 'wb', 'ALPHA', 1), pr('pb2', 'wb', 'Beta', 1))
    await linker.run(BOX)
    expect(local.projects[0].linkId).toBe('pl_2')
    expect(peer.projects[0].linkId).toBe('pl_2')
    // blog's workspace has no partner: untouched; Beta has no partner in a paired workspace: it gets its copy here
    expect(local.projects[1].linkId).toBeUndefined()
    expect(peer.projects[1].linkId).toBe('pl_3')
    expect(local.projects[2]).toEqual(expect.objectContaining({ workspaceId: 'wm', name: 'Beta', linkId: 'pl_3' }))
    expect(linker.status(BOX)?.pairs).toEqual({ workspaces: 1, projects: 1 })
  })

  it('pairs the oldest row when one host has two of a key', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('new', '/b/x/shop', 9), ws('old', '/b/shop', 2))
    local.projects.push(pr('pm', 'wm', 'Alpha', 1))
    peer.projects.push(pr('pnew', 'old', 'alpha', 8), pr('pold', 'old', 'Alpha', 3))
    await linker.run(BOX)
    expect(peer.workspaces.find((w) => w.id === 'old')?.linkId).toBe(local.workspaces[0].linkId)
    expect(peer.workspaces.find((w) => w.id === 'new')?.linkId).toBeUndefined()
    expect(peer.projects.find((p) => p.id === 'pold')?.linkId).toBe(local.projects[0].linkId)
    expect(peer.projects.find((p) => p.id === 'pnew')?.linkId).toBeUndefined()
  })
})

describe('ProjectLinker: deciding', () => {
  it("adopts the peer's id here, and gives this host's id to the peer", async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1, { linkId: 'wl_mine' }))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    local.projects.push(pr('pm', 'wm', 'Alpha', 1))
    peer.projects.push(pr('pb', 'wb', 'Alpha', 1, { linkId: 'pl_theirs' }))
    await linker.run(BOX)
    expect(peer.workspaces[0].linkId).toBe('wl_mine')
    expect(local.projects[0].linkId).toBe('pl_theirs')
    expect(local.calls).toEqual([{ workspaces: [], projects: [{ id: 'pm', linkId: 'pl_theirs' }] }])
    expect(peer.calls).toEqual([{ workspaces: [{ id: 'wb', linkId: 'wl_mine' }], projects: [] }])
    expect(link.methods.filter((m) => m === 'catalog.link')).toHaveLength(1)
  })

  it("keeps the box's id on a conflict when the box is the peer", async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1, { linkId: 'wl_mac' }))
    peer.workspaces.push(ws('wb', '/b/shop', 1, { linkId: 'wl_box' }))
    await linker.run(BOX)
    expect(local.workspaces[0].linkId).toBe('wl_box')
    expect(peer.calls).toEqual([])
  })

  it("keeps the box's id on a conflict when the box runs the linker", async () => {
    const { local, peer, linker } = setup({ me: BOX, platform: 'linux', peerId: MAC, peerPlatform: 'darwin' })
    local.workspaces.push(ws('wb', '/b/shop', 1, { linkId: 'wl_box' }))
    peer.workspaces.push(ws('wm', '/m/shop', 1, { linkId: 'wl_mac' }))
    await linker.run(MAC)
    expect(peer.workspaces[0].linkId).toBe('wl_box')
    expect(local.workspaces[0].linkId).toBe('wl_box')
    expect(local.calls).toEqual([])
  })

  it('counts a peer whose platform is unknown as the box', async () => {
    const { local, peer, linker } = setup({ peerPlatform: null })
    local.workspaces.push(ws('wm', '/m/shop', 1, { linkId: 'wl_mac' }))
    peer.workspaces.push(ws('wb', '/b/shop', 1, { linkId: 'wl_box' }))
    await linker.run(BOX)
    expect(local.workspaces[0].linkId).toBe('wl_box')
  })

  it('writes nothing when every pair already agrees', async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    await linker.run(BOX)
    link.methods.length = 0
    await linker.run(BOX)
    expect(link.methods).toEqual(['workspace.list', 'project.list'])
    expect(local.calls).toHaveLength(1)
  })

  it('never unlinks a row whose partner is gone', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    local.projects.push(pr('pm', 'wm', 'Alpha', 1))
    peer.projects.push(pr('pb', 'wb', 'Alpha', 1))
    await linker.run(BOX)
    const id = local.projects[0].linkId
    peer.projects.length = 0
    await linker.run(BOX)
    expect(local.projects[0].linkId).toBe(id)
    expect(local.calls).toHaveLength(1)
  })

  it('never gives one id to a second row on the same host', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1, { linkId: 'wl_a' }))
    peer.workspaces.push(ws('wb', '/b/shop', 1, { linkId: 'wl_a' }))
    // The box's linked Alpha was renamed to Beta and a fresh Alpha made: the Mac's Alpha would hand its id to a second row there.
    local.projects.push(pr('pm', 'wm', 'Alpha', 1, { linkId: 'pl_a' }))
    peer.projects.push(pr('pb', 'wb', 'Beta', 1, { linkId: 'pl_a' }), pr('pb2', 'wb', 'Alpha', 2))
    await linker.run(BOX)
    expect(peer.projects.find((p) => p.id === 'pb2')?.linkId).toBeUndefined()
    expect(peer.calls).toEqual([])
  })
})

describe('ProjectLinker: making the copies that are missing', () => {
  /** A workspace both hosts have, already linked. */
  const linkedPair = () => {
    const t = setup()
    t.local.workspaces.push(ws('wm', '/Users/l/IdeaProjects/shop', 1, { linkId: 'wl_shop' }))
    t.peer.workspaces.push(ws('wb', '/srv/agents/work/shop', 1, { linkId: 'wl_shop' }))
    return t
  }

  it("a project made on the Mac gets the box's copy, both rows on one id", async () => {
    const { local, peer, link, linker } = linkedPair()
    local.projects.push(pr('pm', 'wm', 'Alpha', 5, { mode: 'worktree', branch: 'alpha', cwd: '/Users/l/IdeaProjects/shop/.claude/worktrees/alpha' }))
    await linker.run(BOX)
    expect(peer.ensured).toEqual([
      expect.objectContaining({ projectLinkId: 'pl_1', workspaceLinkId: 'wl_shop', name: 'Alpha', mode: 'worktree', branch: 'alpha', callerWorkRoot: '/mac-root', workspaceMustExist: true })
    ])
    expect(peer.projects).toEqual([expect.objectContaining({ workspaceId: 'wb', name: 'Alpha', mode: 'worktree', branch: 'alpha', linkId: 'pl_1' })])
    expect(local.projects[0].linkId).toBe('pl_1')
    expect(link.methods).toEqual(['workspace.list', 'project.list', 'project.ensureLinked'])
  })

  it("a project made on the box gets the Mac's copy", async () => {
    const { local, peer, link, linker } = linkedPair()
    peer.projects.push(pr('pb', 'wb', 'Beta', 5))
    await linker.run(BOX)
    expect(local.projects).toEqual([expect.objectContaining({ workspaceId: 'wm', name: 'Beta', mode: 'local', linkId: 'pl_1' })])
    expect(peer.projects[0].linkId).toBe('pl_1')
    expect(peer.calls).toEqual([{ workspaces: [], projects: [{ id: 'pb', linkId: 'pl_1' }], notes: [] }])
    expect(link.methods).toEqual(['workspace.list', 'project.list', 'catalog.link'])
  })

  it('links the workspaces and makes the copy in the same run', async () => {
    const { local, peer, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    local.projects.push(pr('pm', 'wm', 'Alpha', 5))
    await linker.run(BOX)
    expect(peer.workspaces[0].linkId).toBe('wl_1')
    expect(peer.projects).toEqual([expect.objectContaining({ name: 'Alpha', linkId: 'pl_2' })])
    expect(local.projects[0].linkId).toBe('pl_2')
  })

  it('makes the copy of a project added while the box was offline once the link comes back', async () => {
    vi.useFakeTimers()
    try {
      const { local, peer, link, linker } = linkedPair()
      link.connected = false
      linker.start()
      local.projects.push(pr('pm', 'wm', 'Alpha', 5))
      local.change()
      await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS)
      expect(peer.projects).toEqual([])
      link.connected = true
      linker.linkUp(BOX)
      await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS)
      expect(peer.projects).toEqual([expect.objectContaining({ name: 'Alpha', linkId: local.projects[0].linkId })])
      linker.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a project that has lived on one host only its copy on the next pass, once', async () => {
    const { local, peer, linker } = linkedPair()
    local.projects.push(pr('old', 'wm', 'Legacy', 1))
    await linker.run(BOX)
    await linker.run(BOX)
    expect(peer.ensured).toHaveLength(1)
    expect(peer.projects.map((p) => p.linkId)).toEqual([local.projects[0].linkId])
  })

  it('never makes again a copy a person deleted, on either host', async () => {
    const { local, peer, linker } = linkedPair()
    local.projects.push(pr('pm', 'wm', 'Alpha', 5))
    peer.projects.push(pr('pb', 'wb', 'Beta', 5))
    await linker.run(BOX)
    expect(local.projects).toHaveLength(2)
    expect(peer.projects).toHaveLength(2)
    // Alpha's box copy and Beta's Mac copy are deleted: the survivors carry their ids, and nothing comes back.
    peer.projects.splice(peer.projects.findIndex((p) => p.name === 'Alpha'), 1)
    local.projects.splice(local.projects.findIndex((p) => p.name === 'Beta'), 1)
    await linker.run(BOX)
    expect(peer.projects.map((p) => p.name)).toEqual(['Beta'])
    expect(local.projects.map((p) => p.name)).toEqual(['Alpha'])
    expect(peer.ensured).toHaveLength(1)
    expect(local.ensured).toHaveLength(1)
  })

  it('makes no copy of an archived project', async () => {
    const { local, peer, linker } = linkedPair()
    local.projects.push(pr('pm', 'wm', 'Alpha', 5, { archived: true }))
    peer.projects.push(pr('pb', 'wb', 'Beta', 5, { archived: true }))
    await linker.run(BOX)
    expect(local.ensured).toEqual([])
    expect(peer.ensured).toEqual([])
  })

  it('leaves alone a project whose workspace has no copy on the other host, and never makes a workspace', async () => {
    const { local, peer, linker } = linkedPair()
    local.workspaces.push(ws('wm2', '/m/blog', 1))
    local.projects.push(pr('pm', 'wm2', 'Alpha', 5))
    await linker.run(BOX)
    expect(peer.ensured).toEqual([])
    expect(peer.workspaces).toHaveLength(1)
    expect(local.projects[0].linkId).toBeUndefined()
  })

  it('makes no second project of a name the other copy already holds', async () => {
    const { local, peer, linker } = linkedPair()
    local.projects.push(pr('a1', 'wm', 'Alpha', 1), pr('a2', 'wm', 'alpha', 2))
    peer.projects.push(pr('pb', 'wb', 'Alpha', 1))
    await linker.run(BOX)
    expect(peer.ensured).toEqual([])
    expect(local.projects.find((p) => p.id === 'a2')?.linkId).toBeUndefined()
  })

  it("a failed copy leaves the first host's project as it was, with the reason, logged once, and is tried again", async () => {
    const lines: string[] = []
    const { local, peer, link } = linkedPair()
    let n = 0
    const linker = new ProjectLinker({
      environmentId: MAC,
      platform: 'darwin',
      registry: local,
      peers: { get: () => link, all: () => [link] },
      ensureLinked: (args) => local.ensureLinked(args),
      mint: { workspace: () => `wl_${++n}`, project: () => `pl_${++n}` },
      log: (line) => lines.push(line)
    })
    local.projects.push(pr('pm', 'wm', 'Alpha', 5))
    peer.fail = 'git worktree add failed'
    peer.projects.push(pr('pb', 'wb', 'Beta', 5))
    local.fail = 'not a git repository'
    await linker.run(BOX)
    expect(local.projects).toEqual([expect.objectContaining({ id: 'pm', name: 'Alpha', linkNote: "Couldn't make a copy: git worktree add failed" })])
    expect(local.projects[0].linkId).toBeUndefined()
    expect(peer.projects).toEqual([expect.objectContaining({ id: 'pb', linkNote: "Couldn't make a copy: not a git repository" })])
    expect(peer.projects[0].linkId).toBeUndefined()
    expect(lines.filter((l) => l.includes('no copy of'))).toHaveLength(2)
    expect(linker.status(BOX)?.error).toBeUndefined()

    await linker.run(BOX)
    expect(lines.filter((l) => l.includes('no copy of'))).toHaveLength(2)

    peer.fail = null
    local.fail = null
    await linker.run(BOX)
    expect(local.projects.find((p) => p.id === 'pm')).toEqual(expect.objectContaining({ linkId: expect.any(String), linkNote: null }))
    expect(peer.projects.find((p) => p.id === 'pb')).toEqual(expect.objectContaining({ linkId: expect.any(String), linkNote: null }))
  })

  it('a copy refused over the link is a note too', async () => {
    const { local, link, linker } = linkedPair()
    local.projects.push(pr('pm', 'wm', 'Alpha', 5))
    const request = link.request.bind(link)
    link.request = (async (method: string, params?: unknown) => {
      if (method === 'project.ensureLinked') throw new Error('forbidden: project.ensureLinked is outside app-managed roots')
      return request(method, params)
    }) as typeof link.request
    await linker.run(BOX)
    expect(local.projects[0].linkNote).toBe("Couldn't make a copy: project.ensureLinked is outside app-managed roots")
  })
})

describe('ProjectLinker: triggers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once per burst of link-up, peer pushes and catalog changes', async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    linker.start()
    linker.linkUp(BOX)
    linker.onPeerPush(BOX, { push: 'projects', projects: [] })
    linker.onPeerPush(BOX, { push: 'workspaces', workspaces: [] })
    local.change()
    linker.onPeerPush(BOX, { push: 'boot-resume' } as never)
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS - 1)
    expect(link.methods).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(link.methods.filter((m) => m === 'workspace.list')).toHaveLength(1)
    // Its own stamp here is not a change to answer.
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS * 2)
    expect(link.methods.filter((m) => m === 'workspace.list')).toHaveLength(1)
    linker.close()
  })

  it('runs every 5 minutes', async () => {
    const { link, linker } = setup()
    linker.start()
    await vi.advanceTimersByTimeAsync(LINK_PERIOD_MS + LINK_DEBOUNCE_MS)
    expect(link.methods.filter((m) => m === 'workspace.list')).toHaveLength(1)
    linker.close()
  })

  it('skips a link that is down, quietly', async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    link.connected = false
    linker.linkUp(BOX)
    await vi.advanceTimersByTimeAsync(LINK_DEBOUNCE_MS)
    expect(link.methods).toEqual([])
    expect(linker.status(BOX)).toBeNull()
    expect(local.calls).toEqual([])
  })

  it('records an error the peer answered, keeping the last pair counts', async () => {
    const { local, peer, link, linker } = setup()
    local.workspaces.push(ws('wm', '/m/shop', 1))
    peer.workspaces.push(ws('wb', '/b/shop', 1))
    await linker.run(BOX)
    link.request = async () => {
      throw new Error('forbidden: catalog.link needs admin')
    }
    await linker.run(BOX)
    expect(linker.status(BOX)).toEqual({ lastRunAt: 1_000, pairs: { workspaces: 1, projects: 0 }, error: 'forbidden: catalog.link needs admin' })
  })
})
