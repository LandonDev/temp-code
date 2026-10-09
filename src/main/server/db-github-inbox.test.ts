import { afterEach, beforeEach, expect, it } from 'vitest'
import type { GithubInboxItem } from '@shared/contract-github'
import { openDb, Store } from './db'

let db: ReturnType<typeof openDb>
let store: Store
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
})
afterEach(() => db.close())

const item = (number: number): GithubInboxItem => ({
  kind: 'pr',
  repo: 'o/n',
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/n/pull/${number}`,
  state: 'open',
  draft: false,
  updatedAt: '2026-10-09T00:00:00Z',
  author: { login: 'me', avatarUrl: '' },
  assignees: [],
  labels: [{ name: 'bug', color: 'ff0000' }],
  reviewDecision: 'APPROVED',
  headRefName: 'feat',
  baseRefName: 'master',
  checks: 'SUCCESS',
  reviewRequested: ['team-x']
})

it('round-trips snapshot rows and prunes the ones no workspace keeps', () => {
  expect(store.listGithubInboxRepos()).toEqual([])
  store.putGithubInboxRepo({ repo: 'o/n', fetchedAt: 10, error: null, items: [item(1), item(2)] })
  store.putGithubInboxRepo({ repo: 'o/m', fetchedAt: 11, error: 'boom', items: [] })
  expect(store.listGithubInboxRepos()).toEqual([
    { repo: 'o/m', fetchedAt: 11, error: 'boom', items: [] },
    { repo: 'o/n', fetchedAt: 10, error: null, items: [item(1), item(2)] }
  ])
  store.putGithubInboxRepo({ repo: 'o/n', fetchedAt: 12, error: null, items: [item(3)] })
  expect(store.listGithubInboxRepos()[1]).toEqual({ repo: 'o/n', fetchedAt: 12, error: null, items: [item(3)] })
  store.deleteGithubInboxRepos(['o/n'])
  expect(store.listGithubInboxRepos().map((r) => r.repo)).toEqual(['o/n'])
  store.deleteGithubInboxRepos([])
  expect(store.listGithubInboxRepos()).toEqual([])
})

it('keeps the viewer, fetchedAt and auth settings', () => {
  store.setSetting('github.inbox.viewer', 'LandonDev')
  store.setSetting('github.inbox.fetchedAt', '123')
  store.setSetting('github.inbox.auth', JSON.stringify({ state: 'ok', message: '' }))
  expect(store.getSetting('github.inbox.viewer')).toBe('LandonDev')
  expect(store.getSetting('github.inbox.fetchedAt')).toBe('123')
  expect(JSON.parse(store.getSetting('github.inbox.auth') ?? '')).toEqual({ state: 'ok', message: '' })
})
