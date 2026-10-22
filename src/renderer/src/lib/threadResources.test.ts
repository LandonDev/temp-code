import { describe, expect, it } from 'vitest'
import type { ThreadResource } from '@server/shared/contract-resources'
import { KIND_LABEL, countHeldBy, removalClause, rowState, threadResourcesStore } from './threadResources'

const row = (over: Partial<ThreadResource>): ThreadResource => ({
  id: 'r1',
  sessionId: 's1',
  environmentId: 'env_mac',
  kind: 'worktree',
  identifier: '/Users/landon/IdeaProjects/tc-ios/home',
  label: 'ios/home',
  branch: 'ios/home',
  createdAt: 1,
  removeRequestedAt: null,
  removedAt: null,
  note: null,
  ...over
})
const names: Record<string, string> = { env_mac: 'the Mac', env_box: 'the box' }
const nameOf = (id: string) => names[id] ?? id

describe('removalClause', () => {
  it('counts the rows and names their hosts', () => {
    expect(removalClause([], nameOf)).toBe('')
    expect(removalClause([row({})], nameOf)).toBe('and remove 1 resource on the Mac')
    expect(removalClause([row({}), row({ id: 'r2', kind: 'simulator' })], nameOf)).toBe('and remove 2 resources on the Mac')
    expect(removalClause([row({}), row({ id: 'r2', environmentId: 'env_box' }), row({ id: 'r3', environmentId: 'env_box' })], nameOf)).toBe(
      'and remove 3 resources on the Mac and the box'
    )
  })
})

describe('rowState', () => {
  it('says what the last attempt left: nothing, a note, waiting, removed', () => {
    expect(rowState(row({}))).toBeNull()
    expect(rowState(row({ note: 'branch ios/home kept: 2 commits ahead of its upstream' }))).toBe('branch ios/home kept: 2 commits ahead of its upstream')
    expect(rowState(row({ removeRequestedAt: 5 }))).toBe('removing…')
    expect(rowState(row({ removeRequestedAt: 5, note: 'host offline, waiting for its link' }))).toBe('host offline, waiting for its link')
    expect(rowState(row({ removeRequestedAt: 5, removedAt: 6 }))).toBe('removed')
    expect(rowState(row({ removedAt: 6, note: 'branch ios/home deleted' }))).toBe('branch ios/home deleted')
  })
  it('names every kind in plain words', () => {
    expect(KIND_LABEL).toEqual({ worktree: 'worktree', simulator: 'simulator', devInstance: 'dev instance', port: 'dev server' })
  })
})

describe('countHeldBy', () => {
  it('sums the live rows of the given threads, for the fleet\'s Archive done clause', () => {
    threadResourcesStore.setState({
      bySession: {
        s1: [row({}), row({ id: 'r2', kind: 'simulator' }), row({ id: 'r3', removedAt: 9 })],
        s2: [row({ id: 'r4', sessionId: 's2' })],
        s3: []
      }
    })
    expect(countHeldBy(['s1'])).toBe(2)
    expect(countHeldBy(['s1', 's2', 's3', 'unknown'])).toBe(3)
    expect(countHeldBy([])).toBe(0)
  })
})
