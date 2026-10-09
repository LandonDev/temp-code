import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  parentId: null,
  projectId: null,
  workspaceId: null,
  threadType: null,
  planPath: null,
  provider: 'claude',
  model: 'm',
  reasoning: 'medium',
  agentType: 'implementer',
  title: id,
  cwd: '/tmp',
  status: 'idle',
  pinned: false,
  archived: false,
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  permission: 'edits',
  nativeId: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

describe('account columns', () => {
  it('a session has no account until set; it survives an update and never touches updatedAt', () => {
    store.insertSession(meta('s'))
    expect(store.getSession('s')).toMatchObject({ account: null })
    expect(store.getSession('s')).not.toHaveProperty('accountPin')
    const before = store.getSession('s')!.updatedAt
    store.setSessionAccount('s', 'other@x.com')
    expect(store.getSession('s')).toMatchObject({ account: 'other@x.com', updatedAt: before })
    store.updateSession('s', { title: 't' })
    expect(store.getSession('s')).toMatchObject({ account: 'other@x.com' })
    store.setSessionAccount('s', null)
    expect(store.getSession('s')!.account).toBeNull()
  })
  it('projects and workspaces default to no pins, keep one per provider, and drop empty ones', () => {
    store.insertWorkspace({ id: 'w', name: 'w', path: '/w', git: false, createdAt: 1 })
    store.insertProject({ id: 'p', workspaceId: 'w', name: 'p', mode: 'local', branch: null, cwd: '/w', archived: false, createdAt: 1 })
    expect(store.listWorkspaces()[0].accountPins).toEqual({})
    expect(store.getProject('p')!.accountPins).toEqual({})
    store.setWorkspaceAccounts('w', { claude: 'ws@x.com', codex: '' })
    store.setProjectAccounts('p', { codex: 'proj-codex' })
    expect(store.listWorkspaces()[0].accountPins).toEqual({ claude: 'ws@x.com' })
    expect(store.getProject('p')!.accountPins).toEqual({ codex: 'proj-codex' })
    store.setProjectAccounts('p', {})
    expect(store.getProject('p')!.accountPins).toEqual({})
  })
})
